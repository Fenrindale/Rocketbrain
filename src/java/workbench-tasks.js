'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{SaxesParser}=require('saxes');
const M=require('./workbench-model'),{independentJavaExecutable}=require('./debug-runtime');
const {execute:executeProcess}=require('./testing/provision');
const PHASES=['clean','validate','compile','test-compile','test','package','verify','install'];
const gradle = require('./gradle-task-catalog');
function taskName(value,tool){if(typeof value!=='string'||value.length>256||!(tool==='gradle'?/^:?[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/:/^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+){0,3}$/).test(value))throw M.fail('The discovered build task has an unsupported name.');return value;}
function mavenTasks(project){const file=path.join(project.root,'pom.xml'),st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>M.LIMITS.fileBytes)throw M.fail('Use a bounded regular Maven POM.');const source=fs.readFileSync(file,'utf8');if(/<!DOCTYPE|<!ENTITY/i.test(source))throw M.fail('POM entity/DTD declarations are unsupported.');const stack=[],plugins=[];let plugin,property=null;const properties={};const parser=new SaxesParser({xmlns:false});parser.on('opentag',tag=>{stack.push(tag.name);if(stack.slice(-3).join('/')==='build/plugins/plugin'){plugin={groupId:'',goals:[]};plugins.push(plugin);}if(stack.length===3&&stack[1]==='properties'){property=tag.name;properties[property]='';}});parser.on('text',text=>{if(property)properties[property]+=text;if(plugin){const name=stack.at(-1);if(['groupId','artifactId','version'].includes(name)&&stack.at(-2)==='plugin')plugin[name]=(plugin[name]||'')+text;else if(name==='goal'&&stack.slice(-3).join('/')==='execution/goals/goal')plugin.goal=(plugin.goal||'')+text;}});parser.on('closetag',()=>{if(plugin&&stack.at(-1)==='goal'&&plugin.goal!==undefined){plugin.goals.push(plugin.goal.trim());delete plugin.goal;}if(stack.at(-1)==='plugin')plugin=null;if(stack.at(-1)===property)property=null;stack.pop();});parser.write(source).close();const resolve=text=>String(text||'').trim().replace(/\$\{([^}]+)\}/g,(_all,name)=>properties[name]?.trim()??'${'+name+'}'),out=PHASES.map(name=>({name,group:'Lifecycle',description:'Standard Maven lifecycle phase',provenance:'maven-standard-phase'}));for(const p of plugins){const coordinate=[resolve(p.groupId)||'org.apache.maven.plugins',resolve(p.artifactId),resolve(p.version)];if(coordinate.some(v=>!v||v.includes('${')))continue;for(const goal of p.goals){const name=coordinate.concat(goal).join(':');try{taskName(name,'maven');}catch{continue;}out.push({name,group:'Declared plugin goals',description:'Declared in this POM; inherited profiles/plugins are not enumerated',provenance:'pom-declared-goal'});}}return out;}
function buildSpec(project,tools,names,{discovery,output,initFile}={}){const jdk=tools.javaHome||project.jdk;if(!jdk)throw M.fail('Configure an independent project JDK before running build tasks.');const command=independentJavaExecutable(path.join(jdk,'bin',process.platform==='win32'?'java.exe':'java')),env={...process.env,JAVA_HOME:path.dirname(path.dirname(command))};for(const k of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'])delete env[k];let args;
 if(project.tool==='gradle'){if(!tools.gradleHome||!path.isAbsolute(tools.gradleHome))throw M.fail('Set rocketbrain.java.gradleHome to an independent Gradle distribution.');const home=fs.realpathSync(tools.gradleHome),lib=path.join(home,'lib'),launchers=fs.readdirSync(lib).filter(n=>/^gradle-launcher-[\d.]+\.jar$/.test(n));if(launchers.length!==1)throw M.fail('The configured Gradle distribution has no unique launcher.');args=['-Dorg.gradle.java.home='+path.dirname(path.dirname(command)),...(discovery?['-D'+gradle.specification+'='+output]:[]),'-cp',path.join(lib,launchers[0]),'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--max-workers=2',...(discovery?['--no-configuration-cache','--init-script',initFile]:[]),...names.map(n=>taskName(n,'gradle'))];}
 else if(project.tool==='maven'){if(!tools.mavenHome||!path.isAbsolute(tools.mavenHome))throw M.fail('Set rocketbrain.java.mavenHome to an independent Apache Maven distribution.');const home=fs.realpathSync(tools.mavenHome),boot=path.join(home,'boot'),launchers=fs.readdirSync(boot).filter(n=>/^plexus-classworlds-[\d.]+\.jar$/.test(n));if(launchers.length!==1||!fs.existsSync(path.join(home,'bin','m2.conf')))throw M.fail('The configured Maven distribution has no unique classworlds launcher.');args=['-Dmaven.home='+home,'-Dclassworlds.conf='+path.join(home,'bin','m2.conf'),'-Dmaven.multiModuleProjectDirectory='+project.root,'-cp',path.join(boot,launchers[0]),'org.codehaus.plexus.classworlds.launcher.Launcher','--batch-mode','--no-transfer-progress',...names.map(n=>taskName(n,'maven'))];}
 else throw M.fail('This project has no supported Maven or Gradle build file.');return{command,args,env,cwd:project.root,label:project.name+' · '+names.join(' '),tool:project.tool,projectUri:project.uri};}
async function executeReviewedSource(spec, { active, output, cancellation, timeoutMs }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  let subscription;
  if (cancellation?.onCancellationRequested) subscription = cancellation.onCancellationRequested(stop);
  else if (cancellation?.addEventListener) {
    cancellation.addEventListener('abort', stop, { once: true });
    subscription = { dispose: () => cancellation.removeEventListener('abort', stop) };
  }
  if (M.cancelled(cancellation)) stop();
  output?.appendLine?.(spec.label);
  output?.show?.(true);
  const pending = executeProcess(spec.command, spec.args, {
    cwd: spec.cwd, env: spec.env, timeoutMs, cancellation: controller.signal,
    onOutput: value => output?.append?.(value)
  });
  const record = { stop, pending };
  active.add(record);
  try { return await pending; }
  finally { active.delete(record); subscription?.dispose(); }
}

function nativeTaskRunner(vscode,{output}={}){const active=new Set();let disposed=false;async function execute(spec,{cancellation,timeoutMs=M.LIMITS.buildMs}={}){if(disposed||!vscode.workspace.isTrusted)throw M.fail('Trust the workspace before executing project build code.');if(M.cancelled(cancellation))return{code:null,cancelled:true,terminationConfirmed:true};if(spec.reviewedSourceTarget===true)return executeReviewedSource(spec,{active,output,cancellation,timeoutMs});const nonce=crypto.randomUUID(),folder=vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(spec.projectUri)),task=new vscode.Task({type:'rocketbrain-java-workbench',id:nonce,tool:spec.tool},folder||vscode.TaskScope.Workspace,spec.label,'Rocketbrain',new vscode.ProcessExecution(spec.command,spec.args,{cwd:spec.cwd,env:spec.env}),[]);task.presentationOptions={reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.Dedicated,clear:true};let execution,finish,timer,endTimer,sub,settled=false,cancelled=false,timedOut=false;const pending=new Promise(resolve=>{finish=resolve;}),record={terminate:()=>execution?.terminate(),stop:null,pending};active.add(record);const close=(code,extra={})=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(endTimer);sub?.dispose();processEnd.dispose();taskEnd.dispose();active.delete(record);finish({code,cancelled,timedOut,...extra});};const belongs=e=>e.execution===execution||e.execution?.task?.definition?.id===nonce;const processEnd=vscode.tasks.onDidEndTaskProcess(e=>{if(belongs(e))close(e.exitCode??null);}),taskEnd=vscode.tasks.onDidEndTask(e=>{if(belongs(e)&&!settled)endTimer=setTimeout(()=>close(null,{terminationConfirmed:true}),250);});const stop=()=>{if(settled)return;cancelled=true;record.terminate();if(!settled&&!endTimer)endTimer=setTimeout(()=>close(null,{cancelled:true,terminationConfirmed:false}),10000);};if(cancellation?.onCancellationRequested)sub=cancellation.onCancellationRequested(stop);else if(cancellation?.addEventListener){cancellation.addEventListener('abort',stop,{once:true});sub={dispose:()=>cancellation.removeEventListener('abort',stop)};}record.stop=stop;timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);try{execution=await vscode.tasks.executeTask(task);if(M.cancelled(cancellation)||disposed)stop();return await pending;}catch(error){close(null,{startFailed:true});throw error;}}
 return{execute,async stop(){for(const r of active)r.stop();await Promise.allSettled([...active].map(r=>r.pending));},async dispose(){disposed=true;await this.stop();}};}
