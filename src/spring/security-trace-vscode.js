'use strict';

const { randomBytes } = require('node:crypto');
const VIEW='rocketbrain.spring.securityTrace', TITLE='Spring Security Filter Trace';
const AUTHENTICATION_VIEW='rocketbrain.spring.securityTrace.inspectAuthentication', AUTHENTICATION_TITLE='Spring Authentication Decisions';
const safe=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const short=value=>value?value.split('.').at(-1):'Type unavailable';

const roleSourceLabels={'role-hierarchy':'Spring role hierarchy','direct-authorities':'Direct authorities','custom-hierarchy':'Custom role hierarchy'};
const decisionSourceLabels={'no-result':'Manager abstained','framework-result':'Spring authorization result',
  'manager-threw-denial':'Manager raised authorization denied','incomplete':'Decision unavailable'};

function renderMethodDecisions(trace, disclosure) {
  if(!trace.methodCoverage||trace.methodCoverage==='disabled')return '';
  const coverage=trace.methodCoverage==='partial'?'<p>Partial method evidence for this request.</p>':'';
  const rows=trace.methodDecisions.map(event=>{
    const target=event.owner&&event.method?event.owner+'.'+event.method+(event.parameterTypes===null?'':'('+event.parameterTypes.join(', ')+')'):'Method target unavailable';
    const sources=event.roleSources.map(source=>roleSourceLabels[source]).join(', ');
    const roles=disclosure
      ?(event.checkedRoles.length?' · Compared '+event.checkedRoles.join(', ')+(event.matchedRoles.length?' · Matched '+event.matchedRoles.join(', '):''):'')
      :(sources?' · Role labels hidden':'');
    return '<tr><td>'+safe(target)+'</td><td>'+safe(event.phase==='before'?'Before invocation':'After invocation')+'</td><td>'+
      safe(event.decision+' · '+decisionSourceLabels[event.decisionSource])+'</td><td>'+safe(event.delegateManager?event.manager+' → '+event.delegateManager:event.manager||'Manager unavailable')+
      '</td><td>'+safe((sources||'No standard role comparison observed')+roles)+'</td></tr>';
  }).join('');
  const empty=trace.methodCoverage==='unavailable'?'Supported method interceptors are unavailable.':'No method decision was captured.';
  return '<section><h2>Method authorization</h2>'+coverage+(rows?
    '<table><thead><tr><th>Method</th><th>Phase</th><th>Decision</th><th>Manager</th><th>Authority evidence</th></tr></thead><tbody>'+rows+'</tbody></table>'
    :'<p>'+empty+'</p>')+'</section>';
}

