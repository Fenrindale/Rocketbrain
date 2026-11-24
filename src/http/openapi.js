'use strict';

const methods=['get','head','post','put','patch','delete','options'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const owns=(value,key)=>object(value)&&Object.hasOwn(value,key);
const token=/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const limit=1024*1024;

function localReference(document,value) {
  const seen=new Set();
  while (owns(value,'$ref')) {
    const reference=value.$ref;
    if (typeof reference!=='string' || !reference.startsWith('#/') || seen.has(reference) || seen.size>=12) {
      throw Error('This item requires a local, acyclic JSON pointer.');
    }
    if (Object.keys(value).some(key=>!['$ref','summary','description'].includes(key))) {
      throw Error('This reference has additional operation or parameter fields.');
    }
    seen.add(reference);
    let decoded;
    try { decoded=decodeURIComponent(reference.slice(1)); }
    catch { throw Error('The local reference has an invalid pointer.'); }
    let target=document;
    for (const segment of decoded.slice(1).split('/')) {
      if (/~(?![01])/.test(segment)) throw Error('The local reference has an invalid pointer escape.');
      const key=segment.replaceAll('~1','/').replaceAll('~0','~');
      if (target===null || typeof target!=='object' || !Object.hasOwn(target,key)) throw Error('The local reference target is missing.');
      target=target[key];
    }
    value=target;
  }
  if (!object(value)) throw Error('The referenced entry must be an object.');
  return value;
}

function params(document, inputs) {
  if (inputs===undefined) return [];
  if (!Array.isArray(inputs)||inputs.length>40) throw Error('This entry has more than 40 parameters or an invalid parameter list.');
  const names=new Set();
  return inputs.map(input=>{
    const item=localReference(document,input);
    if (typeof item.name!=='string'||!token.test(item.name)||!['path','query','header','cookie'].includes(item.in)) {
      throw Error('Use a supported path, query, header or cookie parameter name.');
    }
    const key=item.in+':'+(item.in==='header'?item.name.toLowerCase():item.name);
    if (names.has(key)) throw Error('This parameter is duplicated.');
    names.add(key);
    if (item.in==='path'&&item.required!==true) throw Error('Path parameters require required:true.');
    return { key,name:item.name,in:item.in,required:item.required===true,
      type:typeof item.schema?.type==='string'?item.schema.type:'unspecified' };
  });
}

function serverUrls(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0,24).flatMap(item=>{
    if (!object(item)||typeof item.url!=='string'||item.url.length>2048) return [];
    return [item.url];
  });
}

