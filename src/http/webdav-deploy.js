'use strict';

const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { captureDirectory } = require('../remote/directory-snapshot');
const { parseCollection, properties } = require('./webdav-inventory');

const MAX_FILES = 20;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const lifetime = 10 * 60 * 1000;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const strongTag = value => typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);

function segments(relative) {
  if (typeof relative !== 'string' || !relative.isWellFormed() || relative.length > 480 ||
      relative.split('/').some(part => !part || part==='.' || part==='..' || /[\\:\x00-\x1f\x7f]/.test(part))) {
    throw Error('Use normalized relative paths with slash-separated folders.');
  }
  return relative.split('/');
}

function deploymentProfile(input) {
  let url;
  try { url = new URL(input.url); }
  catch { throw Error('Enter the HTTP or HTTPS URL of the WebDAV directory.'); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) {
    throw Error('Use a WebDAV directory URL without credentials, query, or fragment.');
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  const root = input.remoteDirectory ? segments(input.remoteDirectory).map(encodeURIComponent).join('/') + '/' : '';
  url.pathname += root;
  const user = input.user || '', password = input.password || '';
  if (typeof user !== 'string' || typeof password !== 'string' || user.length > 160 || password.length > 2048 || /[:\r\n\0]/.test(user)) {
    throw Error('Use a valid WebDAV username and password.');
  }
  const exclusions = input.exclusions || [];
  if (!Array.isArray(exclusions) || exclusions.length > 32 || exclusions.some(rule => typeof rule!=='string' || !rule.length ||
      rule.length>240 || rule.startsWith('/') || /[\\:\x00-\x1f]/.test(rule) || rule.split('/').includes('..'))) {
    throw Error('Use up to 32 workspace-relative exclusion patterns.');
  }
  return { url, authentication:user ? 'Basic '+Buffer.from(user+':'+password,'utf8').toString('base64') : undefined, exclusions:[...exclusions] };
}

async function readLocal(root, relative) {
  const candidate = await fs.realpath(path.join(root,...segments(relative)));
  const rep = path.relative(root,candidate);
  if (!rep || path.isAbsolute(rep) || rep === '..' || rep.startsWith('..'+path.sep)) throw Error('A local file escaped the selected root.');
  const file = await fs.open(candidate,'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) throw Error('Use regular files up to 2 MiB.');
    const buffer = Buffer.alloc(before.size+1);
    const {bytesRead}=await file.read(buffer,0,buffer.length,0);
    const bytes=buffer.subarray(0,bytesRead);
    const after = await file.stat();
    if (bytes.length > MAX_FILE_BYTES || bytes.length!==before.size || before.size!==after.size || before.mtimeMs!==after.mtimeMs) {
      throw Error('A local file changed while reading. Refresh the deployment review.');
    }
    return { bytes, sha256:hash(bytes) };
  } finally { await file.close(); }
}

async function remoteBytes(response, limit = MAX_FILE_BYTES) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw Error('The remote WebDAV response exceeds its size limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks = [];
  let count = 0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) return Buffer.concat(chunks,count);
      count += value.byteLength;
      if (count > limit) throw Error('The remote WebDAV response exceeds its size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}

function createWebDavDeployment({ fetcher=fetch, isTrusted=()=>true }={}) {
  const plans = new Map();
  let disposed = false, applying = false;
  const guard = () => { if (disposed || !isTrusted()) throw Error('Open a trusted workspace to review a WebDAV deployment.'); };

  async function send(profile, relative, method, { headers={},body,signal }={}) {
    guard();
    const url = relative === null ? profile.url : new URL(segments(relative).map(encodeURIComponent).join('/'),profile.url);
    if(url.origin!==profile.url.origin)throw Error('The deployment route is outside the approved server.');
    const deadline=AbortSignal.timeout(10000);
    return fetcher(url,{method,body,redirect:'error',signal:signal?AbortSignal.any([signal,deadline]):deadline,
      headers:{'Accept-Encoding':'identity',...(profile.authentication&&{Authorization:profile.authentication}),...headers}});
  }

  async function remote(profile, relative, signal) {
    const response = await send(profile,relative,'GET',{signal,headers:{'Cache-Control':'no-cache'}});
    if (response.status === 404) { await response.body?.cancel();return null; }
    if (response.status !== 200) { await response.body?.cancel();throw Error('WebDAV could not read the path (HTTP '+response.status+').'); }
    const bytes = await remoteBytes(response);
    return { bytes, sha256:hash(bytes), etag:response.headers.get('etag') };
  }

  async function snapshot(input, { signal } = {}) {
    guard();
    const profile = deploymentProfile(input);
    if (profile.url.protocol !== 'https:' && !['127.0.0.1', '[::1]'].includes(profile.url.hostname)) {
      throw Error('Use HTTPS for a remote WebDAV change review.');
    }
    const collection = async () => {
      const response = await send(profile, null, 'PROPFIND', {
        headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' },
        body: properties, signal,
      });
      if (response.status !== 207) {
        await response.body?.cancel();
        throw Error('WebDAV could not inspect the selected directory (HTTP ' + response.status + ').');
      }
      return parseCollection(await remoteBytes(response, 256 * 1024), profile.url);
    };
    const result = await captureDirectory(collection, async row => {
      const file = await remote(profile, row.name, signal);
      if (strongTag(row.tag) && (file?.etag !== row.tag)) throw Error('The WebDAV file validator changed during review.');
      return file;
    }, { excluded: name => profile.exclusions.some(rule => path.posix.matchesGlob(name, rule)), signal });
    guard();
    return { ...result, identity: ['webdav', profile.url.href, input.user ?? '', profile.exclusions] };
  }

  async function prepare(input,{signal}={}) {
    guard();
    const profile=deploymentProfile(input);
    const root=await fs.realpath(input.root);
    if (input.workspaceRoot) {
      const workspace=await fs.realpath(input.workspaceRoot), relative=path.relative(workspace,root);
      if(path.isAbsolute(relative) || relative==='..' || relative.startsWith('..'+path.sep)) throw Error('Choose a deployment directory inside this workspace.');
    }
    if (!Array.isArray(input.files) || !input.files.length || input.files.length>MAX_FILES || new Set(input.files).size!==input.files.length) {
      throw Error('Choose one to twenty distinct local files.');
    }
    const candidates=input.files.map(name=>segments(name).join('/'));
    const options=await send(profile,null,'OPTIONS',{signal});
    const advertised=options.headers.get('dav');
    await options.body?.cancel();
    if (!options.ok || !advertised?.split(',').some(value=>['1','2','3'].includes(value.trim()))) {
      throw Error('The selected directory did not identify a WebDAV endpoint.');
    }
    const files=[];
    let bytes=0;
    for(const name of candidates) {
      if(profile.exclusions.some(rule=>path.posix.matchesGlob(name,rule))) {files.push({name,state:'excluded'});continue;}
      const local=await readLocal(root,name), before=await remote(profile,name,signal);
      bytes += local.bytes.length + (before?.bytes.length || 0);
      if(bytes>MAX_BYTES)throw Error('Review no more than 16 MiB of local and remote data.');
      const state = !before ? 'create' : local.sha256===before.sha256 ? 'unchanged' : strongTag(before.etag) ? 'replace' : 'validator-unavailable';
      files.push({name,state,local,before});
    }
    guard();
    const id = randomUUID(), expires = Date.now()+lifetime;
    while(plans.size>=3)plans.delete(plans.keys().next().value);
    plans.set(id,{profile,root,files,expires,used:false});
    return {id,directory:profile.url.href,expires,files:files.map(({name,state,local,before})=>({name,state,
      local:local?.sha256||null,remote:before?.sha256||null}))};
  }

  function lookup(id) {
    guard();
    const plan=plans.get(id);
    if (!plan || plan.expires<Date.now()) throw Error('Open a fresh WebDAV deployment review.');
    return plan;
  }

  function compare(id,name) {
    const row=lookup(id).files.find(item=>item.name===name);
    if (!row?.local) throw Error('Choose a compared WebDAV file.');
    const text = bytes => {
      if(!bytes)return '';
      try {
        const result=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
        if(result.includes('\0'))throw Error();
        return result;
      } catch { return 'Binary file · '+bytes.length+' bytes · SHA-256 '+hash(bytes); }
    };
    return {name,state:row.state,remote:text(row.before?.bytes),local:text(row.local.bytes)};
  }

  async function apply(id,selection,{signal}={}) {
    if(applying)throw Error('A WebDAV deployment is already applying.');
    const plan=lookup(id);
    if(plan.used)throw Error('Create a fresh WebDAV deployment review.');
    if(!Array.isArray(selection)||!selection.length||new Set(selection).size!==selection.length)throw Error('Choose distinct reviewed files to upload.');
    const rows=selection.map(name=>plan.files.find(item=>item.name===name));
    if(rows.some(item=>!['create','replace'].includes(item?.state)))throw Error('Choose reviewed changed files with a valid remote condition.');
    applying=true;
    try {
      for(const row of rows) {
        if((await readLocal(plan.root,row.name)).sha256!==row.local.sha256)throw Error('A local file changed after review. Refresh the deployment.');
      }
      guard();
      plan.used=true;
      const results=rows.map(item=>({name:item.name,state:'unattempted'}));
      for(const [index,row] of rows.entries()) {
        if(signal?.aborted)break;
        const result=results[index];
        const condition=row.state==='create'?{'If-None-Match':'*'}:{'If-Match':row.before.etag};
        try {
          const response=await send(plan.profile,row.name,'PUT',{body:row.local.bytes,signal,headers:{...condition,'Content-Type':'application/octet-stream'}});
          result.httpStatus=response.status;
          await response.body?.cancel();
          if(response.status===412) {result.state='conflict';break;}
          if(!response.ok) {result.state='rejected';break;}
          if((await remote(plan.profile,row.name,signal))?.sha256!==row.local.sha256) {result.state='unconfirmed';break;}
          result.state='uploaded';
        } catch {
          result.state='unconfirmed';
          break;
        }
      }
      return {id,directory:plan.profile.url.href,files:results};
    } finally {applying=false;}
  }

  return {prepare,compare,apply,snapshot,dispose() {disposed=true;plans.clear();}};
}

module.exports = { createWebDavDeployment };
