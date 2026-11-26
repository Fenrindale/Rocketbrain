'use strict';

const path=require('node:path');
const {inspectAngularProject,inside,angularSource}=require('./angular-project');
const {startAngularSession}=require('./angular-lsp');
const {checkAngularProject}=require('./angular-check');

const namespace='rocketbrain.angular';
const sourceFile=/\.(?:ts|html)$/iu;
const checkInput=/\.(?:ts|html|json|jsonc|css|s[ac]ss|less)$/iu;
const ignored=new Set(['node_modules','.git','.angular','dist','coverage','build','target']);

function registerAngularWorkbench(context,vscode,{protocol=()=>require('vscode-languageclient/node')}={}) {
  const diagnostics=vscode.languages.createDiagnosticCollection('rocketbrain-angular');
  const subscriptions=[diagnostics];
  let active,disposed=false,generation=0,serial=Promise.resolve();

  function trusted() {
    if (disposed||!vscode.workspace.isTrusted) throw Error('Trust this local workspace before running Angular analysis.');
  }

  function scoped(file,record=active) {
    return record&&typeof file==='string'&&inside(record.project.root,file)&&
      !path.relative(record.project.root,file).split(path.sep).some(part=>ignored.has(part));
  }

  async function inspect(uri) {
    trusted();
    const folder=uri?.scheme==='file'&&!uri.authority&&vscode.workspace.getWorkspaceFolder(uri);
    if (!folder||folder.uri.scheme!=='file'||folder.uri.authority) throw Error('Select a local Angular project in an open workspace folder.');
    return inspectAngularProject(folder.uri.fsPath,uri.fsPath,
      vscode.workspace.getConfiguration(namespace,uri).get('nodePath'));
  }

  function clearCheck(record) {
    record.check?.abort();
    diagnostics.clear();
  }

  async function release() {
    const previous=active;
    active=undefined;
    if (!previous)return true;
    clearCheck(previous);
    previous.watcher?.dispose();
    return previous.peer.stop();
  }

  function queue(operation) {
    const task=serial.then(operation);
    serial=task.catch(()=>{});
    return task;
  }

  function status() {
    return active?.ready ? {state:'running',projectRoot:active.project.root,angularVersion:active.project.version,
      typescriptVersion:active.project.typescriptVersion,diagnosticsMode:'explicit-saved-template-check',runtimeWritesAllowed:false} : {state:'stopped'};
  }

  async function usable(document,record) {
    return !disposed&&vscode.workspace.isTrusted&&record===active&&record?.ready&&!document?.isClosed&&
      document?.uri.scheme==='file'&&!document.uri.authority&&sourceFile.test(document.uri.fsPath)&&
      scoped(document.uri.fsPath,record)&&!!await angularSource(record.project.root,document.uri.fsPath);
  }

  const snapshot=document=>({file:document.uri.fsPath,version:document.version,text:document.getText()});

  async function update(document,record) {
    if (await usable(document,record)) await record.peer.synchronize(snapshot(document));
  }

  function invalidate(file) {
    const record=active;
    if (!scoped(file,record)||!checkInput.test(file))return;
    record.revision++;
    clearCheck(record);
    if (!path.relative(file,record.project.config)||!path.relative(file,path.join(record.project.root,'package.json'))) {
      void stop().catch(()=>{});
    }
  }

  async function start({uri,allowAnalysis,expectedFingerprint}={}) {
    trusted();
    if (allowAnalysis!==true) throw Error('Review and start the installed Angular tools explicitly.');
    const epoch=++generation;
    return queue(async()=>{
      const project=await inspect(uri);
      if (generation!==epoch) throw Error('The Angular session selection changed.');
      if (expectedFingerprint!==undefined&&project.fingerprint!==expectedFingerprint) {
        throw Error('The selected Angular tools changed after review.');
      }
      if (active?.ready&&active.project.fingerprint===project.fingerprint) return status();
      await release();
      trusted();
      if (generation!==epoch) throw Error('The Angular session selection changed.');
      const record={project,uri,ready:false,revision:0};
      record.peer=startAngularSession(project,protocol(),{onExit(){
        if (active!==record)return;
        active=undefined;
        record.watcher?.dispose();
        clearCheck(record);
      }});
      active=record;
      try {
        await record.peer.ready;
        if (active!==record||generation!==epoch) throw Error('The Angular session changed while starting.');
        record.watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(project.root),
          '**/*.{ts,html,json,jsonc,css,scss,sass,less}'));
        record.watcher.onDidCreate(uri=>invalidate(uri.fsPath));
        record.watcher.onDidChange(uri=>invalidate(uri.fsPath));
        record.watcher.onDidDelete(uri=>invalidate(uri.fsPath));
        record.ready=true;
        for (const document of vscode.workspace.textDocuments.slice(0,48)) {
          if (sourceFile.test(document.uri.fsPath)&&scoped(document.uri.fsPath,record)) {
            await update(document,record).catch(()=>{});
          }
        }
        if (active!==record||generation!==epoch) throw Error('The Angular session changed while starting.');
        return status();
      } catch (error) {
        if(active===record)await release();
        else await record.peer.stop();
        throw error;
      }
    });
  }

  function stop() {
    generation++;
    return queue(async()=>{
      const stopped=await release();
      if(!stopped)throw Error('Angular process termination could not be verified.');
      return status();
    });
  }

  function saved(record) {
    if(vscode.workspace.textDocuments.some(document=>document.isDirty&&document.uri.scheme==='file'&&
        scoped(document.uri.fsPath,record)&&checkInput.test(document.uri.fsPath))) {
      throw Error('Save Angular project changes before checking its templates.');
    }
  }

  async function check({allowAnalysis,cancellation}={}) {
    trusted();
    const record=active;
    if(!record?.ready||allowAnalysis!==true) throw Error('Start reviewed Angular analysis before checking templates.');
    if(record.check)throw Error('An Angular template check is running.');
    saved(record);
    const revision=record.revision, controller=new AbortController();
    const cancel=()=>controller.abort();
    const subscription=cancellation?.onCancellationRequested?.(cancel);
    cancellation?.addEventListener?.('abort',cancel,{once:true});
    if(cancellation?.isCancellationRequested||cancellation?.aborted)cancel();
    record.check=controller;
    try {
      const report=await checkAngularProject(record.project,{cancellation:controller.signal});
      trusted();
      saved(record);
      if(controller.signal.aborted||active!==record||record.revision!==revision) throw Error('Angular source changed while checking templates.');
      const grouped=new Map();
      for(const row of report.diagnostics) {
        const {start,end}=row.range;
        const severity={error:vscode.DiagnosticSeverity.Error,warning:vscode.DiagnosticSeverity.Warning,
          information:vscode.DiagnosticSeverity.Information}[row.severity];
        const diagnostic=new vscode.Diagnostic(new vscode.Range(start.line,start.character,end.line,end.character),row.message,severity);
        diagnostic.source='Rocketbrain Angular';diagnostic.code=row.code;
        if(!grouped.has(row.file))grouped.set(row.file,[]);
        grouped.get(row.file).push(diagnostic);
      }
      diagnostics.clear();
      diagnostics.set([...grouped].map(([file,rows])=>[vscode.Uri.file(file),rows]));
      return report;
    } finally {
      if(record.check===controller)record.check=undefined;
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',cancel);
    }
  }

  async function lookup(kind,document,position,cancellation) {
    const record=active;
    if(!await usable(document,record)||cancellation?.isCancellationRequested)return;
    const revision=record.revision, input=snapshot(document);
    const found=await record.peer[kind](input,{line:position.line,character:position.character},cancellation);
    if(record!==active||revision!==record.revision||document.version!==input.version||document.isClosed||
        cancellation?.isCancellationRequested||!vscode.workspace.isTrusted)return;
    return found;
  }

  function command(name,action) {
    subscriptions.push(vscode.commands.registerCommand(namespace+'.'+name,async()=>{
      try {return await action();}
      catch(error){void vscode.window.showErrorMessage(error.message);}
    }));
  }

  command('start',async()=>{
    let uri=vscode.window.activeTextEditor?.document.uri;
    if(uri?.scheme!=='file'||!vscode.workspace.getWorkspaceFolder(uri)) {
      const folders=(vscode.workspace.workspaceFolders||[]).filter(folder=>folder.uri.scheme==='file'&&!folder.uri.authority);
      const chosen=folders.length===1?folders[0]:(await vscode.window.showQuickPick(
        folders.map(folder=>({label:folder.name,description:folder.uri.fsPath,folder})),{title:'Choose an Angular Project'}))?.folder;
      uri=chosen?.uri;
    }
    if(!uri)return;
    const proposal=await inspect(uri);
    const choice=await vscode.window.showInformationMessage('Start the installed Angular language tools?',
      {modal:true,detail:[proposal.root,proposal.config,proposal.node,
        'Angular '+proposal.version+' · TypeScript '+proposal.typescriptVersion].join('\n')},'Start Analysis');
    if(choice==='Start Analysis')return start({uri,allowAnalysis:true,expectedFingerprint:proposal.fingerprint});
  });
  command('stop',stop);
  command('check',async()=>{
    const report=await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,
      title:'Check Angular Templates',cancellable:true},(_progress,cancellation)=>check({allowAnalysis:true,cancellation}));
    if(report.projectDiagnostics.length) {
      const document=await vscode.workspace.openTextDocument({language:'plaintext',
        content:report.projectDiagnostics.map(row=>row.severity.toUpperCase()+' '+row.code+' '+row.message).join('\n')});
      await vscode.window.showTextDocument(document,{preview:true});
    } else if(report.clean)void vscode.window.showInformationMessage('Angular template check passed.');
    return report;
  });

  const selector=[{scheme:'file',language:'html'},{scheme:'file',language:'typescript'}];
  subscriptions.push(vscode.languages.registerDefinitionProvider(selector,{async provideDefinition(document,position,token) {
    const found=await lookup('definition',document,position,token).catch(()=>undefined);
    return found?.map(({file,range:{start,end}})=>new vscode.Location(vscode.Uri.file(file),
      new vscode.Range(start.line,start.character,end.line,end.character)));
  }}),vscode.languages.registerHoverProvider(selector,{async provideHover(document,position,token) {
    const found=await lookup('hover',document,position,token).catch(()=>undefined);
    if(!found)return;
    const markdown=new vscode.MarkdownString();
    markdown.appendText(found);
    return new vscode.Hover(markdown);
  }}),vscode.workspace.onDidChangeTextDocument(({document})=>{
    const record=active;
    if(document.uri.scheme!=='file'||!scoped(document.uri.fsPath,record))return;
    invalidate(document.uri.fsPath);
    void update(document,record).catch(()=>{});
  }),vscode.workspace.onDidCloseTextDocument(document=>{
    if(document.uri.scheme==='file')void active?.peer.close(document.uri.fsPath).catch(()=>{});
  }),vscode.workspace.onDidChangeWorkspaceFolders(()=>{
    if(active&&!vscode.workspace.getWorkspaceFolder(vscode.Uri.file(active.project.root)))void stop().catch(()=>{});
  }));

  const service={inspect,start,stop,status,check,
    definition:(document,position,cancellation)=>lookup('definition',document,position,cancellation),
    hover:(document,position,cancellation)=>lookup('hover',document,position,cancellation),
    async dispose(){
      if(disposed)return;
      disposed=true;
      try{await stop();}finally{for(const item of subscriptions)item.dispose();}
    }};
  context.subscriptions.push(service);
  return service;
}

module.exports={registerAngularWorkbench};
