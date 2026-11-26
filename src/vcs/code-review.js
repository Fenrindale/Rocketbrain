'use strict';

const { createHash, randomUUID } = require('node:crypto');

const defaults = { github:'https://api.github.com/', gitlab:'https://gitlab.com/api/v4/' };
const component = /^[A-Za-z0-9_.-]{1,100}$/;
const sha = /^[a-f0-9]{40}$/i;
const pageSize = 30, maxPages = 20;

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
const discussionId=value=>typeof value==='string'&&/^[a-f0-9]{40,64}$/i.test(value);
const commentBody=value=>typeof value==='string'&&value.trim()&&value.length<=3000&&value.isWellFormed();
function requestCard(raw,provider) {
  const github=provider==='github', id=github?raw?.number:raw?.iid;
  const head=github?raw?.head?.sha:raw?.diff_refs?.head_sha||raw?.sha;
  const base=github?raw?.base?.sha:raw?.diff_refs?.base_sha;
  if(!positive(id)||!sha.test(head||''))throw Error('The review returned an invalid request identity.');
  return {id,head:String(head).toLowerCase(),base:sha.test(base||'')?String(base).toLowerCase():null,
    ...(!github&&{start:sha.test(raw?.diff_refs?.start_sha||'')?raw.diff_refs.start_sha.toLowerCase():null}),
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

function mappedComment(raw,provider,thread) {
  const github=provider==='github', file=github?raw.path:raw.position?.new_path;
  const line=github?raw.line:raw.position?.new_line;
  const revision=github?raw.commit_id:raw.position?.head_sha;
  const id=positive(raw.id)?raw.id:null;
  const threadId=github?(positive(raw.in_reply_to_id)?raw.in_reply_to_id:id):discussionId(thread?.id)?thread.id:null;
  const editable=Boolean(id&&threadId&&!raw.system&&commentBody(raw.body));
  return {body:clipped(raw.body,3000),author:clipped(github?raw.user?.login:raw.author?.username,120),
    file:file?cleanPath(file):null,line:positive(line)?line:null,head:sha.test(revision||'')?revision.toLowerCase():null,
    resolved:github?null:Boolean(raw.resolved),
    ...(editable&&{id,threadId,updated:clipped(raw.updated_at,64)})};
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
  async function request(relative,{signal,values,body,method=body===undefined?'GET':'POST'}={}) {
    const url=new URL(relative,profile.base);
    if(url.origin!==profile.base.origin||!url.pathname.startsWith(profile.base.pathname))throw Error('The request escaped the selected review API.');
    for(const [key,value] of Object.entries(values||{}))url.searchParams.set(key,String(value));
    const deadline=AbortSignal.timeout(10000), writing=body!==undefined;
    const headers={Accept:'application/json',...(writing&&{'Content-Type':'application/json'}),...(github&&{'X-GitHub-Api-Version':'2022-11-28'}),
      ...(profile.token&&(github?{Authorization:'Bearer '+profile.token}:{'PRIVATE-TOKEN':profile.token}))};
    let response;
    try {
      response=await fetcher(url,{method,headers,redirect:'error',
        ...(writing&&{body:JSON.stringify(body)}),signal:signal?AbortSignal.any([deadline,signal]):deadline});
    } catch {
      if(writing) throw uncertainPublication();
      throw Error(signal?.aborted?'The review request was cancelled.':'The selected review API could not be reached.');
    }
    let value;
    try { value=await jsonResponse(response); }
    catch(error) {
      if(writing && !(error.status>=400 && error.status<500)) throw uncertainPublication();
      throw error;
    }
    return {value,more:/rel="next"/.test(response.headers.get('link')||'')||Boolean(response.headers.get('x-next-page'))};
  }

  async function list({signal,page=1}={}) {
    if(!positive(page)||page>maxPages)throw Error('Select a review page from 1 to 20.');
    const result=await request(profile.api,{signal,values:{page,per_page:pageSize,state:github?'open':'opened'}});
    if(!Array.isArray(result.value)||result.value.length>pageSize)throw Error('The review server returned an invalid request list.');
    return {provider:profile.provider,repository:profile.repository,page,more:result.more,
      items:result.value.map(raw=>requestCard(raw,profile.provider))};
  }

  async function read(id,{expectedHead,signal,filePage=1,commentPage=1}={}) {
    if(!positive(id))throw Error('Select a valid review number.');
    const stem=profile.api+'/'+id, before=requestCard((await request(stem,{signal})).value,profile.provider);
    if(before.id!==id||expectedHead&&before.head!==expectedHead)throw Error('The review head changed. Refresh the selected request.');
    if (![filePage,commentPage].every(page=>positive(page)&&page<=maxPages)) throw Error('Use review pages from 1 to 20.');
    const values={per_page:pageSize,page:1};
    const pipelinePath=github ? profile.api.replace(/\/pulls$/,'')+'/commits/'+before.head+'/check-runs' : stem+'/pipelines';
    const [files,comments,pipelines]=await Promise.all([
      request(stem+(github?'/files':'/diffs'),{signal,values:{...values,page:filePage}}),
      request(stem+(github?'/comments':'/discussions'),{signal,values:{...values,page:commentPage}}),
      request(pipelinePath,{signal,values}).catch(error=>{
        if([403,404].includes(error.status))return null;
        throw error;
      })
    ]);
    const after=requestCard((await request(stem,{signal})).value,profile.provider);
    if(after.id!==id||after.head!==before.head||after.base!==before.base||after.start!==before.start)throw Error('The review changed while loading its files. Refresh it.');
    if(!Array.isArray(files.value)||files.value.length>pageSize||!Array.isArray(comments.value)||comments.value.length>pageSize) {
      throw Error('The review server returned an invalid files or comments page.');
    }
    const notes=github?comments.value.map(note=>[note]):comments.value.flatMap(thread=>
      Array.isArray(thread.notes)?thread.notes.map(note=>[note,thread]):[]);
    const parsedFiles=files.value.map(raw=>changedFile(raw,profile.provider));
    const checks=github?pipelines?.value?.check_runs:pipelines?.value;
    return {provider:profile.provider,repository:profile.repository,...after,files:parsedFiles,
      comments:notes.slice(0,100).map(([note,thread])=>mappedComment(note,profile.provider,thread)),
      pipelines:Array.isArray(checks)?checks.slice(0,30).map(check=>({name:clipped(check.name||check.ref,160),
        status:clipped(check.conclusion||check.status,60),id:positive(check.id)?check.id:null})):null,
      linkedIssueNumbers:[...new Set([...after.body.matchAll(/(?:^|\s)#([1-9]\d{0,8})\b/g)].map(match=>Number(match[1])))].slice(0,30),
      filePage,commentPage,coverage:{moreFiles:files.more,moreComments:comments.more,limitedComments:notes.length>100,
        limitedPatches:parsedFiles.filter(file=>file.limited).length}};
  }

  const pending = new Map();
  async function observeDraft(draft,signal) {
    if (!draft || typeof draft.head!=='string'||!sha.test(draft.head)||!positive(draft.line)||
        typeof draft.body!=='string'||!draft.body.trim()||draft.body.length>3000) {
      throw Error('Select a local draft with an exact review revision and a comment.');
    }
    const fileName=cleanPath(draft.path);
    const observed=await read(draft.review,{expectedHead:draft.head,signal,filePage:draft.filePage??1});
    if(observed.state!==(github?'open':'opened')||!observed.base||!github&&!observed.start||
        draft.base&&draft.base!==observed.base||draft.start&&draft.start!==observed.start) {
      throw Error('The review is closed or its base changed. Inspect the current request.');
    }
    const files=observed.files.filter(file=>file.name===fileName && !file.limited);
    if(files.length!==1) throw Error('The selected file patch is no longer available on its observed page.');
    const file=files[0], targets=patchPositions(file.patch).filter(position=>position.line===draft.line);
    const patchSha=createHash('sha256').update(file.patch).digest('hex');
    if(targets.length!==1 || (draft.patchSha && draft.patchSha!==patchSha)) {
      throw Error('The selected patch line changed. Review the current patch.');
    }
    const target=targets[0];
    return {
      repository:profile.repository,provider:profile.provider,review:observed.id,
      base:observed.base,head:observed.head,start:observed.start??null,
      path:file.name, oldPath:file.oldName, oldLine:target.oldLine??null, line:target.line, patchSha, body:draft.body
    };
  }
  async function preparePublication(draft,{signal}={}) {
    if(!profile.token) throw Error('Save a repository review token with comment permissions before publishing.');
    const bound=structuredClone(draft);
    const observed=await observeDraft(bound,signal);
    const publicationId=randomUUID();
    for(const [id,entry] of pending) if(entry.expires<Date.now()) pending.delete(id);
    if(pending.size>=8) pending.delete(pending.keys().next().value);
    pending.set(publicationId,{draft:bound,observed,expires:Date.now()+120000});
    return {publicationId,...observed};
  }
  async function submitPublication(publicationId,{approved=false,signal,beforeDispatch}={}) {
    if(approved!==true) throw Error('Explicitly approve publishing this review draft.');
    const entry=pending.get(publicationId);
    pending.delete(publicationId);
    if(!entry||entry.expires<Date.now()) throw Error('Prepare a fresh review draft before publishing.');
    const current=await observeDraft(entry.draft,signal);
    if(JSON.stringify(current)!==JSON.stringify(entry.observed)) {
      throw Error('The approved review destination changed before publication.');
    }
    const body=github ? {body:current.body,commit_id:current.head,path:current.path,line:current.line,side:'RIGHT'} :
      {body:current.body,position:{position_type:'text',base_sha:current.base,start_sha:current.start,head_sha:current.head,
        old_path:current.oldPath,new_path:current.path,new_line:current.line,...(current.oldLine&&{old_line:current.oldLine})}};
    const target=profile.api+'/'+current.review+(github?'/comments':'/discussions');
    signal?.throwIfAborted();
    await beforeDispatch?.();
    signal?.throwIfAborted();
    const {value}=await request(target,{signal,body});
    const id=value?.id;
    if (!(github?positive(id):typeof id==='string'&&/^[a-f0-9]{40,64}$/i.test(id))) throw uncertainPublication();
    const posted=github?value:value.notes?.[0];
    if (posted?.body!==current.body || (github?
        posted.path!==current.path||posted.line!==current.line||posted.commit_id!==current.head :
        posted.position?.new_path!==current.path||posted.position?.new_line!==current.line||posted.position?.head_sha!==current.head)) {
      throw uncertainPublication();
    }
    return {state:'posted',provider:profile.provider,review:current.review,noteId:String(id)};
  }

  const reviewActions=new Map();
  async function observeAction({action,review,head,base,start=null,commentPage=1,note,body},signal) {
    if(!['approve','comment','request-changes','reply','edit'].includes(action)||(!github&&action==='request-changes')||
       (action==='approve'?body!==undefined&&(!github||!commentBody(body)):!commentBody(body))) {
      throw Error('Choose a supported review action and enter the required text.');
    }
    if(!sha.test(head||'')||!sha.test(base||'')||!github&&!sha.test(start||'')) {
      throw Error('Open the exact review revision before sending an action.');
    }
    const current=await read(review,{expectedHead:head,commentPage,signal});
    if(current.state!==(github?'open':'opened')||current.base!==base||(current.start??null)!==start) {
      throw Error('The review is closed or its base changed. Inspect the current request.');
    }
    if(action==='reply'||action==='edit') {
      if(!positive(note?.id)) throw Error('Choose a discussion note from the current review.');
      const latest=current.comments.find(item=>item.id===note.id&&item.threadId===note.threadId);
      if(!latest||JSON.stringify(latest)!==JSON.stringify(note)) {
        throw Error('The selected discussion note changed. Refresh the requested page.');
      }
    }
    return {action,review,head,base,start,repository:profile.repository,provider:profile.provider,note,body};
  }

  async function prepareAction(input,{signal}={}) {
    if(!profile.token) throw Error('Save a repository review token with write permissions.');
    const bound=structuredClone(input);
    const observed=await observeAction(bound,signal);
    const actionId=randomUUID();
    for(const [id,entry] of reviewActions) if(entry.expires<Date.now()) reviewActions.delete(id);
    if(reviewActions.size>=8) reviewActions.delete(reviewActions.keys().next().value);
    reviewActions.set(actionId,{input:bound,observed,expires:Date.now()+120000});
    return {actionId,...observed};
  }

  async function submitAction(actionId,{approved=false,signal,beforeDispatch}={}) {
    if(approved!==true) throw Error('Explicitly approve the selected review action.');
    const entry=reviewActions.get(actionId);
    reviewActions.delete(actionId);
    if(!entry||entry.expires<Date.now()) throw Error('Prepare a fresh review action.');
    const current=await observeAction(entry.input,signal);
    if(JSON.stringify(current)!==JSON.stringify(entry.observed)) throw Error('The approved review action changed.');
    const {action,review,head,note,body}=current;
    const stem=profile.api+'/'+review;
    let route, method='POST', payload, confirmed;
    if(action==='reply') {
      route=github?`${stem}/comments/${note.threadId}/replies`:`${stem}/discussions/${note.threadId}/notes`;
      payload={body};
      confirmed=value=>positive(value?.id)&&value.body===body&&(!github||value.in_reply_to_id===note.threadId);
    } else if(action==='edit') {
      route=github?`${profile.api}/comments/${note.id}`:`${stem}/discussions/${note.threadId}/notes/${note.id}`;
      method=github?'PATCH':'PUT';
      payload={body};
      confirmed=value=>value?.id===note.id&&value.body===body;
    } else if(github) {
      const decisions={approve:['APPROVE','APPROVED'],comment:['COMMENT','COMMENTED'],'request-changes':['REQUEST_CHANGES','CHANGES_REQUESTED']};
      const [event,state]=decisions[action];
      route=stem+'/reviews';
      payload={commit_id:head,event,...(body!==undefined&&{body})};
      confirmed=value=>positive(value?.id)&&value.state===state&&value.commit_id===head&&(body===undefined||value.body===body);
    } else if(action==='approve') {
      route=stem+'/approve';
      payload={sha:head};
      confirmed=value=>value?.iid===review&&Array.isArray(value.approved_by);
    } else {
      route=stem+'/discussions';
      payload={body};
      confirmed=value=>discussionId(value?.id)&&value.notes?.[0]?.body===body;
    }
    signal?.throwIfAborted();
    await beforeDispatch?.();
    signal?.throwIfAborted();
    const {value}=await request(route,{method,body:payload,signal});
    if(!confirmed(value)) throw uncertainPublication();
    return {state:'submitted',provider:profile.provider,review,action};
  }

  return {list,read,preparePublication,submitPublication,prepareAction,submitAction};
}

function uncertainPublication() {
  return Object.assign(new Error('The server did not confirm the review action. Refresh the remote discussion before sending it again.'),
    {code:'ROCKETBRAIN_REVIEW_PUBLICATION_UNKNOWN'});
}

function patchPositions(patch) {
  if(typeof patch!=='string') return [];
  const result=[];
  let previous=null, next=null, oldCount=0, newCount=0, hunkStart=0;
  for(const [index,line] of patch.split(/\r?\n/).entries()) {
    const header=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if(header) {
      if (oldCount || newCount) result.length=hunkStart;
      previous=Number(header[1]); oldCount=Number(header[2]??1);
      next=Number(header[3]); newCount=Number(header[4]??1);
      hunkStart=result.length;
      continue;
    }
    if(!oldCount && !newCount) continue;
    if(line.startsWith(' ') && oldCount && newCount) {
      result.push({line:next++,patchLine:index,oldLine:previous++}); oldCount--; newCount--;
    } else if(line.startsWith('+') && newCount) {
      result.push({line:next++,patchLine:index}); newCount--;
    } else if(line.startsWith('-') && oldCount) {
      previous++; oldCount--;
    } else if(line && line!=='\\ No newline at end of file') {
      result.length=hunkStart;
      oldCount=newCount=0;
    }
  }
  if (oldCount || newCount) result.length=hunkStart;
  return result;
}

function patchTargetLines(patch) {
  return patchPositions(patch).map(({line,patchLine})=>({line,patchLine}));
}

module.exports = { createReviewClient, reviewProfile, patchTargetLines };
