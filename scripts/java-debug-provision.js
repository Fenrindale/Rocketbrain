'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEBUG_VERSION, KOTLIN_MAP_BUILD: DEBUG_BUILD, KOTLIN_MAP_FILE: DEBUG_FILE, KOTLIN_MAP_SHA256: DEBUG_SHA256,
  DEBUG_URL, UPSTREAM_FILE, UPSTREAM_SHA256, resolveDebugBundles, independentJavaExecutable } = require('../src/java/debug-runtime');
const { buildPatchedBundle, SOURCE_COMMIT, SOURCE_URL, SOURCE_SHA256, CORE_SOURCE_URL, CORE_SOURCE_SHA256,
  EXCEPTION_SOURCE_URL, EXCEPTION_SOURCE_SHA256, INSPECTION_SOURCE_URL, INSPECTION_SOURCE_SHA256,
  LICENSE_URL, LICENSE_SHA256, PATCH_NOTICE } = require('./java-debug-patch');
const SOURCE_JAR_SHA256 = 'a5b3e47a5b524f6bdd0d5cedb3a29bdfac52fa2d4b8ebd725167bc74e65fea53';
const CORE_SOURCE_JAR_SHA256 = 'a4716e849e8cd2d8207dae15b42c9a0c6605a1a1d98ee489e8c193cbf3fb9aa0';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function download(url, checksum, file) {
  if (fs.existsSync(file) && hash(file) === checksum) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Java debugger download failed (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 8 * 1024 * 1024 || crypto.createHash('sha256').update(bytes).digest('hex') !== checksum) throw new Error('Java debugger download SHA-256 mismatch.');
  const partial = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.partial`);
  try { await fs.promises.writeFile(partial, bytes, { flag: 'wx' }); await fs.promises.rename(partial, file); }
  finally { await fs.promises.rm(partial, { force: true }); }
}
async function provisionDebugger(target, progress = () => {}, { javaHome, serverPath } = {}) {
  if (!path.isAbsolute(target || '')) throw new Error('Debugger target must be an absolute directory.');
  await fs.promises.mkdir(target, { recursive: true });
  const file = path.join(target, DEBUG_FILE), upstreamJar = path.join(target, UPSTREAM_FILE);
  const sourceJarUrl = DEBUG_URL.replace(/\.jar$/, '-sources.jar'), sourceJar = path.join(target, UPSTREAM_FILE.replace(/\.jar$/, '-sources.jar'));
  const coreSourceJarUrl = `https://repo.maven.apache.org/maven2/com/microsoft/java/com.microsoft.java.debug.core/${DEBUG_VERSION}/com.microsoft.java.debug.core-${DEBUG_VERSION}-sources.jar`, coreSourceJar = path.join(target, `com.microsoft.java.debug.core-${DEBUG_VERSION}-sources.jar`);
  if (!fs.existsSync(file) || hash(file) !== DEBUG_SHA256) {
    if (!javaHome) throw new Error('A standalone JDK javaHome is required to build the loopback-only Java debugger.');
    independentJavaExecutable(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    progress(`Downloading and verifying public Java debug server ${DEBUG_VERSION} and source JAR.`);
    await download(DEBUG_URL, UPSTREAM_SHA256, upstreamJar);
    await download(sourceJarUrl, SOURCE_JAR_SHA256, sourceJar);
    await download(coreSourceJarUrl, CORE_SOURCE_JAR_SHA256, coreSourceJar);
    progress('Building the loopback DAP server with Java inspection, Kotlin field values, and managed Kotlin and Groovy source lines.');
    const build = await buildPatchedBundle({ target, javaHome, serverPath: serverPath || path.join(path.dirname(target), 'jdtls-1.63.0'), upstreamJar, sourceJar, coreSourceJar, outputJar: file });
    if (build.sha256 !== DEBUG_SHA256) throw new Error(`Java debug local build does not match the reproducible ${DEBUG_BUILD} artifact (${build.sha256}).`);
    await fs.promises.writeFile(path.join(target, 'build.json'), JSON.stringify(build, null, 2) + '\n');
  }
  resolveDebugBundles(file);
  const source = {
    name: 'Microsoft Java Debug Server with Rocketbrain loopback and Java and Kotlin debugging patches', version: DEBUG_BUILD,
    upstream: { version: DEBUG_VERSION, url: DEBUG_URL, sha256: UPSTREAM_SHA256, sourceJarUrl, sourceJarSha256: SOURCE_JAR_SHA256, coreSourceJarUrl, coreSourceJarSha256: CORE_SOURCE_JAR_SHA256, sourceCommit: SOURCE_COMMIT, source: `https://github.com/microsoft/java-debug/tree/${SOURCE_COMMIT}` },
    artifact: { file: DEBUG_FILE, sha256: DEBUG_SHA256, locallyBuilt: true, signed: false },
    patch: { name: 'loopback-stack-exception-jdi-values-coroutine-kotlin-fields-v14', sourceUrl: SOURCE_URL, sourceSha256: SOURCE_SHA256,
      coreSourceUrl: CORE_SOURCE_URL, coreSourceSha256: CORE_SOURCE_SHA256, exceptionSourceUrl: EXCEPTION_SOURCE_URL,
      exceptionSourceSha256: EXCEPTION_SOURCE_SHA256, inspectionSourceUrl: INSPECTION_SOURCE_URL,
      inspectionSourceSha256: INSPECTION_SOURCE_SHA256, notice: PATCH_NOTICE },
    license: 'EPL-1.0 (release LICENSE.txt and artifact Bundle-License); other upstream source files retain their own EPL notices', licenseUrl: LICENSE_URL, licenseSha256: LICENSE_SHA256,
    verification: 'Upstream binary, plugin/core source JARs and source-file SHA-256 are pinned. A JDK compiler rebuilds the debug adapter patches plus the local value, continuation and Kotlin watch helpers with --release 11. JARs retain reproducible timestamps, licenses, sources, a patch notice and a pinned plugin SHA-256.',
    includedComponents: [{ name: 'Microsoft java-debug core', version: DEBUG_VERSION }, { name: 'Apache Commons IO', version: '2.11.0', license: 'Apache-2.0' }, { name: 'RxJava', version: '2.2.21', license: 'Apache-2.0' }, { name: 'Reactive Streams', version: '1.0.4', license: 'CC0-1.0' }],
    integration: 'JDT LS initializationOptions.bundles; Rocketbrain owns the DAP client/provider. The DAP server listens only on 127.0.0.1. No Java Marketplace extension or original IDE is required.'
  };
  await fs.promises.writeFile(path.join(target, 'source.json'), JSON.stringify(source, null, 2) + '\n');
  return { debugBundlePath: file, source };
}

if (require.main === module) {
  const args = process.argv.slice(2), target = args[0], javaHome = args[1];
  if (!path.isAbsolute(target || '') || !path.isAbsolute(javaHome || '')) { console.error('Usage: node scripts/java-debug-provision.js <absolute target> <absolute standalone JDK home>'); process.exitCode = 1; }
  else provisionDebugger(target, console.log, { javaHome }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { provisionDebugger };
