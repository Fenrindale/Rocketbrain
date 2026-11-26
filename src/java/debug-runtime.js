'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Public Maven Central JDT bundle, independent of any Marketplace VSIX.
const DEBUG_VERSION = '0.53.1';
const DEBUG_BUILD = DEBUG_VERSION + '.rocketbrain4';
const COROUTINE_BUILD = DEBUG_VERSION + '.rocketbrain5';
const WATCH_BUILD = DEBUG_VERSION + '.rocketbrain6';
const EXCEPTION_BUILD = DEBUG_VERSION + '.rocketbrain3';
const LEGACY_BUILD = DEBUG_VERSION + '.rocketbrain2';
const UPSTREAM_FILE = `com.microsoft.java.debug.plugin-${DEBUG_VERSION}.jar`;
const UPSTREAM_SHA256 = '4f4778d452a6a0665536f43ce4e32403a24be6593336b80dc85a322912859e24';
const DEBUG_URL = `https://repo.maven.apache.org/maven2/com/microsoft/java/com.microsoft.java.debug.plugin/${DEBUG_VERSION}/${UPSTREAM_FILE}`;
const DEBUG_FILE = `com.microsoft.java.debug.plugin-${DEBUG_BUILD}.jar`;
const DEBUG_SHA256 = 'f22875a873f0e57813a192870d88fc2b4d17d10f197a12e214a0afa451b40d47';
const COROUTINE_FILE = `com.microsoft.java.debug.plugin-${COROUTINE_BUILD}.jar`;
const COROUTINE_SHA256 = '478c858ecc5117221505a2d110a0543c77a6dd21d921045efe8a4921a7db0c8a';
const WATCH_FILE = `com.microsoft.java.debug.plugin-${WATCH_BUILD}.jar`;
const WATCH_SHA256 = '9bbb9411bcaa50d5155f3540e894c1c75688b900779f16309faa067f5a55a177';
const EXCEPTION_SHA256 = '48225381bae43e320041096e1996e4d519614a018d1eaac19341ac66686a26f8';
const LEGACY_SHA256 = 'dd70e3cf8dc599c7a91b0c01efa86aa7bcf7677e3924ab4c4012e85895ab8605';

function resolveDebugBundle(value, serverPath) {
  const defaults = serverPath && path.join(path.dirname(serverPath), 'java-debug');
  const candidate = value || (defaults && [WATCH_BUILD, COROUTINE_BUILD, DEBUG_BUILD, EXCEPTION_BUILD, LEGACY_BUILD].map(build => `com.microsoft.java.debug.plugin-${build}.jar`)
    .map(name => path.join(defaults, name)).find(file => fs.existsSync(file)));
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate)) throw new Error('rocketbrain.java.debugBundlePath must be an absolute JAR path.');
  const file = fs.realpathSync(candidate);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Java debug bundle is not a regular JAR within the supported size.');
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const build = { [WATCH_SHA256]: WATCH_BUILD, [COROUTINE_SHA256]: COROUTINE_BUILD, [DEBUG_SHA256]: DEBUG_BUILD,
    [EXCEPTION_SHA256]: EXCEPTION_BUILD, [LEGACY_SHA256]: LEGACY_BUILD }[checksum];
  if (!build) throw new Error('Java debug bundle must match a pinned Rocketbrain loopback-only build. Run the Java engine installer.');
  return { path: file, sha256: checksum, build };
}

function resolveDebugBundles(value, serverPath) {
  const bundle = resolveDebugBundle(value, serverPath);
  return bundle ? [bundle.path] : [];
}

function independentJavaExecutable(value) {
  if (!path.isAbsolute(value || '')) throw new Error('Java launch executable must be an absolute path.');
  const executable = fs.realpathSync(value);
  if (!fs.statSync(executable).isFile()) throw new Error('Java launch executable is not a regular file.');
  const javaHome = path.dirname(path.dirname(executable));
  const release = fs.readFileSync(path.join(javaHome, 'release'), 'utf8');
  if (/JetBrains/i.test(release) || /(?:^|[\\/])JetBrains(?:[\\/]|$)|(?:^|[\\/])jbr(?:[\\/]|$)/i.test(javaHome)) throw new Error('Java applications must use an independent general-purpose JDK, not an IDE embedded JetBrains Runtime.');
  if (!/(?:^|\n)JAVA_VERSION="\d+/.test(release)) throw new Error('Java launch executable must belong to a JDK with a release file.');
  return executable;
}

function argumentString(value, platform = process.platform) {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.includes('\0'))) throw new Error('Java args and vmArgs must be strings or arrays of strings without NUL characters.');
  return value.map(item => platform === 'win32' ? '"' + item.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"' : '"' + item.replace(/[\\"]/g, '\\$&') + '"').join(' ');
}

module.exports = { DEBUG_VERSION, DEBUG_BUILD, DEBUG_FILE, DEBUG_SHA256, DEBUG_URL, UPSTREAM_FILE, UPSTREAM_SHA256,
  COROUTINE_BUILD, COROUTINE_FILE, COROUTINE_SHA256, EXCEPTION_BUILD, resolveDebugBundle, resolveDebugBundles,
  WATCH_BUILD, WATCH_FILE, WATCH_SHA256, independentJavaExecutable, argumentString };
