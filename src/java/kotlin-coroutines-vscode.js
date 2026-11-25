'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareCoroutineProbe,readCoroutineDescriptor,fetchCoroutineSnapshot } = require('./kotlin-coroutine-probe');
const { workspacePath,workspaceRoots,fail } = require('./workbench-model');

const VIEW='rocketbrain.kotlinCoroutines';
const COMMANDS={prepare:'rocketbrain.coroutines.prepare',connect:'rocketbrain.coroutines.connect',
  refresh:'rocketbrain.coroutines.refresh',disconnect:'rocketbrain.coroutines.disconnect',openFrame:'rocketbrain.coroutines.openFrame'};
const KINDS={observed:'Last observed stack',creation:'Creation stack'};
const SOURCE=/^[\p{L}\p{N}_][\p{L}\p{N}_.-]{0,150}\.(?:kt|java)$/u;

function registerKotlinCoroutines(vscode,java) {
  const changed=new vscode.EventEmitter();
  let session,snapshot,prepared,epoch=0,disposed=false,pending=Promise.resolve();
  const subscriptions=[changed];

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust this workspace to inspect a local Kotlin JVM.');
  }

  function serial(action) {
    const request=pending.then(action);pending=request.catch(()=>{});return request;
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}

  function getChildren(node) {
    if (!snapshot) return [];
    if (!node) return snapshot.coroutines.map((_,ordinal)=>({kind:'coroutine',ordinal}));
    const coroutine=snapshot.coroutines[node.ordinal];
    if (!coroutine) return [];
    if (node.kind==='coroutine') return Object.keys(KINDS).map(stack=>({kind:'stack',ordinal:node.ordinal,stack}));
    if (node.kind==='stack' && KINDS[node.stack]) return coroutine[node.stack].map((_,frame)=>({kind:'frame',ordinal:node.ordinal,stack:node.stack,frame}));
    return [];
  }

  function getTreeItem(node) {
    const coroutine=snapshot?.coroutines[node.ordinal];
    if (!coroutine) return new vscode.TreeItem('Snapshot changed');
    if (node.kind==='coroutine') {
      const item=new vscode.TreeItem(coroutine.name||'Unnamed coroutine',vscode.TreeItemCollapsibleState.Collapsed);
      item.description=coroutine.state;
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

  function showSnapshot(next) {
    snapshot=next;
    tree.description=next ? 'PID '+next.pid+' · '+new Date(next.capturedAt).toLocaleTimeString() : undefined;
    tree.message=!next ? undefined : !next.coroutines.length ? 'No live coroutines in this snapshot.'
      : next.truncated ? 'Showing the first 100 coroutines.' : !next.creationEnabled ? 'Creation stacks are disabled in this JVM.' : undefined;
    changed.fire(undefined);
    return next && structuredClone(next);
  }

  function prepare({debugJar,allowProbeWrites}={}) {
    return serial(async()=>{
      trusted();
      const settings=vscode.workspace.getConfiguration('rocketbrain.java');
      const result=await prepareCoroutineProbe({debugJar,allowProbeWrites,workspaceTrusted:vscode.workspace.isTrusted,
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
    return {state:'disconnected'};
  }

  async function openFrame({ordinal,stack,index,capturedAt}={}) {
    trusted();
    if (!snapshot || capturedAt && capturedAt!==snapshot.capturedAt || !KINDS[stack] ||
        !Number.isInteger(ordinal) || !Number.isInteger(index)) throw fail('Choose a frame from the current coroutine snapshot.');
    const frame=snapshot.coroutines[ordinal]?.[stack]?.[index];
    if (!frame || !SOURCE.test(frame.file) || frame.line<1) throw fail('This coroutine frame has no source line.');
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
    const selected=sources.length===1 ? sources[0] : await vscode.window.showQuickPick(sources,{title:'Select Coroutine Source File'});
    if (!selected) return undefined;
    trusted();
    workspacePath(selected.uri.fsPath,roots(),{directory:false});
    const l=frame.line-1;
    return vscode.window.showTextDocument(selected.uri,{preview:true,selection:new vscode.Range(l,0,l,0)});
  }

  function register(id,handler) {
    subscriptions.push(vscode.commands.registerCommand(id,async (...args)=>{
      try {trusted();return await handler(...args);}
      catch (error) {void vscode.window.showErrorMessage('Rocketbrain coroutines: '+error.message);return undefined;}
    }));
  }

  register(COMMANDS.prepare,async()=>{
    const files=await vscode.window.showOpenDialog({canSelectFiles:true,canSelectMany:false,filters:{'Coroutines debug JAR':['jar']},
      title:'Choose kotlinx-coroutines-debug 1.11.0'});
    if (files?.[0].scheme!=='file') return;
    const result=await prepare({debugJar:files[0].fsPath,allowProbeWrites:true});
    const copy=await vscode.window.showInformationMessage('Coroutine probe prepared. Add its VM arguments to a JVM launch.','Copy VM Arguments');
    if (copy) await vscode.env.clipboard.writeText(JSON.stringify(result.vmArgs,null,2));
    return result;
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

  return {prepare,connect,refresh,disconnect,openFrame,getSnapshot:()=>snapshot && structuredClone(snapshot),async dispose() {
    if (disposed) return;
    disposed=true;
    disconnect();
    await pending;
    for (const item of subscriptions) item.dispose();
  }};
}

module.exports={registerKotlinCoroutines,COMMANDS,VIEW};