class BuildTasks {
  constructor({ runner, storagePath, tools, roots } = {}) {
    this.runner = runner;
    this.storagePath = storagePath;
    this.tools = tools;
    this.roots = roots || (project => [project.root]);
    this.catalog = new Map();
    this.running = false;
  }

  async discover(project, { allowProjectExecution = false, cancellation } = {}) {
    if (this.running) throw M.fail('Finish the current managed build operation first.');
    let tasks, guards = [];
    if (project.tool === 'maven') {
      tasks = mavenTasks(project);
    } else if (project.tool === 'java') {
      tasks = [];
    } else {
      if (allowProjectExecution !== true) {
        throw M.fail('Task discovery executes this trusted Gradle project; choose Discover Build Tasks explicitly.');
      }
      this.running = true;
      try {
        const folder = path.join(this.storagePath, 'gradle-task-catalogs', crypto.randomUUID());
        const output = path.join(folder, 'model'), initFile = path.join(folder, 'discover.init.gradle');
        fs.mkdirSync(output, { recursive: true, mode: 0o700 });
        fs.writeFileSync(initFile, gradle.gradleInit, { flag: 'wx', mode: 0o600 });
        const spec = buildSpec(project, this.tools(project), [':help'], { discovery: true, output, initFile });
        const result = await this.runner.execute(spec, { cancellation, timeoutMs: M.LIMITS.buildMs });
        if (result.code !== 0) {
          throw M.fail('Gradle task discovery did not finish successfully. Check its dedicated task terminal.');
        }
        ({ tasks, guards } = gradle.loadCatalog(output, project, this.roots(project)));
      } finally {
        this.running = false;
      }
    }
    if (tasks.length > M.LIMITS.tasks) throw M.fail('Discover at most 200 build tasks per project.');
    if (M.buildFingerprint(project.root) !== project.buildFingerprint) {
      throw M.fail('Build files changed during discovery; refresh the project and discover tasks again.');
    }
    const guardId = guards.length ? M.hash(guards) : null;
    const entries = tasks.map(task => ({
      id: M.id('task', [project.id, project.buildFingerprint, task.name, ...(task.buildName ? [guardId] : [])]),
      projectId: project.id,
      projectUri: project.uri,
      tool: project.tool,
      name: taskName(task.name, project.tool),
      group: String(task.group || 'Other').slice(0, 100),
      description: String(task.description || '').slice(0, 512),
      provenance: task.provenance,
      ...(task.buildName && { buildName: task.buildName })
    }));
    this.catalog.set(project.id, { entries, guards });
    return structuredClone(entries);
  }

