'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { kmpSpec,regular } = require('./kmp-gradle');
const { verifyKmpModel } = require('./kmp-workbench');
const { snapshotKmpSources } = require('./kmp-sources');
const { inspectKmpDebugSources } = require('./kmp-debug-sources');
const { cancelled, fail } = require('./workbench-model');

const execute = promisify(execFile);
const markerKey = 'rocketbrain.kmp.debug.owner';
const bootOptions = /^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/i;
const init = `import groovy.json.JsonSlurper
import groovy.json.JsonOutput
import org.gradle.api.tasks.JavaExec

gradle.projectsEvaluated {
  def config = new JsonSlurper().parse(new File(System.getProperty('rocketbrain.workbench.output')))
  def project = gradle.rootProject.findProject(config.module)
  def kotlin = project?.pluginManager?.hasPlugin('org.jetbrains.kotlin.multiplatform') ? project.extensions.getByName('kotlin') : null
  def target = kotlin?.targets?.findByName(config.target)
  def taskName = config.target + 'Run'
  if (target?.platformType?.name() != 'jvm' || !project.tasks.names.contains(taskName))
    throw new GradleException('The selected Kotlin JVM run task changed.')
  project.tasks.named(taskName, JavaExec).configure { task ->
    if (task.debugOptions.enabled.get() || task.jvmArgs.any { it.startsWith('-agentlib:jdwp') || it.startsWith('-Xrunjdwp') })
      throw new GradleException('Disable existing Kotlin JVM debugging before starting a managed session.')
    task.systemProperty('${markerKey}', config.marker)
    task.debugOptions {
      enabled.set(true)
      host.set('127.0.0.1')
      port.set(0)
      server.set(true)
      suspend.set(true)
    }
    doFirst { selected ->
      def debug = selected.debugOptions
      if (selected.path != config.task || !selected.mainClass.present || selected.javaLauncher.get().metadata.languageVersion.asInt() < 9)
        throw new GradleException('Debug a configured Kotlin JVM application with a Java 9 or newer launcher.')
      if (!debug.enabled.get() || debug.host.orNull != '127.0.0.1' || debug.port.get() != 0 || !debug.server.get() || !debug.suspend.get() ||
          selected.systemProperties['${markerKey}'] != config.marker ||
          selected.jvmArgs.any { it.startsWith('-agentlib:jdwp') || it.startsWith('-Xrunjdwp') } ||
          selected.environment.any { key, value -> key.toUpperCase(java.util.Locale.ROOT) in ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'] && value })
        throw new GradleException('Disable existing Kotlin JVM debug or launcher options before starting a managed session.')
      if (config.lineOutput) {
        def compilation = target.compilations.findByName('main')
        def classpath = selected.classpath.files.collect { it.canonicalPath }.toSet()
        def roots = compilation.output.classesDirs.files.collect { it.canonicalPath }.findAll { classpath.contains(it) }.sort()
        def output = new File(config.lineOutput)
        if (!output.createNewFile()) throw new GradleException('Kotlin class output evidence already exists.')
        output.setText(JsonOutput.toJson([marker: config.marker, task: selected.path, roots: roots]), 'UTF-8')
      }
    }
  }
}
`;

function selectKmpJvmTarget(model, modulePath, targetName) {
  verifyKmpModel(model);
  const module = model.modules.find(item => item.path === modulePath);
  const target = module?.targets.find(item => item.name === targetName && item.platform === 'jvm');
  if (!target?.runTask) throw fail('Choose an observed Kotlin JVM application with a Gradle run task.');
  const sourcePaths = [...new Set(module.sourceSets.filter(set => target.main.includes(set.name)).flatMap(set => set.directories))];
  if (!sourcePaths.length) throw fail('Gradle did not report source directories for this Kotlin JVM application.');
  return { module, target, sourcePaths };
}

