'use strict';

const {createHash,randomUUID}=require('node:crypto');
const {createReviewClient,reviewProfile,patchTargetLines}=require('./code-review');

const scheme='rocketbrain-code-review';
const storeKey='rocketbrain.codeReview.drafts.v1';

function registerCodeReview(context,vscode) {
  let disposed=false, writes=Promise.resolve();
  const documents=new Map(), publications=new Map(), reviewActions=new Map(), activeDrafts=new Set();
  const updates=new vscode.EventEmitter();

  function guard() {
    if(disposed||!vscode.workspace.isTrusted)throw Error('Open a trusted workspace to review repository changes.');
  }

  function settings(folder) {
    guard();
    const active=vscode.window.activeTextEditor?.document.uri;
    folder ??= (active&&vscode.workspace.getWorkspaceFolder(active))||vscode.workspace.workspaceFolders?.[0];
    if(folder?.uri.scheme!=='file')throw Error('Open a local workspace.');
    const config=vscode.workspace.getConfiguration('rocketbrain.codeReview',folder.uri);
    const profile=reviewProfile({provider:config.get('provider','github'),repository:config.get('repository',''),endpoint:config.get('endpoint','')});
    const scope=createHash('sha256').update(JSON.stringify([folder.uri.toString(),profile.provider,profile.base.href,profile.repository])).digest('hex');
    return {profile,scope};
  }

  function settingsForScope(scope) {
    for (const folder of vscode.workspace.workspaceFolders||[]) {
      let value;
      try { value=settings(folder); } catch { continue; }
      if(value.scope===scope) return value;
    }
    throw Error('The workspace review repository changed. Reopen the request.');
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
    const item={id:randomUUID(),scope:review.scope,review:review.value.id,head:review.value.head,
      base:review.value.base,start:review.value.start??null,filePage:review.value.filePage??1,
      path:file.name,line:target.line,patchSha:createHash('sha256').update(file.patch).digest('hex'),body};
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

  async function changeDraft(id,change,viewId) {
    const next=writes.then(async()=>{
      guard();
      const items=savedDrafts(), index=items.findIndex(item=>item.id===id);
      if(index===-1) throw Error('The selected local draft was removed.');
      const updated=change(items[index]);
      if(updated) items[index]=updated;
      else items.splice(index,1);
      await context.workspaceState.update(storeKey,items);
      updates.fire(reviewUri(viewId));
    });
    writes=next.catch(()=>{});
    return next;
  }

  async function reviewPublication(uri,draftId,options={}) {
    guard();
    const {review,id}=available(uri);
    const draft=savedDrafts().find(item=>item.id===draftId && item.scope===review.scope && item.review===review.value.id);
    if(!draft) throw Error('Choose a local draft from this review.');
    if(draft.publication) throw Error('Refresh the remote discussion to check the previous publication attempt.');
    const config=settingsForScope(review.scope), api=await client(config);
    const observed=await api.preparePublication(draft,options);
    for(const [key,value] of publications) if(value.expires<Date.now()) publications.delete(key);
    if(publications.size>=8) publications.delete(publications.keys().next().value);
    publications.set(observed.publicationId,{id,api,draft,expires:Date.now()+120000});
    return observed;
  }

  async function publishDraft(publicationId,{approved=false,signal}={}) {
    guard();
    if(approved!==true) throw Error('Explicitly approve publishing this review draft.');
    const attached=publications.get(publicationId);
    publications.delete(publicationId);
    if(!attached||attached.expires<Date.now()) throw Error('Prepare a fresh review draft before publishing.');
    const {id,api,draft}=attached;
    settingsForScope(draft.scope);
    if(activeDrafts.has(draft.id)) throw Error('Finish the current publication attempt before retrying.');
    activeDrafts.add(draft.id);
    let sending=false, accepted=false;
    try {
      const result=await api.submitPublication(publicationId,{approved,signal,async beforeDispatch() {
        settingsForScope(draft.scope);
        await changeDraft(draft.id,current=>{
          if(JSON.stringify(current)!==JSON.stringify(draft)) throw Error('The local draft changed. Review it again.');
          return {...current,publication:'sending'};
        },id);
        sending=true;
        settingsForScope(draft.scope);
      }});
      accepted=true;
      await changeDraft(draft.id,()=>null,id);
      return result;
    } catch(error) {
      if(sending && !accepted) {
        await changeDraft(draft.id,current=>{
          const {publication,...original}=current;
          return error.code==='ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'?{...original,publication:'unconfirmed'}:original;
        },id);
      }
      throw error;
    } finally { activeDrafts.delete(draft.id); }
  }

  async function changePage(uri,kind,offset,{signal}={}) {
    const {review}=available(uri);
    const {value}=review;
    const selected=kind==='files'?'filePage':'commentPage';
    if(!['files','comments'].includes(kind)||![-1,1].includes(offset)) throw Error('Choose a review page direction.');
    const page=(value[selected]??1)+offset;
    if(page<1||page>20||offset>0&&!value.coverage[kind==='files'?'moreFiles':'moreComments']) {
      throw Error('No further page was reported for this view.');
    }
    const config=settingsForScope(review.scope), api=await client(config);
    const updated=await api.read(value.id,{expectedHead:value.head,signal,
      filePage:value.filePage??1,commentPage:value.commentPage??1,[selected]:page});
    if(updated.base!==value.base || updated.start!==value.start) throw Error('The review base changed. Reopen it.');
    return publish(review.scope,updated);
  }

  async function refreshReview(uri,{signal}={}) {
    const {review}=available(uri), {value}=review;
    const api=await client(settingsForScope(review.scope));
    const updated=await api.read(value.id,{signal,filePage:value.filePage,commentPage:value.commentPage});
    return publish(review.scope,updated);
  }

  async function reviewAction(uri,{action,noteId,body},{signal}={}) {
    const {review}=available(uri), {value}=review;
    const note=value.comments.find(item=>item.id===noteId&&noteId!==undefined);
    const api=await client(settingsForScope(review.scope));
    const draft=await api.prepareAction({action,review:value.id,head:value.head,base:value.base,
      start:value.start??null,commentPage:value.commentPage,note,body},{signal});
    for(const [id,entry] of reviewActions) if(entry.expires<Date.now()) reviewActions.delete(id);
    if(reviewActions.size>=8) reviewActions.delete(reviewActions.keys().next().value);
    reviewActions.set(draft.actionId,{api,scope:review.scope,expires:Date.now()+120000});
    return draft;
  }

  async function sendReviewAction(actionId,{approved=false,signal}={}) {
    if(approved!==true) throw Error('Explicitly approve the selected review action.');
    const bound=reviewActions.get(actionId);
    reviewActions.delete(actionId);
    if(!bound||bound.expires<Date.now()) throw Error('Prepare a fresh review action.');
    settingsForScope(bound.scope);
    return bound.api.submitAction(actionId,{approved,signal,beforeDispatch:()=>settingsForScope(bound.scope)});
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
        'Changed files · Page '+(view.filePage??1),
        ...view.files.map(file=>file.state+' · '+file.name+(file.limited?' · Patch unavailable':'')),
        ...(view.coverage.moreFiles?['More changed files are available on the server.']:[]),
        '','Discussion · Page '+(view.commentPage??1),...view.comments.map(item=>`${item.author} · ${item.file||'Review'}${item.line?' · Line '+item.line:''}${item.id?' · Note '+item.id:''}\n${item.body}`),
        ...(view.coverage.moreComments?['More comments are available on the server.']:[]),
        ...(view.coverage.limitedComments?['Showing the first 100 comments on this page.']:[]),
        ...(view.linkedIssueNumbers?.length?['','Linked issues',...view.linkedIssueNumbers.map(value=>'#'+value)]:[]),
        ...(view.pipelines?.length?['','Checks and pipelines',...view.pipelines.map(item=>item.name+' · '+item.status)]:[]),
        ...(local.length?['','Local draft comments',...local.map(item=>item.path+' · Line '+item.line+
          (item.head!==view.head?' · Earlier revision':'')+(item.publication?' · Publication unconfirmed':'')+'\n'+item.body)]:[])].join('\n');
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
  command('page',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri;
    const {review}=available(uri), view=review.value;
    const choices=[
      ...((view.filePage??1)>1?[{label:'Previous changed files',kind:'files',offset:-1}]:[]),
      ...(view.coverage.moreFiles && view.filePage<20?[{label:'Next changed files',kind:'files',offset:1}]:[]),
      ...((view.commentPage??1)>1?[{label:'Previous discussion',kind:'comments',offset:-1}]:[]),
      ...(view.coverage.moreComments && view.commentPage<20?[{label:'Next discussion',kind:'comments',offset:1}]:[])
    ];
    if(!choices.length) return vscode.window.showInformationMessage('The provider reported no additional pages.');
    const selected=await vscode.window.showQuickPick(choices,{title:'Navigate Review Pages'});
    if(selected) return progress('Reading review page',signal=>changePage(uri,selected.kind,selected.offset,{signal}));
  });
  command('publishDraft',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri;
    const {review}=available(uri);
    const choices=savedDrafts().filter(item=>item.scope===review.scope && item.review===review.value.id && !item.publication)
      .map(item=>({label:item.path+' · Line '+item.line,description:item.body.slice(0,120),id:item.id}));
    const selected=await vscode.window.showQuickPick(choices,{title:'Select Review Draft to Publish'});
    if(!selected) return;
    const entry=await progress('Checking the exact review line',signal=>reviewPublication(uri,selected.id,{signal}));
    try {
      const action='Publish Comment';
      const title=entry.repository+' #'+entry.review+' · '+entry.path+' line '+entry.line;
      const detail=entry.head+'\n\n'+entry.body;
      if(await vscode.window.showWarningMessage(title,{modal:true,detail},action)!==action) return;
      const result=await progress('Publishing the approved comment',signal=>publishDraft(entry.publicationId,{approved:true,signal}));
      await vscode.window.showInformationMessage('Published review comment '+result.noteId+'.');
      return result;
    } finally { publications.delete(entry.publicationId); }
  });
  command('refresh',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri;
    return progress('Refreshing the repository review',signal=>refreshReview(uri,{signal}));
  });
  command('action',async()=>{
    const uri=vscode.window.activeTextEditor?.document.uri, {review}=available(uri);
    const github=review.value.provider==='github';
    const choices=[
      {label:'Approve Review',action:'approve'},
      {label:'Submit Review Comment',action:'comment'},
      ...(github?[{label:'Request Changes',action:'request-changes'}]:[]),
      {label:'Reply to Discussion',action:'reply'},
      {label:'Edit Discussion Note',action:'edit'}
    ];
    const selected=await vscode.window.showQuickPick(choices,{title:'Repository Review Action'});
    if(!selected) return;
    let note;
    if(['reply','edit'].includes(selected.action)) {
      const notes=review.value.comments.filter(item=>item.id).map(value=>({
        label:value.author+' · Note '+value.id,description:value.body.slice(0,100),value
      }));
      if(!notes.length) return vscode.window.showInformationMessage('No editable discussion notes were returned on this page.');
      note=(await vscode.window.showQuickPick(notes,{title:selected.label}))?.value;
      if(!note) return;
    }
    let body;
    if(selected.action!=='approve') {
      body=await vscode.window.showInputBox({title:selected.label,value:selected.action==='edit'?note.body:undefined});
      if(body===undefined) return;
    }
    const entry=await progress('Checking the review revision',signal=>
      reviewAction(uri,{action:selected.action,noteId:note?.id,body},{signal}));
    try {
      const detail=[entry.head,entry.note&&'Note '+entry.note.id+' · '+entry.note.author,entry.note?.body,entry.body].filter(Boolean).join('\n\n');
      const confirmation=await vscode.window.showWarningMessage(entry.repository+' #'+entry.review,
        {modal:true,detail},selected.label);
      if(confirmation!==selected.label) return;
      const result=await progress('Sending the approved review action',signal=>sendReviewAction(entry.actionId,{approved:true,signal}));
      await vscode.window.showInformationMessage('Review action submitted. Refresh the review to read the current discussion.');
      return result;
    } finally { reviewActions.delete(entry.actionId); }
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
      if(activeDrafts.has(selected.item.id)) throw Error('Finish the current publication attempt before discarding its draft.');
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
    return storeToken({token,approved:true});
  });

  async function storeToken({token,approved=false}={}) {
    const {scope}=settings();
    if(approved!==true || typeof token!=='string'||token.length>2048||/[\x00-\x20\x7f]/.test(token)) {
      throw Error('Approve a valid repository review token.');
    }
    if(token) await context.secrets.store('rocketbrain.review.'+scope,token);
    else await context.secrets.delete('rocketbrain.review.'+scope);
    return scope;
  }

  return {publish,openPatch,draft,changePage,reviewPublication,publishDraft,refreshReview,reviewAction,sendReviewAction,storeToken,
    read(input,id,options){guard();return createReviewClient(input).read(id,options);},
    async dispose(){disposed=true;documents.clear();publications.clear();reviewActions.clear();await writes;for(const item of subscriptions)item.dispose();}};
}

module.exports={registerCodeReview};
