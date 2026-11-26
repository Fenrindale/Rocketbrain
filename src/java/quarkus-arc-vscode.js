'use strict';

const {randomBytes}=require('node:crypto');
const {registerTracePanel}=require('../spring/security-trace-vscode');
const {workspacePath,workspaceRoots}=require('./workbench-model');
const {readObservedSource}=require('../spring/observed-injection');
const {arcProducerSource}=require('./quarkus-arc-lookups');

const VIEW='rocketbrain.quarkus.inspectArcLookups';
const OPEN='rocketbrain.quarkus.openArcProducerSource';
const TITLE='Quarkus Arc Lookups';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);

function renderArcLookups(report){
  const nonce=randomBytes(16).toString('base64');
  const state=report.state==='disabled'?'List approved application packages in quarkusArcPackages and restart the local observer.'
    :report.state==='waiting'?'Waiting for a supported Arc lookup implementation.'
      :report.state==='partial'?'Some lookup evidence was unavailable or expired.'
        :report.lookups.length?'Showing captured application lookups.':'No matching application lookup has been observed.';
  const rows=[...report.lookups].reverse().map(item=>{
    const targets=item.candidates.map(candidate=>{
      const source=candidate.target?candidate.target.owner+'#'+candidate.target.member+' '+candidate.target.descriptor
        :candidate.kind==='opaque'?'No direct Java producer target observed':'Producer outside the approved loader or package';
      return '<li>'+escape(candidate.id??'Identity unavailable')+' · '+escape(source)+'</li>';
    });
    return '<tr><th scope="row">'+escape(item.id)+'</th><td>'+escape(item.scope)+'<br>'+escape(item.requiredType)+
      '</td><td>'+escape(item.qualifierTypes?.join(', ')|| (item.qualifierTypes?'None':'Unavailable'))+'</td><td>'+
      escape(item.status)+' · '+item.eligibleCount+'</td><td>'+(targets.length?'<ul>'+targets.join('')+'</ul>':'')+'</td></tr>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
  <style nonce="${nonce}">body{padding:.75rem 1rem;font-family:var(--vscode-font-family)}
  h1{font-size:1.25rem}p{color:var(--vscode-descriptionForeground)}section{overflow-x:auto}
  table{border-collapse:collapse;width:100%}th,td{padding:.4rem .6rem;vertical-align:top;text-align:left;overflow-wrap:anywhere;border:1px solid var(--vscode-panel-border)}
  thead{background:var(--vscode-editorWidget-background)}ul{padding-left:1rem;margin:0}</style></head>
  <body><h1>${TITLE}</h1><p>${escape(state)}</p>${rows?`<p>Eligibility is the Arc candidate list used for the recorded lookup. Qualifier values are omitted. Use Open Observed Arc Producer Source to inspect a direct Java declaration.</p>
  <section><table><thead><tr><th>Lookup</th><th>Application loader and type</th><th>Qualifier types</th><th>Outcome and eligible count</th><th>Candidate producers</th></tr></thead><tbody>${rows}</tbody></table></section>`:''}</body></html>`;
}

function registerArcLookups(vscode,options){
  const panel=registerTracePanel(vscode,options,{viewId:VIEW,title:TITLE,inspect:'quarkusArcLookups',render:renderArcLookups});
  options.command(OPEN,async selection=>{
    const connection=options.target(), report=await connection.client.quarkusArcLookups();
    const producers=report.lookups.flatMap(lookup=>lookup.candidates.filter(candidate=>candidate.target&&candidate.id)
      .map(candidate=>({lookup,candidate}))).reverse();
    if(!producers.length)throw Error('No direct Java producer target was observed in an approved application package.');
    const chosen=selection?.lookupId||selection?.candidateId
      ? producers.find(item=>item.lookup.id===selection.lookupId&&item.candidate.id===selection.candidateId)
      : (await vscode.window.showQuickPick(producers.map(value=>({
        label:value.candidate.target.owner+'#'+value.candidate.target.member,
        description:value.candidate.target.kind+' · '+value.lookup.id+' · '+value.lookup.status,value
      })),{title:'Open Observed Arc Producer Source'}))?.value;
    if(!chosen){
      if(selection?.lookupId||selection?.candidateId)throw Error('The selected Arc producer observation is unavailable.');
      return;
    }
    connection.assertCurrent();
    const uri=selection?.sourceUri??(await vscode.window.showOpenDialog({canSelectFiles:true,canSelectFolders:false,
      canSelectMany:false,filters:{Java:['java']},openLabel:'Choose the Producer Source'}))?.[0];
    if(!uri)return;
    connection.assertCurrent();
    if(uri.scheme!=='file'||!uri.fsPath.endsWith('.java'))throw Error('Choose a local Java source file.');
    const inside=()=>workspacePath(uri.toString(),workspaceRoots(vscode.workspace.workspaceFolders||[]),{directory:false});
    const file=inside(), saved=await readObservedSource(file);
    const document=await vscode.workspace.openTextDocument(uri);
    if(document.isDirty||document.isClosed||document.languageId!=='java'||document.getText()!==saved.text)
      throw Error('Save or reload the Java source before navigating.');
    const matched=arcProducerSource({uri:uri.toString(),text:saved.text},chosen.candidate.target);
    if(!matched)throw Error('The selected file has no unique matching @Produces declaration with the observed signature.');
    const version=document.version, latest=await connection.client.quarkusArcLookups(), rechecked=await readObservedSource(file);
    connection.assertCurrent();
    const current=latest.lookups.find(item=>item.id===chosen.lookup.id&&item.scope===chosen.lookup.scope)?.candidates
      .find(item=>item.id===chosen.candidate.id);
    if(latest.processId!==report.processId||JSON.stringify(current?.target)!==JSON.stringify(chosen.candidate.target)||
        document.isClosed||document.isDirty||document.version!==version||inside()!==file||saved.sha256!==rechecked.sha256)
      throw Error('The source or Arc observation changed. Inspect it again.');
    const range=new vscode.Range(document.positionAt(matched.start),document.positionAt(matched.end));
    await vscode.window.showTextDocument(document,{selection:range,preview:false});
    return {uri,range,lookupId:chosen.lookup.id,candidateId:chosen.candidate.id,member:matched.name,sameSourceRevisionVerified:false};
  });
  return panel;
}

module.exports={registerArcLookups,renderArcLookups};
