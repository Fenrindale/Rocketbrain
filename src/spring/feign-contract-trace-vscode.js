'use strict';

const {randomBytes}=require('node:crypto');
const {registerTracePanel}=require('./security-trace-vscode');
const VIEW='rocketbrain.spring.feignContracts', TITLE='OpenFeign Runtime Contracts';
const safe=value=>String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]);

function renderFeignContracts(report) {
  const nonce=randomBytes(16).toString('base64');
  const status=report.state==='disabled'?'Enable feignContractTrace in the JVM observer configuration and restart the application.'
    :report.state==='unsupported'?'The loaded Feign proxy factory is outside the supported probe scope.'
    :report.clients.length?report.clients.length+' observed proxy contracts'+(report.dropped?' · '+report.dropped+' omitted':'')
    :'Waiting for a supported Feign proxy to be created. Run the command again to refresh.';
  const clients=report.clients.map(client=>{
    const methods=client.methods.map(method=>'<tr><td>'+safe(method.verb+' '+(method.path??method.template))+
      (method.path===null?'<small>Base path unavailable</small>':'')+'</td><td>'+safe(method.declaration+'.'+method.name+
      '('+method.parameters.join(', ')+')')+(method.inherited?'<small>Inherited</small>':'')+'</td></tr>').join('');
    return '<section><h2>'+safe(client.client)+'</h2><p>'+safe(client.contract)+'</p>'+
      (client.unavailable?'<p>'+client.unavailable+' method descriptions unavailable.</p>':'')+
      (methods?'<table><thead><tr><th>Route template</th><th>Declaring method</th></tr></thead><tbody>'+methods+'</tbody></table>':
        '<p>No supported method templates were captured.</p>')+'</section>';
  }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-'+nonce+'\'"><title>'+TITLE+'</title>'+
    '<style nonce="'+nonce+'">body{padding:1rem;font-family:var(--vscode-font-family)}h1{font-size:1.25rem}h2{font-size:1rem}'+
    'p,small{color:var(--vscode-descriptionForeground)}table{border-collapse:collapse;margin-bottom:1rem}th,td{padding:.45rem .6rem;'+
    'border:1px solid var(--vscode-panel-border);text-align:left;overflow-wrap:anywhere}small{display:block}</style></head>'+
    '<body><h1>'+TITLE+'</h1><p>'+safe(status)+'</p>'+clients+'</body></html>';
}

function registerFeignContracts(vscode,options) {
  return registerTracePanel(vscode,options,{viewId:VIEW,title:TITLE,inspect:'feignContracts',render:renderFeignContracts});
}

module.exports={registerFeignContracts,renderFeignContracts};
