'use strict';

const {randomBytes}=require('node:crypto');
const {workspacePath,workspaceRoots}=require('./workbench-model');
const {registerTracePanel}=require('../spring/security-trace-vscode');
const {readObservedSource}=require('../spring/observed-injection');
const {arcObservedMethodSource}=require('./quarkus-arc-lookups');

const VIEW='rocketbrain.quarkus.inspectInterceptors';
const OPEN='rocketbrain.quarkus.openInterceptorSource';
const TITLE='Quarkus CDI Interceptors';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const display=target=>target.owner+'#'+target.member;

function renderArcInterceptors(report) {
  const nonce=randomBytes(16).toString('base64');
  const state=report.state==='disabled'?'Approve application packages in quarkusInterceptorPackages and restart the local observer.'
    :report.state==='waiting'?'Waiting for a supported Arc around-invoke runtime.'
      :report.state==='partial'?'Some interceptor metadata is outside the approved packages, unsupported or expired.'
        :report.invocations.length?'Showing captured synchronous Java invocations.':'No matching interceptor invocation has been observed.';
  const rows=[...report.invocations].reverse().map(event=>{
    const chain=event.configured.map(entry=>entry.kind==='source'
      ? escape(display(entry.target))+' · priority '+entry.priority : 'Source and priority unavailable');
    return '<tr><th scope="row">'+escape(display(event.target))+'<br><code>'+escape(event.target.descriptor)+'</code></th>'+
      '<td>'+escape(event.bindingTypes.join(', ')||'Unavailable')+'</td><td><ol>'+
      chain.map(label=>'<li>'+label+'</li>').join('')+'</ol></td><td>'+
      escape(event.entered.map(index=>index+1).join(' → ')||'None observed')+'<br>'+escape(event.outcome)+'</td></tr>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
  <style nonce="${nonce}">body{padding:.75rem 1rem;font-family:var(--vscode-font-family)}
  h1{font-size:1.25rem}p{color:var(--vscode-descriptionForeground)}section{overflow-x:auto}
  table{border-collapse:collapse;width:100%}th,td{padding:.4rem .6rem;vertical-align:top;text-align:left;overflow-wrap:anywhere;border:1px solid var(--vscode-panel-border)}
  thead{background:var(--vscode-editorWidget-background)}ol{padding-left:1.25rem;margin:0}</style></head>
  <body><h1>${TITLE}</h1><p>${escape(state)}</p>${rows?`<section><table><thead><tr><th>Observed Java method</th><th>Binding types</th>
  <th>Configured chain</th><th>Entries in actual order</th></tr></thead><tbody>${rows}</tbody></table></section>`:''}</body></html>`;
}

function sourceChoices(report) {
  return [...report.invocations].reverse().flatMap(event=>[
    {eventId:event.id,target:event.target},
    ...event.configured.flatMap((entry,index)=>entry.kind==='source'?[{eventId:event.id,index,target:entry.target}]:[])
  ]);
}

function registerArcInterceptors(vscode,options) {
  const panel=registerTracePanel(vscode,options,{viewId:VIEW,title:TITLE,inspect:'quarkusArcInterceptors',render:renderArcInterceptors});
  options.command(OPEN,async selection=>{
    const connection=options.target(), report=await connection.client.quarkusArcInterceptors();
    const choices=sourceChoices(report);
    if(!choices.length)throw Error('No supported Java method was observed in an approved application package.');
    const chosen=selection?.eventId
      ? choices.find(item=>item.eventId===selection.eventId&&item.index===selection.chainIndex)
      : (await vscode.window.showQuickPick(choices.map(value=>({label:display(value.target),
        description:value.target.descriptor,detail:value.eventId,value})),{title:'Open Observed Quarkus Interceptor Source'}))?.value;
    if(!chosen){
      if(selection?.eventId)throw Error('The selected Quarkus interceptor source observation is unavailable.');
      return;
    }
    connection.assertCurrent();
    const uri=selection?.sourceUri??(await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,
      canSelectMany:false,filters:{Java:['java']},openLabel:'Choose the Java Source'}))?.[0];
    if(!uri)return;
    if(uri.scheme!=='file'||!uri.fsPath.endsWith('.java'))throw Error('Choose a local Java source file.');
    const within=()=>workspacePath(uri.toString(),workspaceRoots(vscode.workspace.workspaceFolders||[]),{directory:false});
    const file=within(), saved=await readObservedSource(file);
    const document=await vscode.workspace.openTextDocument(uri), version=document.version;
    if(document.isDirty||document.isClosed||document.languageId!=='java'||document.getText()!==saved.text)
      throw Error('Save or reload the Java source before navigating.');
    const matched=arcObservedMethodSource({uri:uri.toString(),text:saved.text},chosen.target,
      chosen.index===undefined?undefined:'jakarta.interceptor.AroundInvoke');
    if(!matched)throw Error('The file has no unique Java declaration with the observed method signature.');
    const latest=await connection.client.quarkusArcInterceptors(), rechecked=await readObservedSource(file);
    connection.assertCurrent();
    const current=sourceChoices(latest).find(item=>item.eventId===chosen.eventId&&item.index===chosen.index);
    if(latest.processId!==report.processId||JSON.stringify(current?.target)!==JSON.stringify(chosen.target)||
        document.isClosed||document.isDirty||document.version!==version||within()!==file||saved.sha256!==rechecked.sha256)
      throw Error('The source or Quarkus interceptor observation changed. Inspect it again.');
    const range=new vscode.Range(document.positionAt(matched.start),document.positionAt(matched.end));
    await vscode.window.showTextDocument(document,{selection:range,preview:false});
    return {uri,range,eventId:chosen.eventId,member:matched.name,sameSourceRevisionVerified:false};
  });
  return panel;
}

module.exports={registerArcInterceptors,renderArcInterceptors};
