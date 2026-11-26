'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Public Maven Central JDT bundle, independent of any Marketplace VSIX.
const DEBUG_VERSION = '0.53.1';
const DEBUG_BUILD = DEBUG_VERSION + '.rocketbrain4';
const COROUTINE_BUILD = DEBUG_VERSION + '.rocketbrain5';
const WATCH_BUILD = DEBUG_VERSION + '.rocketbrain6';
const INDEXED_WATCH_BUILD = DEBUG_VERSION + '.rocketbrain7';
const KOTLIN_LOCAL_WRITE_BUILD = DEBUG_VERSION + '.rocketbrain8';
const KOTLIN_FIELD_BUILD = DEBUG_VERSION + '.rocketbrain9';
const KOTLIN_LINE_BUILD = DEBUG_VERSION + '.rocketbrain10';
const KOTLIN_FIELD_VALUES_BUILD = DEBUG_VERSION + '.rocketbrain11';
const GROOVY_LINE_BUILD = DEBUG_VERSION + '.rocketbrain12';
const KOTLIN_BOX_BUILD = DEBUG_VERSION + '.rocketbrain13';
const KOTLIN_MAP_BUILD = DEBUG_VERSION + '.rocketbrain14';
const JVM_STRING_PAGE_BUILD = DEBUG_VERSION + '.rocketbrain15';
const KOTLIN_MAP_BUILDS = Object.freeze([KOTLIN_MAP_BUILD, JVM_STRING_PAGE_BUILD]);
const KOTLIN_BOX_BUILDS = Object.freeze([KOTLIN_BOX_BUILD, ...KOTLIN_MAP_BUILDS]);
const GROOVY_LINE_BUILDS = Object.freeze([GROOVY_LINE_BUILD, ...KOTLIN_BOX_BUILDS]);
const KOTLIN_FIELD_VALUES_BUILDS = Object.freeze([KOTLIN_FIELD_VALUES_BUILD, ...GROOVY_LINE_BUILDS]);
const KOTLIN_LINE_BUILDS = Object.freeze([KOTLIN_LINE_BUILD, ...KOTLIN_FIELD_VALUES_BUILDS]);
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
const INDEXED_WATCH_FILE = `com.microsoft.java.debug.plugin-${INDEXED_WATCH_BUILD}.jar`;
const INDEXED_WATCH_SHA256 = '7b1515444143e6d5fc3a8eb9aff89c86d4d5fea1068cb83c47da6e2c9f53ca15';
const KOTLIN_LOCAL_WRITE_FILE = `com.microsoft.java.debug.plugin-${KOTLIN_LOCAL_WRITE_BUILD}.jar`;
const KOTLIN_LOCAL_WRITE_SHA256 = '3665e64a55c9503c67317fbb49747fe2658bf623bf0b55974a19eb1ab3989127';
const KOTLIN_FIELD_FILE = `com.microsoft.java.debug.plugin-${KOTLIN_FIELD_BUILD}.jar`;
const KOTLIN_FIELD_SHA256 = '6f23f7d52affba7c0f5470b8a30193b41cea834ea9b4e907562797002222728b';
const KOTLIN_LINE_FILE = `com.microsoft.java.debug.plugin-${KOTLIN_LINE_BUILD}.jar`;
const KOTLIN_LINE_SHA256 = '326ebe30bd4911ff77b512d98d299ef44f102134775809863412d331ea0eb138';
const KOTLIN_FIELD_VALUES_FILE = 'com.microsoft.java.debug.plugin-' + KOTLIN_FIELD_VALUES_BUILD + '.jar';
const KOTLIN_FIELD_VALUES_SHA256 = 'b7cfde5ea8f33850941efcf8678e28e56e357db8d0756a169d19ffddcd38f2c0';
const GROOVY_LINE_FILE = 'com.microsoft.java.debug.plugin-' + GROOVY_LINE_BUILD + '.jar';
const GROOVY_LINE_SHA256 = '0234ae136f2e81486ee1b6d46c36961c59f48fe2e9f847e2745f3a3e13e96049';
const KOTLIN_BOX_FILE = 'com.microsoft.java.debug.plugin-' + KOTLIN_BOX_BUILD + '.jar';
const KOTLIN_BOX_SHA256 = 'c5f652dc3d213e95e085911c0776ced8a7a47b9559a7deebde0d505f5a07271f';
const KOTLIN_MAP_FILE = 'com.microsoft.java.debug.plugin-' + KOTLIN_MAP_BUILD + '.jar';
const KOTLIN_MAP_SHA256 = '329e1d9f142b180c8b28d06c16840bef28ee1182b76b884fff735ebccc60305a';
const JVM_STRING_PAGE_FILE = 'com.microsoft.java.debug.plugin-' + JVM_STRING_PAGE_BUILD + '.jar';
const JVM_STRING_PAGE_SHA256 = 'cfc1baabfbe76003d83dd53f3069aa37b1ea031d4b3f30dda501643f9e9bfe26';
const EXCEPTION_SHA256 = '48225381bae43e320041096e1996e4d519614a018d1eaac19341ac66686a26f8';
const LEGACY_SHA256 = 'dd70e3cf8dc599c7a91b0c01efa86aa7bcf7677e3924ab4c4012e85895ab8605';

