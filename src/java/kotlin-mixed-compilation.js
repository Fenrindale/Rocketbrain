'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { inside, fail } = require('./workbench-model');
const { inspectCompilerJar, sanitizeCompilerJar, snapshotClasspath, visitJar } = require('./signature-compiler');
const { execute } = require('./testing/provision');

const outputs = ['build/classes/java/main', 'build/classes/kotlin/main', 'build/resources/main',
  'build/classes/java/test', 'build/classes/kotlin/test', 'build/resources/test', 'bin', 'bin/main', 'bin/test'];
const isMain = (root, file) => /^src[\\/]main[\\/](?:java|kotlin)[\\/]/u.test(path.relative(root, file));
const pathKey = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function reviewedClasspath(root, cp) {
  const project = cp?.projectRoot;
  if (!project || !Array.isArray(cp.classpaths) || cp.classpaths.length > 180 || cp.modulepaths?.length) {
    throw fail('Import the single Gradle JVM project and resolve its ordinary Java compile classpath first.');
  }
  const observed = String(project).startsWith('file:') ? fileURLToPath(project) : project;
  if (typeof observed !== 'string' || !path.isAbsolute(observed) || pathKey(observed) !== pathKey(root)) {
    throw fail('The Java language server resolved a different JVM project.');
  }
  const knownOutputs = new Set(outputs.map(file => pathKey(path.join(root, file))));
  const workspaceOutputs = new Set(outputs.map(file => ('/' + path.basename(root) + '/' + file).toLowerCase()));
  const result = new Map();
  for (const input of cp.classpaths) {
    if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes(path.delimiter)) {
      throw fail('Use physical local JVM compiler classpaths.');
    }
    const spelling = input.replaceAll('\\', '/');
    if (knownOutputs.has(pathKey(input)) ||
        process.platform === 'win32' && workspaceOutputs.has(spelling.toLowerCase())) continue;
    if (spelling.startsWith('//') || process.platform === 'win32' && spelling.startsWith('/')) {
      throw fail('The Java model returned an unreviewed workspace-relative or network classpath.');
    }
    const file = fs.realpathSync(input), stat = fs.lstatSync(input);
    if (!stat.isFile() || stat.isSymbolicLink() || pathKey(file) !== pathKey(input) || !file.endsWith('.jar')) {
      throw fail('Mixed type rename does not use another project output or an unreviewed classpath directory.');
    }
    if (/^kotlin-stdlib(?:-[A-Za-z0-9_.-]+)?\.jar$/u.test(path.basename(file))) continue;
    result.set(pathKey(file), file);
  }
  return [...result.values()];
}

async function compileMixedKotlin({ root, directory, files, classpath, compiler, cancellation }) {
  const source = path.join(directory, 'src'), kotlinOutput = path.join(directory, 'kotlin-output');
  await fsp.mkdir(kotlinOutput, { recursive: true });
  const roots = new Set(), java = [];
  for (const file of files) {
    const relative = path.relative(root, file.file);
    if (!isMain(root, file.file) || relative.length > 220 || !inside(root, file.file)) throw fail('Use bounded main JVM sources.');
    const staged = path.join(source, relative);
    await fsp.mkdir(path.dirname(staged), { recursive: true });
    await fsp.writeFile(staged, file.text, { flag: 'wx' });
    roots.add(path.join(source, ...relative.split(path.sep).slice(0, 3)));
    if (file.file.endsWith('.java')) java.push({ ...file, uri: pathToFileURL(file.file).href });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS)$/iu.test(name)));
  const dependencies = [compiler.stdlib, ...classpath];
  const result = await execute(compiler.java, ['-XX:ActiveProcessorCount=2', '-Xmx768m',
    '-cp', compiler.libraries.join(path.delimiter), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib',
    '-no-reflect', '-jvm-target', '24', '-classpath', dependencies.join(path.delimiter),
    '-d', kotlinOutput, ...roots], { cwd: directory, env, timeoutMs: 45000, cancellation });
  if (result.code !== 0 || result.timedOut || result.cancelled) {
    throw fail('The Kotlin compiler could not verify the reviewed mixed source snapshot. ' + result.output.slice(-1800));
  }
  return { kotlinOutput, java, dependencies };
}

async function withMixedClasspath({ compiler, classpath, fqns }, run) {
  const blocked = new Set(fqns.map(name => name.replaceAll('.', '/') + '.class'));
  const runtime = snapshotClasspath(compiler.javaHome, [...compiler.libraries, ...classpath]);
  const parent = await fsp.realpath(os.tmpdir()), stage = await fsp.mkdtemp(path.join(parent, 'rb-mixed-type-'));
  const identity = await fsp.lstat(stage, { bigint: true });
  try {
    const isolated = [];
    for (const [index, file] of classpath.entries()) {
      await visitJar(file, async entry => {
        const classFile = entry.fileName.replace(/^META-INF\/versions\/\d+\//u, '');
        if (blocked.has(classFile)) throw fail('An observed dependency already supplies the selected or destination JVM class.');
      });
      const metadata = await inspectCompilerJar(file, 256 * 1024);
      if (metadata.sanitized) {
        const target = path.join(stage, index + '.jar');
        await sanitizeCompilerJar(file, target);
        isolated.push(target);
      } else isolated.push(file);
    }
    runtime.validate();
    const result = await run({ stage, isolated, validateRuntime: runtime.validate });
    runtime.validate();
    return result;
  } finally {
    const real = await fsp.realpath(stage), current = await fsp.lstat(real, { bigint: true });
    if (pathKey(real) !== pathKey(stage) || path.dirname(real) !== parent || !path.basename(real).startsWith('rb-mixed-type-') ||
        current.dev !== identity.dev || current.ino !== identity.ino) throw fail('Mixed compiler staging changed ownership.');
    await fsp.rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

module.exports = { isMain, reviewedClasspath, compileMixedKotlin, withMixedClasspath };
