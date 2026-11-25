'use strict';

const {schemaDescriptions}=require('./openapi-schema-shapes');

const methods=['get','head','post','put','patch','delete','options'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const owns=(value,key)=>object(value)&&Object.hasOwn(value,key);
const token=/^[A-Za-z_][A-Za-z0-9_.-]{0,59}$/;
const limit=1024*1024;
const maxReferenceFiles=24;
const maxDescriptionBytes=4*limit;

function parseDescription(text,format) {
  if (typeof text!=='string'||Buffer.byteLength(text)>limit) throw Error('OpenAPI descriptions are limited to 1 MiB per file.');
  if (format==='json') {
    try { return {value:JSON.parse(text.replace(/^\uFEFF/,'')),ranges:new Map()}; }
    catch { throw Error('OpenAPI preview requires valid JSON.'); }
  }
  if (format!=='yaml') throw Error('Open an OpenAPI JSON or YAML description.');
  const {isMap,parseDocument}=require('yaml');
  try {
    const document=parseDocument(text,{version:'1.2',schema:'core',uniqueKeys:true,intAsBigInt:true});
    if (document.errors.length||document.warnings.length) throw Error();
    const value=document.toJS({maxAliasCount:0});
    const pending=[value];
    let count=0;
    while (pending.length) {
      const current=pending.pop();
      if (current===null||typeof current!=='object') continue;
      for (const key of Object.keys(current)) {
        const item=current[key];
        if (++count>100000) throw Error();
        if (typeof item==='bigint') {
          if (item>BigInt(Number.MAX_SAFE_INTEGER)||item<BigInt(Number.MIN_SAFE_INTEGER)) throw Error();
          current[key]=Number(item);
        } else if (typeof item==='number'&&!Number.isFinite(item)) throw Error();
        else if (item!==null&&typeof item==='object') pending.push(item);
      }
    }
    const paths=document.get('paths',true),ranges=new Map();
    if (isMap(paths)) for (const item of paths.items) {
      if (typeof item.key?.value==='string'&&item.key.range) {
        ranges.set(item.key.value,{start:item.key.range[0],end:item.key.range[1]});
      }
    }
    return {value,ranges};
  } catch { throw Error('Use one OpenAPI YAML document with unique keys and exact JSON-compatible values, without aliases or unsupported tags.'); }
}

function pointerTarget(document,fragment,schema) {
  let pointer;
  try { pointer=decodeURIComponent(fragment); }
  catch { throw Error('The OpenAPI reference has an invalid JSON pointer.'); }
  if (pointer&&!pointer.startsWith('/')) throw Error('Use a JSON pointer fragment in this OpenAPI reference.');
  let target=document;
  const checkBase=()=>{
    if (schema&&owns(target,'$id')) throw Error('A schema with a custom base URI requires a full JSON Schema resolver.');
  };
  checkBase();
  for (const segment of pointer?pointer.slice(1).split('/'):[]) {
    if (/~(?![01])/.test(segment)) throw Error('The OpenAPI reference has an invalid pointer escape.');
    const key=segment.replaceAll('~1','/').replaceAll('~0','~');
    if (target===null||typeof target!=='object'||!Object.hasOwn(target,key)) throw Error('The OpenAPI reference target is missing.');
    target=target[key];
    checkBase();
  }
  return {target,pointer};
}

function referenceResolver(document,sourceId,bytes,loadReference) {
  const root={id:sourceId,value:document};
  const documents=new Map([[sourceId,root]]),routes=new Map();
  function external(frame,reference) {
    if (!loadReference) throw Error('This item requires a local, acyclic JSON pointer.');
    const key=frame.id+'\0'+reference;
    if (routes.has(key)) {
      const cached=routes.get(key);
      if (cached.error) throw cached.error;
      return cached.frame;
    }
    if (routes.size>=96) throw Error('OpenAPI preview is limited to 96 reference paths.');
    try {
      const loaded=loadReference(reference,frame.id);
      if (typeof loaded?.id!=='string'||!['json','yaml'].includes(loaded.format)||typeof loaded.text!=='string') {
        throw Error('The referenced OpenAPI file is unavailable.');
      }
      if (!documents.has(loaded.id)) {
        if (documents.size>=maxReferenceFiles||bytes+Buffer.byteLength(loaded.text)>maxDescriptionBytes) {
          throw Error('OpenAPI preview is limited to 24 files and 4 MiB of source.');
        }
        const {value}=parseDescription(loaded.text,loaded.format);
        bytes+=Buffer.byteLength(loaded.text);
        documents.set(loaded.id,{id:loaded.id,value});
      }
      const result=documents.get(loaded.id);
      routes.set(key,{frame:result});
      return result;
    } catch (error) {
      routes.set(key,{error});
      throw error;
    }
  }
  function resolve(value,frame=root,{schema=false}={}) {
    const seen=new Set();
    while (owns(value,'$ref')) {
      const reference=value.$ref;
      if (typeof reference!=='string'||!reference||reference.length>2048||seen.size>=12) {
        throw Error('Use an acyclic OpenAPI reference chain of at most 12 links.');
      }
      if (Object.keys(value).some(key=>!['$ref','summary','description'].includes(key))) {
        throw Error('This reference has additional operation, parameter or schema fields.');
      }
      const delimiter=reference.indexOf('#');
      const file=delimiter<0?reference:reference.slice(0,delimiter);
      const fragment=delimiter<0?'':reference.slice(delimiter+1);
      if (file) frame=external(frame,file);
      const {target,pointer}=pointerTarget(frame.value,fragment,schema);
      const key=frame.id+'\0'+pointer;
      if (seen.has(key)) throw Error('Use an acyclic OpenAPI reference chain of at most 12 links.');
      seen.add(key);value=target;
    }
    if (!object(value)) throw Error('The referenced entry must be an object.');
    return {value,frame};
  }
  return resolve;
}

function params(resolve,frame,inputs) {
  if (inputs===undefined) return [];
  if (!Array.isArray(inputs)||inputs.length>40) throw Error('This entry has more than 40 parameters or an invalid parameter list.');
  const names=new Set();
  return inputs.map(input=>{
    const {value:item,frame:itemFrame}=resolve(input,frame);
    if (typeof item.name!=='string'||!token.test(item.name)||!['path','query','header','cookie'].includes(item.in)) {
      throw Error('Use a supported path, query, header or cookie parameter name.');
    }
    const key=item.in+':'+(item.in==='header'?item.name.toLowerCase():item.name);
    if (names.has(key)) throw Error('This parameter is duplicated.');
    names.add(key);
    if (item.in==='path'&&item.required!==true) throw Error('Path parameters require required:true.');
    const schema=object(item.schema)?resolve(item.schema,itemFrame,{schema:true}).value:undefined;
    const type=typeof schema?.type==='string'?schema.type:Array.isArray(schema?.type)&&
      schema.type.length<=8&&schema.type.every(value=>typeof value==='string')?schema.type.join(' | '):'unspecified';
    return {key,name:item.name,in:item.in,required:item.required===true,type,
      ...(owns(item,'style')&&{style:item.style}),...(owns(item,'allowReserved')&&{allowReserved:item.allowReserved})};
  });
}

function serverUrls(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0,24).flatMap(item=>{
    if (!object(item)||typeof item.url!=='string'||item.url.length>2048) return [];
    return [item.url];
  });
}

