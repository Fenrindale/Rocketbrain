'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { regular, safeDirectory, buildSnapshot, kmpSpec } = require('./kmp-gradle');
const { inspectKmpDebugSources } = require('./kmp-debug-sources');
const { startGradleDebugProcess } = require('./kmp-jvm-debug');
const { inside, fail, cancelled, hash } = require('./workbench-model');

const prefix = 'rb-groovy-debug-';
const markerKey = 'rocketbrain.groovy.debug.owner';
const init = `import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import org.gradle.api.tasks.JavaExec
import org.gradle.api.tasks.compile.GroovyCompile

gradle.projectsEvaluated {
  def requested = new JsonSlurper().parse(new File(System.getProperty('rocketbrain.workbench.output')))
  def root = gradle.rootProject
  if (gradle.parent != null || gradle.includedBuilds || root.childProjects ||
      root.projectDir.canonicalPath != requested.root ||
      !root.pluginManager.hasPlugin('groovy') || !root.pluginManager.hasPlugin('application'))
    throw new GradleException('Debug one root Gradle application with the Groovy and application plugins.')
  def main = root.sourceSets.getByName('main')
  if (main.groovy.srcDirs*.canonicalPath != [new File(root.projectDir, 'src/main/groovy').canonicalPath] ||
      main.java.srcDirs*.canonicalPath != [new File(root.projectDir, 'src/main/java').canonicalPath] ||
      main.resources.srcDirs*.canonicalPath != [new File(root.projectDir, 'src/main/resources').canonicalPath])
    throw new GradleException('Choose the standard Gradle main source directories for Groovy debugging.')
  def compile = root.tasks.named('compileGroovy', GroovyCompile)
  root.tasks.named('run', JavaExec).configure { task ->
    if (task.debugOptions.enabled.get() || task.systemProperties.containsKey('rocketbrain.groovy.debug.owner'))
      throw new GradleException('Remove existing debugger settings before selecting the managed Groovy application.')
    task.systemProperty('rocketbrain.groovy.debug.owner', requested.token)
    task.debugOptions {
      enabled.set(true)
      host.set('127.0.0.1')
      port.set(0)
      server.set(true)
      suspend.set(true)
    }
    doFirst { selected ->
      def output = compile.get().destinationDirectory.get().asFile
      def debug = selected.debugOptions
      def launchVars = ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS']
      if (selected.path != ':run' || !selected.mainClass.present || selected.mainModule.present ||
          selected.javaLauncher.get().metadata.languageVersion.asInt() < 9 ||
          !selected.classpath.files*.canonicalPath.contains(output.canonicalPath) ||
          !debug.enabled.get() || debug.host.orNull != '127.0.0.1' || debug.port.get() != 0 ||
          !debug.server.get() || !debug.suspend.get() ||
          selected.systemProperties['rocketbrain.groovy.debug.owner'] != requested.token ||
          selected.jvmArgs.any { it.startsWith('-agentlib:jdwp') || it.startsWith('-Xrunjdwp') } ||
          selected.environment.any { key, value -> key.toUpperCase(java.util.Locale.ROOT) in launchVars && value })
        throw new GradleException('The reviewed Gradle :run Groovy debugger settings changed or its classpath is unsupported.')
      def evidence = new File(requested.evidence)
      if (!evidence.createNewFile()) throw new GradleException('Groovy class output evidence already exists.')
      evidence.setText(JsonOutput.toJson([token: requested.token, task: selected.path, output: output.canonicalPath]), 'UTF-8')
    }
  }
}
`;

