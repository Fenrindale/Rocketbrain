'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { SaxesParser } = require('saxes');
const { metadataVersion, trackingEntries } = require('./maven-snapshot-cache');
const { modelSnapshotSettings, repoIdPattern } = require('./maven-snapshot-model-settings');

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

function repositorySettings(reactor, roots, repository, snapshot) {
 for (const name of ['MAVEN_OPTS','MAVEN_ARGS','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS']) {
  if (snapshot && name === 'MAVEN_ARGS' && process.env[name]?.trim()) {
   throw Error('MAVEN_ARGS overrides require separate Maven SNAPSHOT model verification.');
  }
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
   const file = path.join(folder,'.mvn',name);
   if (snapshot && samePath(snapshot.config,file)) continue;
   try {
    fs.lstatSync(file);
    throw Error('Maven command or extension overrides require separate external model verification.');
   } catch (error) {
    if (error.code !== 'ENOENT') throw error;
   }
  }
 }
 if (snapshot) return snapshot.identity;
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

function readSnapshotModel(alias, pin, snapshot) {
 const directory = path.dirname(alias);
 if (pin.repositoryId !== snapshot.repositoryId) throw Error('The SNAPSHOT pin repository does not match the active Maven settings.');
 const basename = path.basename(alias), timedName = pin.artifactId+'-'+pin.resolvedVersion+'.pom';
 const exact = path.join(directory,timedName), metadata = path.join(directory,'maven-metadata-'+snapshot.repositoryId+'.xml');
 const trackingFile = path.join(directory,'_remote.repositories'), localMetadata = path.join(directory,'maven-metadata-local.xml');
 const trackingBytes = optionalFile(trackingFile,16*1024), modelBytes = optionalFile(metadata,maxBytes);
 const origins = trackingBytes && trackingEntries(trackingBytes.toString('latin1'),name=>name===timedName||name===basename);
 if (fs.lstatSync(localMetadata,{throwIfNoEntry:false}) || !origins || origins.get(timedName)?.size !== 1 ||
     !origins.get(timedName).has(snapshot.repositoryId) ||
     [...(origins.get(basename)||[])].some(origin=>origin!==snapshot.repositoryId)) {
  throw Error('The Maven SNAPSHOT origin is unavailable, locally installed or ambiguous.');
 }
 const selected = modelBytes && metadataVersion(modelBytes.toString('utf8'),
  {group:pin.groupId,artifact:pin.artifactId,version:pin.version,classifier:''},'pom');
 if (selected !== pin.resolvedVersion) throw Error('Maven SNAPSHOT metadata selects a different timestamped POM.');
 const exactBytes = optionalFile(exact,maxBytes), bytes = optionalFile(alias,maxBytes);
 if (!exactBytes || !bytes) throw Error('The normalized and timestamped Maven SNAPSHOT POMs must be present in the cache.');
 if (hash(bytes) !== pin.sha256 || hash(exactBytes) !== pin.sha256) {
  throw Error('Pinned Maven SNAPSHOT POM SHA-256 mismatch.');
 }
 return {bytes,trackingFile,trackingHash:hash(JSON.stringify([hash(trackingBytes),hash(modelBytes),pin.resolvedVersion])),
  evidenceFiles:[alias,exact,metadata,trackingFile,localMetadata],resolvedVersion:pin.resolvedVersion,repositoryId:pin.repositoryId};
}

