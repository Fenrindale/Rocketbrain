'use strict';

const defaults = { github:'https://api.github.com/', gitlab:'https://gitlab.com/api/v4/' };
const component = /^[A-Za-z0-9_.-]{1,100}$/;
const sha = /^[a-f0-9]{40}$/i;
const pageSize = 30;

function cleanPath(value) {
  if (typeof value!=='string'||value.length>480||!value.isWellFormed()||value.split('/').some(part=>
    !part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part))) throw Error('The review contains an invalid file path.');
  return value;
}

function reviewProfile({provider,repository,endpoint,token}={}) {
  if(!Object.hasOwn(defaults,provider)||typeof repository!=='string')throw Error('Choose a GitHub or GitLab repository.');
  const parts=repository.split('/');
  if(parts.length<2||parts.length>8||provider==='github'&&parts.length!==2||parts.some(part=>!component.test(part)||part==='.'||part==='..')) {
    throw Error('Use the repository owner and project path.');
  }
  let base;
  try{base=new URL(endpoint||defaults[provider]);}catch{throw Error('Use a valid API endpoint URL.');}
  if(!['https:','http:'].includes(base.protocol)||!base.hostname||base.username||base.password||base.search||base.hash) {
    throw Error('Use an HTTP API endpoint without credentials, query, or fragment.');
  }
  if(base.protocol==='http:'&&!['127.0.0.1','[::1]'].includes(base.hostname)) {
    throw Error('Use HTTPS for a remote review API.');
  }
  if(!base.pathname.endsWith('/'))base.pathname+='/';
  if(token!==undefined&&(typeof token!=='string'||token.length>2048||/[\x00-\x20\x7f]/.test(token)))throw Error('Enter a valid review access token.');
  const api=provider==='github'?`repos/${parts.map(encodeURIComponent).join('/')}/pulls`:
    `projects/${encodeURIComponent(repository)}/merge_requests`;
  return {provider,repository,base,api,token};
}

const clipped=(value,max)=>typeof value==='string'?value.slice(0,max):'';
const positive=value=>Number.isSafeInteger(value)&&value>0;
function requestCard(raw,provider) {
  const github=provider==='github', id=github?raw?.number:raw?.iid;
  const head=github?raw?.head?.sha:raw?.diff_refs?.head_sha||raw?.sha;
  const base=github?raw?.base?.sha:raw?.diff_refs?.base_sha;
  if(!positive(id)||!sha.test(head||''))throw Error('The review returned an invalid request identity.');
  return {id,head:String(head).toLowerCase(),base:sha.test(base||'')?String(base).toLowerCase():null,
    title:clipped(raw.title,400),body:clipped(github?raw.body:raw.description,8000),
    author:clipped(github?raw.user?.login:raw.author?.username,120),state:clipped(raw.state,60),
    draft:Boolean(github?raw.draft:raw.draft??raw.work_in_progress)};
}

function changedFile(raw,provider) {
  const github=provider==='github';
  const name=cleanPath(github?raw.filename:raw.new_path);
  const oldName=cleanPath(github?raw.previous_filename||raw.filename:raw.old_path||raw.new_path);
  const state=github?clipped(raw.status,30):raw.new_file?'added':raw.deleted_file?'removed':raw.renamed_file?'renamed':'modified';
  const patch=github?raw.patch:raw.diff;
  return {name,oldName,state,patch:typeof patch==='string'&&Buffer.byteLength(patch)<=65536?patch:null,
    limited:Boolean(raw.too_large||raw.collapsed||typeof patch!=='string'||Buffer.byteLength(patch)>65536)};
}

function mappedComment(raw,provider) {
  const github=provider==='github', file=github?raw.path:raw.position?.new_path;
  const line=github?raw.line:raw.position?.new_line;
  const revision=github?raw.commit_id:raw.position?.head_sha;
  return {body:clipped(raw.body,3000),author:clipped(github?raw.user?.login:raw.author?.username,120),
    file:file?cleanPath(file):null,line:positive(line)?line:null,head:sha.test(revision||'')?revision.toLowerCase():null,
    resolved:github?null:Boolean(raw.resolved)};
}

async function jsonResponse(response) {
  if(!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error('The review request failed (HTTP '+response.status+').'),{status:response.status});
  }
  let size=0;
  const chunks=[];
  for await(const chunk of response.body||[]) {
    size+=chunk.byteLength;
    if(size>4*1024*1024)throw Error('The review response exceeds 4 MiB.');
    chunks.push(Buffer.from(chunk));
  }
  try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}
  catch{throw Error('The review server did not return JSON.');}
}

