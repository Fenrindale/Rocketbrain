'use strict';

const fs=require('node:fs/promises');
const { createHash }=require('node:crypto');
const { isDeepStrictEqual }=require('node:util');
const { inspectionProfile,RULES }=require('./inspection-profiles');
const { inspectSources }=require('./inspection-analysis');
const { supportedPath }=require('../vcs/changelist-git');
const { repository,revision,ancestor,sources,sourceAt,objectId }=require('./quality-git');

const version=1;
const driver='Rocketbrain Java Quality Gate';
const rootId='%SRCROOT%';
const fingerprintId='rocketbrainTokenAnchor/v1';
const digestId=/^[a-f0-9]{64}$/;
const maxFindings=2500;
const maxSarif=8*1024*1024;
const maxProfile=32*1024;
const levels={error:'error',warning:'warning',information:'note',hint:'note'};
const thresholdOrder=['never','hint','information','warning','error'];
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const artifactUri=value=>value.split('/').map(segment=>encodeURIComponent(segment)).join('/');

async function readJson(file,max,label) {
  const stat=await fs.lstat(file);
  if (!stat.isFile() || stat.size>max) throw Error('Choose a local '+label+' file within its size limit.');
  const handle=await fs.open(file,'r');
  try {
    const bytes=Buffer.alloc(max+1);
    let length=0;
    while (length<bytes.length) {
      const {bytesRead}=await handle.read(bytes,length,bytes.length-length,length);
      if (!bytesRead) break;
      length+=bytesRead;
    }
    if (length>max) throw Error('The '+label+' file exceeds its size limit.');
    try { return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,length))); }
    catch { throw Error('The '+label+' file must be valid UTF-8 JSON.'); }
  } finally { await handle.close(); }
}

async function readQualityProfile(file) {
  const profile=await readJson(file,maxProfile,'inspection profile');
  if (!profile || Array.isArray(profile) || typeof profile!=='object' ||
      Object.keys(profile).some(key=>!['name','include','exclude','rules','duplicateMode','minDuplicateTokens'].includes(key))) {
    throw Error('Use one Rocketbrain Java inspection profile JSON object.');
  }
  return profile;
}

function reportOptions(input={name:'Java workspace'}) {
  const profile=inspectionProfile(input,{caseSensitive:true});
  return {profile,policy:hash([version,profile.include,profile.exclude,profile.rules])};
}

async function snapshot(repo,commit,profile,signal,options) {
  const files=await sources(repo,commit,profile,signal,options);
  const result=inspectSources(files,profile,{duplicates:false,includeAnchors:true});
  if (result.skipped.length) throw Error('The quality gate could not parse all selected committed Java sources. Correct the source or narrow the profile.');
  if (result.findings.length>maxFindings) throw Error('The quality gate found more than 2,500 issues. Narrow its inspection profile.');
  const objects=new Map(files.map(file=>[file.uri,file.object]));
  return {files:result.scannedFiles,items:result.findings.map(finding=>{
    const { id,uri,severity,range,anchor }=finding;
    return {rule:id,path:uri,severity,object:objects.get(uri),fingerprint:hash([id,uri,anchor]),range};
  })};
}

function sarifResult(item) {
  const { path:source,rule,severity,range,object,fingerprint,state }=item;
  return {ruleId:rule,level:levels[severity],message:{text:RULES[rule].label},
    locations:[{physicalLocation:{artifactLocation:{uri:artifactUri(source),uriBaseId:rootId},
      region:{startLine:range.start.line+1,startColumn:range.start.character+1,
        endLine:range.end.line+1,endColumn:range.end.character+1}}}],
    partialFingerprints:{[fingerprintId]:fingerprint},baselineState:state,
    properties:{rocketbrainBlob:object,rocketbrainSeverity:severity}};
}

function buildSarif(result,profile,policy,summary) {
  return {$schema:'https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json',
    version:'2.1.0',runs:[{
      tool:{driver:{name:driver,rules:Object.entries(RULES).map(([id,rule])=>({id,shortDescription:{text:rule.label}}))}},
      columnKind:'utf16CodeUnits',originalUriBaseIds:{[rootId]:{description:{text:'Root of the recorded Git commit'}}},
      invocations:[{executionSuccessful:true}],
      properties:{rocketbrainGateVersion:version,rocketbrainPolicy:policy,rocketbrainRevision:summary.revision,
        rocketbrainProfile:profile.name,rocketbrainBaseline:summary.baseline,rocketbrainSummary:summary},
      results:result.map(sarifResult)
    }]};
}

