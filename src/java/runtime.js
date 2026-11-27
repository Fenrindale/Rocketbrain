'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {resolveNullChecks}=require('./null-checks');
const crypto = require('node:crypto');
const { resolveDebugBundle } = require('./debug-runtime');
const { stageLombokAgent } = require('./annotation-processing');

const JDT_VERSION = '1.63.0';

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an explicit absolute directory.`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory.`);
  return resolved;
}

function jdtLaunchArguments({ launcher, configuration, data, javaAgent }) {
  return ['-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4',
    '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=WARNING', '-Xmx1G',
    '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED',
    '--add-opens', 'java.base/java.lang=ALL-UNNAMED', ...(javaAgent ? ['-javaagent:' + javaAgent] : []),
    '-jar', launcher, '-configuration', configuration, '-data', data];
}

function inspectJavaHome(value, platform = process.platform) {
  const javaHome = absoluteDirectory(value, 'Java engine JDK');
  const release = fs.readFileSync(path.join(javaHome, 'release'), 'utf8');
  if (/JetBrains/i.test(release) || /(?:^|[\\/])JetBrains(?:[\\/]|$)|(?:^|[\\/])jbr(?:[\\/]|$)/i.test(javaHome)) throw new Error('Use an independent general-purpose JDK. Installed IDE JetBrains Runtime is not used by Rocketbrain.');
  const version = /(?:^|\n)JAVA_VERSION="((\d+)[^"]*)"/.exec(release);
  if (!version || Number(version[2]) < 25) throw new Error('Rocketbrain Java requires an independent JDK 25 or newer to run JDT LS. Project JDKs can differ.');
  const command = path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.statSync(command, { throwIfNoEntry: false })?.isFile()) throw new Error(`Java executable was not found in ${javaHome}.`);
  return {javaHome, release, command, version: version[1]};
}

function inspectServerPath(value, platform = process.platform, arch = process.arch) {
  const serverPath = absoluteDirectory(value, 'Eclipse JDT LS directory');
  const plugins = path.join(serverPath, 'plugins');
  const launchers = fs.readdirSync(plugins).filter(name => /^org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(name));
  if (launchers.length !== 1) throw new Error('JDT LS must contain exactly one Equinox launcher JAR. Select an extracted official JDT LS distribution.');
  const configName = platform === 'win32' ? 'config_win' : (platform === 'darwin' ? 'config_mac' : 'config_linux') + (arch === 'arm64' ? '_arm' : '');
  const template = path.join(serverPath, configName);
  if (!fs.existsSync(path.join(template, 'config.ini'))) throw new Error(`JDT LS configuration ${configName} is missing.`);
  return {serverPath, plugins, launcher: launchers[0], configName, template};
}

function resolveLaunch(options) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const {javaHome, release, command} = inspectJavaHome(options.javaHome, platform);
  const {serverPath, plugins, launcher, configName, template} = inspectServerPath(options.serverPath, platform, arch);
  if (!path.isAbsolute(options.storagePath || '')) throw new Error('Java storagePath must be absolute.');
  const gradleAnnotationProcessing = options.gradleAnnotationProcessing === true;
  if ((options.lombokJar || gradleAnnotationProcessing) && options.trustedWorkspace !== true) {
    throw new Error('Trust the workspace before enabling Java editor annotation processing.');
  }
  const lombok = stageLombokAgent(options.lombokJar,options.storagePath);
  const debugBundle = resolveDebugBundle(options.debugBundlePath, serverPath);
  const bundles = debugBundle ? [debugBundle.path] : [];
  const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const core = fs.readdirSync(plugins).filter(name => /^org\.eclipse\.jdt\.ls\.core_.*\.jar$/.test(name));
  // OSGi state and JDT/Buildship metadata must use the same engine identity.
  // Retain older indexes instead of opening incompatible/corrupted legacy state
  // when the independent JDK, distribution, debug bundle or import runtime changes.
  const identity = crypto.createHash('sha256').update(JSON.stringify({
    schema: 2, serverPath, javaHome, release, platform, arch, configName,
    template: fileHash(path.join(template, 'config.ini')),
    launcher: { name: launcher, sha256: fileHash(path.join(plugins, launcher)) },
    core: core.map(name => ({ name, sha256: fileHash(path.join(plugins, name)) })),
    bundles: debugBundle ? [{ path: debugBundle.path, sha256: debugBundle.sha256 }] : [],
    gradleUserHome: process.env.GRADLE_USER_HOME || '', importRuntime: options.cacheContext || null,
    processors: {gradle:gradleAnnotationProcessing,lombok:lombok?.sha256 || null}
  })).digest('hex').slice(0, 20);
  const configuration = path.join(options.storagePath, 'configuration', identity);
  const data = path.join(options.storagePath, 'workspaces', identity);
  fs.mkdirSync(configuration, { recursive: true });
  fs.cpSync(template, configuration, { recursive: true, force: false, errorOnExist: false });
  fs.mkdirSync(data, { recursive: true });
  const env = { ...process.env, JAVA_HOME: javaHome };
  // JDT LS interprets these variables as requests to use a socket or named pipe.
  for (const key of ['CLIENT_PORT', 'CLIENT_HOST', 'CLIENT_PIPE', 'SERVER_PORT', 'SERVER_HOST']) delete env[key];
  return {
    command,
    args: jdtLaunchArguments({ launcher: path.join(plugins, launcher), configuration, data, javaAgent: lombok?.file }),
    options: { cwd: serverPath, env, windowsHide: true },
    javaHome, serverPath, configuration, data, identity, bundles, debugBuild: debugBundle?.build,
    annotationProcessing: {gradle:gradleAnnotationProcessing,maven:'project',lombok:lombok && {version:lombok.version,sha256:lombok.sha256}}
  };
}