  list(project) {
    return structuredClone(this.catalog.get(project.id)?.entries || []);
  }

  async run(project, taskId, { allowProjectExecution = false, cancellation } = {}) {
    if (allowProjectExecution !== true) throw M.fail('Run project build code only through an explicit trusted build action.');
    if (this.running) throw M.fail('A managed build task is already running.');
    const catalog = this.catalog.get(project.id);
    const task = catalog?.entries.find(item => item.id === taskId);
    if (!task) throw M.fail('Choose a current observed build task.');
    if (M.buildFingerprint(project.root) !== project.buildFingerprint) {
      throw M.fail('Build files changed after task discovery. Refresh and review the task again.');
    }
    if (catalog.guards.length) gradle.verifyInputs(catalog.guards, this.roots(project));
    return this.executePrepared(() => ({ spec: buildSpec(project, this.tools(project), [task.name]),
      task: task.name, projectId: project.id }), { allowProjectExecution, cancellation });
  }

  async executePrepared(prepare, { allowProjectExecution = false, cancellation } = {}) {
    if (allowProjectExecution !== true) throw M.fail('Run project build code only through an explicit trusted build action.');
    if (this.running) throw M.fail('A managed build task is already running.');
    if (M.cancelled(cancellation)) throw M.fail('The reviewed Java build was cancelled before launch.');
    this.running = true;
    try {
      const { spec, task, projectId } = prepare();
      const result = await this.runner.execute(spec, { cancellation, timeoutMs: M.LIMITS.buildMs });
      return {
        id: crypto.randomUUID(), task, projectId,
        state: result.code === 0 ? 'succeeded' : result.cancelled ? 'cancelled' : 'failed',
        exitCode: result.code, terminationConfirmed: result.terminationConfirmed !== false
      };
    } finally {
      this.running = false;
    }
  }

  async stop() { await this.runner.stop?.(); }
  async dispose() { await this.runner.dispose?.(); }
}

module.exports={PHASES,taskName,mavenTasks,buildSpec,nativeTaskRunner,BuildTasks};
