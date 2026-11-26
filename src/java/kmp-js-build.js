'use strict';

const raw = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { regular, safeDirectory, kmpSpec } = require('./kmp-gradle');
const { verifyKmpModel } = require('./kmp-workbench');
const { snapshotKmpSources } = require('./kmp-sources');
const { bindKotlinJsMap, linkedKotlinMap } = require('./kmp-js-source-map');
const { cancelled, fail, inside } = require('./workbench-model');

const prefix = 'rb-kotlin-js-debug-';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const jsFile = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,180}\.js(?:\.map)?$/u;
const decode = new TextDecoder('utf-8',{fatal:true});
const init = `import groovy.json.JsonOutput
import groovy.json.JsonSlurper

gradle.projectsEvaluated {
  if (gradle.parent != null) return
  def input = new JsonSlurper().parse(new File(System.getProperty('rocketbrain.workbench.output')))
  def project = gradle.rootProject.findProject(input.module)
  def target = project?.extensions?.findByName('kotlin')?.targets?.findByName(input.target)
  if (target?.platformType?.name() != 'js' || project.projectDir.canonicalPath != input.directory)
    throw new GradleException('The selected Kotlin/JS target or its module changed.')
  def run = project.tasks.named(input.run).get()
  def sync = project.tasks.named(input.sync).get()
  def link = project.tasks.named(input.link).get()
  def metadata = project.tasks.named(input.manifest).get()
  def vendorName = { task -> task.class.name.replaceFirst(/_Decorated$/, '') }
  if (vendorName(run) != 'org.jetbrains.kotlin.gradle.targets.js.nodejs.NodeJsExec' ||
      vendorName(sync) != 'org.jetbrains.kotlin.gradle.targets.js.ir.DefaultIncrementalSyncTask' ||
      vendorName(link) != 'org.jetbrains.kotlin.gradle.targets.js.ir.KotlinJsIrLink')
    throw new GradleException('Choose a Kotlin/JS Node development executable from the standard Gradle tasks.')
  def modes = link.class.classLoader.loadClass('org.jetbrains.kotlin.gradle.dsl.JsSourceMapEmbedMode')
  link.compilerOptions.sourceMap.set(true)
  link.compilerOptions.sourceMapEmbedSources.set(modes.enumConstants.find {
    it.name() == 'SOURCE_MAP_SOURCE_CONTENT_ALWAYS'
  })
  sync.doLast {
    def packageJson = metadata.outputs.files.files.findAll { it.name == 'package.json' }
    def evidence = new File(input.result)
    if (packageJson.size() != 1 || !evidence.createNewFile())
      throw new GradleException('The Kotlin/JS runtime output is ambiguous.')
    evidence.setText(JsonOutput.toJson([
      token:input.token, module:project.path, sync:sync.path, output:sync.destinationDirectory.get().canonicalPath,
      entry:run.inputFileProperty.get().asFile.canonicalPath, working:run.workingDir.canonicalPath,
      manifest:packageJson[0].canonicalPath
    ]),'UTF-8')
  }
}
`;

function jsDebugSelection(model, modulePath, name) {
  verifyKmpModel(model);
  const module = model.modules.find(item => item.path === modulePath);
  const target = module?.targets.find(item => item.platform === 'js' && item.name === name);
  const qualify = task => (modulePath === ':' ? ':' : modulePath + ':') + task;
  if (!target || target.runTask !== qualify(name + 'NodeDevelopmentRun') || !/^[A-Za-z][A-Za-z0-9_]{0,55}$/u.test(name)) {
    throw fail('Choose an observed Kotlin/JS target with a Node development executable.');
  }
  const tasks = { run: name+'NodeDevelopmentRun', sync: name+'DevelopmentExecutableCompileSync',
    link: 'compileDevelopmentExecutableKotlin'+name[0].toUpperCase()+name.slice(1), manifest: name+'PackageJson' };
  return { module, target, tasks, syncTask: qualify(tasks.sync), packageTask: qualify(tasks.manifest) };
}

function snapshotJsInputs(model, selection, cancellation) {
  if (cancelled(cancellation)) throw fail('Kotlin/JS debugging was cancelled.');
  verifyKmpModel(model);
  return snapshotKmpSources(model, selection.module, [selection.target.name], cancellation);
}

async function stageFolder() {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  const identity = await fs.lstat(directory,{bigint:true});
  let removed;
  return { directory, remove() {
    removed ||= (async () => {
      const canonical = await fs.realpath(directory), seen = await fs.lstat(canonical,{bigint:true});
      if (path.relative(directory,canonical) || path.relative(parent,path.dirname(canonical)) ||
          !path.basename(canonical).startsWith(prefix) || seen.dev!==identity.dev || seen.ino!==identity.ino) {
        throw fail('The owned Kotlin/JS debug staging directory changed.');
      }
      await fs.rm(canonical,{recursive:true,maxRetries:8,retryDelay:250});
    })().catch(error=>{removed=undefined;throw error;});
    return removed;
  } };
}

