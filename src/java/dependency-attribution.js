'use strict';

const path=require('node:path');
const {rangeAt}=require('../spring/java');
const {analyzeJavaSources}=require('./signature-compiler');
const {buildLayer}=require('./dependency-graph');
const {fileKey}=require('./dependency-builds');

const KINDS=new Set(['type reference','field reference','method call','constructor call','method reference']);
const MAX_REFS=9000;
const qualified=/^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u;
const pack=value=>value===''||typeof value==='string'&&qualified.test(value);
const pkgId=(item,name)=>JSON.stringify([item.projectId,item.sourceSet,name]);
const edgeId=(from,to)=>JSON.stringify([from,to]);
const decimal=value=>Number.isSafeInteger(value)&&value>=0;

function sourcePacket(files) {
  const named=new Set(files.filter(file=>file.sourceSet==='main'&&path.basename(file.path).toLowerCase()==='module-info.java')
    .map(file=>file.projectId));
  return {files:files.filter(file=>file.sourceSet==='main'&&!named.has(file.projectId)),namedProjects:named.size};
}

function observedArchives(projects,files) {
  const owners=new Set(files.map(file=>file.projectId)), archives=new Map();
  for(const project of projects.filter(item=>owners.has(item.id)).sort((a,b)=>a.id.localeCompare(b.id))) {
    for(const library of project.imported?.libraries||[]) {
      if(library.kind==='classpath'&&!library.unavailable&&typeof library.path==='string'&&
        path.isAbsolute(library.path)&&!/^[/\\]{2}/u.test(library.path)&&library.path.toLowerCase().endsWith('.jar')) {
        archives.set(fileKey(library.path),library.path);
      }
    }
  }
  return [...archives.values()];
}

function compareBuildEvidence(layer,projects,buildEdges) {
  const byEdge=new Map(), importedIds=new Map(projects.filter(p=>p.imported?.id).map(p=>[p.imported.id,p.id]));
  const observed=new Map();
  for(const record of buildEdges) {
    const id=edgeId(record.from,record.to);
    if(!byEdge.has(id))byEdge.set(id,[]);
    byEdge.get(id).push(record.evidence);
  }
  for(const project of projects)for(const library of project.imported?.libraries||[]) {
    const related=library.projectDependency, to=importedIds.get(related?.id);
    if(!to||typeof related.output!=='string') continue;
    const id=edgeId(project.id,to);
    if(!observed.has(id))observed.set(id,new Set());
    observed.get(id).add(related.output);
  }
  for(const edge of layer.edges) {
    const id=edgeId(edge.from,edge.to);
    edge.buildDeclarations=(byEdge.get(id)||[]).slice(0,12);
    edge.observedBuildOutputs=[...(observed.get(id)||[])].slice(0,12);
  }
}

