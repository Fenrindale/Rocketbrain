'use strict';

const {createHash,randomUUID}=require('node:crypto');
const {createReviewClient,reviewProfile,patchTargetLines}=require('./code-review');

const scheme='rocketbrain-code-review';
const storeKey='rocketbrain.codeReview.drafts.v1';

function registerCodeReview(context,vscode) {
  let disposed=false, writes=Promise.resolve();
  const documents=new Map();
  const updates=new vscode.EventEmitter();

  function guard() {
    if(disposed||!vscode.workspace.isTrusted)throw Error('Open a trusted workspace to review repository changes.');
  }

  function settings() {
    guard();
    const active=vscode.window.activeTextEditor?.document.uri;
    const folder=(active&&vscode.workspace.getWorkspaceFolder(active))||vscode.workspace.workspaceFolders?.[0];
    if(folder?.uri.scheme!=='file')throw Error('Open a local workspace.');
    const config=vscode.workspace.getConfiguration('rocketbrain.codeReview',folder.uri);
    const profile=reviewProfile({provider:config.get('provider','github'),repository:config.get('repository',''),endpoint:config.get('endpoint','')});
    const scope=createHash('sha256').update(JSON.stringify([folder.uri.toString(),profile.provider,profile.base.href,profile.repository])).digest('hex');
    return {profile,scope};
  }

  async function client(config=settings()) {
    const token=await context.secrets.get('rocketbrain.review.'+config.scope);
    guard();
    const {provider,repository,base}=config.profile;
    return createReviewClient({provider,repository,endpoint:base.href,token});
  }

  function reviewUri(id){return vscode.Uri.from({scheme,path:`/${id}/Review.txt`});}
  function available(uri){
    const [,id,section]=uri?.scheme===scheme?uri.path.split('/'):[];
    const review=documents.get(id);
    if(!review)throw Error('Open a saved review result.');
    return {review,id,section};
  }

  function savedDrafts() {
    const saved=context.workspaceState.get(storeKey,[]);
    return Array.isArray(saved)?saved.filter(item=>item&&typeof item.scope==='string'&&typeof item.body==='string'):[];
  }

  async function publish(scope,value) {
    guard();
    const id=randomUUID();
    while(documents.size>=6)documents.delete(documents.keys().next().value);
    documents.set(id,{scope,value});
    const uri=reviewUri(id);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});
    return uri;
  }

  async function openPatch(uri,name) {
    guard();
    const {review,id}=available(uri);
    const file=review.value.files.find(item=>item.name===name);
    if(!file?.patch)throw Error('The provider did not return text for this patch.');
    const index=review.value.files.indexOf(file);
    const patch=vscode.Uri.from({scheme,path:`/${id}/${index}.diff`});
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(patch),{preview:false});
    return patch;
  }

  function draft(uri,patchLine,body) {
    guard();
    const {review,id,section}=available(uri);
    if(!/^\d+\.diff$/.test(section||''))throw Error('Open a changed file before adding a draft comment.');
    const file=review.value.files[Number(section.slice(0,-5))];
    const target=patchTargetLines(file?.patch).find(item=>item.patchLine===patchLine);
    if(!target||target.line<1)throw Error('Select an observed line on the new side of the patch.');
    if(typeof body!=='string'||!body.trim()||body.length>3000)throw Error('Use a draft from 1 to 3,000 characters.');
    const item={id:randomUUID(),scope:review.scope,review:review.value.id,head:review.value.head,path:file.name,line:target.line,body};
    const update=writes.then(async()=>{
      guard();
      const prior=savedDrafts();
      if(prior.length>=100)throw Error('Remove unused review drafts before adding more.');
      await context.workspaceState.update(storeKey,[...prior,item]);
      updates.fire(reviewUri(id));
      return {...item};
    });
    writes=update.catch(()=>{});
    return update;
  }

  function progress(title,action) {
    return vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title,cancellable:true},async(_,token)=>{
      const abort=new AbortController(), listener=token.onCancellationRequested(()=>abort.abort());
      if(token.isCancellationRequested)abort.abort();
      try{return await action(abort.signal);}finally{listener.dispose();}
    });
  }

  const subscriptions=[updates,vscode.workspace.registerTextDocumentContentProvider(scheme,{
    onDidChange:updates.event,
    provideTextDocumentContent(uri){
      if(disposed||!vscode.workspace.isTrusted)return '';
      const [,id,part]=uri.path.split('/');
      const current=documents.get(id);
      if(!current)return '';
      const view=current.value;
      if(/^\d+\.diff$/.test(part))return view.files[Number(part.slice(0,-5))]?.patch||'';
      const local=savedDrafts().filter(item=>item.scope===current.scope&&item.review===view.id);
      return [view.repository+' #'+view.id,view.title,view.author+' · '+view.state,'Commit '+view.head,view.body,'',
        ...view.files.map(file=>file.state+' · '+file.name+(file.limited?' · Patch unavailable':'')),
        ...(view.coverage.moreFiles?['More changed files are available on the server.']:[]),
        '',...view.comments.map(item=>`${item.author} · ${item.file||'Review'}${item.line?' · Line '+item.line:''}\n${item.body}`),
        ...(view.coverage.moreComments?['More comments are available on the server.']:[]),
        ...(view.linkedIssueNumbers?.length?['','Linked issues',...view.linkedIssueNumbers.map(value=>'#'+value)]:[]),
        ...(view.pipelines?.length?['','Checks and pipelines',...view.pipelines.map(item=>item.name+' · '+item.status)]:[]),
        ...(local.length?['','Local draft comments',...local.map(item=>item.path+' · Line '+item.line+
          (item.head!==view.head?' · Earlier revision':'')+'\n'+item.body)]:[])].join('\n');
    }
  })];

  function command(name,action){
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.review.'+name,async()=>{
      try{guard();return await action();}catch(error){await vscode.window.showErrorMessage(error.message);}
    }));
  }
  command('open',async()=>{
    const config=settings(), api=await client(config);
    let page=1;
    for(;;){
      const list=await progress('Reading repository reviews',signal=>api.list({signal,page}));
      const choices=list.items.map(value=>({label:'#'+value.id+' · '+value.title,description:value.author,value}));
      if(list.more&&page<20)choices.push({label:'Next page'});
      if(!choices.length){await vscode.window.showInformationMessage('No open reviews were returned for this repository.');return;}
      const chosen=await vscode.window.showQuickPick(choices,{title:'Open Repository Review'});
      if(!chosen)return;
      if(!chosen.value){page++;continue;}
      const value=await progress('Reading review changes',signal=>api.read(chosen.value.id,{expectedHead:chosen.value.head,signal}));
      return publish(config.scope,value);
    }
  });
  command('patch',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri;
    const {review}=available(uri);
    const selection=await vscode.window.showQuickPick(review.value.files.filter(file=>file.patch).map(file=>({label:file.name,description:file.state})),
      {title:'Open Changed Review File'});
    if(selection)return openPatch(uri,selection.label);
  });
  command('draft',async()=>{
    const editor=vscode.window.activeTextEditor;
    const uri=editor?.document.uri,line=editor?.selection.active.line;
    const body=await vscode.window.showInputBox({title:'Local Review Draft',prompt:'Save a local comment on the selected changed line'});
    if(body)return draft(uri,line,body);
  });
  command('discardDraft',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri;
    const {review,id}=available(uri);
    const choices=savedDrafts().filter(item=>item.scope===review.scope&&item.review===review.value.id).map(item=>({
      label:item.path+' · Line '+item.line,description:item.body.slice(0,120),item
    }));
    const selected=await vscode.window.showQuickPick(choices,{title:'Discard Local Review Draft'});
    if(!selected)return;
    const update=writes.then(async()=>{
      guard();
      await context.workspaceState.update(storeKey,savedDrafts().filter(item=>item.id!==selected.item.id));
      updates.fire(reviewUri(id));
    });
    writes=update.catch(()=>{});
    return update;
  });
  command('token',async()=>{
    const {scope}=settings();
    const token=await vscode.window.showInputBox({title:'Repository Review Token',password:true,prompt:'Leave empty to clear the saved token'});
    if(token===undefined||settings().scope!==scope)return;
    if(token.length>2048||/[\x00-\x20\x7f]/.test(token))throw Error('Enter a valid review access token.');
    if(token)await context.secrets.store('rocketbrain.review.'+scope,token);
    else await context.secrets.delete('rocketbrain.review.'+scope);
  });

  return {publish,openPatch,draft,read(input,id,options){guard();return createReviewClient(input).read(id,options);},
    async dispose(){disposed=true;documents.clear();await writes;for(const item of subscriptions)item.dispose();}};
}

module.exports={registerCodeReview};
