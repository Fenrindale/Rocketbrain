'use strict';

const path = require('node:path');
const { kotlinEditorLaunch,kotlinBuildTool,kotlinProjectRoot,kotlinProtocolUri,isMavenClasspathFile,validateMavenComponent } = require('./kotlin-editor-runtime');
const { inside,workspacePath,workspaceRoots,fail } = require('./workbench-model');
const {registerSourceFormatting} = require('./format-vscode');
const {kotlinFormatterOptions,buildKotlinFormatEdits} = require('./kotlin-format-edits');
const {registerKotlinRename} = require('./kotlin-rename-vscode');
const {registerKotlinNullability} = require('./kotlin-nullability-vscode');
const {createKotlinEditorScope}=require('./kotlin-editor-scope');
const {isReactorComponent,reviewKotlinReactor,prepareKotlinReactor} = require('./kotlin-maven-reactor');

const COMMANDS={start:'rocketbrain.kotlinEditor.start',stop:'rocketbrain.kotlinEditor.stop',output:'rocketbrain.kotlinEditor.output',reactor:'rocketbrain.kotlinEditor.startMavenReactor'};

function registerKotlinEditor(context,vscode,java) {
  const output=vscode.window.createOutputChannel('Rocketbrain Kotlin Editor',{log:true});
  const subscriptions=[output];
  const reactorReviews=new WeakMap();
  let state={state:'stopped'}, active, preparation, closing, disposed=false, suspended=false, pending=Promise.resolve();

  function serial(action) {
    const task=pending.then(action,action);
    pending=task.catch(()=>{});
    return task;
  }

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust the local workspace before starting Kotlin editing.');
  }

  function roots() {return workspaceRoots(vscode.workspace.workspaceFolders||[]);}

  function containing(folder) {
    return roots().filter(root=>inside(root,folder)).sort((a,b)=>b.length-a.length)[0];
  }

  const dirty = file => vscode.workspace.textDocuments.some(document=>document.uri.scheme==='file' && !document.isClosed &&
    document.isDirty && !path.relative(file,document.uri.fsPath));

  function projectOf(document) {
    if (!document || document.languageId!=='kotlin' || document.uri.scheme!=='file' || document.uri.authority) return undefined;
    const boundary=roots();
    const source=workspacePath(document.uri.fsPath,boundary,{directory:false});
    const outer=boundary.filter(root => inside(root,source)).sort((a,b)=>b.length-a.length)[0];
    if (!outer) return undefined;
    return kotlinProjectRoot(source,outer);
  }

  function report(next,details={}) {
    state={state:next,...details};
    if (details.message) output.appendLine(details.message);
    return {...state};
  }

  async function release(record) {
    if (record.released) return record.released;
    record.stopping=true;
    record.released=(async () => {
      try {if (record.client) await record.client.stop(5000);}
      catch (error) {output.appendLine('Kotlin language-server shutdown: '+error.message);}
      finally {
        record.watcher?.dispose();
        record.reactorWatcher?.dispose();
        try {await record.launch.dispose();}
        finally {await record.reactor?.dispose();}
      }
    })();
    return record.released;
  }

  async function stopNow() {
    const record=active;
    active=undefined;
    nullability.clear();
    try {if (record) await release(record);}
    catch (error) {report('error',{message:error.message});throw error;}
    return report('stopped');
  }

  async function startNow(root,reactor) {
    trusted();
    const settings=vscode.workspace.getConfiguration('rocketbrain.kotlinEditor');
    const serverHome=settings.get('serverHome');
    if (!serverHome) throw fail('Configure the extracted open ktlsp server in rocketbrain.kotlinEditor.serverHome.');
    if (!root) throw fail('Open a Kotlin source file in a local Gradle or Maven project first.');
    const buildTool=kotlinBuildTool(root);
    if (!reactor && active && !path.relative(active.launch.root,root) && active.launch.buildTool===buildTool && state.state==='running') return {...state};
    if (!reactor && buildTool==='maven' && isReactorComponent(root,containing(root))) {
      throw fail('Use Start Kotlin Maven Reactor to review and prepare this module’s dependencies.');
    }
    if (active) await stopNow();
    const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
    report('starting',{message:'Starting Rocketbrain Kotlin editing for '+path.basename(root)+'.'});
    let record, timeout;
    try {
      const launch=await kotlinEditorLaunch({serverHome,root,
        javaHome:javaSettings.get('javaHome')||java.getState().javaHome,gradleHome:javaSettings.get('gradleHome'),
        mavenHome:javaSettings.get('mavenHome'),
        gradleUserHome:settings.get('gradleUserHome'),storageRoot:(context.storageUri||context.globalStorageUri).fsPath,reactor});
      record={launch,reactor};
      active=record;
      trusted();
      if (suspended) throw fail('Kotlin editing was stopped while its server was preparing.');
      const uri=vscode.Uri.file(launch.root), folder=vscode.workspace.getWorkspaceFolder(uri);
      if (!folder) throw fail('Keep the Kotlin project inside an open workspace.');
      const scope={uri,name:path.basename(launch.root),index:folder.index};
      const selected=createKotlinEditorScope(launch.root,()=>active===record&&!record.stopping&&vscode.workspace.isTrusted);
      const { LanguageClient,ErrorAction,CloseAction }=require('vscode-languageclient/node');
      const files=launch.buildTool==='maven'
        ? '**/{*.kt,*.kts,*.java,pom.xml,build.gradle,build.gradle.kts,kls-classpath*,kotlinLspClasspath*}'
        : '**/{*.kt,*.kts,build.gradle,settings.gradle,gradle.properties}';
      record.watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope,files));
      if (reactor) watchReactor(record);
      record.client=new LanguageClient('rocketbrain-kotlin-editor','Rocketbrain Kotlin Editor',
        {command:launch.command,args:launch.args,options:launch.options},{
          workspaceFolder:scope,outputChannel:output,
          documentSelector:[{scheme:'file',language:'kotlin',pattern:new vscode.RelativePattern(scope,'**/*.kt')}],
          uriConverters:{code2Protocol:uri=>uri.scheme==='file' && !uri.authority ? kotlinProtocolUri(uri.fsPath) : uri.toString(),
            protocol2Code:value=>vscode.Uri.parse(value)},
          synchronize:{fileEvents:record.watcher},markdown:{isTrusted:false},
          middleware:{
            ...selected.middleware,
            provideCompletionItem:selected.request,
            provideHover:selected.request,
            provideSignatureHelp:selected.request,
            provideDefinition:selected.request,
            provideReferences:selected.request,
            provideCodeActions:selected.request,
            provideCodeLenses:selected.request,
            provideFoldingRanges:selected.request,
            provideDocumentSemanticTokens:selected.request,
            provideDocumentRangeSemanticTokens:selected.request,
            provideInlayHints(document,range,token,next) {
              if (!selected.available(document)) return undefined;
              return java.codeHints?.available(document)?[]:next(document,range,token);
            },
            provideDocumentSymbols(document,token,next) {
              if (!selected.available(document)) return undefined;
              return java.structure.outline(document,token,next);
            },
            provideDocumentFormattingEdits(document,options,token,next) {
              if (!selected.available(document)) return undefined;
              return formatting.native(document,undefined,options,token,()=>next(document,options,token));
            },
            provideDocumentRangeFormattingEdits(document,range,options,token,next) {
              if (!selected.available(document)) return undefined;
              return formatting.native(document,range,options,token,()=>next(document,range,options,token));
            },
            workspace:{
              handleApplyEdit:() => ({applied:false,failureReason:'Apply Kotlin editor changes through the VS Code action that initiated them.'}),
              async didChangeWatchedFile(event,next) {
                const uri=vscode.Uri.parse(event.uri);
                if (active!==record || !vscode.workspace.isTrusted || !selected.owns(uri,true)) return;
                if (launch.buildTool==='maven' && isMavenClasspathFile(path.basename(uri.fsPath))) {
                  if (record.reactor && path.basename(uri.fsPath)==='pom.xml') return;
                  try {await validateMavenComponent(launch.root);}
                  catch (error) {
                    void serial(async()=>{
                      if (active!==record) return;
                      await stopNow();
                      report('error',{message:'Kotlin Maven project changed. '+error.message});
                    }).catch(failure=>output.appendLine(failure.message));
                    return;
                  }
                }
                if (active===record) await next(event);
              }
            }
          },
          errorHandler:{error:()=>({action:ErrorAction.Shutdown}),closed:()=>{
            if (active===record && !record.stopping) {
              active=undefined;
              nullability.clear();
              report('error',{message:'The Kotlin language server exited. Check the Rocketbrain Kotlin Editor output.'});
              void release(record).catch(error=>output.appendLine(error.message));
            }
            return {action:CloseAction.DoNotRestart};
          }}
        });
      await Promise.race([record.client.start(),new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(fail('Kotlin editor startup timed out. Check its Output channel.')),90000);
      })]);
      trusted();
      if (suspended || active!==record) throw fail('Kotlin editing stopped during startup.');
      await record.client.sendNotification('workspace/didChangeConfiguration',{settings:{
        kotlin:{inlayHints:{typeHints:true,parameterHints:true,chainedHints:false}}
      }});
      const running=report('running',{projectUri:uri.toString(),buildTool:launch.buildTool,serverVersion:launch.serverVersion,
        compilerVersion:launch.compilerVersion,windowsPathAdapter:launch.windowsPathAdapter,
        ...(reactor&&{reactor:{module:reactor.module,dependencies:reactor.dependencies,repository:reactor.repository}}),
        message:'Kotlin language features are connected.'});
      java.codeHints?.refresh();
      return running;
    } catch (error) {
      if (active===record) active=undefined;
      if (record) await release(record);
      report('error',{message:error.message});
      throw error;
    } finally {clearTimeout(timeout);}
  }

  function start({projectUri,document=vscode.window.activeTextEditor?.document}={}) {
    suspended=false;
    return serial(() => {
      trusted();
      const root=projectUri ? workspacePath(projectUri,roots()) : projectOf(document);
      return startNow(root);
    });
  }

  function stop() {suspended=true;preparation?.abort();return serial(stopNow);}

  function reactorPlan(document) {
    trusted();
    const project=projectOf(document),workspace=project&&containing(project);
    if (!project||!workspace||kotlinBuildTool(project)!=='maven') throw fail('Open a Kotlin source in a Maven reactor module first.');
    if (!vscode.workspace.getConfiguration('rocketbrain.kotlinEditor').get('serverHome')) {
      throw fail('Configure the extracted open ktlsp server before starting a Kotlin Maven reactor.');
    }
    const javaSettings=vscode.workspace.getConfiguration('rocketbrain.java');
    return reviewKotlinReactor({project,workspace,dirty,tools:{javaHome:javaSettings.get('javaHome')||java.getState().javaHome,
      mavenHome:javaSettings.get('mavenHome')}});
  }

  function reviewReactor({document=vscode.window.activeTextEditor?.document}={}) {
    const plan=reactorPlan(document),review=Object.freeze(structuredClone(plan.report));
    reactorReviews.set(review,{document,fingerprint:plan.fingerprint,expires:Date.now()+120000});
    return review;
  }

  function startReactor(review,{allowProjectExecution,cancellation}={}) {
    if (allowProjectExecution!==true) return Promise.reject(fail('Approve the reviewed Maven dependency build before starting Kotlin editing.'));
    const saved=reactorReviews.get(review);
    if (!saved||saved.expires<Date.now()) return Promise.reject(fail('Review the current Kotlin Maven module dependencies again.'));
    reactorReviews.delete(review);
    suspended=false;
    return serial(async()=>{
      const plan=reactorPlan(saved.document);
      if (plan.fingerprint!==saved.fingerprint||suspended) throw fail('The reviewed Maven reactor changed. Review its dependencies again.');
      const controller=new AbortController();
      const cancel=cancellation?.onCancellationRequested(()=>controller.abort());
      if (cancellation?.isCancellationRequested) controller.abort();
      preparation=controller;
      let prepared;
      try {
        output.appendLine('Preparing Kotlin Maven module '+plan.report.module+' using '+plan.report.steps.join(', ')+'.');
        prepared=await prepareKotlinReactor(plan,{cancellation:controller.signal,onOutput:text=>output.append(text)});
        if (controller.signal.aborted||suspended||reactorPlan(saved.document).fingerprint!==plan.fingerprint) {
          throw fail('The Maven reactor changed during preparation. Review its dependencies again.');
        }
        return await startNow(plan.report.project,prepared);
      } catch (error) {
        await prepared?.dispose();
        throw error;
      } finally {
        preparation=undefined;
        cancel?.dispose();
      }
    });
  }

  function watchReactor(record) {
    const reactor=record.reactor;
    const scope={uri:vscode.Uri.file(reactor.root),name:path.basename(reactor.root),index:0};
    const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(scope,
      '**/{pom.xml,maven.config,jvm.config,extensions.xml,*.kt,*.java}'));
    record.reactorWatcher=watcher;
    const react=uri=>{
      if (active!==record) return;
      const file=uri.fsPath;
      const descriptor=[...reactor.watched.keys()].some(item=>!path.relative(item,file));
      const dependency=reactor.dependencies.some(item=>inside(path.join(item.directory,'src'),file));
      if (!descriptor&&!dependency) return;
      void serial(async()=>{
        if (active!==record) return;
        await stopNow();
        report('stopped',{message:'The Kotlin Maven reactor changed. Review and prepare its dependencies again.'});
      }).catch(failure=>output.appendLine(failure.message));
    };
    watcher.onDidCreate(react);
    watcher.onDidDelete(react);
    watcher.onDidChange(react);
  }

  async function chooseReactor() {
    const review=reviewReactor();
    const choice=await vscode.window.showWarningMessage('Prepare Kotlin editing for '+review.module+'?',{modal:true,
      detail:'Maven install will run the following reactor modules and use an editor-owned local repository.\n'+
        review.steps.join(', ')+'\n'+review.dependencies.map(item=>item.coordinates).join('\n')+'\n'+review.root},'Build Dependencies and Start');
    if (choice!=='Build Dependencies and Start') return;
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Preparing Kotlin Maven reactor',cancellable:true},
      (_progress,cancellation)=>startReactor(review,{allowProjectExecution:true,cancellation}));
  }

  const formatting=registerSourceFormatting(vscode,{language:'kotlin',name:'Kotlin',commandId:'rocketbrain.kotlinEditor.previewFormatting',
    start:document=>start({document}),refactoring:java.refactoring,output,buildEdits:buildKotlinFormatEdits,engineOptions:kotlinFormatterOptions,
    request:async (method,params,cancellation,document) => {
      trusted();
      const record=active,root=projectOf(document);
      if (!record||!root||state.state!=='running'||path.relative(record.launch.root,root)||cancellation?.isCancellationRequested) {
        throw fail('Start Kotlin editing for the current project.');
      }
      const capability=params.range?'documentRangeFormattingProvider':'documentFormattingProvider';
      if (!record.client.initializeResult?.capabilities?.[capability]) throw fail('The Kotlin provider does not support this formatting mode.');
      const edits=await record.client.sendRequest(method,{...params,textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)}},...(cancellation?[cancellation]:[]));
      trusted();
      if (active!==record) throw fail('The Kotlin formatter server changed during formatting.');
      return edits;
    }});
  subscriptions.push(formatting);

  async function documentSymbols(document,token) {
    trusted();
    const record=active,root=projectOf(document);
    if (!record?.client?.isRunning()||!root||path.relative(record.launch.root,root)||token?.isCancellationRequested) {
      throw fail('Start Kotlin editing for the current project.');
    }
    const symbols=await record.client.sendRequest('textDocument/documentSymbol',{
      textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)}
    },token);
    trusted();
    if (active!==record) throw fail('The Kotlin language server changed during file structure lookup.');
    return symbols;
  }

  async function selectionRanges(document,positions,token) {
    await start({document});
    trusted();
    const record=active,root=projectOf(document);
    if (!record?.client?.isRunning()||!root||path.relative(record.launch.root,root)||token?.isCancellationRequested) {
      throw fail('Start Kotlin editing for the current project.');
    }
    if (!record.client.initializeResult?.capabilities?.selectionRangeProvider) return undefined;
    const response=await record.client.sendRequest('textDocument/selectionRange',{
      textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)},positions
    },token);
    if (active!==record) throw fail('The Kotlin language server changed during selection.');
    return response;
  }

  async function codeInformation(document,position,{method,capability},token) {
    await start({document});
    trusted();
    const record=active,root=projectOf(document);
    if(!['textDocument/hover','textDocument/signatureHelp'].includes(method)||
        !record?.client?.isRunning()||!root||path.relative(record.launch.root,root)||token?.isCancellationRequested) {
      throw fail('Start Kotlin editing for the current project.');
    }
    if(!record.client.initializeResult?.capabilities?.[capability])throw fail('The configured Kotlin provider does not supply this code information.');
    const response=await record.client.sendRequest(method,{textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)},position},token);
    if(active!==record)throw fail('The Kotlin server changed. Request code information again.');
    return response;
  }

  async function inlayHints(document,range,token) {
    const record=active,root=record&&projectOf(document);
    if(!vscode.workspace.isTrusted||!record?.client?.isRunning()||state.state!=='running'||!root||
        path.relative(record.launch.root,root)||token.isCancellationRequested)return [];
    const response=await record.client.sendRequest('textDocument/inlayHint',{
      textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)},range
    },token);
    return active===record?response:[];
  }

  async function sourceRequest(method,document,position,context,cancellation) {
    trusted();
    const current=active,root=projectOf(document);
    if (!current||!root||state.state!=='running'||path.relative(current.launch.root,root)||cancellation?.isCancellationRequested) {
      throw fail('Start Kotlin editing for the current project.');
    }
    if (method==='textDocument/references' && !current.client.initializeResult?.capabilities?.referencesProvider) {
      throw fail('The connected Kotlin language server does not offer semantic references.');
    }
    const locations=await current.client.sendRequest(method,{
      textDocument:{uri:kotlinProtocolUri(document.uri.fsPath)},position,...(context?{context}:{})
    },...(cancellation?[cancellation]:[]));
    trusted();
    if (active!==current) throw fail('The Kotlin language server changed during navigation.');
    return locations;
  }

  const definition=(document,position,cancellation)=>sourceRequest('textDocument/definition',document,position,null,cancellation);
  const references=(document,position,includeDeclaration,cancellation)=>sourceRequest('textDocument/references',
    document,position,{includeDeclaration:Boolean(includeDeclaration)},cancellation);

  async function beginProjectAnalysis(document,cancellation,feature) {
    await start({document});
    const record = active, root = projectOf(document);
    const check = () => {
      trusted();
      if (!record?.client?.isRunning() || active!==record || !root || state.state!=='running' ||
          path.relative(record.launch.root,root) || cancellation?.isCancellationRequested) {
        throw fail('Keep the Kotlin language server and selected project open during '+feature+'.');
      }
    };
    check();
    const capabilities = record.client.initializeResult?.capabilities;
    if (!capabilities?.definitionProvider || feature==='rename' &&
        (!capabilities.renameProvider?.prepareProvider || !capabilities.referencesProvider)) {
      throw fail('The connected Kotlin language server does not offer semantic '+feature+'.');
    }
    return {root,check,compiler:record.launch.compiler,async classpath(token) {
      check();
      await java.start();
      check();
      const args=[vscode.Uri.file(root).toString(),{scope:'runtime'}];
      const result=await java.requestWorkspaceCommand('java.project.getClasspaths',args,token);
      check();
      return result;
    },async request(method,params,token) {
      check();
      let timer;
      try {
        const response = await Promise.race([
          record.client.sendRequest(method,params,...(token ? [token] : [])),
          new Promise((_,reject)=>{timer=setTimeout(()=>reject(fail('Kotlin '+feature+' analysis timed out. Wait for project indexing and try again.')),30000);})
        ]);
        check();
        return response;
      } finally {clearTimeout(timer);}
    }};
  }

  const rename = registerKotlinRename(vscode,{begin:(document,token)=>beginProjectAnalysis(document,token,'rename'),
    refactoring:java.refactoring,output});
  const nullability = registerKotlinNullability(vscode,{begin:(document,token)=>beginProjectAnalysis(document,token,'nullability'),output});
  subscriptions.push(rename,nullability);

  function automatic(document) {
    if (disposed || suspended || !vscode.workspace.isTrusted || !vscode.workspace.getConfiguration('rocketbrain.kotlinEditor').get('serverHome')) return;
    if (document?.languageId!=='kotlin') return;
    void serial(async () => {
      if (disposed || suspended || !vscode.workspace.isTrusted) return;
      const root=projectOf(document);
      if (root && (kotlinBuildTool(root)==='gradle'||(active && !path.relative(active.launch.root,root)))) await startNow(root);
    }).catch(error=>output.appendLine(error.message));
  }

  subscriptions.push(vscode.commands.registerCommand(COMMANDS.start,async () => {
    try {return await start();}
    catch (error) {void vscode.window.showErrorMessage('Rocketbrain Kotlin: '+error.message);}
  }),vscode.commands.registerCommand(COMMANDS.reactor,async()=>{
    try {return await chooseReactor();}
    catch (error) {void vscode.window.showErrorMessage('Rocketbrain Kotlin: '+error.message);}
  }),vscode.commands.registerCommand(COMMANDS.stop,stop),
  vscode.commands.registerCommand(COMMANDS.output,()=>output.show()),
  vscode.window.onDidChangeActiveTextEditor(editor=>automatic(editor?.document)),
  vscode.workspace.onDidChangeConfiguration(event=>{
    if (!['rocketbrain.kotlinEditor','rocketbrain.java.javaHome','rocketbrain.java.gradleHome','rocketbrain.java.mavenHome'].some(name=>event.affectsConfiguration(name))) return;
    void serial(stopNow).then(()=>automatic(vscode.window.activeTextEditor?.document)).catch(error=>output.appendLine(error.message));
  }),vscode.workspace.onDidChangeWorkspaceFolders(()=>{
    void serial(stopNow).then(()=>automatic(vscode.window.activeTextEditor?.document)).catch(error=>output.appendLine(error.message));
  }));
  automatic(vscode.window.activeTextEditor?.document);

  return {start,stop,reviewReactor,startReactor,definition,references,formatting,rename,
    beginJavaTypeRename:(document,token)=>beginProjectAnalysis(document,token,'Java type rename'),
    nullability,documentSymbols,selectionRanges,codeInformation,inlayHints,getState:()=>({...state}),dispose() {
    if (closing) return closing;
    disposed=true;
    suspended=true;
    preparation?.abort();
    closing=serial(stopNow).finally(()=>{for (const item of subscriptions) item.dispose();});
    return closing;
  }};
}

module.exports={registerKotlinEditor,COMMANDS};
