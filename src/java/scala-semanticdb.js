'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { inside,fail,cancelled } = require('./workbench-model');

const FILE_BYTES=4*1024*1024;
const PATH_SEGMENT=/^[^\\/:\0%]+$/;
const EXCLUDED=new Set(['.git','.idea','.bloop','.metals','.bsp','node_modules','test-output','project','src']);
const decode=new TextDecoder('utf-8',{fatal:true});
const normalize=value => value.replace(/\r\n/g,'\n');
const digest=(algorithm,bytes) => createHash(algorithm).update(bytes).digest('hex');

// SemanticDB v4 uses Protocol Buffers. This reader consumes only document, range and occurrence fields.
function fields(bytes) {
  const result=[];
  let offset=0;
  function number() {
    let value=0;
    for (let shift=0; shift<=56 && offset<bytes.length; shift+=7) {
      const byte=bytes[offset++];
      value+=(byte&127)*2**shift;
      if (!(byte&128) && Number.isSafeInteger(value)) return value;
    }
    throw fail('Invalid SemanticDB integer field.');
  }
  while (offset<bytes.length) {
    const tag=number(), id=Math.floor(tag/8), wire=tag%8;
    if (!id || id>0x1fffffff || result.length>=32000) throw fail('Invalid SemanticDB field or document limit.');
    if (wire===0) {
      result.push({id,wire,value:number()});
      continue;
    }
    const size=wire===2 ? number() : wire===1 ? 8 : wire===5 ? 4 : -1;
    if (size<0 || size>bytes.length-offset) throw fail('Truncated or unsupported SemanticDB field.');
    result.push({id,wire,value:bytes.subarray(offset,offset+size)});
    offset+=size;
  }
  return result;
}

const get=(items,id,wire) => items.find(item => item.id===id && item.wire===wire)?.value;
const all=(items,id,wire) => items.filter(item => item.id===id && item.wire===wire).map(item => item.value);
const string=(items,id) => decode.decode(get(items,id,2) || Buffer.alloc(0));

function occurrence(bytes) {
  const items=fields(bytes), role=get(items,3,0), symbol=string(items,2), raw=get(items,1,2);
  if (![1,2].includes(role) || !symbol || symbol.length>2000 || !raw) return null;
  const values=fields(raw), coordinates=[1,2,3,4].map(id => get(values,id,0) || 0);
  if (coordinates.some(value => value>2_000_000)) return null;
  const [line,character,endLine,endCharacter]=coordinates;
  if (line>endLine || line===endLine && character>=endCharacter) return null;
  return {symbol,role,range:{start:{line,character},end:{line:endLine,character:endCharacter}}};
}

function semanticDocuments(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length>FILE_BYTES) throw fail('SemanticDB input exceeds its byte limit.');
  return all(fields(bytes),1,2).flatMap(raw => {
    const items=fields(raw), language=get(items,10,0), schema=get(items,1,0);
    if (schema!==4 || language!==1) return [];
    const uri=string(items,2), text=string(items,3), md5=string(items,11).toLowerCase();
    if (!uri || (!/^[0-9a-f]{32}$/.test(md5) && !text)) return [];
    return [{uri,text,md5,occurrences:all(items,6,2).map(occurrence).filter(Boolean)}];
  });
}

function regular(file,root,max=FILE_BYTES) {
  const real=fs.realpathSync(file), stat=fs.lstatSync(file);
  if (path.relative(file,real) || !inside(root,real) || !stat.isFile() || stat.isSymbolicLink() || stat.size>max) {
    throw fail('SemanticDB and Scala source inputs must be bounded physical files inside the sbt project.');
  }
  const bytes=fs.readFileSync(real);
  if (bytes.length>max) throw fail('A SemanticDB source changed beyond its byte limit.');
  return bytes;
}

function relativeScala(uri) {
  if (uri.length>4096 || !uri.endsWith('.scala')) return undefined;
  try {
    const parts=uri.split('/').map(decodeURIComponent);
    return parts.every(part => part!=='.' && part!=='..' && PATH_SEGMENT.test(part)) ? parts : undefined;
  } catch {return undefined;}
}

function sourceOf(document,root,owner) {
  const relative=relativeScala(document.uri);
  if (!relative) return undefined;
  const matches=[];
  for (const candidate of new Set([path.join(root,...relative),path.join(owner,...relative)])) {
    if (!fs.existsSync(candidate)) continue;
    const bytes=regular(candidate,root), text=decode.decode(bytes);
    const matching=document.md5===digest('md5',bytes) || document.md5===digest('md5',normalize(text)) ||
      Boolean(document.text && normalize(document.text)===normalize(text));
    if (matching) matches.push({file:candidate,uri:pathToFileURL(candidate).href,sha256:digest('sha256',bytes),text:normalize(text)});
  }
  return matches.length===1 ? matches[0] : undefined;
}

function configSnapshot(root) {
  const files=new Set([path.join(root,'build.sbt'),path.join(root,'project/build.properties')]);
  const home=path.join(root,'project');
  if (path.relative(home,fs.realpathSync(home))) throw fail('Use a physical sbt project directory.');
  function collect(folder,extension) {
    const directory=fs.opendirSync(folder);
    let entries=0;
    try {
      for (let item; (item=directory.readSync())!==null;) {
        if (++entries>3000 || files.size>=100) throw fail('The sbt build descriptor count exceeds the analysis limit.');
        if (item.isFile() && extension.test(item.name)) files.add(path.join(folder,item.name));
      }
    } finally {directory.closeSync();}
  }
  collect(root,/\.sbt$/);
  collect(home,/\.(?:sbt|scala|properties)$/);
  return [...files].sort().map(file => [file,digest('sha256',regular(file,root,1024*1024))]);
}