async function within(promise, ms) {
  const timer = new AbortController();
  try {return await Promise.race([promise.then(() => true), delay(ms, false, { signal:timer.signal })]);}
  finally {timer.abort();}
}

async function removeStage(stage) {
  const real = await fs.realpath(stage.folder), latest = await fs.lstat(real, {bigint:true});
  if (path.relative(stage.folder, real) || path.relative(stage.parent, path.dirname(real)) ||
      !path.basename(real).startsWith('rb-kmp-debug-') || latest.dev!==stage.identity.dev || latest.ino!==stage.identity.ino) {
    throw fail('Kotlin JVM debug staging directory changed.');
  }
  await fs.rm(real,{recursive:true,maxRetries:8,retryDelay:250});
}

function alive(pid) {
  try {process.kill(pid,0);return true;}
  catch (error) {
    if (error.code==='ESRCH') return false;
    if (error.code==='EPERM') return true;
    throw error;
  }
}

async function stopProcess(record) {
  const {child,done} = record;
  if (child.pid && child.exitCode===null && child.signalCode===null) {
    if (process.platform==='win32') {
      const taskkill=path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe');
      try {await execute(taskkill,['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:10000});}
      catch (error) {if (child.exitCode===null && child.signalCode===null) throw error;}
    } else {
      try {process.kill(-child.pid,'SIGTERM');} catch (error) {if (error.code!=='ESRCH') throw error;}
      if (!await within(done,2500)) {
        try {process.kill(-child.pid,'SIGKILL');} catch (error) {if (error.code!=='ESRCH') throw error;}
      }
    }
  }
  if (!await within(done,12000)) throw fail('The owned Gradle debug task did not exit after stopping.');
  if (record.target) {
    const deadline=Date.now()+5000;
    while (alive(record.target.pid) && Date.now()<deadline) await delay(125);
    if (alive(record.target.pid)) throw fail('The owned debug JVM did not confirm termination.');
  }
  return done;
}

async function startGradleDebugProcess({launch,task,label,marker,resolveDescendant,cancellation,startupMs,
  onOutput,cleanup,ready}) {
  let record,lastError;
  try {
    const child=spawn(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,windowsHide:true,
      detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    record={child,error:undefined,exited:false,tail:'',target:undefined};
    let stopping;
    const stop=()=>stopping??=stopProcess(record).catch(error=>{stopping=undefined;throw error;});
    child.once('error',error=>{record.error=error;});
    const capture=chunk=>{record.tail=(record.tail+chunk).slice(-64000);onOutput(chunk);};
    child.stdout.setEncoding('utf8').on('data',capture);
    child.stderr.setEncoding('utf8').on('data',capture);
    record.done=new Promise(resolve=>child.once('close',(code,signal)=>{
      record.exited=true;
      resolve({code,signal,task});
    })).finally(cleanup);
    void record.done.catch(()=>{});
    record.stop=stop;
    const assertRunning=()=>{
      if (cancelled(cancellation)) throw fail(label+' debugging was cancelled.');
      if (record.exited || record.error) throw fail('The '+label+' Gradle run task exited before exposing its owned debugger. Check its output.');
    };
    const deadline=Date.now()+startupMs;
    while(Date.now()<deadline) {
      assertRunning();
      const ports=[...new Set([...record.tail.matchAll(/^Listening for transport dt_socket at address: (\d{1,5})\s*$/gm)]
        .map(match=>Number(match[1])).filter(port=>port>=1&&port<=65535))];
      if (ports.length>8) throw fail('Gradle reported too many possible '+label+' debugger ports.');
      for (const port of ports) {
        const candidate=await resolveDescendant({ancestorPid:child.pid,port,marker},cancellation)
          .catch(error=>{lastError=error;return undefined;});
        if (!candidate) continue;
        assertRunning();
        record.target=candidate;
        const details=await ready(assertRunning);
        assertRunning();
        return {target:candidate,...details,task,done:record.done,stop};
      }
      await delay(175);
    }
    throw fail('Gradle did not start a verified '+label+' debug listener. Check its output.'+
      (lastError?' '+lastError.message:''));
  } catch(error) {
    if (record) await record.stop();
    else await cleanup();
    throw error;
  }
}


async function startKmpJvmDebug({model,modulePath,targetName,tools,workspaceTrusted,allowProjectExecution,cancellation,
  resolveDescendant,onOutput=()=>{},startupMs=180000,sourceLineJavaHome}) {
  if (workspaceTrusted!==true || allowProjectExecution!==true) throw fail('Explicitly choose Kotlin JVM debugging in a trusted workspace.');
  if (cancelled(cancellation)) throw fail('Kotlin JVM debugging was cancelled.');
  if (typeof resolveDescendant!=='function') throw fail('Configure independent Java debugger ownership checks before Kotlin JVM debugging.');
  const {module,target,sourcePaths}=selectKmpJvmTarget(model,modulePath,targetName);
  const checkSources=()=>snapshotKmpSources(model,module,[targetName],cancellation);
  const before=checkSources(), marker={key:markerKey,value:randomUUID()};
  const parent=await fs.realpath(os.tmpdir()), folder=await fs.mkdtemp(path.join(parent,'rb-kmp-debug-'));
  const stage={parent,folder,identity:await fs.lstat(folder,{bigint:true})};
  const script=path.join(folder,'debug.init.gradle'), settings=path.join(folder,'selection.json'), lineOutput=path.join(folder,'kotlin-classes.json');
  let ownedByRunner=false;
  try {
    await fs.writeFile(script,init,{flag:'wx'});
    await fs.writeFile(settings,JSON.stringify({module:modulePath,target:targetName,task:target.runTask,marker:marker.value,
      ...(sourceLineJavaHome&&{lineOutput})}),{flag:'wx'});
    const launch=await kmpSpec(model.root,tools,[target.runTask],{discovery:true,initFile:script,output:settings});
    for (const key of Object.keys(launch.env)) if (bootOptions.test(key)) delete launch.env[key];
    verifyKmpModel(model);
    if (before.fingerprint!==checkSources().fingerprint) throw fail('Kotlin source files changed before starting the JVM debugger.');
    if (cancelled(cancellation)) throw fail('Kotlin JVM debugging was cancelled.');

    ownedByRunner=true;
    return await startGradleDebugProcess({
      launch,task:target.runTask,label:'Kotlin JVM',marker,resolveDescendant,cancellation,startupMs,onOutput,
      cleanup:()=>removeStage(stage),
      async ready(assertRunning) {
        verifyKmpModel(model);
        if (before.fingerprint!==checkSources().fingerprint) throw fail('Kotlin source files changed while Gradle prepared the debugger.');
        let sourceLines;
        if (sourceLineJavaHome) {
          try {
            const evidence=JSON.parse(regular(lineOutput,folder,65536).toString('utf8'));
            if (evidence.marker!==marker.value || evidence.task!==target.runTask) throw fail('Kotlin class output evidence belongs to a different task.');
            sourceLines=await inspectKmpDebugSources({model,module,snapshot:before,outputs:evidence.roots,folder,
              javaHome:sourceLineJavaHome,cancellation});
            if (Buffer.byteLength(JSON.stringify(sourceLines))>8*1024*1024) throw fail('Kotlin source line evidence exceeds its session limit.');
          } catch (error) {
            sourceLines=undefined;
            onOutput('Kotlin source-line evidence was unavailable. '+error.message+'\n');
          }
          assertRunning();
          verifyKmpModel(model);
          if (before.fingerprint!==checkSources().fingerprint) throw fail('Kotlin sources changed during debugger source verification.');
        }
        return {sourcePaths,sourceLines};
      }
    });
  } catch (error) {
    if (!ownedByRunner) await removeStage(stage);
    throw error;
  }
}

module.exports = { startKmpJvmDebug, selectKmpJvmTarget, startGradleDebugProcess };
