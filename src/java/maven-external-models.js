'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { SaxesParser } = require('saxes');

const lockName = '.rocketbrain-maven-models.json';
const maxModels = 16;
const maxBytes = 256 * 1024;
const groupPattern = /^[A-Za-z0-9_][\w-]*(?:\.[A-Za-z0-9_][\w-]*)*$/;
const coordinatePattern = /^[A-Za-z0-9][\w.-]*$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => path.relative(left, right) === '';
const coordinate = ({group, artifact, version}) => [group, artifact, version].join(':');

function boundedPhysicalFile(file, limit) {
 const stat = fs.lstatSync(file);
 if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || !samePath(fs.realpathSync(file), file)) {
  throw Error('External Maven model inputs must be bounded physical files without links.');
 }
 const bytes = fs.readFileSync(file);
 if (bytes.length > limit) throw Error('An external Maven model input exceeds its byte limit.');
 return bytes;
}

function optionalFile(file, limit) {
 try {
  return boundedPhysicalFile(file, limit);
 } catch (error) {
  if (error.code === 'ENOENT') return null;
  throw error;
 }
}

function repositorySettings(reactor, roots, repository) {
 for (const name of ['MAVEN_OPTS','MAVEN_ARGS','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS']) {
  if (/maven\.repo\.local|user\.home|maven\.ext\.class\.path|maven\.(?:user|global)\.settings|aether\.(?:enhancedLocalRepository|localRepository|lrm)|(?:^|\s)(?:-s|-gs|--settings|--global-settings)(?:[=\s]|$)/i.test(process.env[name] || '')) {
   throw Error('External Maven models require the default Maven repository and standard settings resolution.');
  }
 }
 const folders = new Set(roots);
 for (let folder = reactor;; folder = path.dirname(folder)) {
  folders.add(folder);
  if (path.dirname(folder) === folder) break;
 }
 for (const folder of folders) {
  for (const name of ['maven.config','jvm.config','extensions.xml']) {
   try {
    fs.lstatSync(path.join(folder,'.mvn',name));
    throw Error('Maven command or extension overrides require separate external model verification.');
   } catch (error) {
    if (error.code !== 'ENOENT') throw error;
   }
  }
 }
 const settings = optionalFile(path.join(path.dirname(repository),'settings.xml'), maxBytes);
 if (!settings) return null;
 const text = settings.toString('utf8');
 if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw Error('Unreviewed Maven settings prevent external model verification.');
 const parser = new SaxesParser({ xmlns: true });
 let replacement = false;
 parser.on('opentag', tag => {
  if (tag.local === 'localRepository' || /^aether\.(?:enhancedLocalRepository|localRepository|lrm)/i.test(tag.local)) replacement = true;
 });
 try {
  parser.write(text).close();
 } catch {
  throw Error('Unreviewed Maven settings prevent external model verification.');
 }
 if (replacement) throw Error('A custom Maven localRepository requires separate external model verification.');
 return hash(settings);
}

function repositoryTracking(file) {
 const trackingFile = path.join(path.dirname(file),'_remote.repositories');
 const bytes = optionalFile(trackingFile, 16 * 1024);
 if (!bytes) return {trackingFile, trackingHash:null};
 const basename = path.basename(file);
 let tracked = false, installed = false;
 for (const line of bytes.toString('latin1').split(/\r?\n/)) {
  if (!line.trim() || /^[#!]/.test(line)) continue;
  const entry = /^([A-Za-z0-9_.-]+)>([A-Za-z0-9_.-]*)=$/.exec(line);
  if (!entry) throw Error('Unreviewed Maven local repository origin metadata.');
  if (entry[1] !== basename) continue;
  tracked = true;
  if (entry[2] === '') installed = true;
 }
 // Maven checks origin availability for downloaded files. A local install
 // or a legacy untracked POM is visible without a matching remote ID.
 if (tracked && !installed) throw Error('A remote-origin cached POM requires separate Maven repository verification.');
 return {trackingFile, trackingHash:hash(bytes)};
}

function openExternalMavenModels(reactor, roots, { repository = path.join(os.homedir(),'.m2','repository') } = {}) {
 const lock = path.join(reactor, lockName);
 const pins = new Map(), observed = new Map();
 let lockHash, settingsHash;

 function loadPins() {
  const input = optionalFile(lock, 16 * 1024);
  if (!input) throw Error('An external Maven parent or BOM requires an exact SHA-256 pin in ' + lockName + '.');
  let data;
  try {
   data = JSON.parse(input.toString('utf8').replace(/^\uFEFF/,''));
  } catch {
   throw Error('Invalid external Maven model pin file.');
  }
  if (data?.version !== 1 || !Array.isArray(data.models) || !data.models.length || data.models.length > maxModels ||
      Object.keys(data).some(name => !['version','models'].includes(name))) throw Error('Invalid external Maven model pin file.');
  for (const pin of data.models) {
   if (!pin || ![pin.groupId,pin.artifactId,pin.version,pin.sha256].every(value => typeof value === 'string') ||
       Object.keys(pin).length !== 4 || !groupPattern.test(pin.groupId) || !coordinatePattern.test(pin.artifactId) ||
       !coordinatePattern.test(pin.version) || /-SNAPSHOT$/i.test(pin.version) || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw Error('External Maven model pins require literal release coordinates and a SHA-256.');
   }
   const id = [pin.groupId,pin.artifactId,pin.version].join(':');
   if (pins.has(id)) throw Error('Duplicate external Maven model pin: ' + id + '.');
   pins.set(id,pin);
  }
  lockHash = hash(input);
  settingsHash = repositorySettings(reactor,roots,repository);
 }

 function inspect(dependency) {
  const id = coordinate(dependency);
  if (!lockHash) loadPins();
  const pin = pins.get(id);
  if (!pin) throw Error('No exact external Maven model pin for ' + id + '.');
  const file = path.join(repository,...pin.groupId.split('.'),pin.artifactId,pin.version,pin.artifactId+'-'+pin.version+'.pom');
  const bytes = optionalFile(file, maxBytes);
  if (!bytes) throw Error('Pinned external Maven model is missing from the local repository: ' + id + '.');
  if (hash(bytes) !== pin.sha256) throw Error('Pinned external Maven model SHA-256 mismatch: ' + id + '.');
  return { id, file, bytes, sha256:pin.sha256, ...repositoryTracking(file) };
 }

 return {
  read(dependency) {
   const model = inspect(dependency);
   observed.set(model.id, { dependency, file:model.file, sha256:model.sha256, trackingFile:model.trackingFile, trackingHash:model.trackingHash });
   return model;
  },
  finish() {
   if (!observed.size) return undefined;
   const records = [...observed.values()];
   const validate = () => {
    const input = optionalFile(lock, 16 * 1024);
    if (!input || hash(input) !== lockHash || repositorySettings(reactor,roots,repository) !== settingsHash) {
     throw Error('External Maven model pins or settings changed after review.');
    }
    for (const {dependency,trackingHash} of records) {
     if (inspect(dependency).trackingHash !== trackingHash) throw Error('External Maven model origin metadata changed after review.');
    }
   };
   validate();
   return { lock, files:records.flatMap(({file,trackingFile}) => [file,trackingFile]),
    pins:records.map(({dependency,sha256}) => ({coordinate:coordinate(dependency),sha256})), validate };
  }
 };
}

module.exports = { openExternalMavenModels, lockName };
