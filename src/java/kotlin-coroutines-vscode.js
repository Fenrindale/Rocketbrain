'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { prepareCoroutineProbe,readCoroutineDescriptor,fetchCoroutineSnapshot } = require('./kotlin-coroutine-probe');
const { coroutineDebugger } = require('./kotlin-coroutine-debug-vscode');
const { workspacePath,workspaceRoots,fail } = require('./workbench-model');

const VIEW='rocketbrain.kotlinCoroutines';
const COMMANDS={prepare:'rocketbrain.coroutines.prepare',connect:'rocketbrain.coroutines.connect',
  refresh:'rocketbrain.coroutines.refresh',disconnect:'rocketbrain.coroutines.disconnect',openFrame:'rocketbrain.coroutines.openFrame',
  prepareDebug:'rocketbrain.coroutines.prepareDebug',watchFrame:'rocketbrain.coroutines.watchFrame',detachDebugger:'rocketbrain.coroutines.detachDebugger'};
const KINDS={observed:'Last observed stack',creation:'Creation stack'};
const SOURCE=/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,150}\.(?:kt|java)$/u;

function registerKotlinCoroutines(vscode,java) {
  const changed=new vscode.EventEmitter();
  let session,snapshot,prepared,epoch=0,disposed=false,pending=Promise.resolve();
  let debugCleanup=Promise.resolve();
  const subscriptions=[changed];
  let childrenByParent=new Map();

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust this workspace to inspect a local Kotlin JVM.');
  }

  function serial(action) {
    const request=pending.then(action);pending=request.catch(()=>{});return request;
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}

  function getChildren(node) {
    if (!snapshot) return [];
    if (!node) return snapshot.coroutines.flatMap((item,ordinal)=>item.parentOrdinal===undefined?[{kind:'coroutine',ordinal}]:[]);
    const coroutine=snapshot.coroutines[node.ordinal];
    if (!coroutine) return [];
    if (node.kind==='coroutine') {
      const children=Object.keys(KINDS).map(stack=>({kind:'stack',ordinal:node.ordinal,stack}));
      if (childrenByParent.has(node.ordinal)) children.push({kind:'children',ordinal:node.ordinal});
      if (coroutine.debugFrame) children.unshift({kind:'debug',ordinal:node.ordinal,capture:snapshot.debugCapture});
      return children;
    }
    if (node.kind==='children') return (childrenByParent.get(node.ordinal)||[]).map(ordinal=>({kind:'coroutine',ordinal}));
    if (node.kind==='stack' && KINDS[node.stack]) return coroutine[node.stack].map((_,frame)=>({kind:'frame',ordinal:node.ordinal,stack:node.stack,frame}));
    return [];
  }

  function getTreeItem(node) {
    const coroutine=snapshot?.coroutines[node.ordinal];
    if (!coroutine) return new vscode.TreeItem('Snapshot changed');
    if (node.kind==='coroutine') {
      const item=new vscode.TreeItem(coroutine.name||'Unnamed coroutine',vscode.TreeItemCollapsibleState.Collapsed);
      item.description=coroutine.state;
      if (coroutine.jobRelationship==='parent-outside-capture') item.tooltip='Parent job is outside this capture.';
      return item;
    }
    if (node.kind==='children') {
      const count=childrenByParent.get(node.ordinal)?.length||0;
      const item=new vscode.TreeItem('Observed child coroutines',count?vscode.TreeItemCollapsibleState.Expanded:vscode.TreeItemCollapsibleState.None);
      item.description=String(count);
      return item;
    }
    if (node.kind==='debug') {
      if (!coroutine.debugFrame || node.capture!==snapshot.debugCapture) return new vscode.TreeItem('Coroutine capture expired');
      const item=new vscode.TreeItem('Debug when this coroutine resumes');
      item.description=coroutine.debugFrame.file+':'+coroutine.debugFrame.line;
      item.command={command:COMMANDS.watchFrame,title:'Debug Selected Kotlin Coroutine',arguments:[{
        ordinal:node.ordinal,capture:node.capture
      }]};
      return item;
    }
    const frames=coroutine[node.stack] || [];
    if (node.kind==='stack') {
      const item=new vscode.TreeItem(KINDS[node.stack],frames.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      if (!frames.length) item.description='No frames';
      if (node.stack==='observed') item.tooltip='A running coroutine can show its last resume point.';
      return item;
    }
    const frame=frames[node.frame];
    if (!frame) return new vscode.TreeItem('Frame expired');
    const item=new vscode.TreeItem(frame.className+'.'+frame.method);
    item.description=frame.file+(frame.line>0 ? ':'+frame.line : '');
    if (SOURCE.test(frame.file) && frame.line>0) {
      item.command={command:COMMANDS.openFrame,title:'Open coroutine source frame',arguments:[{
        ordinal:node.ordinal,stack:node.stack,index:node.frame,capturedAt:snapshot.capturedAt
      }]};
    }
    return item;
  }

  const tree=vscode.window.createTreeView(VIEW,{treeDataProvider:{getChildren,getTreeItem,onDidChangeTreeData:changed.event},showCollapseAll:true});
  subscriptions.push(tree);
  const debuggerController=coroutineDebugger(vscode,java,{
    trusted, resolveSource:reviewSource, reveal:revealDebugFrame,
    report:message=>{if(!disposed&&snapshot)tree.message=message;}
  });

  function showSnapshot(next) {
    snapshot=next;
    childrenByParent=new Map();
    next?.coroutines.forEach(({parentOrdinal},ordinal)=>{
      if (parentOrdinal===undefined) return;
      if (!childrenByParent.has(parentOrdinal)) childrenByParent.set(parentOrdinal,[]);
      childrenByParent.get(parentOrdinal).push(ordinal);
    });
    tree.description=next ? 'PID '+next.pid+' · '+new Date(next.capturedAt).toLocaleTimeString() : undefined;
    tree.message=!next ? undefined : !next.coroutines.length ? 'No live coroutines in this snapshot.'
      : next.truncated ? 'Showing the first 100 coroutines.' : !next.creationEnabled ? 'Creation stacks are disabled in this JVM.' : undefined;
    changed.fire(undefined);
    return next && structuredClone(next);
  }

  function prepare({debugJar,allowProbeWrites,debugPort}={}) {
    return serial(async()=>{
      trusted();
      const settings=vscode.workspace.getConfiguration('rocketbrain.java');
      const result=await prepareCoroutineProbe({debugJar,allowProbeWrites,debugPort,workspaceTrusted:vscode.workspace.isTrusted,
        javaHome:settings.get('javaHome')||java.getState().javaHome,storageRoot:await fs.realpath(os.tmpdir())});
      trusted();
      prepared=result;
      return structuredClone(result);
    });
  }

  function connect({descriptorFile}={}) {
    const generation=epoch;
    return serial(async()=>{
      trusted();
      const selected=await readCoroutineDescriptor(descriptorFile);
      const result=await fetchCoroutineSnapshot(selected);
      trusted();
      if (generation!==epoch) throw fail('The coroutine connection was cancelled.');
      session=selected;
      return showSnapshot(result);
    });
  }

  function refresh() {
    const generation=epoch;
    return serial(async()=>{
      trusted();
      if (!session) throw fail('Connect to the active local coroutine probe first.');
      try {
        const result=await fetchCoroutineSnapshot(session);
        trusted();
        if (generation!==epoch) throw fail('The coroutine connection was cancelled.');
        return showSnapshot(result);
      } catch (error) {
        if (generation===epoch) showSnapshot(undefined);
        throw error;
      }
    });
  }

  function disconnect() {
    epoch++;
    session=undefined;
    showSnapshot(undefined);
    debugCleanup=debuggerController.detach();
    void debugCleanup.catch(error=>{if(!disposed)void vscode.window.showErrorMessage(error.message);});
    return {state:'disconnected'};
  }

  async function openFrame({ordinal,stack,index,capturedAt}={}) {
    trusted();
    if (!snapshot || capturedAt && capturedAt!==snapshot.capturedAt || !KINDS[stack] ||
        !Number.isInteger(ordinal) || !Number.isInteger(index)) throw fail('Choose a frame from the current coroutine snapshot.');
    const frame=snapshot.coroutines[ordinal]?.[stack]?.[index];
    if (!frame || !SOURCE.test(frame.file) || frame.line<1) throw fail('This coroutine frame has no source line.');
    const selected=await findFrameSource(frame);
    if (!selected) return undefined;
    trusted();
    workspacePath(selected.uri.fsPath,roots(),{directory:false});
    const l=frame.line-1;
    return vscode.window.showTextDocument(selected.uri,{preview:true,selection:new vscode.Range(l,0,l,0)});
  }

  async function findFrameSource(frame) {
    const at=frame.className.lastIndexOf('.'), packageName=at<0 ? '' : frame.className.slice(0,at);
    const files=await vscode.workspace.findFiles('**/'+frame.file,'**/{build,target,node_modules,.git,.gradle}/**',35);
    const sources=[];
    for (const uri of files.filter(file=>file.scheme==='file' && !file.authority)) {
      const file=workspacePath(uri.fsPath,roots(),{directory:false});
      const stats=await fs.stat(file);
      if (stats.size>512*1024) continue;
      const text=await fs.readFile(file,'utf8');
      const declared=/^\s*package\s+([\p{L}_][\p{L}\p{N}_.]*)\s*(?:;|$)/mu.exec(text)?.[1] || '';
      if (declared===packageName && frame.line<=text.split(/\r?\n/).length) sources.push({label:path.basename(file),description:file,uri});
    }
    if (!sources.length) throw fail('No opened workspace source matches this coroutine frame and package.');
    return sources.length===1 ? sources[0] : vscode.window.showQuickPick(sources,{title:'Select Coroutine Source File'});
  }

  async function reviewSource(frame) {
    const selected=await findFrameSource(frame);
    if (!selected) return;
    trusted();
    const file=workspacePath(selected.uri.fsPath,roots(),{directory:false});
    let root=path.dirname(file);
    const parts=frame.className.split('.').slice(0,-1);
    for (const part of parts.reverse()) {
      if (path.basename(root)!==part) throw fail('Use the saved Kotlin source under its matching package directory.');
      root=path.dirname(root);
    }
    const document=await vscode.workspace.openTextDocument(selected.uri);
    const bytes=await fs.readFile(file);
    if (document.isDirty || bytes.length>512*1024) throw fail('Save the bounded Kotlin source before reviewing its debug frame.');
    return {uri:selected.uri,root,folder:vscode.workspace.getWorkspaceFolder(selected.uri),
      digest:createHash('sha256').update(bytes).digest('hex')};
  }

  async function revealDebugFrame(source, frame, fresh) {
    trusted();
    if (!fresh() || vscode.debug.activeDebugSession?.id!==frame.sessionId) return;
    const file=workspacePath(source.uri.fsPath,roots(),{directory:false});
    const document=await vscode.workspace.openTextDocument(source.uri);
    const bytes=await fs.readFile(file);
    if(document.isDirty || bytes.length>512*1024 || createHash('sha256').update(bytes).digest('hex')!==source.digest ||
        frame.line>document.lineCount) throw fail('The selected Kotlin source changed after the watch was armed.');
    if (!fresh() || vscode.debug.activeDebugSession?.id!==frame.sessionId) return;
    const line=frame.line-1;
    await vscode.window.showTextDocument(document,{preview:true,selection:new vscode.Range(line,0,line,0)});
  }

  function watchFrame({ordinal,capture}={}) {
    const generation=epoch;
    return serial(async()=>{
      trusted();
      const selected=snapshot, descriptor=session;
      const debugFrame=Number.isInteger(ordinal)&&selected?.coroutines[ordinal]?.debugFrame;
      if (!descriptor?.debugPort || !capture || capture!==selected?.debugCapture || !debugFrame) {
        throw fail('Refresh the opted-in probe and select a supported parked Kotlin coroutine.');
      }
      return debuggerController.watchFrame(descriptor,capture,ordinal,debugFrame,()=>{
        trusted();
        if(epoch!==generation||session!==descriptor||snapshot!==selected) throw fail('The Kotlin debug snapshot changed.');
      });
    });
  }

  function register(id,handler) {
    subscriptions.push(vscode.commands.registerCommand(id,async (...args)=>{
      try {trusted();return await handler(...args);}
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain coroutines: '+error.message);return undefined;}
    }));
  }

  async function choosePreparation(debugPort) {
    const files=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectMany:false,filters:{'Coroutines debug JAR':['jar']},
      title:'Choose kotlinx-coroutines-debug 1.11.0'});
    if (files?.[0].scheme!=='file') return;
    const result=await prepare({debugJar:files[0].fsPath,allowProbeWrites:true,debugPort});
    const copy=await vscode.window.showInformationMessage('Coroutine probe prepared. Add its VM arguments to a JVM launch.','Copy VM Arguments');
    if (copy) await vscode.env.clipboard.writeText(JSON.stringify(result.vmArgs,null,2));
    return result;
  }
  register(COMMANDS.prepare,()=>choosePreparation());
  register(COMMANDS.prepareDebug,async()=>{
    const port=await vscode.window.showInputBox({title:'Prepare Kotlin Coroutine Debug Attach',
      prompt:'Choose an unused TCP port on IPv4 loopback for the JVM launch',
      validateInput:value=>/^[1-9][0-9]{0,4}$/.test(value)&&Number(value)<=65535?undefined:'Use a port from 1 to 65535.'});
    if (port!==undefined) return choosePreparation(Number(port));
  });
  register(COMMANDS.connect,async()=>{
    const files=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectMany:false,filters:{'Coroutine probe':['json']},
      ...(prepared ? {defaultUri:vscode.Uri.file(path.dirname(prepared.descriptor))} : {}),title:'Open Local Coroutine Probe Descriptor'});
    if (files?.[0].scheme!=='file') return;
    return connect({descriptorFile:files[0].fsPath});
  });
  register(COMMANDS.refresh,refresh);
  register(COMMANDS.disconnect,disconnect);
  register(COMMANDS.openFrame,openFrame);
  register(COMMANDS.watchFrame,async selected=>{
    if (!selected) {
      const current=snapshot;
      const choices=current?.coroutines.flatMap((item,ordinal)=>item.debugFrame?[{
        label:item.name,description:item.debugFrame.file+':'+item.debugFrame.line,
        detail:'Coroutine '+item.debugFrame.sequence,
        ordinal,capture:current.debugCapture
      }]:[])||[];
      if(!choices.length)throw fail('Connect to an opted-in probe with a supported parked Kotlin coroutine.');
      selected=await vscode.window.showQuickPick(choices,{title:'Debug a Parked Kotlin Coroutine'});
    }
    if(selected)return watchFrame(selected);
  });
  register(COMMANDS.detachDebugger,()=>debuggerController.detach());

  return {prepare,connect,refresh,disconnect,openFrame,watchFrame,detachDebugger:()=>debuggerController.detach(),
    getDebugFrame:()=>{const frame=debuggerController.getFrame();return frame&&structuredClone(frame);},
    getSnapshot:()=>snapshot && structuredClone(snapshot),async dispose() {
    if (disposed) return;
    disposed=true;
    disconnect();
    await pending;
    await debugCleanup.catch(()=>{});
    await debuggerController.dispose();
    for (const item of subscriptions) item.dispose();
  }};
}

module.exports={registerKotlinCoroutines,COMMANDS,VIEW};
