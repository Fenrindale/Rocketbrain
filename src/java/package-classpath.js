'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { visitJar } = require('./signature-compiler');

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);

function proveLocalBuildMapping(project, roots, buildFiles) {
  const names = buildFiles.map(file => path.relative(project, file));
  if (roots.kind === 'literal-gradle-additive-main-resources') {
    if (!names.includes('build.gradle') || names.some(name => !['build.gradle', 'settings.gradle'].includes(name))) {
      throw Error('Advanced resource contracts require a literal single-project Gradle resource mapping.');
    }
    if (names.includes('settings.gradle')) {
      const { tokens, issues } = require('../spring/java').lexJava(fs.readFileSync(path.join(project, 'settings.gradle'), 'utf8'));
      if (issues.length || !/^rootProject\.name=(['"])[A-Za-z0-9_-]+\1;?$/.test(tokens.map(token => token.text).join(''))) {
        throw Error('Advanced resource contracts require literal single-project Gradle settings.');
      }
    }
    return;
  }
  if (names.some(name => name !== 'pom.xml')) throw Error('Advanced resource contracts require a proven standard main-resource mapping.');
  if (names.includes('pom.xml')) {
    const pom = fs.readFileSync(path.join(project, 'pom.xml'), 'utf8');
    if (/<!DOCTYPE|<!ENTITY|<(?:[\w.-]+:)?(?:parent|profiles|build|packaging|modules|plugin|resources|filtering)\b/i.test(pom) ||
        fs.existsSync(path.join(project, '.mvn'))) {
      throw Error('Advanced resource contracts require a Maven project with standard resource processing; custom or inherited mappings need separate analysis.');
    }
  }
}

function regularRelativeEntry(root, relative) {
  const parts = relative.split('/');
  let file = root;
  for (const [index, part] of parts.entries()) {
    file = path.join(file, part);
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw Error('Linked service or resource classpath entries need separate analysis.');
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw Error('Service and resource classpath identities must be regular files.');
      return { file, size: stat.size };
    }
    if (!stat.isDirectory()) throw Error('Service and resource classpath namespaces must be directories.');
  }
  return null;
}

async function proveClasspathPaths(classpaths, project, roots, paths) {
  if (!paths.size) return null;
  if (!Array.isArray(classpaths) || !classpaths.length || classpaths.length > 250 || paths.size > 256) {
    throw Error('Service and resource identity checks require bounded observed classpaths.');
  }
  const reserved = new Set([...paths.keys()].map(name => name.toLowerCase()));
  const owned = new Set([
    ...roots,
    ...['bin/main', 'target/classes', 'build/classes/java/main', 'build/resources/main'].map(relative => path.join(project, relative))
  ].map(key));
  const jars = [];
  const directories = [];
  let totalBytes = 0;
  const deadline = Date.now() + 30000;

  function inspectDirectory(directory) {
    const observed = [];
    for (const [name, allowed] of paths) {
      const item = regularRelativeEntry(directory, name);
      if (!item) continue;
      if (!owned.has(key(directory)) || !allowed || item.size > 128 * 1024) {
        throw Error('A competing service or resource identity already exists on the observed classpath: ' + name);
      }
      const sha = sha256(fs.readFileSync(item.file));
      if (!allowed.classFile && allowed.sha256 !== sha) throw Error('A built service or resource does not match its reviewed source bytes: ' + name);
      observed.push({ name, sha });
    }
    return JSON.stringify(observed);
  }

  for (const input of [...new Set(classpaths)]) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) throw Error('Service and resource isolation requires absolute observed classpaths.');
    const stat = fs.lstatSync(input);
    const actual = fs.realpathSync(input);
    if (stat.isSymbolicLink() || key(actual) !== key(input)) throw Error('Service or resource classpath links need separate analysis.');
    if (stat.isDirectory()) {
      directories.push({ file: actual, observed: inspectDirectory(actual) });
      continue;
    }
    if (!stat.isFile() || !input.toLowerCase().endsWith('.jar') || stat.size > 64 * 1024 * 1024 ||
        (totalBytes += stat.size) > 256 * 1024 * 1024) {
      throw Error('Service and resource classpath isolation requires bounded regular JARs.');
    }
    const sha = sha256(fs.readFileSync(actual));
    await visitJar(actual, async (entry, read) => {
      if (Date.now() > deadline) throw Error('Service and resource classpath isolation exceeded its inspection time bound.');
      const name = entry.fileName.toLowerCase();
      const base = name.replace(/^meta-inf\/versions\/\d+\//, '');
      if (reserved.has(base)) throw Error('A competing service or resource identity already exists in an observed JAR: ' + entry.fileName);
      // Legacy INDEX.LIST has no loader effect on the supported JDK 25+ runtime.
      if (name === 'meta-inf/manifest.mf') {
        if (entry.uncompressedSize > 64 * 1024) throw Error('A JAR manifest exceeds the resource review size bound.');
        const manifest = (await read()).toString('utf8').replace(/\r?\n /g, '');
        if (/^Class-Path\s*:\s*\S/mi.test(manifest)) throw Error('Indirect JAR manifest classpaths need separate service and resource analysis.');
      }
    });
    jars.push({ file: actual, sha });
  }
  const validate = () => {
    for (const dir of directories) {
      if (key(fs.realpathSync(dir.file)) !== key(dir.file) || inspectDirectory(dir.file) !== dir.observed) {
        throw Error('A service or resource classpath directory changed after review.');
      }
    }
    for (const jar of jars) {
      if (key(fs.realpathSync(jar.file)) !== key(jar.file) || sha256(fs.readFileSync(jar.file)) !== jar.sha) {
        throw Error('A service or resource JAR changed after review.');
      }
    }
  };
  validate();
  return { proof: { directories: directories.length, jars: jars.length, identities: paths.size }, validate };
}

module.exports = { proveLocalBuildMapping, proveClasspathPaths };
