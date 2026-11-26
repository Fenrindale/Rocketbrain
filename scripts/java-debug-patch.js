'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { EXCEPTION_SOURCE_PATH, EXCEPTION_SOURCE_SHA256, patchExceptionSession } = require('./java-debug-exception-patch');

const SOURCE_COMMIT = '5c7562ade22977b15f76f46d13c098e82cc58ced';
const SOURCE_PATH = 'com.microsoft.java.debug.plugin/src/main/java/com/microsoft/java/debug/plugin/internal/JavaDebugServer.java';
const SOURCE_URL = `https://raw.githubusercontent.com/microsoft/java-debug/${SOURCE_COMMIT}/${SOURCE_PATH}`;
const SOURCE_SHA256 = 'f70a6678899e0f5f13fc4d64381c2479d32cbf51ddf6462d6553a0a2863c608d';
const LICENSE_URL = `https://raw.githubusercontent.com/microsoft/java-debug/${SOURCE_COMMIT}/LICENSE.txt`;
const LICENSE_SHA256 = 'f494326c16bc95ebb14874ea5fa2c16a963eb36d1f2ab6fe99490073709771c1';
const CORE_SOURCE_PATH = 'com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/AdapterUtils.java';
const CORE_SOURCE_URL = `https://raw.githubusercontent.com/microsoft/java-debug/${SOURCE_COMMIT}/${CORE_SOURCE_PATH}`;
const CORE_SOURCE_SHA256 = '344b263beda29243db301e1e04bb3812a73d71e4b4e5b23f145165e8c8df76ec';
const EXCEPTION_SOURCE_URL = 'https://raw.githubusercontent.com/microsoft/java-debug/' + SOURCE_COMMIT + '/' + EXCEPTION_SOURCE_PATH;
const INSPECTION_SOURCE_PATH = 'com.microsoft.java.debug.core/src/main/java/com/microsoft/java/debug/core/adapter/DebugAdapter.java';
const INSPECTION_SOURCE_URL = 'https://raw.githubusercontent.com/microsoft/java-debug/' + SOURCE_COMMIT + '/' + INSPECTION_SOURCE_PATH;
const INSPECTION_SOURCE_SHA256 = '9e4ecb59403bacf8f2dc7ef537a13717a17981ad0636b14402e0b4e7b5bae322';
const DISPATCH_FROM = '        Command command = Command.parse(request.command);';
const DISPATCH_TO = '        if ("rocketbrain/readJavaValues".equals(request.command)) {\n' +
  '            return LocalValueInspection.read(request, response, debugContext);\n        }\n' +
  '        if ("rocketbrain/watchKotlinCoroutine".equals(request.command)) {\n' +
  '            return CoroutineFrameWatch.dispatch(request, response, debugContext);\n        }\n' +
  '        CompletableFuture<Messages.Response> kotlinWatch = KotlinWatchEvaluation.dispatch(request, response, debugContext);\n' +
  '        if (kotlinWatch != null) {\n            return kotlinWatch;\n        }\n' + DISPATCH_FROM;
