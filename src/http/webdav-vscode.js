'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { createWebDavDeployment } = require('./webdav-deploy');

const scheme = 'rocketbrain-webdav-review';
const commandNames = ['reviewWebDav','compareWebDav','applyWebDav','saveWebDavPassword'];

function registerWebDav(context,vscode) {
  let disposed=false;
  const trusted=()=>!disposed && vscode.workspace.isTrusted;
  const core=createWebDavDeployment({isTrusted:trusted});
  const documents=new Map();
  const updates=new vscode.EventEmitter();
  const reviewUri=id=>vscode.Uri.from({scheme,path:`/${id}/Deployment Review.txt`});

  function workspace() {
    if(!trusted())throw Error('Open a trusted workspace before deploying files.');
    const active=vscode.window.activeTextEditor?.document.uri;
    const folder=(active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
    if(folder?.uri.scheme!=='file')throw Error('Open a local workspace folder.');
    const config=vscode.workspace.getConfiguration('rocketbrain.deploy.webdav',folder.uri);
    const url=config.get('url',''), user=config.get('user','');
    if(!url)throw Error('Set the WebDAV directory URL in Rocketbrain settings.');
    const input={url,user,remoteDirectory:config.get('remoteDirectory',''),exclusions:config.get('exclusions',[])};
    const local=config.get('localDirectory','');
    if(local && (path.isAbsolute(local) || /[\\:\x00-\x1f]/.test(local) || local.split('/').some(part=>!part||['.','..'].includes(part)))) {
      throw Error('Set a workspace-relative local directory using slashes.');
    }
    const key=createHash('sha256').update(JSON.stringify([folder.uri.toString(),url,user])).digest('hex');
    input.workspaceRoot=folder.uri.fsPath;
    return {key,root:path.join(folder.uri.fsPath,...(local?local.split('/'):[])),input};
  }

  async function publish(result) {
    if(!trusted())throw Error('Open a trusted workspace to inspect deployment results.');
    while(documents.size>=3)documents.delete(documents.keys().next().value);
    documents.set(result.id,result);
    const uri=reviewUri(result.id);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});
    return uri;
  }

  function current() {
    const uri=vscode.window.activeTextEditor?.document.uri;
    const result=uri?.scheme===scheme && documents.get(uri.path.split('/')[1]);
    if(!result)throw Error('Open a WebDAV deployment review.');
    return result;
  }

  const item = file => ({ label:file.name,description:file.state,file });
  const progress = (title, action) => vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title,cancellable:true},
    async(_,token)=>{
      const controller=new AbortController(), listener=token.onCancellationRequested(()=>controller.abort());
      if(token.isCancellationRequested)controller.abort();
      try {return await action(controller.signal);}
      finally {listener.dispose();}
    });

  async function diff(result,name) {
    const file=core.compare(result.id,name);
    const uri=side=>vscode.Uri.from({scheme,path:`/${result.id}/${side}.text`,query:encodeURIComponent(file.name)});
    await vscode.commands.executeCommand('vscode.diff',uri('remote'),uri('local'),file.name+' · WebDAV Comparison');
    return { remote:uri('remote'), local:uri('local') };
  }

  const subscriptions=[updates,vscode.workspace.registerTextDocumentContentProvider(scheme,{
    onDidChange:updates.event,
    provideTextDocumentContent(uri) {
      if(!trusted())return '';
      const [,id,resource]=uri.path.split('/');
      const record=documents.get(id);
      if(!record)return '';
      if(resource==='remote.text'||resource==='local.text') {
        return core.compare(id,decodeURIComponent(uri.query))[resource.slice(0,-5)];
      }
      return ['WebDAV Deployment Review',record.directory,'',...record.files.map(file=>file.state+' · '+file.name),
        ...(record.receipt?['','Upload Result',...record.receipt.files.map(file=>file.state+' · '+file.name)]:[])].join('\n');
    }
  })];
  function command(name,action) {
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.deploy.'+name,async()=>{
      try {if(!trusted())throw Error('Open a trusted workspace before using WebDAV deployment.');return await action();}
      catch(error){await vscode.window.showErrorMessage(error.message);}
    }));
  }

  command(commandNames[0],async()=>{
    const {key,root,input}=workspace();
    const selected=await vscode.window.showOpenDialog({title:'Choose Local Deployment Files',defaultUri:vscode.Uri.file(root),canSelectMany:true});
    if(!selected?.length)return;
    const files=selected.map(uri=>path.relative(root,uri.fsPath).split(path.sep).join('/'));
    if(selected.some(uri=>uri.scheme!=='file'))throw Error('Choose files in the configured local directory.');
    const password=input.user ? await context.secrets.get('rocketbrain.webdav.'+key) : undefined;
    const result=await progress('Comparing local and WebDAV files',signal=>core.prepare({...input,root,files,password},{signal}));
    return publish(result);
  });
  command(commandNames[1],async()=>{
    const result=current();
    const selected=await vscode.window.showQuickPick(result.files.filter(file=>file.local).map(item),{title:'Choose a WebDAV Compare File'});
    if(selected)await diff(result,selected.file.name);
  });
  command(commandNames[2],async()=>{
    const result=current();
    const candidates=result.files.filter(file=>['create','replace'].includes(file.state)).map(item);
    if(!candidates.length)throw Error('The review has no uploadable changes.');
    const selected=await vscode.window.showQuickPick(candidates,{title:'Choose Reviewed WebDAV Uploads',canPickMany:true});
    if(!selected?.length)return;
    const answer=await vscode.window.showWarningMessage('Upload '+selected.length+' reviewed files to '+result.directory+'?',{modal:true},'Upload');
    if(answer!=='Upload')return;
    const receipt=await progress('Uploading reviewed WebDAV files',signal=>core.apply(result.id,selected.map(value=>value.file.name),{signal}));
    result.receipt=receipt;
    updates.fire(reviewUri(result.id));
    return receipt;
  });
  command(commandNames[3],async()=>{
    const {key,input}=workspace();
    if(!input.user)throw Error('Set the WebDAV username in Rocketbrain settings.');
    const password=await vscode.window.showInputBox({title:'WebDAV Password',password:true,prompt:'Leave empty to clear the saved password'});
    if(password===undefined)return;
    if(workspace().key!==key)throw Error('The WebDAV endpoint changed. Set its password again.');
    if(password.length>2048)throw Error('Use a WebDAV password of at most 2,048 characters.');
    if(password)await context.secrets.store('rocketbrain.webdav.'+key,password);
    else await context.secrets.delete('rocketbrain.webdav.'+key);
  });
  return {...core,publish,diff,dispose(){disposed=true;documents.clear();core.dispose();for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={registerWebDav};