function openExternalMavenModels(reactor, roots, { repository = path.join(os.homedir(),'.m2','repository') } = {}) {
 const lock = path.join(reactor, lockName);
 const pins = new Map(), observed = new Map();
 let lockHash, settingsHash, snapshot;

 function loadPins() {
  const input = optionalFile(lock, 16 * 1024);
  if (!input) throw Error('An external Maven parent or BOM requires an exact SHA-256 pin in ' + lockName + '.');
  let data;
  try {
   data = JSON.parse(input.toString('utf8').replace(/^\uFEFF/,''));
  } catch {
   throw Error('Invalid external Maven model pin file.');
  }
  if (![1,2].includes(data?.version) || !Array.isArray(data.models) || !data.models.length || data.models.length > maxModels ||
      Object.keys(data).some(name => !['version','models'].includes(name))) throw Error('Invalid external Maven model pin file.');
  let snapshots=0;
  for (const pin of data.models) {
   if (!pin || ![pin.groupId,pin.artifactId,pin.version,pin.sha256].every(value => typeof value === 'string') ||
       !groupPattern.test(pin.groupId) || !coordinatePattern.test(pin.artifactId) ||
       !coordinatePattern.test(pin.version) || !/^[0-9a-f]{64}$/.test(pin.sha256)) {
    throw Error('External Maven model pins require literal coordinates and a SHA-256.');
   }
   if (/-SNAPSHOT$/i.test(pin.version)) {
    if (data.version===1) throw Error('External Maven model pins require literal release coordinates and a SHA-256.');
    const prefix=pin.version.slice(0,-'SNAPSHOT'.length);
    if (!pin.version.endsWith('-SNAPSHOT') || Object.keys(pin).length!==6 || typeof pin.repositoryId!=='string' ||
        !repoIdPattern.test(pin.repositoryId) ||
        typeof pin.resolvedVersion!=='string' || !pin.resolvedVersion.startsWith(prefix) ||
        !/^\d{8}\.\d{6}-[1-9][0-9]{0,8}$/u.test(pin.resolvedVersion.slice(prefix.length))) {
     throw Error('Maven SNAPSHOT model pins require the exact timestamped version, repository ID and SHA-256.');
    }
    snapshots++;
   } else if (Object.keys(pin).length!==4) {
    throw Error('External Maven release pins require literal release coordinates and a SHA-256.');
   }
   const id = [pin.groupId,pin.artifactId,pin.version].join(':');
   if (pins.has(id)) throw Error('Duplicate external Maven model pin: ' + id + '.');
   pins.set(id,pin);
  }
  if (data.version===2 && !snapshots) throw Error('Use version 1 pins for release-only external Maven models.');
  if (snapshots) {
   snapshot = modelSnapshotSettings({reactor,read:optionalFile,hash});
   repository = snapshot.repository;
  }
  lockHash = hash(input);
  settingsHash = repositorySettings(reactor,roots,repository,snapshot);
 }

 function inspect(dependency) {
  const id = coordinate(dependency);
  if (!lockHash) loadPins();
  const pin = pins.get(id);
  if (!pin) throw Error('No exact external Maven model pin for ' + id + '.');
  const file = path.join(repository,...pin.groupId.split('.'),pin.artifactId,pin.version,pin.artifactId+'-'+pin.version+'.pom');
  if (pin.resolvedVersion) return {id,file,sha256:pin.sha256,...readSnapshotModel(file,pin,snapshot)};
  const bytes = optionalFile(file, maxBytes);
  if (!bytes) throw Error('Pinned external Maven model is missing from the local repository: ' + id + '.');
  if (hash(bytes) !== pin.sha256) throw Error('Pinned external Maven model SHA-256 mismatch: ' + id + '.');
  return { id, file, bytes, sha256:pin.sha256, ...repositoryTracking(file) };
 }

 return {
  read(dependency) {
   const model = inspect(dependency);
   observed.set(model.id, { dependency, file:model.file, sha256:model.sha256,
    files:model.evidenceFiles||[model.file,model.trackingFile],trackingHash:model.trackingHash,
    ...(model.resolvedVersion&&{resolvedVersion:model.resolvedVersion,repositoryId:model.repositoryId}) });
   return model;
  },
  finish() {
   if (!observed.size) return undefined;
   const records = [...observed.values()];
   const validate = () => {
    const input = optionalFile(lock, 16 * 1024);
    const configuration = snapshot && modelSnapshotSettings({reactor,read:optionalFile,hash});
    if (!input || hash(input) !== lockHash || repositorySettings(reactor,roots,repository,configuration) !== settingsHash) {
     throw Error('External Maven model pins or settings changed after review.');
    }
    for (const {dependency,trackingHash} of records) {
     if (inspect(dependency).trackingHash !== trackingHash) throw Error('External Maven model origin metadata changed after review.');
    }
   };
   validate();
   return { lock, files:[...(snapshot?.files||[]),...records.flatMap(record=>record.files)],
    pins:records.map(({dependency,sha256,resolvedVersion,repositoryId}) => ({coordinate:coordinate(dependency),sha256,
     ...(resolvedVersion&&{resolvedVersion,repositoryId})})), validate };
  }
 };
}

module.exports = { openExternalMavenModels, lockName };
