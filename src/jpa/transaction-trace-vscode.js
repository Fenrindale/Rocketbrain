'use strict';

const { randomBytes }=require('node:crypto');
const { registerTracePanel }=require('../spring/security-trace-vscode');

const VIEW='rocketbrain.jpa.observer.inspectTransactions', TITLE='Spring JPA Transaction Outcomes';
const safe=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const labels={returned:'Returned',threw:'Threw','not-reached':'Call not reached',unobserved:'Outcome unavailable'};

function renderTransactionTrace(report){
  const nonce=randomBytes(16).toString('base64');
  const message=report.state==='disabled'?'Set jpaTransactionTrace to true in the observer configuration and restart the application.'
    :report.state==='waiting'?'Waiting for a supported Spring JpaTransactionManager.'
      :report.transactions.length?'Showing '+report.transactions.length+' recent transaction outcomes'+(report.dropped?' · '+report.dropped+' samples omitted':'')+'.'
        :'No completed transactions were observed. Exercise the application and run this command again.';
  const rows=report.transactions.map(tx=>{
    const owner=tx.owner;
    const columns=['begin','commit','rollback','cleanup'].map(key=>{
      const stage=tx.stages[key];
      return !stage?'<td>Unobserved</td>':'<td>'+safe(labels[stage.spring])+(stage.provider?
        '<br><small>JPA call · '+safe(labels[stage.provider])+'</small>':'')+'</td>';
    }).join('');
    return '<tr><th scope="row">#'+tx.id+'<br><small>'+safe(tx.startedAt)+' · '+tx.durationMs+' ms</small></th><td>'+
      safe(tx.managerId)+'<br><small>'+safe(tx.managerType)+'</small></td><td>'+
      (owner?safe(owner.persistenceUnit)+'<br><small>'+safe(owner.contextKey)+' · '+safe(owner.factoryId)+'</small>':'Ownership unavailable')+
      '</td><td>'+(tx.readOnly===null?'Unobserved':tx.readOnly?'Read only':'Read/write')+'</td>'+columns+'</tr>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
    <style nonce="${nonce}">
    body{padding:.75rem 1rem;font-family:var(--vscode-font-family)} h1{font-size:1.25rem}
    p,small{color:var(--vscode-descriptionForeground)} .observations{overflow-x:auto}
    table{width:100%;border-collapse:collapse} th,td{padding:.45rem .6rem;border:1px solid var(--vscode-panel-border);text-align:left;vertical-align:top;overflow-wrap:anywhere}
    th{background:var(--vscode-editorWidget-background)}
    </style></head><body><h1>${TITLE}</h1><p>${safe(message)}</p>
    ${rows?'<div class="observations"><table><thead><tr><th>Transaction</th><th>Manager</th><th>Persistence unit</th><th>Mode</th><th>Begin</th><th>Commit</th><th>Rollback</th><th>Cleanup</th></tr></thead><tbody>'+rows+'</tbody></table></div>':''}
    </body></html>`;
}
function registerTransactionTrace(vscode,options){
  return registerTracePanel(vscode,options,{viewId:VIEW,title:TITLE,inspect:'transactions',render:renderTransactionTrace});
}

module.exports={registerTransactionTrace,renderTransactionTrace};
