'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const { analyzeQuality,parseQualitySarif }=require('../java/quality-gate');
const { analyzeSql }=require('../db/sql-analysis');

const maxInventoryEntries=4000;
const maxInventoryDepth=10;
const maxBuildFiles=100;
const maxFindings=80;
const maxSqlBytes=32*1024;
const excluded=new Set(['node_modules','target','build','dist','out','bin','vendor','test-output','outputs']);
const buildFiles=new Set(['pom.xml','build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','build.sbt']);
const languages={'.java':'java','.kt':'kotlin','.scala':'scala','.groovy':'groovy','.sql':'sql'};
const ref=/^[A-Za-z0-9][A-Za-z0-9_./-]{0,190}$/;
const controls=/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g;
const isObject=value=>!!value && typeof value==='object' && !Array.isArray(value);

function safeSegment(value) {
  return !!value && !value.startsWith('.') && !excluded.has(value.toLowerCase()) &&
    !/[\\:]/.test(value) && value.replace(controls,'')===value && Buffer.byteLength(value)<=160;
}

function folderSegments(relative) {
  if (relative==='.') return [];
  if (typeof relative!=='string' || Buffer.byteLength(relative)>240 || !relative.split('/').every(safeSegment)) {
    throw Error('Choose a relative project folder inside the approved workspace.');
  }
  return relative.split('/');
}

function inside(base,target) {
  const relative=path.relative(base,target);
  return relative==='' || relative!=='..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative);
}

async function approveWorkspace(value) {
  if (typeof value!=='string' || !path.isAbsolute(value) || /^[\\/]{2}/.test(value) || value.replace(controls,'')!==value) {
    throw Error('Set --workspace to an absolute local workspace directory.');
  }
  const root=await fs.realpath(value);
  if (/^[\\/]{2}/.test(root) || !(await fs.stat(root)).isDirectory()) throw Error('Choose a local workspace directory.');
  return root;
}

async function getFolder(root,relative) {
  if (path.relative(root,await fs.realpath(root))) throw Error('The approved workspace changed. Restart Rocketbrain MCP.');
  let current=root;
  for (const name of folderSegments(relative)) {
    current=path.join(current,name);
    const stat=await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Use an ordinary project directory inside the approved workspace.');
  }
  const real=await fs.realpath(current);
  if (!inside(root,real) || path.relative(real,current)) throw Error('The project directory escaped the approved workspace.');
  return real;
}

async function inventory(root,relative,signal) {
  const parent=await getFolder(root,relative);
  const pending=[{directory:parent,depth:0}];
  const counts=Object.fromEntries(Object.values(languages).map(name=>[name,0]));
  const builds=[];
  let visited=0,truncated=false;
  while (pending.length && visited<maxInventoryEntries) {
    signal.throwIfAborted();
    const {directory,depth}=pending.pop();
    const canonical=await fs.realpath(directory);
    if (!inside(parent,canonical) || path.relative(canonical,directory)) continue;
    const stream=await fs.opendir(canonical);
    for await (const entry of stream) {
      signal.throwIfAborted();
      if (++visited>maxInventoryEntries) { truncated=true; break; }
      if (!safeSegment(entry.name) || entry.isSymbolicLink()) continue;
      const item=path.join(directory,entry.name);
      if (entry.isDirectory()) {
        if (depth<maxInventoryDepth) pending.push({directory:item,depth:depth+1});
        else truncated=true;
        continue;
      }
      if (!entry.isFile()) continue;
      const language=languages[path.extname(entry.name).toLowerCase()];
      if (language) counts[language]++;
      if (buildFiles.has(entry.name)) {
        if (builds.length<maxBuildFiles) builds.push(path.relative(root,item).split(path.sep).join('/'));
        else truncated=true;
      }
    }
  }
  return {folder:relative,sourceFiles:counts,buildFiles:builds.sort(),truncated:truncated || pending.length>0};
}

function boundedText(value,limit=200) {
  return String(value??'').replace(controls,'').slice(0,limit);
}

