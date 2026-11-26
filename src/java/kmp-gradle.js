'use strict';

const fs = require('node:fs/promises');
const rawFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { buildSpec,taskName } = require('./workbench-tasks');
const { inside,fail,cancelled } = require('./workbench-model');

const BINDINGS=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const BUILD_FILES=['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradle/libs.versions.toml'];

const GRADLE_KMP_INIT=`import groovy.json.JsonOutput
gradle.projectsEvaluated {
  def root = gradle.rootProject
  if (root.tasks.names.contains('rocketbrainKmpModel')) throw new GradleException('The Rocketbrain model task name is already used.')
  root.tasks.register('rocketbrainKmpModel') {
    doLast {
      def modules = root.allprojects.findAll { it.pluginManager.hasPlugin('org.jetbrains.kotlin.multiplatform') }.collect { p ->
        def k = p.extensions.getByName('kotlin')
        def names = p.tasks.names
        def fullTask = { name -> names.contains(name) ? (p.path == ':' ? ':' : p.path + ':') + name : null }
        def sourceSets = k.sourceSets.collect { s ->
          [name: s.name, directories: s.kotlin.srcDirs.collect { it.canonicalPath }.sort(),
           resourceDirectories: s.resources.srcDirs.collect { it.toPath().toAbsolutePath().normalize().toString() }.sort(),
           dependsOn: s.dependsOn.collect { it.name }.sort()]
        }.sort { it.name }
        def targets = k.targets.findAll { it.platformType.name() in ['jvm', 'js'] }.collect { target ->
          def main = target.compilations.findByName('main')
          def test = target.platformType.name() == 'jvm' ? target.name + 'Test' : target.name + 'NodeTest'
          def run = target.platformType.name() == 'jvm' ? target.name + 'Run' : target.name + 'NodeDevelopmentRun'
          [name: target.name, platform: target.platformType.name(), main: main?.allKotlinSourceSets?.collect { it.name }?.sort() ?: [],
           compileTask: main ? fullTask(main.compileTaskProvider.name) : null, testTask: fullTask(test), runTask: fullTask(run)]
        }.sort { it.name }
        [path: p.path, directory: p.projectDir.canonicalPath,
         buildDirectory: p.layout.buildDirectory.get().asFile.canonicalPath, sourceSets: sourceSets, targets: targets]
      }.sort { it.path }
      new File(System.getProperty('rocketbrain.workbench.output')).setText(JsonOutput.toJson([format: 'RocketbrainKmpModel1', modules: modules]), 'UTF-8')
    }
  }
}
`;

function regular(file,root,max) {
  const real=rawFs.realpathSync(file), stat=rawFs.lstatSync(file);
  if (!inside(root,real) || path.relative(file,real) || !stat.isFile() || stat.isSymbolicLink() || stat.size>max) {
    throw fail('Use physical files within the Gradle workspace and inspection byte limits.');
  }
  const read=rawFs.readFileSync(real);
  if (read.length>max) throw fail('A Gradle input changed beyond its inspection limit.');
  return read;
}

function projectForRoot(root) {
  const build=BUILD_FILES.slice(0,2).filter(name => rawFs.existsSync(path.join(root,name)));
  const settings=BUILD_FILES.slice(2,4).filter(name => rawFs.existsSync(path.join(root,name)));
  if (build.length!==1 || settings.length!==1) throw fail('Choose a Gradle root with one build script and one settings script.');
  return {root,uri:pathToFileURL(root).href,name:path.basename(root),tool:'gradle'};
}

function buildSnapshot(root,modules=[]) {
  const files=new Set();
  for (const directory of new Set([root,...modules.map(item => item.directory)])) {
    for (const name of BUILD_FILES) files.add(path.join(directory,name));
  }
  return [...files].sort().map(file => [file,rawFs.existsSync(file)
    ? createHash('sha256').update(regular(file,root,1024*1024)).digest('hex') : null]);
}

function safeDirectory(root,directory) {
  if (typeof directory!=='string' || !path.isAbsolute(directory) || !inside(root,directory)) throw fail('Gradle reported a source root outside the workspace.');
  let existing=directory;
  while (!rawFs.existsSync(existing)) existing=path.dirname(existing);
  const real=rawFs.realpathSync(existing), stat=rawFs.lstatSync(existing);
  if (path.relative(existing,real) || !inside(root,real) || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw fail('Gradle source directories must be physical locations inside the workspace.');
  }
  return directory;
}

