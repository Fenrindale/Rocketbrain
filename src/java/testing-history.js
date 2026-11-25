'use strict';

const path=require('node:path');
const {createHash,randomUUID}=require('node:crypto');

const KEY='rocketbrain.java.testing.history.v1';
const MAX_RUNS=20,MAX_FAILURES=60,MAX_BYTES=2*1024*1024,MAX_TEXT=8192;
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const frameworks=new Set(['junit','testng']);
const comparisonKinds=new Set(['opentest4j','junit4','junit3','testng-text']);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const text=(value,limit)=>typeof value==='string'?value.slice(0,limit):'';
const selector=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!value.includes('\0');
const workspacePath=value=>{
  const normalized=path.resolve(value);
  return process.platform==='win32'?normalized.toLowerCase():normalized;
};

function projectIdentity(project) {
  return createHash('sha256').update(JSON.stringify([String(project.id),project.framework||'junit',workspacePath(project.workspace),
    (project.testClassPaths||[]).map(workspacePath),(project.sourceRoots||[]).map(workspacePath)])).digest('hex');
}

function methodIdentity(data) {
  return [text(data.className,512),text(data.methodName,256),text(data.methodParameterTypes,1024)];
}

function stableFailure(project,data) {
  const framework=project.framework||'junit',method=methodIdentity(data);
  if(data.kind!=='test'||!method[0]||!method[1]||!selector(data.id))return null;
  if(framework==='testng') {
    if(data.rerunnable!==true||!selector(data.parentId)||!data.id.startsWith(data.parentId+'/'))return null;
    return {method,parent:data.parentId};
  }
  if(!/^\[engine:(?:junit-jupiter|junit-vintage)\]\//.test(data.id)||
      /\[(?:dynamic-test|dynamic-container|test-template-invocation|class-template-invocation|repetition):/.test(data.id)||
      !/\[(?:method|test):[^\]]+\]$/.test(data.id))return null;
  return {method,parent:null};
}

function describeFailure(project,data,failure,message,options={}) {
  const comparison=typeof failure.expected==='string'&&typeof failure.actual==='string'&&
    failure.expected.length<=MAX_TEXT&&failure.actual.length<=MAX_TEXT?{
      kind:comparisonKinds.has(failure.comparisonKind)?failure.comparisonKind:'structured',
      expected:failure.expected,actual:failure.actual,expectedType:text(failure.expectedType,512),actualType:text(failure.actualType,512)
    }:null;
  return {project:projectIdentity(project),framework:project.framework||'junit',
    selector:selector(data.id)?data.id:null,label:text(data.label||data.methodName||data.className,512),
    failureType:text(failure.className,512),message:text(message,2048),comparison,
    rerun:options.allowReplay!==false?stableFailure(project,data):null};
}

function boundedHistory(runs) {
  if(!Array.isArray(runs))return [];
  const result=[];
  let bytes=2;
  for(const run of runs.slice(0,MAX_RUNS)) {
    if(!run||!UUID.test(run.id)||!Number.isSafeInteger(run.when)||!Array.isArray(run.projects)||
        !Array.isArray(run.failures)||run.failures.length>MAX_FAILURES)continue;
    const size=Buffer.byteLength(JSON.stringify(run))+(result.length?1:0);
    if(size>MAX_BYTES||bytes+size>MAX_BYTES)continue;
    bytes+=size;result.push(run);
  }
  return result;
}

function createTestHistory(state) {
  let pending=Promise.resolve();
  const read=()=>boundedHistory(state?.get(KEY,[]));
  const update=action=>{
    const task=pending.then(action,action);
    pending=task.catch(()=>{});
    return task;
  };
  return {
    list:()=>structuredClone(read()),
    get:id=>structuredClone(read().find(run=>run.id===id)),
    append({projects,failures,failureCount,mode,sourceChanged}) {
      return update(async()=>{
        if(!state)return;
        const record={id:randomUUID(),when:Date.now(),mode,sourceChanged,
          projects:projects.map(({project,summary})=>({
            label:text(project.label,256),framework:project.framework||'junit',
            passed:count(summary?.testsSucceeded),failed:count(summary?.testsFailed),
            skipped:count(summary?.testsSkipped),aborted:count(summary?.testsAborted),
            containerFailures:count(summary?.containersFailed),durationMs:count(summary?.durationMs)
          })),
          failures:[],
          omittedFailures:count(failureCount)
        };
        let size=Buffer.byteLength(JSON.stringify(record));
        for(const failure of failures.slice(0,MAX_FAILURES)){
          const stored=sourceChanged?{...failure,rerun:null}:failure;
          const added=Buffer.byteLength(JSON.stringify(stored))+1;
          if(size+added+2>MAX_BYTES)continue;
          record.failures.push(stored);
          size+=added;
        }
        record.omittedFailures=Math.max(0,record.omittedFailures-record.failures.length);
        await state.update(KEY,boundedHistory([record,...read()]));
        return record.id;
      });
    },
    clear:()=>update(()=>state?.update(KEY,undefined))
  };
}

function historicalSelection(selected,projects,lookup) {
  if(!Array.isArray(selected)||!selected.length||selected.length>MAX_FAILURES)throw Error('Select saved failures with stable test IDs.');
  const resolved=new Map([...projects].map(project=>[projectIdentity(project),project])),selection=new Map();
  for(const failure of selected) {
    const project=resolved.get(failure.project),currentFramework=project?.framework||'junit';
    if(!project||!frameworks.has(failure.framework)||currentFramework!==failure.framework||
        !selector(failure.selector)||!failure.rerun)throw Error('The saved failure no longer identifies a runnable test in this workspace.');
    const saved=failure.rerun;
    const anchor=lookup(project,saved.parent??failure.selector);
    const current=anchor?.data;
    if(!current||current.id!==(saved.parent??failure.selector)||JSON.stringify(methodIdentity(current))!==JSON.stringify(saved.method)) {
      throw Error('The saved failure no longer matches a discovered Java test. Open a current result and choose that test.');
    }
    if(failure.framework==='testng'){
      if(current.kind!=='container'||!selector(saved.parent)||!failure.selector.startsWith(saved.parent+'/')) {
        throw Error('The saved TestNG invocation no longer matches a discovered test method.');
      }
    }else if(!stableFailure(project,current))throw Error('The saved JUnit selector no longer refers to a stable test method.');
    let entry=selection.get(project);
    if(!entry){entry={selectors:[],excludes:[],items:[]};selection.set(project,entry);}
    if(!entry.selectors.some(item=>item.value===failure.selector)){
      entry.selectors.push({kind:'uniqueId',value:failure.selector});
      entry.items.push(lookup(project,failure.selector)?.item??anchor.item);
    }
  }
  return selection;
}

module.exports={createTestHistory,describeFailure,historicalSelection,MAX_FAILURES};