function indexSemanticdb(root,cancellation) {
  const documents=new Map(), definitions=new Map(), rejected=new Set();
  let examined=0, size=0, count=0, sourceBytes=0, occurrenceCount=0;
  function scan(directory,depth,visitor) {
    if (depth>32 || path.relative(directory,fs.realpathSync(directory))) throw fail('A Scala output directory cannot be inspected safely.');
    const handle=fs.opendirSync(directory);
    try {
      for (let item; (item=handle.readSync())!==null;) {
        if (++examined>30000 || cancelled(cancellation)) throw fail('Scala metadata inspection exceeded its budget or was cancelled.');
        if (!item.isSymbolicLink()) visitor(item,path.join(directory,item.name),depth);
      }
    } finally {handle.closeSync();}
  }
  function readMetadata(file,owner) {
    if (++count>1000) throw fail('Scala metadata file count exceeds its analysis limit.');
    const bytes=regular(file,root);
    if ((size+=bytes.length)>32*1024*1024) throw fail('Scala metadata exceeds its total byte limit.');
    for (const document of semanticDocuments(bytes)) {
      const source=sourceOf(document,root,owner);
      if (!source) continue;
      sourceBytes+=Buffer.byteLength(source.text);
      occurrenceCount+=document.occurrences.length;
      if (sourceBytes>24*1024*1024 || occurrenceCount>250000) throw fail('Scala source metadata exceeds its index budget.');
      if (documents.has(source.file)) {
        documents.delete(source.file);
        rejected.add(source.file);
      }
      if (!rejected.has(source.file)) documents.set(source.file,{...source,
        artifact:file,artifactHash:digest('sha256',bytes),occurrences:document.occurrences});
    }
  }
  function outputs(target,owner) {
    scan(target,1,(entry,scalaOutput) => {
      if (!entry.isDirectory() || !/^scala-[0-9][A-Za-z0-9.\-]{1,45}$/.test(entry.name)) return;
      for (const group of ['meta','test-meta','classes','test-classes']) {
        const start=path.join(scalaOutput,group,'META-INF/semanticdb');
        if (!fs.existsSync(start)) continue;
        const visit=(child,file,depth) => {
          if (child.isDirectory()) scan(file,depth+1,visit);
          else if (child.isFile() && child.name.endsWith('.semanticdb')) readMetadata(file,owner);
        };
        scan(start,0,visit);
      }
    });
  }
  function projectFolder(directory,depth) {
    if (depth>10) return;
    scan(directory,depth,(entry,child) => {
      if (!entry.isDirectory() || entry.name.startsWith('.') || EXCLUDED.has(entry.name)) return;
      if (entry.name==='target') outputs(child,directory);
      else projectFolder(child,depth+1);
    });
  }
  projectFolder(root,0);
  for (const document of documents.values()) {
    for (const item of document.occurrences) {
      if (item.role!==2) continue;
      const key=/^local\d/.test(item.symbol) ? document.file+'\0'+item.symbol : item.symbol;
      const locations=definitions.get(key) || [];
      locations.push({document,range:item.range});
      definitions.set(key,locations);
    }
  }
  return {root,documents,definitions,configs:configSnapshot(root)};
}

function positionOrder(left,right) {return left.line-right.line || left.character-right.character;}

function definitionAt(index,{file,text,position}) {
  if (!index || !file || !position || typeof text!=='string') return undefined;
  const document=index.documents.get(file);
  if (!document) return undefined;
  function unchanged(record) {
    try {
      return digest('sha256',regular(record.file,index.root))===record.sha256 &&
        digest('sha256',regular(record.artifact,index.root))===record.artifactHash;
    } catch {return false;}
  }
  function sameConfig() {
    try {return JSON.stringify(configSnapshot(index.root))===JSON.stringify(index.configs);}
    catch {return false;}
  }
  const stale=() => fail('Scala sources, build files or SemanticDB changed after compile. Compile and index again.');
  if (normalize(text)!==document.text || !unchanged(document) || !sameConfig()) throw stale();
  const candidates=document.occurrences.filter(item => item.role===1 && positionOrder(position,item.range.start)>=0 &&
    positionOrder(position,item.range.end)<0);
  const bySymbol=new Map(candidates.map(item => [item.symbol,item]));
  if (bySymbol.size!==1) return undefined;
  const [symbol]=bySymbol.keys(), key=/^local\d/.test(symbol) ? document.file+'\0'+symbol : symbol;
  const targets=index.definitions.get(key) || [];
  if (targets.length!==1) return undefined;
  const [target]=targets;
  if (!unchanged(target.document)) throw stale();
  const line=target.document.text.split('\n')[target.range.start.line];
  if (target.range.start.line!==target.range.end.line || line===undefined || target.range.end.character>line.length) return undefined;
  return {symbol,uri:target.document.uri,range:target.range};
}

module.exports = { semanticDocuments,indexSemanticdb,definitionAt,configSnapshot };