function serverSettings(projectJdks = [], options = {}) {
  if (!Array.isArray(projectJdks)) throw new Error('rocketbrain.java.projectJdks must be an array.');
  const runtimes = projectJdks.map(runtime => {
    if (!runtime || !/^JavaSE-(?:1\.8|\d+)$/.test(runtime.name || '') || !path.isAbsolute(runtime.path || '')) throw new Error('Each project JDK requires a JavaSE-N name and an absolute path. Use JavaSE-1.8 for Java 8.');
    const name = runtime.name === 'JavaSE-8' ? 'JavaSE-1.8' : runtime.name;
    return { name, path: absoluteDirectory(runtime.path, 'Project JDK'), default: Boolean(runtime.default) };
  });
  if (runtimes.filter(runtime => runtime.default).length > 1) throw new Error('Only one project JDK can be the default.');
  const gradle = { enabled: true, wrapper: { enabled: true },
    annotationProcessing: {enabled:options.gradleAnnotationProcessing === true} };
  if (options.gradleHome) gradle.home = absoluteDirectory(options.gradleHome, 'rocketbrain.java.gradleHome');
  if (options.gradleJavaHome) gradle.java = { home: absoluteDirectory(options.gradleJavaHome, 'rocketbrain.java.gradleJavaHome') };
  const {profile,...nullAnalysis}=resolveNullChecks(options.nullChecks);
  const favorites=options.favoriteStaticMembers;
  const qualifiedMember=/^(?:[\p{L}_$][\p{L}\p{N}_$]*\.){2,}(?:[\p{L}_$][\p{L}\p{N}_$]*|\*)$/u;
  if(favorites!==undefined&&(!Array.isArray(favorites)||favorites.length>32||favorites.some(value=>typeof value!=='string'||value.length>512||!qualifiedMember.test(value))))
    throw Error('Java static import favorites require at most 32 qualified member names or declaring-type wildcards.');
  return {
    java: {
      // Initial trusted import remains enabled; later build-file changes require
      // the explicit Java Projects resync action instead of executing automatically.
      configuration: { updateBuildConfiguration: 'disabled', runtimes },
      import: { maven: { enabled: true }, gradle },
      autobuild: { enabled: true },
      completion: { enabled: true, ...(favorites!==undefined?{favoriteStaticMembers:[...new Set(favorites)]}:{}) },
      signatureHelp: { enabled: true },
      inlayHints: { parameterNames: { enabled: 'all' }, variableTypes: { enabled: true }, parameterTypes: { enabled: true } },
      compile: { nullAnalysis },
      referencesCodeLens: { enabled: true },
      implementationsCodeLens: { enabled: true },
      format: { enabled: true },
      refactoring: { extract: { interface: { replace:options.extractInterfaceReplaceUsages === true } } },
      errors: { incompleteClasspath: { severity: 'warning' } }
    }
  };
}

module.exports = { JDT_VERSION, inspectJavaHome, inspectServerPath, resolveLaunch, serverSettings, jdtLaunchArguments };