function captureGroovyDebugSources(root, file, cancellation) {
  if (cancelled(cancellation)) throw fail('Groovy debugging was cancelled.');
  if (fs.existsSync(path.join(root,'buildSrc'))) throw fail('Use a standard Gradle application without a local buildSrc project.');
  const sourceRoot = path.join(root, 'src', 'main', 'groovy'), files = new Map(), inputs = [];
  if (!inside(sourceRoot, file) || !/\.groovy$/u.test(file)) throw fail('Open a saved Groovy class in src/main/groovy.');
  const main = path.dirname(sourceRoot);
  let examined = 0, total = 0;
  function walk(directory, depth) {
    if (depth > 24) throw fail('Groovy project sources exceed their directory depth limit.');
    safeDirectory(root, directory);
    const listing = fs.opendirSync(directory);
    try {
      for (let entry; (entry = listing.readSync()) !== null;) {
        if (cancelled(cancellation)) throw fail('Groovy debugging was cancelled.');
        if (++examined > 5000) throw fail('Groovy project sources exceed their inspection limit.');
        const current = path.join(directory, entry.name);
        if (entry.isDirectory()) { walk(current, depth + 1); continue; }
        if (!entry.isFile()) throw fail('Use physical Groovy source and resource files.');
        const bytes = regular(current, root, 512 * 1024);
        total += bytes.length;
        if (total > 16 * 1024 * 1024) throw fail('Groovy project sources exceed their byte limit.');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        inputs.push([current, sha256]);
        if (inside(sourceRoot, current) && current.endsWith('.groovy')) {
          if (files.size >= 240) throw fail('Debug at most 240 saved Groovy files in one application.');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n');
          files.set(current, { file: current, text, sha256 });
        }
      }
    } finally { listing.closeSync(); }
  }
  walk(main, 0);
  if (!files.has(file)) throw fail('Choose a physical saved Groovy source file in the application.');
  return { files, sourceRoot, fingerprint: hash([buildSnapshot(root), inputs.sort(([left],[right]) => left.localeCompare(right))]) };
}

async function startGroovyApplicationDebug({ project, file, tools, javaHome, cancellation, verify,
  resolveDescendant, onOutput=()=>{} }) {
  const snapshot = verify();
  const target = path.join(project.root, 'build', 'classes', 'groovy', 'main');
  const parent = await fsp.realpath(os.tmpdir());
  const folder = await fsp.mkdtemp(path.join(parent, prefix));
  const identity = await fsp.lstat(folder, { bigint: true });
  const cleanup = async () => {
    const real = await fsp.realpath(folder), found = await fsp.lstat(real, { bigint: true });
    if (path.relative(real, folder) || path.relative(parent, path.dirname(real)) ||
        !path.basename(real).startsWith(prefix) || identity.dev !== found.dev || identity.ino !== found.ino) {
      throw fail('The owned Groovy debug staging directory changed.');
    }
    await fsp.rm(real, { recursive: true, maxRetries: 8, retryDelay: 250 });
  };
  const marker = { key: markerKey, value: randomUUID() };
  let handedOff = false;
  try {
    const initFile = path.join(folder, 'debug.init.gradle'), output = path.join(folder, 'review.json');
    const evidence = path.join(folder, 'compiled.json');
    await fsp.writeFile(initFile, init, { flag: 'wx' });
    await fsp.writeFile(output, JSON.stringify({ root: project.root, token: marker.value, evidence }), { flag: 'wx' });
    const launch = await kmpSpec(project.root, tools, [':run'], { discovery: true, initFile, output });
    for (const key of Object.keys(launch.env)) {
      if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|GRADLE_OPTS)$/iu.test(key)) delete launch.env[key];
    }
    verify();
    handedOff = true;
    return await startGradleDebugProcess({ launch, task: ':run', label: 'Groovy JVM', marker,
      resolveDescendant, cancellation, startupMs: 180000, onOutput, cleanup,
      async ready(assertRunning) {
        verify();
        const compiled = JSON.parse(regular(evidence, folder, 4096).toString('utf8'));
        if (compiled.token !== marker.value || compiled.task !== ':run' || path.relative(target, compiled.output)) {
          throw fail('Gradle did not report the reviewed Groovy main class output.');
        }
        const sourceLines = await inspectKmpDebugSources({ model: project, module: { directory: project.root },
          snapshot, outputs: [safeDirectory(project.root,target)], javaHome, folder, cancellation, language: 'groovy' });
        const selected = sourceLines.files.find(source => !path.relative(source.file, file));
        if (!Object.keys(selected?.lines ?? {}).length || Buffer.byteLength(JSON.stringify(sourceLines)) > 8 * 1024 * 1024) {
          throw fail('The selected Groovy class has no unambiguous saved source-line evidence.');
        }
        assertRunning();
        verify();
        return { sourcePaths: [snapshot.sourceRoot], sourceLines };
      }
    });
  } catch (error) {
    if (!handedOff) await cleanup();
    throw error;
  }
}

module.exports = { startGroovyApplicationDebug, captureGroovyDebugSources };
