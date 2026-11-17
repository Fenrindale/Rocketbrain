'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveDebugBundles } = require('./debug-runtime');

function absoluteDirectory(value, label) {
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) throw new Error(`${label} must be an explicit absolute directory.`);
  const resolved = fs.realpathSync(value);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory.`);
  return resolved;
}

function resolveLaunch(options) {
  const platform = options.platform || process.platform;
  const javaHome = absoluteDirectory(options.javaHome, 'rocketbrain.java.javaHome');
  const serverPath = absoluteDirectory(options.serverPath, 'rocketbrain.java.serverPath');
  const release = fs.readFileSync(path.join(javaHome, 'release'), 'utf8');
  if (/JetBrains/i.test(release) || /(?:^|[\\/])JetBrains(?:[\\/]|$)|(?:^|[\\/])jbr(?:[\\/]|$)/i.test(javaHome)) throw new Error('Use an independent general-purpose JDK. Installed IDE JetBrains Runtime is not used by Rocketbrain.');
  const version = /(?:^|\n)JAVA_VERSION="(\d+)/.exec(release);
  if (!version || Number(version[1]) < 25) throw new Error('Rocketbrain Java requires an independent JDK 25 or newer to run JDT LS. Project JDKs can differ.');
  const command = path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(command)) throw new Error(`Java executable was not found in ${javaHome}.`);
  const plugins = path.join(serverPath, 'plugins');
  const launchers = fs.readdirSync(plugins).filter(name => /^org\.eclipse\.equinox\.launcher_[^/]+\.jar$/.test(name));
  if (launchers.length !== 1) throw new Error('JDT LS must contain exactly one Equinox launcher JAR. Select an extracted official JDT LS distribution.');
  const arch = options.arch || process.arch;
  const configName = platform === 'win32' ? 'config_win' : (platform === 'darwin' ? 'config_mac' : 'config_linux') + (arch === 'arm64' ? '_arm' : '');
  const template = path.join(serverPath, configName);
  if (!fs.existsSync(path.join(template, 'config.ini'))) throw new Error(`JDT LS configuration ${configName} is missing.`);
  if (!path.isAbsolute(options.storagePath || '')) throw new Error('Java storagePath must be absolute.');
  const bundles = resolveDebugBundles(options.debugBundlePath, serverPath);
  const fileHash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const core = fs.readdirSync(plugins).filter(name => /^org\.eclipse\.jdt\.ls\.core_.*\.jar$/.test(name));
  // OSGi state and JDT/Buildship metadata must use the same engine identity.
  // Retain older indexes instead of opening incompatible/corrupted legacy state
  // when the independent JDK, distribution, debug bundle or import runtime changes.
  const identity = crypto.createHash('sha256').update(JSON.stringify({
    schema: 2, serverPath, javaHome, release, platform, arch, configName,
    template: fileHash(path.join(template, 'config.ini')),
    launcher: { name: launchers[0], sha256: fileHash(path.join(plugins, launchers[0])) },
    core: core.map(name => ({ name, sha256: fileHash(path.join(plugins, name)) })),
    bundles: bundles.map(file => ({ path: file, sha256: fileHash(file) })),
    gradleUserHome: process.env.GRADLE_USER_HOME || '', importRuntime: options.cacheContext || null
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
    args: ['-Declipse.application=org.eclipse.jdt.ls.core.id1', '-Dosgi.bundles.defaultStartLevel=4', '-Declipse.product=org.eclipse.jdt.ls.core.product', '-Dlog.level=WARNING', '-Xmx1G', '--add-modules=ALL-SYSTEM', '--add-opens', 'java.base/java.util=ALL-UNNAMED', '--add-opens', 'java.base/java.lang=ALL-UNNAMED', '-jar', path.join(plugins, launchers[0]), '-configuration', configuration, '-data', data],
    options: { cwd: serverPath, env, windowsHide: true },
    javaHome, serverPath, configuration, data, identity, bundles
  };
}

function serverSettings(projectJdks = [], options = {}) {
  if (!Array.isArray(projectJdks)) throw new Error('rocketbrain.java.projectJdks must be an array.');
  const runtimes = projectJdks.map(runtime => {
    if (!runtime || !/^JavaSE-\d+$/.test(runtime.name || '') || !path.isAbsolute(runtime.path || '')) throw new Error('Each project JDK requires a JavaSE-N name and an absolute path.');
    return { name: runtime.name, path: absoluteDirectory(runtime.path, 'Project JDK'), default: Boolean(runtime.default) };
  });
  if (runtimes.filter(runtime => runtime.default).length > 1) throw new Error('Only one project JDK can be the default.');
  const gradle = { enabled: true, wrapper: { enabled: true } };
  if (options.gradleHome) gradle.home = absoluteDirectory(options.gradleHome, 'rocketbrain.java.gradleHome');
  if (options.gradleJavaHome) gradle.java = { home: absoluteDirectory(options.gradleJavaHome, 'rocketbrain.java.gradleJavaHome') };
  return {
    java: {
      // Initial trusted import remains enabled; later build-file changes require
      // the explicit Java Projects resync action instead of executing automatically.
      configuration: { updateBuildConfiguration: 'disabled', runtimes },
      import: { maven: { enabled: true }, gradle },
      autobuild: { enabled: true },
      completion: { enabled: true },
      signatureHelp: { enabled: true },
      referencesCodeLens: { enabled: true },
      implementationsCodeLens: { enabled: true },
      format: { enabled: true },
      errors: { incompleteClasspath: { severity: 'warning' } }
    }
  };
}

module.exports = { resolveLaunch, serverSettings };