function analyzeOpenApi(text) {
  if (typeof text!=='string'||Buffer.byteLength(text)>limit) throw Error('OpenAPI JSON documents are limited to 1 MiB.');
  let document;
  try { document=JSON.parse(text.replace(/^\uFEFF/,'')); } catch { throw Error('OpenAPI preview requires valid JSON.'); }
  if (!object(document)||!/^3\.[01]\.\d+$/.test(document.openapi)||!object(document.info)||!object(document.paths)) {
    throw Error('Use an OpenAPI 3.0 or 3.1 JSON description with info and paths.');
  }
  const entries=Object.entries(document.paths).filter(([path])=>!path.startsWith('x-'));
  if (entries.length>256) throw Error('OpenAPI preview is limited to 256 paths.');
  const operations=[],diagnostics=[];
  const paths=new Set(), ids=new Set();
  for (const [path,input] of entries) {
    if (!/^\/(?!\/)[^?\x00-\x20#\\]*$/.test(path)||path.length>2048) {
      diagnostics.push({path,message:'Use an absolute API path component without query or fragment.'});
      continue;
    }
    const pathKey=path.replace(/\{[^}]*\}/g,'{}');
    if (paths.has(pathKey)) {
      diagnostics.push({path,message:'A path with the same template shape already exists.'});
      continue;
    }
    paths.add(pathKey);
    let pathItem;
    try { pathItem=localReference(document,input); }
    catch(error) { diagnostics.push({path,message:error.message}); continue; }
    for (const method of methods) {
      if (!owns(pathItem,method)) continue;
      try {
        const entry=pathItem[method];
        if (!object(entry)||!object(entry.responses)) throw Error('An operation requires a responses mapping.');
        const id=typeof entry.operationId==='string'?entry.operationId.slice(0,120):null;
        if (id && ids.has(id)) throw Error('The operationId is duplicated.');
        const parameters=new Map(params(document,pathItem.parameters).map(item=>[item.key,item]));
        for (const item of params(document,entry.parameters)) parameters.set(item.key,item);
        const pathParams=[...path.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]);
        if (/[{}]/.test(path.replace(/\{[^{}]+\}/g,'')) ||
            pathParams.some(name=>!parameters.has('path:'+name)) ||
            [...parameters.values()].some(item=>item.in==='path'&&!pathParams.includes(item.name))) {
          throw Error('Every path placeholder must have the corresponding required parameter.');
        }
        const body=entry.requestBody===undefined?null:localReference(document,entry.requestBody);
        const jsonBody=body?.content?.['application/json'];
        const statuses=Object.keys(entry.responses).filter(key=>/^[1-5](?:\d\d|XX)$/.test(key)||key==='default');
        if (!statuses.length) throw Error('The operation must declare at least one response status.');
        operations.push({key:method.toUpperCase()+' '+path,method:method.toUpperCase(),path,id,
          summary:typeof entry.summary==='string'?entry.summary.slice(0,180):'',
          parameters:[...parameters.values()],statuses,servers:serverUrls(entry.servers ?? pathItem.servers ?? document.servers),
          requestBody:body?{required:body.required===true,json:object(jsonBody),example:jsonBody?.example}:null,
          security:(entry.security ?? document.security)?.length>0 });
        if (id) ids.add(id);
        if (operations.length>512) throw Error('OpenAPI preview is limited to 512 operations.');
      } catch(error) {
        if (operations.length>512) throw error;
        diagnostics.push({path,method,message:error.message});
      }
    }
  }
  const title=typeof document.info.title==='string'?document.info.title.trim().slice(0,120):'OpenAPI';
  return {version:document.openapi,title,operations,diagnostics};
}

function requestTemplate(operation, baseVariable='baseUrl') {
  if (!token.test(baseVariable)||baseVariable.startsWith('secret.')) throw Error('Choose an ordinary HTTP base URL variable.');
  if (operation.requestBody?.required&&!operation.requestBody.json) throw Error('This operation requires a body outside the JSON request generator.');
  const header=operation.parameters.filter(item=>item.required&&item.in==='header');
  const illegal=new Set(['host','content-length','connection','transfer-encoding','expect','upgrade']);
  if (header.some(item=>illegal.has(item.name.toLowerCase()))) throw Error('This operation requires a controlled HTTP header.');
  const variables=new Set([baseVariable]);
  let url='{{'+baseVariable+'}}'+operation.path.replace(/\{([^{}]+)\}/g,(_,name)=>{
    const key='path_'+name;
    variables.add(key);
    return '{{'+key+'}}';
  });
  const query=operation.parameters.filter(item=>item.required&&item.in==='query');
  for (const item of query) variables.add('query_'+item.name);
  if (query.length) url+='?'+query.map(item=>encodeURIComponent(item.name)+'={{query_'+item.name+'}}').join('&');
  for (const item of header) variables.add('header_'+item.name);
  const settings=[...variables].map(name=>'# Provide @'+name+' using a literal value or the HTTP environment.');
  if (operation.security) settings.push('# Review the declared security requirements and add any authorization headers.');
  const cookies=operation.parameters.filter(item=>item.required&&item.in==='cookie');
  if (cookies.length) settings.push('# Add Cookie values for '+cookies.map(item=>item.name).join(', ')+'.');
  const success=operation.statuses.find(value=>/^2\d\d$/.test(value));
  if (success) settings.push('# @expect status '+success);
  const lines=[...settings,operation.method+' '+url,...header.map(item=>item.name+': {{header_'+item.name+'}}')];
  if (operation.requestBody?.json&&!['GET','HEAD'].includes(operation.method)) {
    lines.push('Content-Type: application/json','',JSON.stringify(operation.requestBody.example ?? {},null,2));
  }
  const result=lines.join('\n')+'\n';
  if (Buffer.byteLength(result)>128*1024) throw Error('The HTTP template exceeds 128 KiB.');
  return result;
}

module.exports={analyzeOpenApi,requestTemplate};