function decodeKmpModel(root,value) {
  if (value?.format!=='RocketbrainKmpModel1' || !Array.isArray(value.modules) || value.modules.length>20) throw fail('Unsupported Kotlin Multiplatform Gradle model.');
  const modules=value.modules.map(module => {
    if (!(module.path===':' || typeof module.path==='string' && /^:[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*$/.test(module.path)) ||
        !Array.isArray(module.sourceSets) || module.sourceSets.length>70 || !Array.isArray(module.targets) || module.targets.length>32) {
      throw fail('Invalid Kotlin Multiplatform Gradle module.');
    }
    const directory=safeDirectory(root,module.directory);
    const sourceSets=module.sourceSets.map(set => {
      if (typeof set.name!=='string' || !BINDINGS.test(set.name) || !Array.isArray(set.directories) || set.directories.length>30 ||
          !Array.isArray(set.dependsOn) || !set.dependsOn.every(item => typeof item==='string' && BINDINGS.test(item))) {
        throw fail('Invalid Gradle Kotlin source set.');
      }
      const resourceDirectories=set.resourceDirectories===undefined ? [] : set.resourceDirectories;
      if (!Array.isArray(resourceDirectories)||resourceDirectories.length>30||
          !resourceDirectories.every(dir=>typeof dir==='string'&&path.isAbsolute(dir)&&dir.length<=4096&&!dir.includes('\0'))) {
        throw fail('Invalid Gradle Kotlin resource directories.');
      }
      return {name:set.name,directories:set.directories.map(dir => safeDirectory(root,dir)),dependsOn:set.dependsOn,resourceDirectories};
    });
    const known=new Set(sourceSets.map(set => set.name));
    if (known.size!==sourceSets.length || sourceSets.some(set => set.dependsOn.some(name => !known.has(name)))) throw fail('Inconsistent Kotlin source set graph.');
    function scopedTask(value) {
      if (value===null) return null;
      const name=taskName(value,'gradle'), full=module.path===':' ? ':' : module.path+':';
      if (!name.startsWith(full) || name.slice(full.length).includes(':')) throw fail('A Kotlin task belongs to a different Gradle module.');
      return name;
    }
    const targets=module.targets.map(target => {
      if (typeof target.name!=='string' || !BINDINGS.test(target.name) || !['jvm','js'].includes(target.platform) ||
          !Array.isArray(target.main) || !target.main.every(name => known.has(name))) throw fail('Invalid Kotlin Multiplatform target.');
      return {name:target.name,platform:target.platform,main:target.main,compileTask:scopedTask(target.compileTask),
        testTask:scopedTask(target.testTask),runTask:scopedTask(target.runTask)};
    });
    if (new Set(targets.map(item => item.name)).size!==targets.length) throw fail('Duplicate observed Gradle Kotlin targets.');
    if (module.buildDirectory!==undefined &&
        (typeof module.buildDirectory!=='string'||!path.isAbsolute(module.buildDirectory)||module.buildDirectory.length>4096||
          module.buildDirectory.includes('\0'))) {
      throw fail('Invalid Kotlin Multiplatform build output directory.');
    }
    return {path:module.path,directory,buildDirectory:module.buildDirectory,sourceSets,targets};
  });
  if (!modules.length) throw fail('No configured Kotlin Multiplatform Gradle module was reported.');
  if (new Set(modules.map(module => module.path)).size!==modules.length) throw fail('Duplicate observed Gradle module paths.');
  return {format:'RocketbrainKmpModel1',root,modules,digests:buildSnapshot(root,modules)};
}

async function kmpSpec(root,tools,tasks,discovery) {
  const spec=buildSpec(projectForRoot(root),tools,tasks,discovery);
  if (discovery) spec.args.push('--no-configuration-cache');
  if (tools.gradleUserHome) {
    if (!path.isAbsolute(tools.gradleUserHome)) throw fail('Set an absolute Gradle user home for Kotlin tasks.');
    await fs.mkdir(tools.gradleUserHome,{recursive:true});
    spec.env.GRADLE_USER_HOME=await fs.realpath(tools.gradleUserHome);
  }
  if (tools.nodeHome) {
    if (!path.isAbsolute(tools.nodeHome)) throw fail('Set an absolute Node.js installation directory.');
    const home=await fs.realpath(tools.nodeHome);
    const bin=process.platform==='win32' ? home : path.join(home,'bin');
    const node=await fs.stat(path.join(bin,process.platform==='win32'?'node.exe':'node'));
    if (!node.isFile()) throw fail('Choose a Node.js distribution directory with its executable.');
    const inherited=Object.keys(spec.env).find(key => key.toLowerCase()==='path') || 'PATH';
    spec.env[inherited]=[bin,spec.env[inherited]].filter(Boolean).join(path.delimiter);
  }
  return spec;
}

async function loadKmpModel({root,tools,runner,workspaceTrusted,allowProjectExecution,cancellation}) {
  if (workspaceTrusted!==true || allowProjectExecution!==true) throw fail('Explicitly inspect Kotlin Multiplatform from a trusted Gradle workspace.');
  if (cancelled(cancellation)) throw fail('Kotlin Gradle model inspection cancelled.');
  const parent=await fs.realpath(os.tmpdir()), staging=await fs.mkdtemp(path.join(parent,'rb-kmp-meta-'));
  const identity=await fs.lstat(staging,{bigint:true});
  try {
    const initFile=path.join(staging,'model.gradle'), output=path.join(staging,'model.json');
    await fs.writeFile(initFile,GRADLE_KMP_INIT,{flag:'wx'});
    const previous=JSON.stringify(buildSnapshot(root));
    const spec=await kmpSpec(root,tools,[':rocketbrainKmpModel'],{discovery:true,initFile,output});
    const result=await runner.execute(spec,{cancellation,timeoutMs:240000});
    if (result.code!==0 || cancelled(cancellation)) throw fail('Gradle did not finish Kotlin Multiplatform model inspection. Check its task terminal.');
    if (previous!==JSON.stringify(buildSnapshot(root))) throw fail('Gradle settings changed while reading Kotlin targets. Inspect the project again.');
    const bytes=regular(output,staging,2*1024*1024);
    return decodeKmpModel(root,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  } finally {
    const checked=await fs.realpath(staging), current=await fs.lstat(checked,{bigint:true});
    if (path.relative(staging,checked) || path.relative(path.dirname(checked),parent) || !path.basename(checked).startsWith('rb-kmp-meta-') ||
        current.dev!==identity.dev || current.ino!==identity.ino) throw fail('Kotlin metadata staging directory ownership changed.');
    await fs.rm(checked,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports = { projectForRoot,buildSnapshot,kmpSpec,loadKmpModel,decodeKmpModel,regular,safeDirectory };
