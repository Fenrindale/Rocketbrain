'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { lexJava,rangeAt } = require('../spring/java');
const { inside,fail,cancelled } = require('./workbench-model');
const { regular,safeDirectory,buildSnapshot } = require('./kmp-gradle');

const TYPED_SCALARS=new Set(['Any','Unit','Nothing','Boolean','Byte','Short','Int','Long','Float','Double','Char','String',
  'UByte','UShort','UInt','ULong']);
const IDENTIFIER=/^[A-Za-z_][A-Za-z0-9_]*$/;
const decode=new TextDecoder('utf-8',{fatal:true});
const normal=text => text.replace(/\r\n/g,'\n');
const shadowsScalar=text => [...text.matchAll(/\b(?:class|interface|object|typealias)\s+([A-Za-z_][\w]*)\b/g)]
  .some(item => TYPED_SCALARS.has(item[1]));

function declarationTokens(text) {
  const {tokens,issues}=lexJava(text);
  // The common lexer does not interpret Kotlin's nested comments or quoted identifiers.
  if (issues.length || /`/.test(text) || [...text.matchAll(/\/\*[\s\S]*?\*\//g)].some(item => item[0].slice(2,-2).includes('/*'))) return [];
  return tokens;
}

function kotlinDeclarations(text) {
  text=normal(text);
  const tokens=declarationTokens(text), declarations=[];
  let packageName='', depth=0;
  const at=index => tokens[index]?.text;
  const expectedLine=token => text.indexOf('\n',token.end);
  // Explicit imports of a scalar and local shadowing can change a written type's identity.
  if (/^\s*import\s+(?:\S+\s+as\s+)?[\w.]*\*/m.test(text) || shadowsScalar(text)) return [];
  for (const match of text.matchAll(/^\s*import\s+([\w.]+)(?:\s+as\s+([\w]+))?/gm)) {
    const type=match[2] || match[1].split('.').at(-1);
    if (TYPED_SCALARS.has(type) && match[1]!=='kotlin.'+type) return [];
  }
  function scalar(cursor) {
    if (at(cursor)==='kotlin' && at(cursor+1)==='.') cursor+=2;
    const type=at(cursor++);
    if (!TYPED_SCALARS.has(type)) return undefined;
    const nullable=at(cursor)==='?';
    return {value:type+(nullable ? '?' : ''),next:cursor+Number(nullable)};
  }
  for (let i=0;i<tokens.length;i++) {
    const token=tokens[i], current=token.text;
    if (current==='{') {depth++;continue;}
    if (current==='}') {depth--;continue;}
    if (depth!==0) continue;
    if (current==='package') {
      const end=expectedLine(token);
      let cursor=i+1;
      const parts=[];
      while (tokens[cursor] && (end<0 || tokens[cursor].start<end) && IDENTIFIER.test(at(cursor))) {
        parts.push(at(cursor++));
        if (at(cursor)!=='.') break;
        cursor++;
      }
      packageName=parts.join('.');
      continue;
    }
    if (!['expect','actual'].includes(current) || !['fun','val','var'].includes(at(i+1))) continue;
    const kind=at(i+1), name=tokens[i+2];
    if (!name || !IDENTIFIER.test(name.text)) continue;
    let cursor=i+3;
    const parameters=[];
    if (kind==='fun') {
      if (at(cursor++)!=='(') continue;
      while (at(cursor)!==')') {
        if (!IDENTIFIER.test(at(cursor)||'') || at(cursor+1)!==':' || parameters.length>=16) break;
        const type=scalar(cursor+2);
        if (!type) break;
        parameters.push(type.value);
        cursor=type.next;
        if (at(cursor)!==',') break;
        cursor++;
      }
      if (at(cursor++)!==')') continue;
    }
    if (at(cursor++)!==':') continue;
    const type=scalar(cursor);
    if (!type || ['.','<','[','?','&','|','!','-'].includes(at(type.next))) continue;
    const signature=JSON.stringify([packageName,kind,name.text,parameters,type.value]);
    declarations.push({role:current,name:name.text,kind,signature,range:rangeAt(text,name.start,name.end)});
  }
  return declarations;
}

function snapshotKmpSources(model,module,targetNames,cancellation) {
  const allowed=new Set(module.targets.filter(target => targetNames.includes(target.name)).flatMap(target => target.main));
  const files=new Map();
  let examined=0,totalSize=0;
  function walk(directory,sourceSet,depth) {
    if (depth>24 || path.relative(directory,fs.realpathSync(directory))) throw fail('Kotlin source directories must be bounded physical paths.');
    const handle=fs.opendirSync(directory);
    try {
      for (let entry; (entry=handle.readSync())!==null;) {
        if (++examined>10000 || cancelled(cancellation)) throw fail('Kotlin source inspection exceeded its limit or was cancelled.');
        if (entry.isSymbolicLink()) continue;
        const file=path.join(directory,entry.name);
        if (entry.isDirectory()) walk(file,sourceSet,depth+1);
        else if (entry.isFile() && file.endsWith('.kt')) {
          const existing=files.get(file);
          if (existing) {existing.sets.add(sourceSet);continue;}
          if (files.size>=240) throw fail('Inspect at most 240 Kotlin source files.');
          const bytes=regular(file,model.root,512*1024);
          totalSize+=bytes.length;
          if (totalSize>8*1024*1024) throw fail('Kotlin sources exceed their analysis byte limit.');
          const text=normal(decode.decode(bytes));
          files.set(file,{file,uri:pathToFileURL(file).href,text,sets:new Set([sourceSet]),
            sha256:createHash('sha256').update(bytes).digest('hex')});
        }
      }
    } finally {handle.closeSync();}
  }
  for (const set of module.sourceSets.filter(item => allowed.has(item.name))) {
    for (const directory of set.directories) {
      safeDirectory(model.root,directory);
      if (fs.existsSync(directory)) walk(directory,set.name,0);
    }
  }
  const fingerprint=[...files].sort(([left],[right]) => left.localeCompare(right))
    .map(([file,info]) => [file,info.sha256,[...info.sets].sort()]);
  return {files,fingerprint:JSON.stringify(fingerprint)};
}

function indexesFor(model,module,targetNames,snapshot) {
  const files=new Map(), links=new Map();
  const shadowed=[...snapshot.files.values()].some(source => shadowsScalar(source.text));
  for (const source of snapshot.files.values()) {
    if (source.sets.size!==1) continue;
    const [set]=source.sets;
    const declarations=shadowed ? [] : kotlinDeclarations(source.text).map(item => ({...item,file:source.file,uri:source.uri,set}));
    files.set(source.file,{...source,declarations});
  }
  function key(item) {return item.file+'#'+item.range.start.line+':'+item.range.start.character;}
  function relate(from,to,target) {
    const known=links.get(key(from)) || new Map();
    const token=key(to), entry=known.get(token)||{...to,targets:[]};
    entry.targets.push(target);
    known.set(token,entry);
    links.set(key(from),known);
  }
  const declarations=[...files.values()].flatMap(file => file.declarations);
  for (const target of module.targets.filter(item => targetNames.includes(item.name))) {
    const bySignature=new Map();
    for (const item of declarations.filter(value => target.main.includes(value.set))) {
      const pair=bySignature.get(item.signature) || {expect:[],actual:[]};
      pair[item.role].push(item);
      bySignature.set(item.signature,pair);
    }
    for (const pair of bySignature.values()) {
      if (pair.expect.length!==1 || pair.actual.length!==1 || pair.expect[0].set===pair.actual[0].set) continue;
      const [expected]=pair.expect, [actual]=pair.actual;
      relate(expected,actual,target.name);
      relate(actual,expected,target.name);
    }
  }
  return {model,module,targetNames,files,links,fingerprint:snapshot.fingerprint,key};
}

function definitionForKmp(index,{file,text,position}={},cancellation) {
  if (!index || typeof file!=='string' || !inside(index.model.root,file) || !position || typeof text!=='string') return [];
  const source=index.files.get(file);
  const selected=source?.declarations.find(item => item.range.start.line===position.line &&
    position.character>=item.range.start.character && position.character<item.range.end.character);
  if (!selected) return [];
  if (normal(text)!==source.text || JSON.stringify(buildSnapshot(index.model.root,index.model.modules))!==JSON.stringify(index.model.digests) ||
      snapshotKmpSources(index.model,index.module,index.targetNames,cancellation).fingerprint!==index.fingerprint) {
    throw fail('Kotlin sources or Gradle settings changed after compile. Inspect and build again.');
  }
  return [...(index.links.get(index.key(selected))?.values()||[])].map(item => ({name:item.name,role:item.role,
    sourceSet:item.set,targets:item.targets,uri:item.uri,range:item.range}));
}

module.exports = { kotlinDeclarations,snapshotKmpSources,indexesFor,definitionForKmp };