function createReviewClient(input,{fetcher=fetch}={}) {
  const profile=reviewProfile(input), github=profile.provider==='github';
  async function get(relative,{signal,values}={}) {
    const url=new URL(relative,profile.base);
    if(url.origin!==profile.base.origin||!url.pathname.startsWith(profile.base.pathname))throw Error('The request escaped the selected review API.');
    for(const [key,value] of Object.entries(values||{}))url.searchParams.set(key,String(value));
    const deadline=AbortSignal.timeout(10000);
    const headers={Accept:'application/json',...(github&&{'X-GitHub-Api-Version':'2022-11-28'}),
      ...(profile.token&&(github?{Authorization:'Bearer '+profile.token}:{'PRIVATE-TOKEN':profile.token}))};
    let response;
    try{response=await fetcher(url,{method:'GET',headers,redirect:'error',signal:signal?AbortSignal.any([deadline,signal]):deadline});}
    catch{throw Error(signal?.aborted?'The review request was cancelled.':'The selected review API could not be reached.');}
    const value=await jsonResponse(response);
    return {value,more:/rel="next"/.test(response.headers.get('link')||'')||Boolean(response.headers.get('x-next-page'))};
  }

  async function list({signal,page=1}={}) {
    if(!positive(page)||page>20)throw Error('Select a review page from 1 to 20.');
    const result=await get(profile.api,{signal,values:{page,per_page:pageSize,state:github?'open':'opened'}});
    if(!Array.isArray(result.value)||result.value.length>pageSize)throw Error('The review server returned an invalid request list.');
    return {provider:profile.provider,repository:profile.repository,page,more:result.more,
      items:result.value.map(raw=>requestCard(raw,profile.provider))};
  }

  async function read(id,{expectedHead,signal}={}) {
    if(!positive(id))throw Error('Select a valid review number.');
    const stem=profile.api+'/'+id, before=requestCard((await get(stem,{signal})).value,profile.provider);
    if(before.id!==id||expectedHead&&before.head!==expectedHead)throw Error('The review head changed. Refresh the selected request.');
    const values={per_page:pageSize,page:1};
    const pipelinePath=github ? profile.api.replace(/\/pulls$/,'')+'/commits/'+before.head+'/check-runs' : stem+'/pipelines';
    const [files,comments,pipelines]=await Promise.all([
      get(stem+(github?'/files':'/diffs'),{signal,values}),
      get(stem+(github?'/comments':'/discussions'),{signal,values}),
      get(pipelinePath,{signal,values}).catch(error=>{
        if([403,404].includes(error.status))return null;
        throw error;
      })
    ]);
    const after=requestCard((await get(stem,{signal})).value,profile.provider);
    if(after.id!==id||after.head!==before.head||after.base!==before.base)throw Error('The review changed while loading its files. Refresh it.');
    if(!Array.isArray(files.value)||files.value.length>pageSize||!Array.isArray(comments.value)||comments.value.length>pageSize) {
      throw Error('The review server returned an invalid files or comments page.');
    }
    const notes=(github?comments.value:comments.value.flatMap(item=>Array.isArray(item.notes)?item.notes:[]));
    const parsedFiles=files.value.map(raw=>changedFile(raw,profile.provider));
    const checks=github?pipelines?.value?.check_runs:pipelines?.value;
    return {provider:profile.provider,repository:profile.repository,...after,files:parsedFiles,
      comments:notes.slice(0,100).map(raw=>mappedComment(raw,profile.provider)),
      pipelines:Array.isArray(checks)?checks.slice(0,30).map(check=>({name:clipped(check.name||check.ref,160),
        status:clipped(check.conclusion||check.status,60),id:positive(check.id)?check.id:null})):null,
      linkedIssueNumbers:[...new Set([...after.body.matchAll(/(?:^|\s)#([1-9]\d{0,8})\b/g)].map(match=>Number(match[1])))].slice(0,30),
      coverage:{moreFiles:files.more,moreComments:comments.more||notes.length>100,limitedPatches:parsedFiles.filter(file=>file.limited).length}};
  }
  return {list,read};
}

function patchTargetLines(patch) {
  if(typeof patch!=='string')return [];
  const result=[];
  let next=null;
  for(const [index,line] of patch.split(/\r?\n/).entries()) {
    const header=/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if(header){next=Number(header[1]);continue;}
    if(next===null)continue;
    if(line.startsWith('+')||line.startsWith(' '))result.push({line:next++,patchLine:index});
  }
  return result;
}

module.exports = { createReviewClient, reviewProfile, patchTargetLines };