function parseQualitySarif(sarif) {
  if (sarif?.version!=='2.1.0' || !Array.isArray(sarif.runs) || sarif.runs.length!==1) {
    throw Error('Choose a Rocketbrain Java quality gate SARIF 2.1.0 report.');
  }
  const [run]=sarif.runs, meta=run?.properties;
  if (run?.tool?.driver?.name!==driver || meta?.rocketbrainGateVersion!==version ||
      !objectId.test(meta?.rocketbrainRevision) || !digestId.test(meta?.rocketbrainPolicy) ||
      !Array.isArray(run.results) || run.results.length>maxFindings) {
    throw Error('The SARIF report is missing its Rocketbrain commit, policy or results.');
  }
  const items=run.results.map(item=>{
    const location=item?.locations?.[0]?.physicalLocation;
    const artifact=location?.artifactLocation, region=location?.region;
    const fingerprint=item?.partialFingerprints?.[fingerprintId], {rocketbrainBlob:object,rocketbrainSeverity:severity}=item?.properties ?? {};
    let source;
    try { source=decodeURIComponent(artifact?.uri); } catch { /* Checked below. */ }
    const positions=[region?.startLine,region?.startColumn,region?.endLine,region?.endColumn];
    if (!supportedPath(source) || !source.endsWith('.java') || artifactUri(source)!==artifact.uri || artifact.uriBaseId!==rootId ||
        !Object.hasOwn(RULES,item.ruleId) || !Object.hasOwn(levels,severity) || levels[severity]!==item.level ||
        !objectId.test(object) || object.length!==meta.rocketbrainRevision.length || !digestId.test(fingerprint) ||
        !['new','unchanged'].includes(item.baselineState) ||
        positions.some(value=>!Number.isSafeInteger(value) || value<1 || value>512*1024+1)) {
      throw Error('The SARIF report contains an invalid or unsupported Java location.');
    }
    const [line,column,endLine,endColumn]=positions;
    if (endLine<line || endLine===line && endColumn<=column) throw Error('The SARIF report contains an invalid Java source range.');
    return {rule:item.ruleId,path:source,severity,object,fingerprint,
      range:{start:{line:line-1,character:column-1},end:{line:endLine-1,character:endColumn-1}},state:item.baselineState};
  });
  return {revision:meta.rocketbrainRevision,policy:meta.rocketbrainPolicy,items};
}

const readQualitySarif=async file=>parseQualitySarif(await readJson(file,maxSarif,'SARIF'));

async function analyzeQuality({directory,ref='HEAD',profile:input,baselinePath,baselineRef,failOn='warning',signal}={}) {
  if (!thresholdOrder.includes(failOn)) throw Error('Use error, warning, information, hint or never for the gate threshold.');
  if (baselinePath && baselineRef) throw Error('Choose a baseline SARIF file or revision.');
  const repo=await repository(directory,signal);
  const commit=await revision(repo,ref,signal);
  const {profile,policy}=reportOptions(input);
  const imported=baselinePath?await readQualitySarif(baselinePath):null;
  if (imported && imported.policy!==policy) throw Error('The baseline used a different inspection policy. Generate it again with the current profile.');
  const baseline=imported?.revision ?? (baselineRef ? await revision(repo,baselineRef,signal) : null);
  const current=await snapshot(repo,commit,profile,signal);
  const counts=new Map();
  if (baseline) {
    await ancestor(repo,baseline,commit,signal);
    const prior=baseline===commit?current:await snapshot(repo,baseline,profile,signal,{allowEmpty:true});
    if (imported && !isDeepStrictEqual(prior.items,imported.items.map(({state,...item})=>item))) {
      throw Error('The SARIF baseline results differ from the recorded commit. Generate the baseline again.');
    }
    for (const item of prior.items) counts.set(item.fingerprint,(counts.get(item.fingerprint) ?? 0)+1);
  }
  const items=current.items.map(item=>{
    const remaining=counts.get(item.fingerprint) ?? 0;
    if (remaining) counts.set(item.fingerprint,remaining-1);
    return {...item,state:remaining?'unchanged':'new'};
  });
  const introduced=items.filter(item=>item.state==='new');
  const blocking=introduced.filter(item=>failOn!=='never' && thresholdOrder.indexOf(item.severity)>=thresholdOrder.indexOf(failOn)).length;
  const summary={revision:commit,baseline,files:current.files,new:introduced.length,unchanged:items.length-introduced.length,
    fixed:[...counts.values()].reduce((total,count)=>total+count,0),blocking,failOn};
  return {summary,sarif:buildSarif(items,profile,policy,summary)};
}

function encodeQualitySarif(sarif) {
  const data=JSON.stringify(sarif,null,2)+'\n';
  if (Buffer.byteLength(data)>maxSarif) throw Error('The SARIF results exceed 8 MiB. Narrow the profile.');
  return data;
}

async function writeQualitySarif(file,sarif) {
  const data=encodeQualitySarif(sarif);
  await fs.writeFile(file,data,{encoding:'utf8',flag:'wx'});
}

async function resolveQualityLocation(directory,report,item,signal) {
  const repo=await repository(directory,signal);
  const file=await sourceAt(repo,report.revision,item.path,item.object,signal);
  const {text}=file;
  const lines=text.split('\n');
  for (const point of [item.range.start,item.range.end]) {
    if (point.line>=lines.length || point.character>lines[point.line].length) {
      throw Error('The SARIF range is outside the recorded Java source.');
    }
  }
  return {text,range:item.range};
}

module.exports={analyzeQuality,readQualityProfile,readQualitySarif,parseQualitySarif,encodeQualitySarif,writeQualitySarif,resolveQualityLocation};