function resolveDebugBundle(value, serverPath) {
  const defaults = serverPath && path.join(path.dirname(serverPath), 'java-debug');
  const candidate = value || (defaults && [JVM_STRING_PAGE_BUILD, KOTLIN_MAP_BUILD, KOTLIN_BOX_BUILD, GROOVY_LINE_BUILD, KOTLIN_FIELD_VALUES_BUILD, KOTLIN_LINE_BUILD, KOTLIN_FIELD_BUILD, KOTLIN_LOCAL_WRITE_BUILD, INDEXED_WATCH_BUILD, WATCH_BUILD, COROUTINE_BUILD, DEBUG_BUILD, EXCEPTION_BUILD, LEGACY_BUILD].map(build => `com.microsoft.java.debug.plugin-${build}.jar`)
    .map(name => path.join(defaults, name)).find(file => fs.existsSync(file)));
  if (!candidate) return undefined;
  if (!path.isAbsolute(candidate)) throw new Error('rocketbrain.java.debugBundlePath must be an absolute JAR path.');
  const file = fs.realpathSync(candidate);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('Java debug bundle is not a regular JAR within the supported size.');
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const build = { [JVM_STRING_PAGE_SHA256]: JVM_STRING_PAGE_BUILD, [KOTLIN_MAP_SHA256]: KOTLIN_MAP_BUILD, [KOTLIN_BOX_SHA256]: KOTLIN_BOX_BUILD, [GROOVY_LINE_SHA256]: GROOVY_LINE_BUILD, [KOTLIN_FIELD_VALUES_SHA256]: KOTLIN_FIELD_VALUES_BUILD, [KOTLIN_LINE_SHA256]: KOTLIN_LINE_BUILD, [KOTLIN_FIELD_SHA256]: KOTLIN_FIELD_BUILD, [KOTLIN_LOCAL_WRITE_SHA256]: KOTLIN_LOCAL_WRITE_BUILD, [INDEXED_WATCH_SHA256]: INDEXED_WATCH_BUILD,
    [WATCH_SHA256]: WATCH_BUILD, [COROUTINE_SHA256]: COROUTINE_BUILD, [DEBUG_SHA256]: DEBUG_BUILD,
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

function launchCommandMode(config, platform = process.platform) {
  const requested = config.shortenCommandLine ?? 'auto';
  if (['none', 'argfile', 'jarmanifest'].includes(requested)) return requested;
  if (requested !== 'auto') throw Error('Use auto, none, argfile, or jarmanifest for shortenCommandLine.');
  if (platform !== 'win32') return 'none';

  // Reserve room for Windows quoting and the debugger's extra VM arguments.
  // External and integrated terminals may launch through cmd.exe.
  const limit = config.console === 'internalConsole' ? 28000 : 7000;
  const length = [config.javaExec, config.mainClass, config.vmArgs, config.args,
    ...(config.classPaths || []), ...(config.modulePaths || [])]
    .reduce((sum, value) => sum + (typeof value === 'string' ? value.length + 3 : 0), 0);
  if (length < limit) return 'none';

  const release = fs.readFileSync(path.join(path.dirname(path.dirname(config.javaExec)), 'release'), 'utf8');
  const version = /(?:^|\n)JAVA_VERSION="(?:1\.)?(\d+)/u.exec(release)?.[1];
  if (Number(version) >= 9) return 'argfile';
  if (config.classPaths?.length && !config.modulePaths?.length) return 'jarmanifest';
  throw Error('Use JDK 9 or later to shorten this Java debug launch.');
}

module.exports = { DEBUG_VERSION, DEBUG_BUILD, DEBUG_FILE, DEBUG_SHA256, DEBUG_URL, UPSTREAM_FILE, UPSTREAM_SHA256,
  COROUTINE_BUILD, COROUTINE_FILE, COROUTINE_SHA256, EXCEPTION_BUILD, resolveDebugBundle, resolveDebugBundles,
  WATCH_BUILD, WATCH_FILE, WATCH_SHA256, INDEXED_WATCH_BUILD, INDEXED_WATCH_FILE, INDEXED_WATCH_SHA256,
  KOTLIN_LOCAL_WRITE_BUILD, KOTLIN_LOCAL_WRITE_FILE, KOTLIN_LOCAL_WRITE_SHA256,
  KOTLIN_FIELD_BUILD, KOTLIN_FIELD_FILE, KOTLIN_FIELD_SHA256,
  KOTLIN_LINE_BUILD, KOTLIN_LINE_FILE, KOTLIN_LINE_SHA256,
  KOTLIN_LINE_BUILDS, KOTLIN_FIELD_VALUES_BUILD, KOTLIN_FIELD_VALUES_FILE, KOTLIN_FIELD_VALUES_SHA256,
  KOTLIN_FIELD_VALUES_BUILDS, GROOVY_LINE_BUILDS, GROOVY_LINE_BUILD, GROOVY_LINE_FILE, GROOVY_LINE_SHA256,
  KOTLIN_BOX_BUILD, KOTLIN_BOX_BUILDS, KOTLIN_BOX_FILE, KOTLIN_BOX_SHA256,
  KOTLIN_MAP_BUILD, KOTLIN_MAP_BUILDS, KOTLIN_MAP_FILE, KOTLIN_MAP_SHA256,
  JVM_STRING_PAGE_BUILD, JVM_STRING_PAGE_FILE, JVM_STRING_PAGE_SHA256,
  independentJavaExecutable, argumentString, launchCommandMode };