function inspectDistribution(module, facts) {
  const { output, entry, working, manifest } = facts;
  safeDirectory(module.directory, working);
  safeDirectory(module.directory, output);
  if (!inside(path.join(module.directory,'build'), working) ||
      path.relative(path.join(working,'kotlin'),output) ||
      typeof entry !== 'string' || path.relative(output,path.dirname(entry)) || !jsFile.test(path.basename(entry)) ||
      !entry.endsWith('.js') || typeof manifest!=='string' || path.relative(path.join(working,'package.json'),manifest)) {
    throw fail('Gradle did not provide one physical development JS executable and package descriptor.');
  }
  const metadata = regular(manifest, module.directory, 128*1024);
  const descriptor = JSON.parse(decode.decode(metadata));
  const dependencies = ['dependencies','optionalDependencies','peerDependencies'];
  if (descriptor.main !== 'kotlin/'+path.basename(entry) ||
      descriptor.type !== undefined && descriptor.type !== 'commonjs' ||
      descriptor.bundledDependencies !== undefined &&
        (!Array.isArray(descriptor.bundledDependencies) || descriptor.bundledDependencies.length) ||
      dependencies.some(key => descriptor[key] !== undefined &&
        (!descriptor[key] || Array.isArray(descriptor[key]) || typeof descriptor[key] !== 'object' || Object.keys(descriptor[key]).length))) {
    throw fail('Use a CommonJS Kotlin/JS development executable without external npm runtime dependencies.');
  }
  const files = [];
  let bytes = 0;
  const names = new Set(), directory=raw.opendirSync(output);
  try {
    for(let item;(item=directory.readSync())!==null;) {
      if (!item.isFile() || !jsFile.test(item.name) || names.has(item.name.toLowerCase()) || files.length>=80) {
        throw fail('The Kotlin/JS debug package contains unsupported output files.');
      }
      names.add(item.name.toLowerCase());
      const file=path.join(output,item.name), input=regular(file,module.directory,16*1024*1024);
      if ((bytes += input.length)>64*1024*1024) throw fail('The Kotlin/JS debug package exceeds its byte limit.');
      files.push({ name:item.name,file,input,sha256:digest(input) });
    }
  } finally {directory.closeSync();}
  return { entry, metadata, files };
}

async function buildKotlinJsDebug({ model, selection, tools, runner, cancellation, validate }) {
  const snapshot = validate();
  const stage = await stageFolder(), token = randomUUID();
  try {
    const initFile=path.join(stage.directory,'debug.gradle'), settings=path.join(stage.directory,'selection.json');
    const resultFile=path.join(stage.directory,'output.json');
    await fs.writeFile(initFile,init,{flag:'wx'});
    await fs.writeFile(settings,JSON.stringify({ ...selection.tasks, token, module:selection.module.path,
      target:selection.target.name,directory:selection.module.directory,result:resultFile }),{flag:'wx'});
    const build = await kmpSpec(model.root,tools,[selection.packageTask,selection.syncTask],
      {discovery:true,initFile,output:settings});
    build.args.push('--rerun-tasks');
    validate();
    const result=await runner.execute(build,{cancellation,timeoutMs:240000});
    validate();
    if (result.code!==0) throw fail('Gradle did not build the Kotlin/JS development executable. Check its task terminal.');
    const facts=JSON.parse(decode.decode(regular(resultFile,stage.directory,8192)));
    if (facts.token!==token || facts.module!==selection.module.path || facts.sync!==selection.syncTask) {
      throw fail('Gradle output belongs to a different Kotlin/JS build.');
    }
    const distribution=inspectDistribution(selection.module,facts);
    const entry=distribution.files.find(file=>!path.relative(file.file,distribution.entry));
    if (!entry) throw fail('Gradle did not emit the Kotlin/JS executable.');
    const script=decode.decode(entry.input);
    const mapName=linkedKotlinMap(script,distribution.entry);
    const mapFile=distribution.files.find(file=>file.name===mapName);
    if (!mapFile) throw fail('Gradle did not emit the adjacent Kotlin/JS source map.');
    const mapping=bindKotlinJsMap({map:JSON.parse(decode.decode(mapFile.input)),mapFile:mapFile.file,script,snapshot});
    const files=path.join(stage.directory,'kotlin');
    await fs.mkdir(files);
    await fs.writeFile(path.join(stage.directory,'package.json'),distribution.metadata,{flag:'wx'});
    for(const artifact of distribution.files) {
      if(cancelled(cancellation)) throw fail('Kotlin/JS debugging was cancelled.');
      await fs.writeFile(path.join(files,artifact.name),artifact.input,{flag:'wx'});
    }
    for(const artifact of distribution.files) {
      if (digest(regular(artifact.file,selection.module.directory,16*1024*1024))!==artifact.sha256) {
        throw fail('The Kotlin/JS build output changed while freezing it. Debug again.');
      }
    }
    validate();
    return { ...stage, entry:path.join(files,entry.name), artifactSha256:entry.sha256,
      mapName,mapSha256:mapFile.sha256,mapping };
  } catch(error) {
    await stage.remove();
    throw error;
  }
}

module.exports = { jsDebugSelection, snapshotJsInputs, buildKotlinJsDebug, digest };
