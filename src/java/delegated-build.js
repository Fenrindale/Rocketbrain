'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash,randomUUID} = require('node:crypto');
const {inside,fail,cancelled} = require('./workbench-model');

const reviewMs = 120000;
const limit = 1500;
const byteLimit = 48*1024*1024;
const descriptors = ['pom.xml','build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties',
  'gradle/libs.versions.toml','.mvn/maven.config','.mvn/jvm.config','.mvn/extensions.xml'];
const toolRecipe = {
  maven:{task:'compile',output:'target/classes'},
  gradle:{task:':classes',output:'build/classes/java/main'}
};
const physicalKey = file => process.platform==='win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function physical(root,relative) {
  const absolute = path.resolve(root,relative);
  if (!inside(root,absolute)) throw fail('Build evidence must remain inside the selected project.');
  let current = root;
  for (const piece of path.relative(root,absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current,piece);
    let info;
    try {info = fs.lstatSync(current,{bigint:true});}
    catch (error) {if (error.code==='ENOENT') return undefined; throw error;}
    if (info.isSymbolicLink()) throw fail('Reviewed build inputs and outputs cannot follow linked paths.');
  }
  if (physicalKey(fs.realpathSync(absolute)) !== physicalKey(absolute)) throw fail('A reviewed build path changed its physical location.');
  return absolute;
}

function capture(root,{files=[],trees=[],match=()=>true,withIdentity=false} = {}) {
  const entries = new Map();
  let bytes = 0, visits = 0;
  function save(file) {
    const id = path.relative(root,file).split(path.sep).join('/');
    const before = fs.lstatSync(file,{bigint:true});
    if (!before.isFile() || before.isSymbolicLink() || before.size>1024n*1024n || entries.size>=limit ||
        (bytes+=Number(before.size))>byteLimit) throw fail('Build evidence exceeds its regular file or size limit.');
    const handle = fs.openSync(file,'r');
    try {
      const actual = fs.fstatSync(handle,{bigint:true});
      if (!actual.isFile() || actual.dev!==before.dev || actual.ino!==before.ino || actual.size!==before.size) {
        throw fail('A build file changed while its evidence was captured.');
      }
      const hash = digest(fs.readFileSync(handle)), after = fs.fstatSync(handle,{bigint:true});
      if (after.size!==before.size || after.mtimeNs!==before.mtimeNs || after.ctimeNs!==before.ctimeNs) {
        throw fail('A build file changed while its evidence was captured.');
      }
      entries.set(id,withIdentity?{hash,stamp:[before.ino,before.mtimeNs,before.ctimeNs].map(String).join(':')}:hash);
    } finally {fs.closeSync(handle);}
  }
  function walk(directory,depth) {
    if (depth>35 || !fs.lstatSync(directory).isDirectory()) throw fail('Build evidence requires ordinary bounded project directories.');
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if (++visits>6000 || entry.isSymbolicLink()) throw fail('Build evidence requires a bounded, unlinked project tree.');
      const file = path.join(directory,entry.name);
      if (entry.isDirectory()) walk(file,depth+1);
      else if (entry.isFile() && match(file)) save(file);
    }
  }
  for (const relative of files) {
    const file = physical(root,relative);
    if (file) save(file);
  }
  for (const relative of trees) {
    const directory = physical(root,relative);
    if (directory) walk(directory,0);
  }
  return new Map([...entries].sort(([a],[b])=>a.localeCompare(b)));
}

function sourceInputs(root) {
  return capture(root,{files:descriptors,trees:['src/main/java','src/main/resources']});
}

function compare(before,after,same=(a,b)=>a===b) {
  const added=[],removed=[],changed=[];
  for (const [file,value] of after) {
    if (!before.has(file)) added.push(file);
    else if (!same(before.get(file),value)) changed.push(file);
  }
  for (const file of before.keys()) if (!after.has(file)) removed.push(file);
  return {added,removed,changed};
}

function differs(delta) {return delta.added.length+delta.removed.length+delta.changed.length>0;}
const equalOutputs = (before,after)=>before.hash===after.hash && before.stamp===after.stamp;

function observe({before,after,outcome,inputsChanged}) {
  if (!after) return {state:'unobserved',before:before.size,after:null};
  const delta = compare(before,after,equalOutputs);
  let state = 'outputs-reused';
  if (outcome !== 'succeeded' || inputsChanged) state = 'unverified';
  else if (!after.size) state = 'no-classes';
  else if (!before.size) state = 'outputs-produced';
  else if (differs(delta)) state = 'outputs-updated';
  return {state,before:before.size,after:after.size,...delta};
}

function delegateName(project) {
  const recipe = toolRecipe[project?.tool];
  if (!recipe) throw fail('Choose an imported Maven or Gradle project for delegated compilation.');
  return recipe.task;
}

