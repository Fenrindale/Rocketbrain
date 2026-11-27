'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JDT_VERSION, inspectJavaHome, inspectServerPath } = require('./runtime');

function desktopJavaHome(value, platform = process.platform) {
  const jdk = inspectJavaHome(value, platform);
  const executable = name => path.join(jdk.javaHome, 'bin', name + (platform === 'win32' ? '.exe' : ''));
  if (!['javac', 'jar'].every(name => fs.statSync(executable(name), { throwIfNoEntry: false })?.isFile())) {
    throw Error('Select a full JDK with javac and jar. The JDK runs editor services and builds the debugger.');
  }
  return { path: jdk.javaHome, version: jdk.version };
}

function childDirectories(folder) {
  if (!path.isAbsolute(folder || '')) return [];
  try {
    return fs.readdirSync(folder, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name)
      .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
      .map(name => path.join(folder, name));
  } catch {
    return [];
  }
}

function discoverDesktopJdk(target, { env = process.env, platform = process.platform, home = os.homedir() } = {}) {
  const macHome = root => platform === 'darwin' ? path.join(root, 'Contents', 'Home') : root;
  const managed = childDirectories(target).filter(folder => path.basename(folder).startsWith('temurin-'));
  const vendors = ['Eclipse Adoptium', 'Microsoft', 'Java', 'Amazon Corretto', 'BellSoft', 'Zulu', 'IBM', 'OpenJDK'];
  const programs = [env.ProgramFiles, env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const system = platform === 'win32' ? programs.flatMap(folder => vendors.map(vendor => path.join(folder, vendor))) :
    platform === 'darwin' ? ['/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines')] : ['/usr/lib/jvm'];
  const fileName = platform === 'win32' ? 'java.exe' : 'java';
  const pathHomes = (env.PATH || '').split(path.delimiter).flatMap(raw => {
    const bin = raw.replace(/^"|"$/g, '');
    if (!path.isAbsolute(bin)) return [];
    try { return [path.dirname(path.dirname(fs.realpathSync(path.join(bin, fileName))))]; }
    catch { return []; }
  });
  const localHomes = [path.join(home, '.jdks'), path.join(home, '.sdkman', 'candidates', 'java')];
  const candidates = [...managed.flatMap(childDirectories).map(macHome), env.JDK_HOME, env.JAVA_HOME, ...pathHomes,
    ...localHomes.flatMap(childDirectories), ...system.flatMap(childDirectories).map(macHome)];
  for (const candidate of new Set(candidates)) {
    if (!path.isAbsolute(candidate || '')) continue;
    try { return desktopJavaHome(candidate, platform); } catch { /* Try the next installation. */ }
  }
}

function inspectDesktopRuntime(config, target, detectJdk = () => discoverDesktopJdk(target)) {
  const configuredJdk = config.get('javaHome');
  const configuredServer = config.get('serverPath');
  const debugBundlePath = config.get('debugBundlePath');
  const expected = path.join(target, `jdtls-${JDT_VERSION}`);
  const problems = [];
  let jdk, serverPath;
  if (configuredJdk) {
    try { jdk = desktopJavaHome(configuredJdk); }
    catch (error) { problems.push(`JDK: ${error.message}`); }
  } else {
    jdk = detectJdk();
  }
  if (configuredServer || fs.existsSync(expected)) {
    try { serverPath = inspectServerPath(configuredServer || expected).serverPath; }
    catch (error) { problems.push(`Java language engine: ${error.message}`); }
  }
  return { jdk, configuredJdk, configuredServer, serverPath, debugBundlePath, problems };
}

module.exports = { desktopJavaHome, discoverDesktopJdk, inspectDesktopRuntime };