const inputSchemas={
  project_inventory:{type:'object',additionalProperties:false,properties:{folder:{type:'string',minLength:1,maxLength:240,
    description:'Slash-separated path relative to the approved workspace, or . for its root.'}}},
  java_quality:{type:'object',additionalProperties:false,properties:{revision:{type:'string',pattern:ref.source},
    baselineRevision:{type:'string',pattern:ref.source},profile:{enum:['workspace','application-sources']}}},
  sql_structure:{type:'object',additionalProperties:false,required:['sql'],properties:{sql:{type:'string',minLength:1,maxLength:maxSqlBytes},
    dialect:{enum:['mysql','mariadb']}}}
};
const descriptions={
  project_inventory:'Count supported source files and find known build files inside an approved workspace folder. Returns relative paths and never reads file contents.',
  java_quality:'Run the owned Java inspections on a local Git commit in the approved workspace root. Optionally compare against an ancestor revision. Returns issue locations and counts.',
  sql_structure:'Inspect one supplied MySQL or MariaDB SELECT/WITH statement with the owned static analyzer. Uses no database connection or catalog.'
};

function validateArguments(name,args={}) {
  const schema=inputSchemas[name];
  if (!isObject(args) || Object.keys(args).some(key=>!Object.hasOwn(schema.properties,key))) throw Error('Unsupported tool arguments.');
  for (const [key,value] of Object.entries(args)) {
    const rule=schema.properties[key];
    if (typeof value!=='string' || rule.enum && !rule.enum.includes(value) || rule.pattern && !ref.test(value) ||
        rule.maxLength && Buffer.byteLength(value)>rule.maxLength || rule.minLength && !value.trim() || value.includes('\0')) {
      throw Error('An argument did not match the tool input contract.');
    }
  }
  if (schema.required?.some(key=>!Object.hasOwn(args,key))) throw Error('A required tool argument is missing.');
  if (name==='project_inventory') folderSegments(args.folder ?? '.');
  return {...args};
}

function sqlSummary(sql,dialect) {
  const model=analyzeSql(sql,[],{dialect});
  const limited=model.projections.length>100 || model.relations.length>100 || model.diagnostics.length>40 || model.coverage.unknown.length>40;
  const relation=({name,alias,kind})=>({name:boundedText(name),alias:boundedText(alias),kind});
  return {dialect:model.dialect,state:model.state,executedSql:false,validityVerified:false,
    projections:model.projections.slice(0,100).map(({name,type})=>({name:boundedText(name),type:type.family,nullable:type.nullable ?? true})),
    relations:model.relations.slice(0,100).map(relation),
    diagnostics:model.diagnostics.slice(0,40).map(({code,severity,start,end})=>({code,severity,start,end})),
    coverage:{supported:model.coverage.supported,unknown:model.coverage.unknown.slice(0,40).map(({reason,start})=>({reason:boundedText(reason),start}))},
    truncated:limited};
}

function workspaceTools(root,names) {
  const selected=new Set(names);
  if (!selected.size || [...selected].some(name=>!Object.hasOwn(inputSchemas,name))) throw Error('Choose recognized tools with --allow-tool.');
  const tools=Object.keys(inputSchemas).filter(name=>selected.has(name)).sort().map(name=>({name,description:descriptions[name],
    inputSchema:inputSchemas[name],annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false}}));
  async function invoke(name,args,signal) {
    signal.throwIfAborted();
    if (name==='project_inventory') return inventory(root,args.folder ?? '.',signal);
    if (name==='sql_structure') return sqlSummary(args.sql,args.dialect ?? 'mysql');
    const directory=await getFolder(root,'.');
    const profile=args.profile==='application-sources' ? {name:'Java application sources',include:['**/src/main/java/**/*.java']} : undefined;
    const {summary,sarif}=await analyzeQuality({directory,ref:args.revision,baselineRef:args.baselineRevision,profile,signal});
    const {items}=parseQualitySarif(sarif);
    const findings=items.slice(0,maxFindings).map(({rule,path:source,severity,range,state})=>({rule,source,severity,range,state}));
    return {summary,findings,truncated:items.length>maxFindings};
  }
  return {tools,authorized:name=>selected.has(name),validate:validateArguments,invoke};
}

module.exports={approveWorkspace,workspaceTools,isObject};
