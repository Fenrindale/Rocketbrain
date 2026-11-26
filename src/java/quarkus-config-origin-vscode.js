'use strict';

const {randomBytes}=require('node:crypto');
const {registerTracePanel}=require('../spring/security-trace-vscode');

const VIEW='rocketbrain.quarkus.inspectConfigOrigins', TITLE='Quarkus Configuration Origins';
const safe=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);
const labels={'classpath-properties':'Packaged properties','file-properties':'Properties file',environment:'Environment',
  system:'JVM system properties',default:'Mapping default',other:'Other configuration source',unavailable:'Origin unavailable'};

function renderQuarkusConfigOrigins(report){
  const nonce=randomBytes(16).toString('base64');
  const text=report.state==='disabled'?'List the keys in quarkusConfigOriginKeys in the local observer configuration and restart the application.'
    :report.state==='waiting'?'Waiting for a supported SmallRye Config lookup.'
      :report.state==='partial'?'The observer has partial coverage of configuration contexts.'
        :!report.contexts.length?'No approved key lookup has been observed.':'Showing origins reported by the running SmallRye Config instance.';
  const rows=report.contexts.map(context=>{
    const origins=new Map(context.origins.map(row=>[row.key,row]));
    return '<section><h2>'+safe(context.id)+'</h2><p>Active profiles '+safe(context.activeProfiles.join(', ')||'Unavailable')+
      '</p><table><thead><tr><th>Key</th><th>Source</th><th>Ordinal</th><th>Selected profile</th></tr></thead><tbody>'+
      report.keys.map(key=>{
        const origin=origins.get(key);
        const source=origin?labels[origin.kind]+(origin.file?' · '+origin.file:'')+(origin.line?' · line '+origin.line:''):'Lookup not observed';
        return '<tr><th scope="row">'+safe(key)+'</th><td>'+safe(source)+'</td><td>'+safe(origin?.ordinal??'')+'</td><td>'+
          safe(origin?.selectedProfile??'')+'</td></tr>';
      }).join('')+'</tbody></table></section>';
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>${TITLE}</title>
  <style nonce="${nonce}">body{padding:.75rem 1rem;font-family:var(--vscode-font-family)}
  h1{font-size:1.25rem} h2{font-size:1rem} p{color:var(--vscode-descriptionForeground)}
  section{margin-top:1rem;overflow-x:auto} table{border-collapse:collapse;width:100%}
  th,td{padding:.4rem .6rem;vertical-align:top;text-align:left;overflow-wrap:anywhere;border:1px solid var(--vscode-panel-border)}
  thead{background:var(--vscode-editorWidget-background)}</style></head>
  <body><h1>${TITLE}</h1><p>${safe(text)}</p>${rows}</body></html>`;
}

function registerQuarkusConfigOrigins(vscode,options){
  return registerTracePanel(vscode,options,{viewId:VIEW,title:TITLE,inspect:'quarkusConfigOrigins',render:renderQuarkusConfigOrigins});
}

module.exports={registerQuarkusConfigOrigins,renderQuarkusConfigOrigins};
