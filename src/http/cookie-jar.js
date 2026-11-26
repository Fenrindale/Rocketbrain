'use strict';

const jarName=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const cookieName=/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]{1,128}$/;
const cookieValue=/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/;
const maxJars=16,maxCookies=32,maxHeader=8192;

function pathMatches(path,scope) {
  return path===scope || path.startsWith(scope) && (scope.endsWith('/')||path.charAt(scope.length)==='/');
}

function candidate(line,url,now) {
  if (typeof line!=='string'||Buffer.byteLength(line)>4096||/[\x00-\x1f\x7f]/.test(line)) return null;
  const [pair,...attributes]=line.split(';');
  const separator=pair.indexOf('=');
  if (separator<1) return null;
  const name=pair.slice(0,separator).trim();
  const value=pair.slice(separator+1).trim();
  if (!cookieName.test(name)||!cookieValue.test(value)) return null;
  const attrs=new Map();
  for (const item of attributes) {
    const [raw,...parts]=item.trim().split('=');
    attrs.set(raw.toLowerCase(),parts.join('='));
  }
  const scope=attrs.get('path');
  const path=scope?.startsWith('/')&&scope.length<=512?scope:url.pathname.slice(0,url.pathname.lastIndexOf('/'))||'/';
  const secure=attrs.has('secure');
  const allowed=!attrs.has('domain')&&(!secure||url.protocol==='https:')&&
    (!name.startsWith('__Secure-')||secure)&&(!name.startsWith('__Host-')||secure&&scope==='/');
  let expires=Infinity;
  if (/^-?\d{1,15}$/.test(attrs.get('max-age')||'')) expires=now+Number(attrs.get('max-age'))*1000;
  else if (attrs.has('expires')) {
    const date=Date.parse(attrs.get('expires'));
    if (Number.isFinite(date)) expires=date;
  }
  return {name,value,path,expires,allowed};
}

class HttpCookieJars {
  constructor(now=Date.now) {this.now=now;this.jars=new Map();this.closed=false;}

  session(owner,environment,name,url) {
    if (this.closed||typeof name!=='string'||!jarName.test(name)||!['http:','https:'].includes(url.protocol)) {
      throw Error('Choose a named cookie jar for an HTTP request.');
    }
    const key=JSON.stringify([owner,environment,name,url.origin]);
    const existing=this.jars.get(key)||new Map();
    this.jars.delete(key);
    this.jars.set(key,existing);
    while(this.jars.size>maxJars)this.jars.delete(this.jars.keys().next().value);
    const purge=now=>{for(const [id,item]of existing)if(item.expires<=now)existing.delete(id);};
    purge(this.now());
    const selected=[...existing.values()].filter(item=>pathMatches(url.pathname,item.path))
      .sort((a,b)=>b.path.length-a.path.length);
    const sent=[],parts=[];
    let bytes=0;
    for(const item of selected) {
      const part=item.name+'='+item.value;
      bytes+=part.length+(parts.length?2:0);
      if(bytes>maxHeader)break;
      sent.push(item);parts.push(part);
    }
    const observed=[];
    return {
      header:parts.join('; '),
      capture:lines=>{
        if(this.closed||this.jars.get(key)!==existing)return;
        const now=this.now();
        purge(now);
        for(const line of lines.slice(0,maxCookies)) {
          const item=candidate(line,url,now);
          if(!item)continue;
          observed.push(item);
          if(!item.allowed)continue;
          const id=JSON.stringify([item.name,item.path]);
          if(item.expires<=now)existing.delete(id);
          else if(existing.has(id)||existing.size<maxCookies)existing.set(id,item);
        }
      },
      redact:value=>{
        let sanitized=String(value);
        const mask=new Set();
        for(const item of [...sent,...observed]) {
          if(!item.value)continue;
          mask.add(item.name+'='+item.value);
          if(item.value.length>=8) {
            mask.add(item.value);
            mask.add(encodeURIComponent(item.value));
          }
        }
        for(const secret of [...mask].sort((a,b)=>b.length-a.length))sanitized=sanitized.replaceAll(secret,'[redacted]');
        return sanitized;
      },
      info:()=>({name,sent:sent.length,retained:existing.size})
    };
  }

  dispose() {this.closed=true;this.jars.clear();}
}

module.exports={jarName,HttpCookieJars};
