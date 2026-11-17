'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const {pathToFileURL}=require('node:url');
const {sha,TestingError}=require('./provision');
const counters=()=>({lines:{covered:0,total:0},branches:{covered:0,total:0},methods:{covered:0,total:0}});
function decode(value){return value.replace(/&(?:amp|lt|gt|quot|apos);/g,entity=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"}[entity]));}
function attrs(text){const result={};for(const value of text.matchAll(/([A-Za-z][\w-]*)="([^"<>]*)"/g))result[value[1]]=decode(value[2]);return result;}
function number(value){if(!/^\d+$/.test(value||'')||Number(value)>2147483647)throw new TestingError('INVALID_COVERAGE','Invalid coverage counter.');return Number(value);}
function count(xml,type){const values=[...xml.matchAll(/<counter\b([^>]*?)\/>/g)].map(match=>attrs(match[1])).filter(item=>item.type===type);if(!values.length)return {covered:0,total:0};const last=values.at(-1),covered=number(last.covered),missed=number(last.missed);return {covered,total:covered+missed};}
function locateSource(roots,relative){if(!relative||path.isAbsolute(relative)||relative.split(/[\\/]/).some(part=>part==='..'||part===''))return null;for(const root of roots){const file=path.resolve(root,relative),rel=path.relative(root,file);if(rel.startsWith('..')||path.isAbsolute(rel))continue;try{if(fs.statSync(file).isFile())return {file,uri:pathToFileURL(file).href};}catch{}}return null;}
function parseCoverageXml(xml,{sourceRoots=[],execFile,xmlFile,htmlDirectory}={}){
  if(typeof xml!=='string'||Buffer.byteLength(xml)>32*1024*1024)throw new TestingError('INVALID_COVERAGE','Coverage report exceeds 32 MiB.');
  // JaCoCo emits this fixed declaration; no XML entity/schema/network resolver is used.
  xml=xml.replace(/<!DOCTYPE report PUBLIC "-\/\/JACOCO\/\/DTD Report 1\.1\/\/EN" "report\.dtd">/,'');
  if(/<!DOCTYPE|<!ENTITY|<\?|&(?!(?:amp|lt|gt|quot|apos);)/.test(xml.replace(/^<\?xml[^?]*\?>/,'')))throw new TestingError('INVALID_COVERAGE','Unsupported coverage XML declaration or entity.');
  if(!/^\s*(?:<\?xml[^?]*\?>\s*)?<report\b/.test(xml)||!/<\/report>\s*$/.test(xml))throw new TestingError('INVALID_COVERAGE','No complete JaCoCo report.');
  const files=[],warnings=[];
  for(const pkg of xml.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)){
    const packageName=attrs(pkg[1]).name||'',body=pkg[2],methods=new Map();
    if(packageName&&(!/^[\p{L}\p{N}_$/]+$/u.test(packageName)||packageName.split('/').includes('..')))throw new TestingError('INVALID_COVERAGE','Invalid coverage package path.');
    for(const cls of body.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)){
      const info=attrs(cls[1]);if(!info.sourcefilename)continue;
      if(!methods.has(info.sourcefilename))methods.set(info.sourcefilename,[]);
      for(const method of cls[2].matchAll(/<method\b([^>]*)>([\s\S]*?)<\/method>/g)){
        const properties=attrs(method[1]),methodCounter=count(method[2],'METHOD');
        methods.get(info.sourcefilename).push({name:properties.name,descriptor:properties.desc,className:info.name?.replaceAll('/','.'),line:properties.line?number(properties.line)-1:undefined,covered:methodCounter.covered>0,lines:count(method[2],'LINE'),branches:count(method[2],'BRANCH')});
      }
    }
    for(const source of body.matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)){
      const properties=attrs(source[1]),relativePath=[packageName,properties.name].filter(Boolean).join('/'),location=locateSource(sourceRoots,relativePath);
      if(!location){warnings.push('Source file not found: '+relativePath);continue;}
      const details=[];
      for(const line of source[2].matchAll(/<line\b([^>]*?)\/>/g)){
        const row=attrs(line[1]),coveredInstructions=number(row.ci),missedInstructions=number(row.mi),coveredBranches=number(row.cb),missedBranches=number(row.mb);
        details.push({line:number(row.nr)-1,covered:coveredInstructions>0,coveredInstructions,missedInstructions,...(coveredBranches+missedBranches?{branches:{covered:coveredBranches,total:coveredBranches+missedBranches}}:{})});
      }
      files.push({uri:location.uri,relativePath,lines:count(source[2],'LINE'),branches:count(source[2],'BRANCH'),methods:{covered:(methods.get(properties.name)||[]).filter(method=>method.covered).length,total:(methods.get(properties.name)||[]).length},details,methodDetails:methods.get(properties.name)||[]});
      if(files.length>5000||details.length>100000)throw new TestingError('INVALID_COVERAGE','Coverage detail limit exceeded.');
    }
  }
  if(!files.length)warnings.push('No source files with matching debug-line metadata were found.');
  const totals=counters();for(const item of files)for(const key of ['lines','branches','methods']){totals[key].covered+=item[key].covered;totals[key].total+=item[key].total;}
  return {state:warnings.length?'partial':'available',scope:'run',perTestCoverage:false,execFile,xmlFile,htmlDirectory,files,totals,warnings,branchLocations:'JaCoCo line-level branch counts; individual branch positions are not reported.'};
}
async function snapshotInputs(roots,extension,{maximumFiles=20000,maximumBytes=256*1024*1024}={}){
  const result={};let size=0,files=0;
  async function walk(folder){for(const entry of await fsp.readdir(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw new TestingError('COVERAGE_INPUT','Coverage inputs cannot contain symbolic links.');if(entry.isDirectory())await walk(file);else if(entry.isFile()&&file.endsWith(extension)){const stat=await fsp.stat(file);size+=stat.size;if(++files>maximumFiles||size>maximumBytes)throw new TestingError('COVERAGE_INPUT','Coverage input snapshot limit exceeded.');result[file]=sha(await fsp.readFile(file));}}}
  for(const root of roots)await walk(root);return result;
}
module.exports={parseCoverageXml,snapshotInputs,locateSource};
