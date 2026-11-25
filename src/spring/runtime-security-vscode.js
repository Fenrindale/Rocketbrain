'use strict';

const { randomBytes }=require('node:crypto');
const { auditTypes,allowedMinutes,auditRequest }=require('./runtime-security');

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const cell=value=>'<td>'+escape(value)+'</td>';
const table=(headers,rows)=>'<table><thead><tr>'+headers.map(label=>'<th scope="col">'+escape(label)+'</th>').join('')+
  '</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(cell).join('')+'</tr>').join('')+'</tbody></table>';

function endpointStatus(endpoint) {
  if (!endpoint) return 'Awaiting observation';
  if (endpoint.state==='available') return 'Available';
  if (endpoint.status===401) return 'HTTP 401 · authentication required or rejected';
  if (endpoint.status===403) return 'HTTP 403 · access denied';
  if (endpoint.status===404) return 'HTTP 404 · unavailable at this base URL';
  return endpoint.status?'HTTP '+endpoint.status+' · unavailable':endpoint.code;
}

function renderSecurity(current,nonce,revision) {
  const {state,report}=current;
  const blocked=['disconnected','loading'].includes(state) ? ' disabled' : '';
  const option=(value,label,selected)=>'<option value="'+escape(value)+'"'+(value===selected?' selected':'')+'>'+escape(label)+'</option>';
  const filters='<form><label>Audit window <select id="minutes"'+blocked+'>'+allowedMinutes.map(minutes=>
    option(minutes,'Last '+minutes+' minutes',report?.selection.minutes??15)).join('')+'</select></label>'+
    '<label>Event type <select id="type"'+blocked+'>'+option('','All recognized security events',report?.selection.type??'')+
    Object.entries(auditTypes).map(([type,label])=>option(type,label,report?.selection.type)).join('')+'</select></label>'+
    '<label>Principal <input id="principal" placeholder="All principals" maxlength="180"'+blocked+'></label>'+
    '<button type="submit"'+blocked+'>Apply filters</button><button id="refresh" type="button"'+blocked+'>Refresh</button></form>';
  const status=state==='disconnected'?'Connect to the Spring runtime to inspect its security configuration and audit events.'
    :state==='ready'?'Refresh to inspect the connected application.':state==='loading'?'Reading Actuator endpoints…'
    :`Observed ${report.observedAt}${report.selection.filteredPrincipal?' · Principal filter applied':''}.`;
  let body='';
  if (report) {
    const {beans,conditions,audit,endpoints}=report;
    body='<section><h2>Access</h2>'+table(['Actuator endpoint','Status'],
      ['beans','conditions','auditevents'].map(name=>[name,endpointStatus(endpoints[name])]))+'</section>'+
      '<section><h2>Observed security audit events</h2>'+(audit?.events.length?table(['Timestamp','Principal','Recorded outcome'],
        audit.events.map(event=>[event.timestamp,event.principal,event.outcome])):audit?'No matching security audit events returned.':'Audit events unavailable.')+
      (audit?.truncated?'<p>Showing 200 of '+escape(audit.matched)+' matching events.</p>':'')+'</section>'+
      '<section><h2>Security beans and filter chain registrations</h2>'+(beans.length?table(['Application context','Bean','Type','Kind'],
        beans.map(bean=>[bean.context,bean.name,bean.type,bean.kind])):'No security bean metadata observed.')+
      (report.beansTruncated?'<p>Showing the first 200 matching beans.</p>':'')+'</section>'+
      '<details><summary>Security auto-configuration conditions</summary>'+(conditions.length?table(['Application context','Source','Condition','Matched'],
        conditions.map(item=>[item.context,item.source,item.condition,item.matched?'Yes':'No'])):'No matching condition metadata observed.')+
      (report.conditionsTruncated?'<p>Showing the first 200 matching conditions.</p>':'')+'</details>'+
      '<p class="note">Audit entries are the outcomes the application published. Authentication and authorization are separate observations. Filter order and request matcher rules require application configuration.</p>';
  }
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none';">
<title>Spring Security Runtime</title><style nonce="${nonce}">
body{margin:0 auto;padding:20px 24px;max-width:1250px;color:var(--vscode-foreground);font:var(--vscode-font-size) var(--vscode-font-family)}
h1{font-size:25px;margin:0 0 8px}h2{font-size:16px;margin:0 0 8px}section,details{margin-top:22px}
form{display:flex;flex-wrap:wrap;align-items:end;gap:8px;margin:14px 0}label{display:grid;gap:4px}
select,input,button{font:inherit;padding:5px 7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent)}
button{color:var(--vscode-button-foreground);background:var(--vscode-button-background)}button:disabled{opacity:.55}summary{cursor:pointer}table{width:100%;border-collapse:collapse}th,td{overflow-wrap:anywhere;padding:6px 8px;text-align:left;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}th{color:var(--vscode-descriptionForeground)}.note{color:var(--vscode-descriptionForeground);margin-top:20px}
</style></head><body><h1>Spring Security Runtime</h1><p role="status">${escape(status)}</p>${filters}${body}
<script nonce="${nonce}">const vscode=acquireVsCodeApi(); const revision=${revision};
document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();vscode.postMessage({revision,kind:'apply',minutes:Number(document.getElementById('minutes').value),type:document.getElementById('type').value,principal:document.getElementById('principal').value});});
document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({revision,kind:'refresh'}));</script></body></html>`;
}

function registerRuntimeSecurity(vscode,{getClient,assertTrusted,onConnectionChange}) {
  const events=new vscode.EventEmitter();
  let current={state:'disconnected',report:null};
  let client, panel, pending, selection={}, revision=0, disposed=false;
  const snapshot=()=>structuredClone(current);
  const render=()=>{ if (panel) panel.webview.html=renderSecurity(current,randomBytes(18).toString('base64'),revision); };
  function update(state,report=null) {
    current={state,report};
    revision++;
    render();
    if (!disposed) events.fire(snapshot());
  }
  const connection=onConnectionChange(()=>{
    const next=getClient();
    if (client===next) return;
    client=next;
    pending=undefined;
    selection={};
    update(client?'ready':'disconnected');
  });

  async function refresh(input=selection) {
    assertTrusted();
    if (!client) return snapshot();
    auditRequest(input);
    if (pending) return pending;
    const filters={...input}, candidate=client;
    selection=filters;
    const request=Promise.resolve().then(async()=>{
      const report=await candidate.security(filters);
      if (!disposed && candidate===client) {
        assertTrusted();
        update(report.state,report);
      }
      return snapshot();
    });
    pending=request;
    update('loading');
    try { return await request; }
    finally { if (pending===request) pending=undefined; }
  }

  async function open() {
    assertTrusted();
    if (panel) panel.reveal();
    else {
      const view=vscode.window.createWebviewPanel('rocketbrainSpringSecurity','Spring Security Runtime',vscode.ViewColumn.Beside,
        {enableScripts:true,localResourceRoots:[]});
      panel=view;
      view.onDidDispose(()=>{ if (panel===view) panel=undefined; });
      view.webview.onDidReceiveMessage(async message=>{
        if (disposed || view!==panel || message?.revision!==revision) return;
        try {
          if (message.kind==='apply') await refresh({minutes:message.minutes,type:message.type,principal:message.principal});
          else if (message.kind==='refresh') await refresh();
        } catch (error) {
          if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Spring: '+error.message);
        }
      });
      render();
    }
    return refresh();
  }

  const close=()=>panel?.dispose();
  return {open,refresh,snapshot,close,onDidChange:events.event,dispose(){
    disposed=true;
    selection={};
    close();
    connection.dispose();
    events.dispose();
  }};
}

module.exports={registerRuntimeSecurity,renderSecurity};