const CORE_PATCH_FROM = '                Path fullpath = Paths.get(path, sourceName);\n                if (Files.isRegularFile(fullpath)) {\n                    return fullpath.toString();\n                }';
const CORE_PATCH_TO = '                try {\n                    Path fullpath = Paths.get(path, sourceName);\n                    if (Files.isRegularFile(fullpath)) {\n                        return fullpath.toString();\n                    }\n                } catch (InvalidPathException invalidGeneratedSource) {\n                    // Runtime-generated source names such as <generated> are not files.\n                    // Keep the frame without source instead of failing the whole stack.\n                }';
const PATCH_FROM = 'this.serverSocket = new ServerSocket(0, 1);';
const PATCH_TO = 'this.serverSocket = new ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1"));';
const PATCH_NOTICE = [
  'Rocketbrain Java debug server patches v6',
  'Upstream: microsoft/java-debug 0.53.1 (' + SOURCE_COMMIT + ')',
  'Patch 1 source: ' + SOURCE_URL,
  'Original source SHA-256: ' + SOURCE_SHA256,
  'Change: bind the DAP server to IPv4 loopback 127.0.0.1.',
  'Patch 2 source: ' + CORE_SOURCE_URL,
  'Original source SHA-256: ' + CORE_SOURCE_SHA256,
  'Change: retain stack frames for invalid generated source paths on Windows.',
  'Patch 3 source: ' + EXCEPTION_SOURCE_URL,
  'Original source SHA-256: ' + EXCEPTION_SOURCE_SHA256,
  'Change: bind class-prepare events to their own exception request, and use one effective exception request for overlapping exception types.',
  'Patch 4 source: ' + INSPECTION_SOURCE_URL,
  'Original source SHA-256: ' + INSPECTION_SOURCE_SHA256,
  'Change: add a local array/list and string read request using direct suspended-frame JDI values.',
  'Patch 5: bind an opted-in Kotlin continuation to one temporary JDI method entry request and report its live source frame.',
  'Patch 6: use suspended Kotlin frame debug metadata to evaluate read-only scalar watches without executing debuggee methods.',
  'Removed original signature files from modified JARs. Original project copyright and license notices are retained.',
  'Patched JavaDebugServer.java, AdapterUtils.java, DebugSession.java, DebugAdapter.java, LocalValueInspection.java, CoroutineFrameWatch.java and KotlinWatchEvaluation.java are included under META-INF/rocketbrain-sources/.',
  'Full upstream source is available at https://github.com/microsoft/java-debug/tree/' + SOURCE_COMMIT,
  ''
].join('\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Java debug local build failed: ${path.basename(executable)} ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}
async function verifiedText(url, checksum, file) {
  if (fs.existsSync(file) && hash(fs.readFileSync(file)) === checksum) return fs.readFileSync(file, 'utf8');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Debug source download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 65536 || hash(bytes) !== checksum) throw new Error('Debug source checksum mismatch.');
  await fs.promises.writeFile(file, bytes); return bytes.toString('utf8');
}
async function buildPatchedBundle({ target, javaHome, serverPath, upstreamJar, sourceJar, coreSourceJar, outputJar }) {
  if (![target, javaHome, upstreamJar, outputJar].every(value => path.isAbsolute(value || ''))) throw new Error('Debug build paths must be absolute.');
  await fs.promises.mkdir(target, { recursive: true });
  const originalSource = await verifiedText(SOURCE_URL, SOURCE_SHA256, path.join(target, 'JavaDebugServer.upstream.java'));
  const originalCoreSource = await verifiedText(CORE_SOURCE_URL, CORE_SOURCE_SHA256, path.join(target, 'AdapterUtils.upstream.java'));
  const originalExceptionSource = await verifiedText(EXCEPTION_SOURCE_URL, EXCEPTION_SOURCE_SHA256, path.join(target, 'DebugSession.upstream.java'));
  const originalInspectionSource = await verifiedText(INSPECTION_SOURCE_URL, INSPECTION_SOURCE_SHA256, path.join(target, 'DebugAdapter.upstream.java'));
  const license = await verifiedText(LICENSE_URL, LICENSE_SHA256, path.join(target, 'LICENSE.txt'));
  if (originalSource.split(PATCH_FROM).length !== 2) throw new Error('Expected exactly one Java debug server socket construction.');
  const patchedSource = originalSource.replace(PATCH_FROM, PATCH_TO);
  if (originalCoreSource.split(CORE_PATCH_FROM).length !== 2) throw new Error('Expected exactly one source lookup path construction.');
  const patchedCoreSource = originalCoreSource.replace(CORE_PATCH_FROM, CORE_PATCH_TO);
  const patchedExceptionSource = patchExceptionSession(originalExceptionSource);
  if (originalInspectionSource.split(DISPATCH_FROM).length !== 2) throw Error('Unexpected pinned Java DebugAdapter dispatch source.');
  const patchedInspectionSource = originalInspectionSource.replace(DISPATCH_FROM, DISPATCH_TO);
  const inspectionName = 'LocalValueInspection.java';
  const coroutineName = 'CoroutineFrameWatch.java';
  const kotlinWatchName = 'KotlinWatchEvaluation.java';
  const readHelper = name => {
    const helper = [path.join(__dirname, 'java-debug', name), path.join(__dirname, '../runtime/java-debug', name)]
      .find(candidate => fs.existsSync(candidate));
    if (!helper) throw Error('The Rocketbrain debug helper source is missing: ' + name);
    return fs.readFileSync(helper, 'utf8').replace(/\r\n/g, '\n');
  };
  const localInspectionSource = readHelper(inspectionName), coroutineSource = readHelper(coroutineName);
  const kotlinWatchSource = readHelper(kotlinWatchName);
  const buildDir = await fs.promises.mkdtemp(path.join(target, '.loopback-build-'));
  const stage = path.join(buildDir, 'stage'), classes = path.join(buildDir, 'classes'), sourceDir = path.join(buildDir, 'source');
  for (const folder of [stage, classes, sourceDir]) await fs.promises.mkdir(folder);
  const executable = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  try {
    const entries = run(executable('jar'), ['tf', upstreamJar]);
    for (const entry of entries.split(/\r?\n/).filter(Boolean)) if (entry.startsWith('/') || /^[a-z]:/i.test(entry) || entry.replace(/\\/g, '/').split('/').includes('..')) throw new Error('Unsafe upstream JAR entry.');
    run(executable('jar'), ['xf', upstreamJar], stage);
    if (sourceJar) {
      const entry = 'com/microsoft/java/debug/plugin/internal/JavaDebugServer.java';
      run(executable('jar'), ['xf', sourceJar, entry], sourceDir);
      if (hash(fs.readFileSync(path.join(sourceDir, entry))) !== SOURCE_SHA256) throw new Error('Maven source JAR and pinned upstream source do not agree.');
    }
    const javaFile = path.join(sourceDir, 'JavaDebugServer.java'); await fs.promises.writeFile(javaFile, patchedSource);
    const coreJar = path.join(stage, 'lib', 'com.microsoft.java.debug.core-0.53.1.jar');
    run(executable('javac'), ['--release', '11', '-encoding', 'UTF-8', '-cp', [upstreamJar, coreJar].join(path.delimiter), '-d', classes, javaFile]);
    const packagePath = path.join('com', 'microsoft', 'java', 'debug', 'plugin', 'internal');
    const compiledFiles = fs.readdirSync(path.join(classes, packagePath));
    if (compiledFiles.length !== 3 || compiledFiles.some(name => !/^JavaDebugServer(?:\$[12])?\.class$/.test(name))) throw new Error('Unexpected patched Java class output.');
    for (const name of compiledFiles) await fs.promises.copyFile(path.join(classes, packagePath, name), path.join(stage, packagePath, name));
    const coreStage = path.join(buildDir, 'core-stage'), coreClasses = path.join(buildDir, 'core-classes');
    await fs.promises.mkdir(coreStage); await fs.promises.mkdir(coreClasses);
    run(executable('jar'), ['xf', coreJar], coreStage);
    if (coreSourceJar) {
      const entry = 'com/microsoft/java/debug/core/adapter/AdapterUtils.java';
      const exceptionEntry = 'com/microsoft/java/debug/core/DebugSession.java';
      const inspectionEntry = 'com/microsoft/java/debug/core/adapter/DebugAdapter.java';
      run(executable('jar'), ['xf', coreSourceJar, entry, exceptionEntry, inspectionEntry], sourceDir);
      if (hash(fs.readFileSync(path.join(sourceDir, entry))) !== CORE_SOURCE_SHA256) throw new Error('Maven core source JAR and pinned upstream source do not agree.');
      if (hash(fs.readFileSync(path.join(sourceDir, exceptionEntry))) !== EXCEPTION_SOURCE_SHA256) throw new Error('Maven exception source and pinned upstream source do not agree.');
      if (hash(fs.readFileSync(path.join(sourceDir, inspectionEntry))) !== INSPECTION_SOURCE_SHA256) throw new Error('Maven adapter source and pinned upstream source do not agree.');
    }
    const coreJava = path.join(sourceDir, 'AdapterUtils.java'); await fs.promises.writeFile(coreJava, patchedCoreSource);
    const exceptionJava = path.join(sourceDir, 'DebugSession.java'); await fs.promises.writeFile(exceptionJava, patchedExceptionSource);
    const adapterJava = path.join(sourceDir, 'DebugAdapter.java'); await fs.promises.writeFile(adapterJava, patchedInspectionSource);
    const inspectionJava = path.join(sourceDir, inspectionName); await fs.promises.writeFile(inspectionJava, localInspectionSource);
    const coroutineJava = path.join(sourceDir, coroutineName); await fs.promises.writeFile(coroutineJava, coroutineSource);
    const kotlinWatchJava = path.join(sourceDir, kotlinWatchName); await fs.promises.writeFile(kotlinWatchJava, kotlinWatchSource);
    if (!path.isAbsolute(serverPath || '')) throw new Error('The independent JDT LS serverPath is required to compile the public core source patch.');
    const dependencies = fs.readdirSync(path.join(serverPath, 'plugins')).filter(name => /^(?:org\.apache\.commons\.lang3_|com\.google\.gson_).*\.jar$/.test(name)).map(name => path.join(serverPath, 'plugins', name));
    if (dependencies.length !== 2) throw new Error('Expected the verified JDT LS commons-lang3 and Gson build dependencies.');
    dependencies.push(...['rxjava-2.2.21.jar', 'reactive-streams-1.0.4.jar'].map(name => path.join(stage, 'lib', name)));
    run(executable('javac'), ['--release', '11', '-encoding', 'UTF-8', '-cp', [coreJar, ...dependencies].join(path.delimiter),
      '-d', coreClasses, coreJava, exceptionJava, adapterJava, inspectionJava, coroutineJava, kotlinWatchJava]);
    const corePackage = path.join('com', 'microsoft', 'java', 'debug', 'core');
    for (const file of ['DebugSession.class', 'adapter/AdapterUtils.class', 'adapter/DebugAdapter.class',
      'adapter/LocalValueInspection.class', 'adapter/LocalValueInspection$IndexedValue.class', 'adapter/CoroutineFrameWatch.class',
      'adapter/CoroutineFrameWatch$Watch.class', 'adapter/CoroutineFrameWatch$FrameEvent.class', 'adapter/CoroutineFrameWatch$WatchExpired.class',
      'adapter/KotlinWatchEvaluation.class', 'adapter/KotlinWatchEvaluation$Kind.class', 'adapter/KotlinWatchEvaluation$Scalar.class',
      'adapter/KotlinWatchEvaluation$Expression.class', 'adapter/KotlinWatchEvaluation$Operand.class', 'adapter/KotlinWatchEvaluation$Parser.class']) {
      await fs.promises.copyFile(path.join(coreClasses, corePackage, file), path.join(coreStage, corePackage, file));
    }
    const coreMeta = path.join(coreStage, 'META-INF');
    for (const name of fs.readdirSync(coreMeta)) if (/\.(?:SF|RSA|DSA|EC)$|^SIG-/i.test(name)) await fs.promises.rm(path.join(coreMeta, name));
    const coreManifestPath = path.join(coreMeta, 'MANIFEST.MF');
    const coreMain = fs.readFileSync(coreManifestPath, 'utf8').split(/\r?\n\r?\n/)[0];
    await fs.promises.writeFile(coreManifestPath, coreMain.replace(/\r?\n/g, '\r\n') + '\r\n\r\n');
    const coreSources = path.join(coreMeta, 'rocketbrain-sources'); await fs.promises.mkdir(coreSources);
    await fs.promises.writeFile(path.join(coreSources, 'AdapterUtils.java'), patchedCoreSource);
    await fs.promises.writeFile(path.join(coreSources, 'DebugSession.java'), patchedExceptionSource);
    await fs.promises.writeFile(path.join(coreSources, 'DebugAdapter.java'), patchedInspectionSource);
    await fs.promises.writeFile(path.join(coreSources, inspectionName), localInspectionSource);
    await fs.promises.writeFile(path.join(coreSources, coroutineName), coroutineSource);
    await fs.promises.writeFile(path.join(coreSources, kotlinWatchName), kotlinWatchSource);
    await fs.promises.writeFile(path.join(coreMeta, 'ROCKETBRAIN-PATCH.txt'), PATCH_NOTICE);
    await fs.promises.writeFile(path.join(coreMeta, 'LICENSE-java-debug.txt'), license);
    const rebuiltCore = path.join(buildDir, 'com.microsoft.java.debug.core-0.53.1.jar');
    run(executable('jar'), ['--create', '--file', rebuiltCore, '--no-manifest', '--date=2024-01-01T00:00:00Z', '-C', coreStage, '.']);
    await fs.promises.copyFile(rebuiltCore, coreJar);
    const meta = path.join(stage, 'META-INF');
    for (const name of fs.readdirSync(meta)) if (/\.(?:SF|RSA|DSA|EC)$|^SIG-/i.test(name)) await fs.promises.rm(path.join(meta, name));
    const manifestPath = path.join(meta, 'MANIFEST.MF');
    const main = fs.readFileSync(manifestPath, 'utf8').split(/\r?\n\r?\n/)[0].replace(/Bundle-Version: 0\.53\.1\b/, 'Bundle-Version: 0.53.1.rocketbrain6');
    await fs.promises.writeFile(manifestPath, main.replace(/\r?\n/g, '\r\n') + '\r\n\r\n');
    const sourcesDir = path.join(meta, 'rocketbrain-sources'); await fs.promises.mkdir(sourcesDir);
    await fs.promises.writeFile(path.join(sourcesDir, 'JavaDebugServer.java'), patchedSource);
    await fs.promises.writeFile(path.join(sourcesDir, 'AdapterUtils.java'), patchedCoreSource);
    await fs.promises.writeFile(path.join(sourcesDir, 'DebugSession.java'), patchedExceptionSource);
    await fs.promises.writeFile(path.join(sourcesDir, 'DebugAdapter.java'), patchedInspectionSource);
    await fs.promises.writeFile(path.join(sourcesDir, inspectionName), localInspectionSource);
    await fs.promises.writeFile(path.join(sourcesDir, coroutineName), coroutineSource);
    await fs.promises.writeFile(path.join(sourcesDir, kotlinWatchName), kotlinWatchSource);
    await fs.promises.writeFile(path.join(meta, 'ROCKETBRAIN-PATCH.txt'), PATCH_NOTICE);
    await fs.promises.writeFile(path.join(meta, 'LICENSE-java-debug.txt'), license);
    run(executable('jar'), ['--create', '--file', outputJar, '--no-manifest', '--date=2024-01-01T00:00:00Z', '-C', stage, '.']);
    await fs.promises.writeFile(path.join(target, 'ROCKETBRAIN-PATCH.txt'), PATCH_NOTICE);
    return { sha256: hash(fs.readFileSync(outputJar)), sourceSha256: SOURCE_SHA256, patchedSourceSha256: hash(Buffer.from(patchedSource)),
      coreSourceSha256: CORE_SOURCE_SHA256, patchedCoreSourceSha256: hash(Buffer.from(patchedCoreSource)),
      exceptionSourceSha256: EXCEPTION_SOURCE_SHA256, patchedExceptionSourceSha256: hash(Buffer.from(patchedExceptionSource)),
      inspectionSourceSha256: INSPECTION_SOURCE_SHA256, patchedInspectionSourceSha256: hash(Buffer.from(patchedInspectionSource)),
      localInspectionSourceSha256: hash(Buffer.from(localInspectionSource)),
      coroutineSourceSha256: hash(Buffer.from(coroutineSource)),
      kotlinWatchSourceSha256: hash(Buffer.from(kotlinWatchSource)),
      rebuiltCoreSha256: hash(fs.readFileSync(coreJar)), sourceCommit: SOURCE_COMMIT, sourceUrl: SOURCE_URL,
      coreSourceUrl: CORE_SOURCE_URL, exceptionSourceUrl: EXCEPTION_SOURCE_URL, inspectionSourceUrl: INSPECTION_SOURCE_URL,
      buildDependencies: dependencies.map(file => ({ file: path.basename(file), sha256: hash(fs.readFileSync(file)) })),
      patch: PATCH_NOTICE, javac: run(executable('javac'), ['--version']).trim() };
  } finally {
    const resolved = fs.realpathSync(buildDir), intended = fs.realpathSync(target) + path.sep;
    if (!resolved.startsWith(intended) || !path.basename(resolved).startsWith('.loopback-build-')) throw new Error('Refusing cleanup outside own debugger build directory.');
    await fs.promises.rm(resolved, { recursive: true, force: true });
  }
}
module.exports = { buildPatchedBundle, SOURCE_COMMIT, SOURCE_URL, SOURCE_SHA256, CORE_SOURCE_URL, CORE_SOURCE_SHA256,
  EXCEPTION_SOURCE_URL, EXCEPTION_SOURCE_SHA256, INSPECTION_SOURCE_URL, INSPECTION_SOURCE_SHA256, LICENSE_URL, LICENSE_SHA256, PATCH_NOTICE };
