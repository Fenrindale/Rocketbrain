'use strict';

const options=new Set(['tokenUrl','clientId','clientSecret','scope']);
const localHost=new Set(['127.0.0.1','[::1]']);
const bearer=/^[A-Za-z0-9._~+/-]+=*$/;
const scopeSyntax=/^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const tokenResponseLimit=32*1024;
const size=value=>Buffer.byteLength(value,'utf8');

function parseClientCredentials(input) {
  const invalid=()=>Error('Use @oauth-client with a tokenUrl, clientId, Secret Storage clientSecret and optional scope.');
  if (size(input)>4096) throw invalid();
  let value;
  try { value=JSON.parse(input); } catch { throw invalid(); }
  if (!value||typeof value!=='object'||Array.isArray(value)||
      Object.keys(value).some(key=>!options.has(key))||
      !['tokenUrl','clientId','clientSecret'].every(key=>typeof value[key]==='string'&&value[key].length>0)||
      value.scope!==undefined&&typeof value.scope!=='string'||
      !/^\{\{secret\.[A-Za-z_][A-Za-z0-9_.-]{0,71}\}\}$/.test(value.clientSecret)) throw invalid();
  return value;
}

async function resolveClientCredentials(draft,resource,expand) {
  let tokenURL;
  const target=await expand(draft.tokenUrl,false);
  try { tokenURL=new URL(target); } catch { throw Error('Use an absolute OAuth token endpoint.'); }
  const sameLocal=resource.protocol==='http:'&&tokenURL.origin===resource.origin&&localHost.has(resource.hostname);
  if (size(target)>2048||tokenURL.username||tokenURL.password||tokenURL.hash||/[\r\n\t]|\{\{|\}\}/.test(target)||
      !sameLocal&&(tokenURL.protocol!=='https:'||resource.protocol!=='https:')) {
    throw Error('Use HTTPS for both OAuth endpoints, or the same literal loopback HTTP origin for development.');
  }
  const clientId=await expand(draft.clientId,false);
  const scope=draft.scope===undefined?'':await expand(draft.scope,false);
  if (!clientId||size(clientId)>512||/[\x00-\x1f\x7f]/.test(clientId)||
      scope&&(size(scope)>512||!scopeSyntax.test(scope))) {
    throw Error('Choose a bounded OAuth client ID and space-delimited scope.');
  }
  const clientSecret=await expand(draft.clientSecret,true);
  if (/[\x00-\x1f\x7f]/.test(clientSecret)) throw Error('The OAuth client secret contains an unsupported character.');
  return {tokenURL,clientId,clientSecret,scope};
}

function formPart(value) { return new URLSearchParams([['v',value]]).toString().slice(2); }

async function fetchAccessToken({tokenURL,clientId,clientSecret,scope},{fetcher,signal}) {
  const body=new URLSearchParams({grant_type:'client_credentials'});
  if (scope) body.set('scope',scope);
  const basic=Buffer.from(formPart(clientId)+':'+formPart(clientSecret),'utf8').toString('base64');
  let response;
  try {
    response=await fetcher(tokenURL,{method:'POST',redirect:'error',signal,body,
      headers:{Authorization:'Basic '+basic,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'}});
  } catch {
    throw Error('Unable to reach the OAuth token endpoint without following redirects.');
  }
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'') || !response.body) {
    await response.body?.cancel();
    throw Error('The OAuth token endpoint did not return a JSON token (HTTP '+response.status+').');
  }
  const reader=response.body.getReader(), chunks=[];
  let bytes=0;
  try {
    for (;;) {
      const {done,value}=await reader.read();
      if (done) break;
      bytes+=value.length;
      if (bytes>tokenResponseLimit) {
        await reader.cancel();
        throw Error('The OAuth token response exceeds 32 KiB.');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let data;
  try { data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks,bytes))); }
  catch { throw Error('The OAuth token response is invalid JSON.'); }
  const token=data?.access_token;
  if (typeof token!=='string'||token.length>8192||!bearer.test(token)||
      typeof data?.token_type!=='string'||data.token_type.toLowerCase()!=='bearer') {
    throw Error('The OAuth token endpoint did not return a usable Bearer token.');
  }
  return token;
}

module.exports={parseClientCredentials,resolveClientCredentials,fetchAccessToken};
