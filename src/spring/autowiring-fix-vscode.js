'use strict';

const path=require('node:path');
const crypto=require('node:crypto');
const {FIX_CODE,candidateChoices,prepareQualifier,snapshotFingerprint}=require('./autowiring-fix');

const SCHEME='rocketbrain-spring-qualifier';
const PREVIEW='rocketbrain.spring.reviewQualifier';
const SOURCE='Rocketbrain Spring (local model)';
const TTL=5*60*1000;

function registerAutowiringFix(vscode,{analyze,refresh,inputsFor,enabled,output}) {
  const reviews=new Map(),subscriptions=[];
  const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
  const range=item=>new vscode.Range(item.start.line,item.start.character,item.end.line,item.end.character);
  const live=review=>review && Date.now()<review.expiresAt;
  let disposed=false;

  function assertTrusted() {
    if (disposed || !enabled() || !vscode.workspace.isTrusted) throw new Error('Enable Spring analysis in a trusted workspace before editing an injection.');
  }

  async function workspaceDocument(value) {
    assertTrusted();
    const uri=vscode.Uri.parse(value);
    if (uri.scheme!=='file' || !uri.path.endsWith('.java') || !vscode.workspace.getWorkspaceFolder(uri))
      throw new Error('Choose a Java file in the current workspace.');
    const stat=await vscode.workspace.fs.stat(uri);
    if (vscode.FileType?.SymbolicLink && stat.type&vscode.FileType.SymbolicLink) throw new Error('Choose an ordinary Java file inside the workspace.');
    const document=await vscode.workspace.openTextDocument(uri);
    if (document.languageId!=='java') throw new Error('Choose the Java declaration of the injection.');
    return document;
  }

  async function prepare(request) {
    if (typeof request?.uri!=='string') throw new Error('Select a Spring autowiring diagnostic in Java source.');
    const document=await workspaceDocument(request.uri);
    if (request.version!==undefined && request.version!==document.version) throw new Error('The injection changed since the Quick Fix was computed.');
    const version=document.version;
    const model=await refresh(), inputs=inputsFor(model);
    assertTrusted();
    if (!inputs || document.version!==version) throw new Error('The source index changed. Refresh Spring analysis and try again.');
    const fixed=prepareQualifier(model,inputs,request);
    if (digest(document.getText())!==fixed.beforeHash) throw new Error('The source changed since Spring analysis.');
    for (const [key,value] of reviews) if (!live(value)) reviews.delete(key);
    while (reviews.size>=8) reviews.delete(reviews.keys().next().value);
    const id=crypto.randomUUID(),expiresAt=Date.now()+TTL;
    const uri=vscode.Uri.from({scheme:SCHEME,path:'/'+id+'/'+path.basename(document.uri.path)});
    const publicReview={id,uri:fixed.uri,previewUri:uri.toString(),owner:fixed.owner,injection:fixed.injection,origin:fixed.origin,candidate:fixed.candidate,
      change:{range:fixed.range,text:fixed.text},beforeHash:fixed.beforeHash,afterHash:fixed.afterHash,profiles:[...model.profiles],scope:fixed.scope,expiresAt};
    reviews.set(id,{fixed,request:{uri:request.uri,injectionId:request.injectionId,beanId:request.beanId,qualifier:request.qualifier},
      version,expiresAt,publicReview});
    return structuredClone(publicReview);
  }

  async function apply(id) {
    assertTrusted();
    const review=reviews.get(id);
    if (!live(review)) throw new Error('This Spring Qualifier review expired. Open the Quick Fix again.');
    reviews.delete(id);
    const document=await workspaceDocument(review.fixed.uri);
    if (document.version!==review.version || digest(document.getText())!==review.fixed.beforeHash)
      throw new Error('The injection file changed after review. Open the Quick Fix again.');
    const model=await refresh(),inputs=inputsFor(model);
    assertTrusted();
    if (!inputs || snapshotFingerprint(inputs)!==review.fixed.fingerprint)
      throw new Error('Spring source, configuration or profiles changed after review.');
    const rechecked=prepareQualifier(model,inputs,review.request);
    if (rechecked.afterHash!==review.fixed.afterHash || document.version!==review.version || digest(document.getText())!==review.fixed.beforeHash)
      throw new Error('The reviewed Qualifier edit no longer matches the active declaration.');
    const edit=new vscode.WorkspaceEdit(),at=document.positionAt(rechecked.offset);
    edit.insert(document.uri,at,rechecked.text);
    if (!await vscode.workspace.applyEdit(edit) || digest(document.getText())!==rechecked.afterHash)
      throw new Error('VS Code did not apply the reviewed Qualifier edit exactly.');
    return {...structuredClone(review.publicReview),applied:true};
  }

  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME,{
    provideTextDocumentContent(uri){
      const review=reviews.get(uri.path.split('/')[1]);
      return live(review)?review.fixed.after:'This Spring Qualifier review is no longer available.';
    }
  }));

  subscriptions.push(vscode.languages.registerCodeActionsProvider({scheme:'file',language:'java'},{
    async provideCodeActions(document,selection,context,token){
      if (!enabled() || !vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(document.uri)) return [];
      const diagnostics=context.diagnostics.filter(item=>item.code===FIX_CODE && item.source===SOURCE && item.range.intersection(selection));
      if (!diagnostics.length) return [];
      const version=document.version, model=await analyze();
      if (token.isCancellationRequested || document.version!==version || !vscode.workspace.isTrusted || disposed) return [];
      const uri=document.uri.toString(), input=inputsFor(model)?.java.find(file=>file.uri===uri);
      if (!input || input.text!==document.getText()) return [];
      const actions=[];
      for (const injection of model.injections.filter(item=>item.uri===uri)) {
        const diagnostic=diagnostics.find(item=>item.range.isEqual(range(injection.range)));
        if (!diagnostic) continue;
        for (const choice of candidateChoices(model,injection)) {
          const title='Qualify '+injection.name+' with '+choice.beanName+(choice.qualifier===choice.beanName?'':' ('+choice.qualifier+')');
          const action=new vscode.CodeAction(title,vscode.CodeActionKind.QuickFix);
          action.diagnostics=[diagnostic];
          action.command={command:PREVIEW,title,arguments:[{uri,injectionId:injection.id,beanId:choice.beanId,qualifier:choice.qualifier,version}]};
          actions.push(action);
        }
      }
      return actions;
    }
  },{providedCodeActionKinds:[vscode.CodeActionKind.QuickFix]}));

  subscriptions.push(vscode.commands.registerCommand(PREVIEW,async(request,options)=>{
    let review;
    try {
      review=await prepare(request);
      await vscode.commands.executeCommand('vscode.diff',vscode.Uri.parse(review.uri),vscode.Uri.parse(review.previewUri),
        'Spring Qualifier · '+review.injection+' → '+review.candidate.beanName,{preview:false});
      if (options?.previewOnly===true) return review;
      const choice=await vscode.window.showWarningMessage('Apply the reviewed Spring Qualifier?',{modal:true,
        detail:review.change.text.trim()+'\n'+review.owner+'.'+review.injection+' → '+review.candidate.beanName+
          '\nVerified in the configured local Spring source model.'},'Apply Qualifier');
      if (choice==='Apply Qualifier') return await apply(review.id);
      reviews.delete(review.id);
    } catch(error) {
      if (review) reviews.delete(review.id);
      output.appendLine('Spring Qualifier: '+error.message);
      await vscode.window.showErrorMessage(error.message);
    }
  }));

  return {prepare,apply,dispose(){disposed=true;reviews.clear();for(const subscription of subscriptions)subscription.dispose();}};
}

module.exports={registerAutowiringFix,PREVIEW};