function analyzeOpenApi(text,{format='json',sourceId='entry',loadReference}={}) {
  const {value:document,ranges}=parseDescription(text,format);
  if (!object(document)||!/^3\.[01]\.\d+$/.test(document.openapi)||!object(document.info)||!object(document.paths)) {
    throw Error('Use an OpenAPI 3.0 or 3.1 description with info and paths.');
  }
  const resolve=referenceResolver(document,sourceId,Buffer.byteLength(text),loadReference);
  const describe=schemaDescriptions(resolve);
  const entries=Object.entries(document.paths).filter(([path])=>!path.startsWith('x-'));
  if (entries.length>256) throw Error('OpenAPI preview is limited to 256 paths.');
  const operations=[],diagnostics=[];
  const diagnose=(path,message,method)=>{
    const range=ranges.get(path);
    diagnostics.push({path,...(method&&{method}),message,...(range&&{range})});
  };
  const paths=new Set(), ids=new Set();
  for (const [path,input] of entries) {
    if (!/^\/(?!\/)[^?\x00-\x20#\\]*$/.test(path)||path.length>2048) {
      diagnose(path,'Use an absolute API path component without query or fragment.');
      continue;
    }
    const pathKey=path.replace(/\{[^}]*\}/g,'{}');
    if (paths.has(pathKey)) {
      diagnose(path,'A path with the same template shape already exists.');
      continue;
    }
    paths.add(pathKey);
    let pathItem,frame;
    try { ({value:pathItem,frame}=resolve(input)); }
    catch(error) { diagnose(path,error.message); continue; }
    for (const method of methods) {
      if (!owns(pathItem,method)) continue;
      try {
        const entry=pathItem[method];
        if (!object(entry)||!object(entry.responses)) throw Error('An operation requires a responses mapping.');
        const id=typeof entry.operationId==='string'?entry.operationId.slice(0,120):null;
        if (id && ids.has(id)) throw Error('The operationId is duplicated.');
        const parameters=new Map(params(resolve,frame,pathItem.parameters).map(item=>[item.key,item]));
        for (const item of params(resolve,frame,entry.parameters)) parameters.set(item.key,item);
        const pathParams=[...path.matchAll(/\{([^{}]+)\}/g)].map(match=>match[1]);
        if (/[{}]/.test(path.replace(/\{[^{}]+\}/g,'')) ||
            pathParams.some(name=>!parameters.has('path:'+name)) ||
            [...parameters.values()].some(item=>item.in==='path'&&!pathParams.includes(item.name))) {
          throw Error('Every path placeholder must have the corresponding required parameter.');
        }
        const request=entry.requestBody===undefined?null:resolve(entry.requestBody,frame);
        const body=request?.value;
        const jsonBody=body?.content?.['application/json'];
        let example=jsonBody?.example;
        let requestSchema;
        if (jsonBody?.schema!==undefined) {
          try {
            requestSchema=describe(jsonBody.schema,request.frame);
            if (example===undefined&&object(jsonBody.schema)) {
              const schema=resolve(jsonBody.schema,request.frame,{schema:true}).value;
              example=owns(schema,'example')?schema.example:Array.isArray(schema.examples)?schema.examples[0]:undefined;
            }
          } catch (error) { diagnose(path,error.message,method); }
        }
        const statuses=Object.keys(entry.responses).filter(key=>/^[1-5](?:\d\d|XX)$/.test(key)||key==='default');
        if (!statuses.length) throw Error('The operation must declare at least one response status.');
        const responseBodies=[];
        for (const status of statuses.slice(0,12)) {
          try {
            const response=resolve(entry.responses[status],frame);
            const schema=response.value.content?.['application/json']?.schema;
            if (schema!==undefined) responseBodies.push({status,schema:describe(schema,response.frame)});
          } catch (error) { diagnose(path,error.message,method); }
        }
        operations.push({key:method.toUpperCase()+' '+path,method:method.toUpperCase(),path,id,
          summary:typeof entry.summary==='string'?entry.summary.slice(0,180):'',
          parameters:[...parameters.values()],statuses,servers:serverUrls(entry.servers ?? pathItem.servers ?? document.servers),
          requestBody:body?{required:body.required===true,json:object(jsonBody),example,...(requestSchema&&{schema:requestSchema})}:null,
          ...(responseBodies.length&&{responseBodies}),
          security:(entry.security ?? document.security)?.length>0 });
        if (id) ids.add(id);
        if (operations.length>512) throw Error('OpenAPI preview is limited to 512 operations.');
      } catch(error) {
        if (operations.length>512) throw error;
        diagnose(path,error.message,method);
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
    const example=operation.requestBody.example;
    lines.push('Content-Type: application/json','',JSON.stringify(example===undefined?{}:example,null,2));
  }
  const result=lines.join('\n')+'\n';
  if (Buffer.byteLength(result)>128*1024) throw Error('The HTTP template exceeds 128 KiB.');
  return result;
}

module.exports={analyzeOpenApi,requestTemplate};