function createDelegatedBuild({projectFor,taskFor,runTask,assertTrusted,assertSaved = ()=>{},clock = Date.now}) {
  const plans = new Map(), attempts = new Map();
  let running = false, disposed = false, generation = 0;
  function guard(cancellation,ticket = generation) {
    assertTrusted();
    if (disposed || cancelled(cancellation)) throw fail('The reviewed Java compile was closed or cancelled.');
    if (ticket!==generation) throw fail('Workspace folders changed during the delegated Java compile review.');
  }
  function activeProject(project) {
    if (!project || !path.isAbsolute(project.root) || fs.lstatSync(project.root).isSymbolicLink() ||
        physicalKey(fs.realpathSync(project.root))!==physicalKey(project.root)) throw fail('The imported project path changed.');
    return project;
  }
  async function prepare({projectUri,retryFrom,cancellation} = {}) {
    guard(cancellation);
    const ticket = generation;
    const project = activeProject(await projectFor(projectUri,cancellation)), task = delegateName(project);
    const inputs = sourceInputs(project.root), previous = attempts.get(project.id);
    const sincePrevious = previous ? compare(previous.inputs,inputs) : {added:[],removed:[],changed:[]};
    if (retryFrom !== undefined && (previous?.public.state!=='failed' || previous.public.id!==retryFrom)) {
      throw fail('Choose the current failed delegated compile before preparing a retry.');
    }
    assertSaved(project.root,inputs);
    guard(cancellation,ticket);
    for (const [id,plan] of plans) if (clock()>=plan.public.expiresAt || plan.project.id===project.id) plans.delete(id);
    while (plans.size>=12) plans.delete(plans.keys().next().value);
    const id = randomUUID(), visible = {id,projectUri:project.uri,projectName:project.name,tool:project.tool,task,
      inputs:inputs.size,sincePrevious,retryOf:retryFrom||null,expiresAt:clock()+reviewMs};
    plans.set(id,{public:visible,inputs,project});
    return structuredClone(visible);
  }
  async function apply({id,allowProjectExecution = false,cancellation} = {}) {
    guard(cancellation);
    if (allowProjectExecution!==true) throw fail('Choose Run Delegated Compile to execute the reviewed project build.');
    const plan = plans.get(id);
    if (!plan || clock()>=plan.public.expiresAt) throw fail('Review the delegated compile again.');
    if (running) throw fail('Finish the current delegated compile before starting another one.');
    running = true;
    const ticket = generation;
    const {project,inputs} = plan;
    try {
      const current = activeProject(await projectFor(project.uri,cancellation));
      if (current.id!==project.id || current.tool!==project.tool || !inside(project.root,current.root) ||
          physicalKey(current.root)!==physicalKey(project.root)) throw fail('The reviewed Java project changed.');
      function assertInputs() {
        guard(cancellation,ticket);
        if (differs(compare(inputs,sourceInputs(project.root)))) throw fail('Saved Java source or build inputs changed. Review the delegated compile again.');
        assertSaved(project.root,inputs);
      }
      assertInputs();
      const task = await taskFor(current,plan.public.task,cancellation);
      assertInputs();
      if (!task?.id || task.name!==plan.public.task) throw fail('The build tool did not report the reviewed compile task.');
      const outputRoot = toolRecipe[project.tool].output;
      const sample = ()=>capture(project.root,{trees:[outputRoot],withIdentity:true,match:file=>file.endsWith('.class')});
      const before = sample();
      plans.delete(id);
      const result = await runTask(current,task,cancellation);
      assertTrusted();
      if (disposed || ticket!==generation) throw fail('The delegated compile review closed or its workspace changed during the build.');
      let after,inputsChanged;
      try {after=sample(); inputsChanged=differs(compare(inputs,sourceInputs(project.root))); assertSaved(project.root,inputs);}
      catch {inputsChanged=true;}
      const state = ['succeeded','failed','cancelled'].includes(result.state) && result.terminationConfirmed!==false ?
        result.state : 'unconfirmed';
      const report = {id,projectUri:project.uri,projectName:project.name,tool:project.tool,task:task.name,
        state,exitCode:result.exitCode ?? null,terminationConfirmed:result.terminationConfirmed!==false,
        inputsChanged,retryOf:plan.public.retryOf,classes:observe({before,after,outcome:state,inputsChanged}),
        outputRoot,outputEvidence:'Observed local class file contents and file metadata around the delegated build.'};
      while (attempts.size>=30 && !attempts.has(project.id)) attempts.delete(attempts.keys().next().value);
      attempts.set(project.id,{inputs,public:report});
      return structuredClone(report);
    } finally {running=false;}
  }
  function invalidate() {generation++; plans.clear(); attempts.clear();}
  return {prepare,apply,invalidate,report:()=>[...attempts.values()].map(record=>structuredClone(record.public)),dispose(){
    disposed=true; invalidate();
  }};
}

module.exports = {createDelegatedBuild,delegateName,sourceInputs,observe,physicalKey};
