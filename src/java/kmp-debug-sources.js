'use strict';

const fs = require('node:fs/promises');
const raw = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { lexJava } = require('../spring/java');
const { regular,safeDirectory } = require('./kmp-gradle');
const { independentJavaExecutable } = require('./debug-runtime');
const { fail,cancelled } = require('./workbench-model');

const invoke=promisify(execFile);
const names=/^[A-Za-z_$][\w$]*(?:[/.][A-Za-z_$][\w$]*)*$/u;
const sourceName=/^[A-Za-z_$][\w$-]*\.kt$/u;
const decode=new TextDecoder('utf-8',{fatal:true});
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');

function kotlinPackage(text) {
  const {tokens,issues}=lexJava(text);
  if (issues.length) return undefined;
  const index=tokens.findIndex(token=>token.text==='package');
  if (index<0) return '';
  const rest=text.slice(tokens[index].start).split('\n',1)[0];
  const parsed=/^package[ \t]+([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)[ \t]*;?[ \t]*(?:\/\/.*)?$/.exec(rest);
  return parsed?.[1].replaceAll('.','/');
}

function sourceMap(text, expected) {
  if (!text) return {stratum:'Java',path:undefined,line:value=>value};
  const rows=text.replace(/\r\n/g,'\n').split('\n');
  if (rows[0]!=='SMAP' || rows[1]!==expected || rows.length>2000) return undefined;
  const start=rows.indexOf('*S Kotlin'), end=rows.findIndex((row,index)=>index>start && /^\*(?:S |E$)/.test(row));
  if (start<0 || end<0) return undefined;
  const files=rows.indexOf('*F',start+1), lines=rows.indexOf('*L',files+1);
  if (files<=start || lines<=files || lines>=end) return undefined;
  const sourceFiles=[];
  for (let cursor=files+1;cursor<lines;cursor++) {
    const entry=/^(\+ )?(\d{1,4}) ([^\r\n]+)$/.exec(rows[cursor]);
    if (!entry) return undefined;
    const namedPath=entry[1] ? rows[++cursor] : undefined;
    if (cursor>=lines || namedPath?.startsWith('*')) return undefined;
    sourceFiles.push({id:Number(entry[2]),file:entry[3],path:namedPath});
  }
  const byName=sourceFiles.filter(file=>file.file===expected);
  if (byName.length!==1 || !byName[0].path || !names.test(byName[0].path)) return undefined;
  const primary=byName[0], ranges=[];
  let sourceId=1;
  for (const row of rows.slice(lines+1,end)) {
    const item=/^(\d{1,5})(?:#(\d{1,4}))?(?:,(\d{1,5}))?:(\d{1,5})(?:,(\d{1,5}))?$/.exec(row);
    if (!item) return undefined;
    sourceId=Number(item[2] || sourceId);
    const range={sourceId,input:Number(item[1]),count:Number(item[3] || 1),out:Number(item[4]),stride:Number(item[5] || 1)};
    if (!range.input || !range.count || !range.out || !range.stride || !sourceFiles.some(file=>file.id===sourceId)) return undefined;
    ranges.push(range);
  }
  return {stratum:'Kotlin',path:primary.path,line(value) {
    const matching=ranges.filter(range=>value>=range.out && value<range.out+range.count*range.stride);
    if (matching.length!==1 || matching[0].sourceId!==primary.id) return undefined;
    const {input,out,stride}=matching[0];
    return input+Math.floor((value-out)/stride);
  }};
}

function classesFromOutput(output,input) {
  const classes=new Map();
  for (const row of output.trimEnd().split(/\r?\n/).filter(Boolean)) {
    const [type,key,...fields]=row.split('\t'), id=Number(key);
    if (!Number.isInteger(id) || !input[id] || String(id)!==key) throw fail('Unexpected Kotlin class line metadata.');
    if (type==='class') {
      const [owner,source,debug]=fields;
      if (fields.length!==3 || classes.has(id) || !names.test(owner) || owner.includes('.') ||
          !sourceName.test(source) || !/^[0-9A-Za-z+/]*={0,2}$/.test(debug)) throw fail('Unexpected Kotlin class file metadata.');
      const bytes=Buffer.from(debug,'base64');
      let mapping;
      try {mapping=sourceMap(decode.decode(bytes),source);} catch {}
      classes.set(id,{owner,source,mapping,debugSha256:bytes.length ? digest(bytes) : '',methods:[]});
      continue;
    }
    const [method,signature,code,entries]=fields;
    const binary=classes.get(id);
    if (type!=='method' || fields.length!==4 || !binary || !/^(?:[A-Za-z_$][\w$-]*|<init>|<clinit>)$/u.test(method) ||
        !/^\([^\t\r\n]*\).+$/u.test(signature) || signature.length>512 || !/^[0-9a-f]{64}$/.test(code) ||
        !/^\d{1,5}:\d{1,5}(?:,\d{1,5}:\d{1,5})*$/.test(entries)) throw fail('Unexpected Kotlin method line metadata.');
    binary.methods.push({method,signature,code,entries:entries.split(',').map(entry=>entry.split(':').map(Number))});
  }
  return [...classes.values()];
}

function buildSourceEvidence(snapshot,binaries) {
  const byName=new Map(), byOwner=new Map();
  for (const source of snapshot.files.values()) {
    const base=path.basename(source.file), namespace=kotlinPackage(source.text);
    if (!sourceName.test(base) || namespace===undefined) continue;
    const key=namespace+'/'+base;
    if (byName.has(key)) byName.set(key,null);
    else byName.set(key,source);
  }
  for (const binary of binaries) {
    byOwner.set(binary.owner,(byOwner.get(binary.owner) || 0)+1);
  }
  const result=new Map();
  for (const binary of binaries) {
    const {owner,source,mapping,debugSha256}=binary;
    const separator=owner.lastIndexOf('/');
    const saved=byName.get((separator<0?'':owner.slice(0,separator))+'/'+source);
    if (!saved || !mapping || byOwner.get(owner)!==1) continue;
    let evidence=result.get(saved.file);
    if (!evidence) result.set(saved.file,evidence={file:saved.file,sha256:saved.sha256,name:source,lines:{}});
    const lineCount=saved.text.split('\n').length;
    for (const method of binary.methods) {
      for (const [bci,value] of method.entries) {
        const line=mapping.line(value);
        if (!line || line>lineCount) continue;
        const existing=evidence.lines[line];
        const site={owner:owner.replaceAll('/','.'),method:method.method,signature:method.signature,code:method.code,bci,
          stratum:mapping.stratum,debugSha256,...(mapping.path&&{path:mapping.path})};
        if (existing===null) continue;
        if (!existing) evidence.lines[line]=site;
        else if (existing.owner===site.owner && existing.method===site.method && existing.signature===site.signature) {
          if (bci<existing.bci) evidence.lines[line]=site;
        } else evidence.lines[line]=null;
      }
    }
  }
  for (const evidence of result.values()) {
    for (const [line,location] of Object.entries(evidence.lines)) if (!location) delete evidence.lines[line];
  }
  return {format:'RocketbrainKmpSourceLines1',files:[...result.values()]};
}

function classFiles(root,dirs) {
  if (!Array.isArray(dirs) || dirs.length>12) throw fail('Unexpected Kotlin JVM class output roots.');
  const files=[], seen=new Set();
  let total=0, examined=0;
  function walk(directory,depth) {
    if (depth>30 || path.relative(raw.realpathSync(directory),directory)) throw fail('Kotlin class output must be physically contained.');
    for (const entry of raw.readdirSync(directory,{withFileTypes:true})) {
      if (++examined>8000) throw fail('Kotlin class output exceeds its inspection limit.');
      if (entry.isSymbolicLink()) throw fail('Kotlin class output must be physically contained.');
      const file=path.join(directory,entry.name);
      if (entry.isDirectory()) walk(file,depth+1);
      else if (entry.isFile() && file.endsWith('.class') && !seen.has(file)) {
        const bytes=regular(file,root,512*1024);
        total+=bytes.length;
        if (files.length>=1200 || total>32*1024*1024) throw fail('Kotlin class output exceeds its inspection limit.');
        seen.add(file);
        files.push({file,sha256:digest(bytes)});
      }
    }
  }
  for (const directory of new Set(dirs)) if (raw.existsSync(safeDirectory(root,directory))) walk(directory,0);
  return files;
}

async function inspectKmpDebugSources({model,module,snapshot,outputs,javaHome,folder,cancellation}) {
  if (cancelled(cancellation) || !path.isAbsolute(javaHome||'')) throw fail('Use the independent Java debugger JDK for Kotlin source verification.');
  const binary=independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const script=[path.join(__dirname,'java-debug','KmpClassLines.java'),path.join(__dirname,'../../runtime/java-debug/KmpClassLines.java')]
    .find(candidate=>raw.existsSync(candidate));
  if (!script) throw fail('The Kotlin class source inspector is unavailable.');
  const files=classFiles(module.directory,outputs), list=path.join(folder,'classes.txt');
  await fs.writeFile(list,files.map(item=>Buffer.from(item.file).toString('base64')).join('\n'),{flag:'wx'});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH)$/i.test(key)));
  const {stdout}=await invoke(binary,['--source','25',script,list],{cwd:folder,env,windowsHide:true,timeout:25000,maxBuffer:8*1024*1024,
    ...(cancellation instanceof AbortSignal&&{signal:cancellation})});
  for (const item of files) {
    if (digest(regular(item.file,model.root,512*1024))!==item.sha256) throw fail('Kotlin compiled output changed during debugger setup.');
  }
  return buildSourceEvidence(snapshot,classesFromOutput(stdout,files));
}

module.exports = { buildSourceEvidence,inspectKmpDebugSources,sourceMap };