function attributedLayers(packet,projects,buildEdges,report) {
  if(!Array.isArray(report?.references)||report.references.length>MAX_REFS||!decimal(report.omitted)) {
    throw Error('Invalid compiler dependency reference report.');
  }
  const files=new Map(packet.map(file=>[file.uri,file])), projectById=new Map(projects.map(item=>[item.id,item]));
  const pkgNodes=new Map(), projectNodes=new Map(), pkgEdges=[], projectEdges=[];
  function packageNode(file,name) {
    const id=pkgId(file,name);
    if(!pkgNodes.has(id))pkgNodes.set(id,{id,label:name||'(default package)',project:file.projectLabel,
      sourceSet:file.sourceSet,uri:file.uri});
    return id;
  }
  function projectNode(file) {
    const project=projectById.get(file.projectId);
    if(!project)throw Error('Compiler dependency reference has no selected workspace project.');
    if(!projectNodes.has(project.id))projectNodes.set(project.id,{id:project.id,label:project.label,
      ...(project.range&&{uri:project.uri,range:project.range})});
    return project.id;
  }
  for(const raw of report.references) {
    const from=files.get(raw?.uri),to=files.get(raw?.targetUri);
    if(!from||!to||!KINDS.has(raw.kind)||typeof raw.symbol!=='string'||!raw.symbol||!qualified.test(raw.targetType??'')||
      !pack(raw.packageName)||!pack(raw.targetPackage)||!decimal(raw.start)||!decimal(raw.end)||
      raw.end<=raw.start||raw.end>from.text.length||raw.end-raw.start>4096||!decimal(raw.declaration)||
      raw.declaration>=to.text.length) throw Error('Invalid compiler dependency source range or symbol.');
    const evidence={kind:raw.kind,symbol:raw.symbol.slice(0,500),uri:from.uri,
      range:rangeAt(from.text,raw.start,raw.end),
      target:{uri:to.uri,symbol:raw.targetType,kind:'Bound type declaration',range:rangeAt(to.text,raw.declaration,raw.declaration)}};
    if(pkgId(from,raw.packageName)!==pkgId(to,raw.targetPackage)) {
      pkgEdges.push({from:packageNode(from,raw.packageName),to:packageNode(to,raw.targetPackage),evidence});
    }
    if(from.projectId!==to.projectId) {
      projectEdges.push({from:projectNode(from),to:projectNode(to),evidence});
    }
  }
  const packages=buildLayer('Javac package references',[...pkgNodes.values()],pkgEdges);
  const modules=buildLayer('Javac project references',[...projectNodes.values()],projectEdges);
  compareBuildEvidence(modules,projects,buildEdges);
  return {layers:[modules,packages],references:report.references.length,omitted:report.omitted};
}

async function observeAttributedSources({files,projects,buildEdges,javaHome,storagePath,cancellation}) {
  const packet=sourcePacket(files), classpath=observedArchives(projects,packet.files);
  const notes=[], summary={sourceFiles:packet.files.length,namedProjects:packet.namedProjects,archiveCount:classpath.length,
    release:25, buildExecuted:false};
  if(packet.namedProjects)notes.push({message:'Named JPMS sources remain in their separate requires and compiled layers.'});
  if(!packet.files.length)return {summary:{...summary,state:'empty'},layers:[],notes};
  if(packet.files.some(file=>file.dirty||file.invalidUtf8)) {
    notes.push({message:'Save every production source as valid UTF-8 before requesting attributed edges.'});
    return {summary:{...summary,state:'unsaved'},layers:[],notes};
  }
  let compiled;
  try {
    compiled=await analyzeJavaSources({javaHome,storagePath,classpath,release:25,cancellation,manifestLimit:256*1024,
      sources:packet.files,inspection:{kind:'attributedDependencies'}});
  } catch(error) {
    if(cancellation?.isCancellationRequested) throw error;
    notes.push({message:'Javac attribution unavailable · '+String(error.message).replace(/\s+/gu,' ').slice(0,240)});
    return {summary:{...summary,state:'unavailable'},layers:[],notes};
  }
  if(compiled.errors.length) {
    const byUri=new Map(packet.files.map(file=>[file.uri,file]));
    notes.push(...compiled.errors.slice(0,12).map(error=>{
      const file=byUri.get(error.uri), located=file&&decimal(error.start)&&decimal(error.end)&&
        error.end>=error.start&&error.end<=file.text.length;
      return {message:'Javac source packet · '+String(error.message).replace(/\s+/gu,' ').slice(0,240),
        ...(located&&{uri:file.uri,range:rangeAt(file.text,error.start,error.end)})};
    }));
    return {summary:{...summary,state:'compiler-errors',errors:compiled.errors.length},layers:[],notes,compiler:compiled};
  }
  const result=attributedLayers(packet.files,projects,buildEdges,compiled.attributedDependencies);
  return {summary:{...summary,state:'attributed',references:result.references,omitted:result.omitted},
    layers:result.layers,notes,compiler:compiled};
}

module.exports={attributedLayers,observeAttributedSources};