function renderSecurityTrace(report) {
  const nonce=randomBytes(16).toString('base64');
  const summary=report.state==='disabled'?'The application must start with securityTrace enabled in the observer configuration.'
    :report.state==='waiting'?'Waiting for a supported Spring Security servlet filter chain.'
      :report.traces.length?'Showing '+report.traces.length+' recent requests'+(report.dropped?' · '+report.dropped+' older requests expired':'')+'.'
        :'Send a request to the connected application, then run this command again.';
  const body=report.traces.map((trace,index)=>{
    const outcome=trace.authorizationDecision==='unobserved'?'Authorization decision unavailable':'Authorization '+trace.authorizationDecision;
    const matches=trace.matches.map(item=>'<li><span title="'+safe(item.chainType||'')+'">'+safe(short(item.matcherType||item.chainType))+'</span> · '+(item.matched?'Matched and selected':'Did not match')+'</li>').join('');
    const stages=trace.configured.map((name,pos)=>'<tr><td>'+safe(name||'Type unavailable')+'</td><td>'+
      (pos<trace.entered.length?'Entered':trace.coverage==='observed'?'Execution stopped earlier':'Entry unavailable')+'</td></tr>').join('');
    return '<details'+(index===0?' open':'')+'><summary>'+safe(trace.startedAt)+' · '+safe(trace.method)+' · '+
      (trace.status===null?'Status unavailable':'HTTP '+trace.status)+' · '+trace.durationMs+' ms</summary><p>'+safe(outcome)+
      (trace.coverage==='partial'?' · Partial trace':'')+(trace.completed?'':' · Filter chain threw')+'</p><div class="paths"><section><h2>Chain match order</h2>'+
      (matches?'<ol>'+matches+'</ol>':'<p>No matcher result recorded</p>')+'</section><section><h2>Filter order</h2>'+(stages?'<table><thead><tr><th>Filter class</th><th>Execution</th></tr></thead><tbody>'+stages+
      '</tbody></table>':'<p>No selected filters recorded</p>')+'</section></div>'+renderMethodDecisions(trace,report.roleDisclosureEnabled)+'</details>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
  <style nonce="${nonce}">
  body{padding:.75rem 1rem;font-family:var(--vscode-font-family)} h1{font-size:1.25rem} p{color:var(--vscode-descriptionForeground)}
  details{padding:.6rem 0;border-bottom:1px solid var(--vscode-panel-border)} summary{cursor:pointer} h2{font-size:1rem} .paths{display:flex;gap:1rem;flex-wrap:wrap}
  section{min-width:15rem} table{border-collapse:collapse} th,td{padding:.35rem .55rem;border:1px solid var(--vscode-panel-border);text-align:left;overflow-wrap:anywhere}
  th{background:var(--vscode-editorWidget-background)} td:first-child{font-family:var(--vscode-editor-font-family)}
  </style></head><body><h1>${TITLE}</h1><p>${safe(summary)}</p>${body}</body></html>`;
}

function registerTracePanel(vscode, { target, command }, { viewId, title, inspect, render }) {
  let panel, request=0;
  function close(){request++;const active=panel;panel=undefined;active?.dispose();}
  async function open(){
    const epoch=++request, connection=target(), report=await connection.client[inspect]();
    connection.assertCurrent();
    if(epoch!==request)return;
    if(!panel){
      const view=vscode.window.createWebviewPanel(viewId,title,vscode.ViewColumn.Beside,{enableScripts:false,localResourceRoots:[],enableCommandUris:false});
      panel=view;
      view.onDidDispose(()=>{if(panel===view){panel=undefined;request++;}});
    }else panel.reveal();
    panel.webview.html=render(report);
    return {...report,view:viewId};
  }
  command(viewId,open);
  return {close};
}

function registerSecurityTrace(vscode, options) {
  const filters=registerTracePanel(vscode, options, {viewId:VIEW,title:TITLE,inspect:'securityTrace',render:renderSecurityTrace});
  const authentication=registerTracePanel(vscode, options, {viewId:AUTHENTICATION_VIEW,title:AUTHENTICATION_TITLE,
    inspect:'securityTrace',render:renderAuthenticationDecisions});
  return {close(){filters.close();authentication.close();}};
}

const managerLabels={returned:'Returned an authentication result',rejected:'Raised an authentication rejection',
  error:'Raised an application or authentication service error',unobserved:'Final result unavailable'};
const providerLabels={skipped:'Skipped · supports returned false',abstained:'Abstained · returned null',returned:'Returned an authentication result',
  rejected:'Raised an authentication rejection',error:'Raised an application or authentication service error',
  'support-error':'Supports check raised an exception',unobserved:'Provider result unavailable'};
const parentOutcomes={...managerLabels,empty:'Returned null','provider-not-found':'Raised provider not found'};
const parentDispositions={propagated:'Propagated by the calling manager',unused:'The calling manager retained another outcome',
  'ignored-not-found':'Ignored by the calling manager',unobserved:'Propagation unavailable'};
function parentDecision(manager){
  if(!manager.delegated)return '';
  const details=manager.parentCall, type=safe(manager.parentType||'Parent type unavailable');
  if(!details)return '<p>Delegated to '+type+' · Parent internals unavailable</p>';
  const resolved=details.childIndex?' · Invocation '+details.childIndex:' · Parent internals unavailable';
  return '<p>Delegated to '+type+(details.managerId?' · '+safe(details.managerId):'')+resolved+'<br>'+
    safe(parentOutcomes[details.outcome])+' · '+safe(parentDispositions[details.disposition])+'</p>';
}
function renderAuthenticationDecisions(report){
  const nonce=randomBytes(16).toString('base64');
  const samples=report.traces.filter(trace=>trace.authenticationManagers?.length || trace.authenticationCoverage==='partial');
  const summary=!report.authenticationProviderTraceEnabled
    ?'Set authenticationProviderTrace to true in the local observer configuration and restart the application.'
    :!report.hooks.includes('authentication-provider-manager')
      ?'Waiting for a supported Servlet ProviderManager.'
      :!samples.length?'No supported authentication manager invocation has been captured.'
        :'Showing '+samples.length+' requests with authentication evidence'+(report.dropped?' · Older requests expired':'')+'.';
  const sections=samples.map((trace,index)=>{
    const managers=trace.authenticationManagers.map(manager=>{
      const providers=manager.providers.map(provider=>'<tr><td>'+provider.index+'</td><td>'+safe(provider.providerType)+'</td><td>'+
        safe(providerLabels[provider.outcome])+(manager.selectedProvider===provider.index?' · Returned by manager':'')+
        (manager.failureProvider===provider.index?' · Failure retained by manager':'')+'</td></tr>').join('');
      return '<section><h2>'+safe(manager.managerId)+' · '+safe(manager.managerType)+' · Invocation '+manager.index+'</h2><p>'+
        safe(managerLabels[manager.outcome])+'</p>'+parentDecision(manager)+
        (providers?'<table><thead><tr><th>Step</th><th>Provider</th><th>Outcome</th></tr></thead><tbody>'+providers+'</tbody></table>':
          '<p>No provider steps captured.</p>')+'</section>';
    }).join('');
    return '<details'+(index===0?' open':'')+'><summary>Request '+trace.id+' · '+safe(trace.method)+' · '+
      (trace.status===null?'Status unavailable':'HTTP '+trace.status)+' · '+safe(trace.startedAt)+'</summary>'+
      (trace.authenticationCoverage==='partial'?'<p>Partial authentication evidence for this request.</p>':'')+managers+'</details>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${AUTHENTICATION_TITLE}</title>
    <style nonce="${nonce}">
    body{padding:.75rem 1rem;font-family:var(--vscode-font-family)} h1{font-size:1.25rem} h2{font-size:1rem;overflow-wrap:anywhere}
    p{color:var(--vscode-descriptionForeground)} details{padding:.6rem 0;border-bottom:1px solid var(--vscode-panel-border)} summary{cursor:pointer}
    table{border-collapse:collapse} th,td{padding:.35rem .55rem;border:1px solid var(--vscode-panel-border);text-align:left;overflow-wrap:anywhere}
    th{background:var(--vscode-editorWidget-background)} td:nth-child(2){font-family:var(--vscode-editor-font-family)}
    </style></head><body><h1>${AUTHENTICATION_TITLE}</h1><p>${safe(summary)}</p>${sections}</body></html>`;
}

module.exports={registerTracePanel,registerSecurityTrace,renderSecurityTrace,renderAuthenticationDecisions};
