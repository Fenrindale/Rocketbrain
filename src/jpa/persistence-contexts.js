'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { workspacePath, workspaceRoots } = require('../java/workbench-model');

const contextKey = /^context-[1-9][0-9]{0,15}$/u;
const factoryKey = /^factory-[1-9][0-9]{0,15}$/u;
const typeName = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/u;
const label = /^[A-Za-z0-9_.$:@ -]{1,180}$/u;
const hash = /^[a-f0-9]{64}$/u;
const maxClassBytes = 262144;
const maxBuildBytes = 16 * 1024 * 1024;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const pathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

function safe(value, pattern, limit = 256) {
  return typeof value === 'string' && value.length <= limit && value.trim().length > 0 && pattern.test(value);
}

function fingerprint(rows) {
  return sha(rows.map(row => row.javaType + ' ' + row.sha256 + '\n').join(''));
}

function readBuild(raw) {
  if (!raw || !['known','partial','disabled','unavailable'].includes(raw.state) ||
      !Array.isArray(raw.classes) || raw.classes.length > 128) throw Error('Invalid persistence build evidence.');
  const classes = raw.classes.map(value => {
    if (!safe(value?.javaType,typeName) || (value.sha256 !== undefined && !safe(value.sha256,hash))) {
      throw Error('Invalid compiled type fingerprint.');
    }
    return { javaType:value.javaType, ...(value.sha256 && { sha256:value.sha256 }) };
  });
  if (classes.some((value, index) => index > 0 && value.javaType <= classes[index - 1].javaType)) {
    throw Error('Duplicate or unsorted managed type fingerprints.');
  }
  if (raw.state === 'known') {
    if (!classes.length || classes.some(value => !value.sha256) || raw.fingerprint !== fingerprint(classes)) {
      throw Error('Invalid managed class fingerprint.');
    }
    return { state:raw.state, classes, fingerprint:raw.fingerprint };
  }
  if (raw.fingerprint !== undefined || (raw.state === 'partial' ? !classes.some(value => !value.sha256) : classes.length)) {
    throw Error('Invalid partial persistence build evidence.');
  }
  return { state:raw.state, classes };
}

function normalizePersistenceContexts(raw) {
  if (!raw || !['observed','partial','awaiting-hooks','disabled'].includes(raw.state) ||
      !Number.isSafeInteger(raw.processId) || raw.processId < 1 ||
      raw.observerExecutedSql !== false || raw.applicationCallbacksInvoked !== false ||
      !Array.isArray(raw.contexts) || raw.contexts.length > 16 ||
      !Array.isArray(raw.unassignedFactoryIds) || raw.unassignedFactoryIds.length > 4) {
    throw Error('Invalid Spring persistence context metadata.');
  }
  const remaining = new Set(raw.unassignedFactoryIds);
  const claimed = new Set();
  const graph = new Map();
  if (remaining.size !== raw.unassignedFactoryIds.length || [...remaining].some(id => !safe(id,factoryKey))) {
    throw Error('Invalid unassigned persistence factory IDs.');
  }
  const contexts = raw.contexts.map(value => {
    if (!safe(value?.key,contextKey) || graph.has(value.key) ||
        (value.id !== undefined && !safe(value.id,label)) ||
        !['root','observed','unobserved'].includes(value.parentState) ||
        (value.parentState === 'observed' ? !safe(value.parentKey,contextKey) : value.parentKey !== undefined) ||
        !Array.isArray(value.factories) || value.factories.length > 4) throw Error('Invalid Spring context identity.');
    graph.set(value.key,value.parentKey);
    const factories = value.factories.map(factory => {
      if (!safe(factory?.factoryId,factoryKey) || !safe(factory.beanName,label) || !safe(factory.persistenceUnit,label) ||
          claimed.has(factory.factoryId) || remaining.has(factory.factoryId)) throw Error('Invalid Spring factory ownership.');
      claimed.add(factory.factoryId);
      return { factoryId:factory.factoryId, beanName:factory.beanName, persistenceUnit:factory.persistenceUnit, build:readBuild(factory.build) };
    });
    return { key:value.key, ...(value.id && { id:value.id }), parentState:value.parentState,
      ...(value.parentKey && { parentKey:value.parentKey }), factories };
  });
  if (claimed.size + remaining.size > 4 ||
      (raw.state === 'disabled' && (contexts.length || remaining.size)) ||
      (raw.state === 'observed' && (remaining.size || contexts.some(value => value.parentState === 'unobserved')))) {
    throw Error('Invalid persistence ownership coverage.');
  }
  for (const [key, parent] of graph) {
    const seen = new Set([key]);
    for (let next = parent; next; next = graph.get(next)) {
      if (!graph.has(next) || seen.has(next)) throw Error('Invalid Spring context hierarchy.');
      seen.add(next);
    }
  }
  return { state:raw.state, processId:raw.processId, contexts, unassignedFactoryIds:[...remaining],
    observerExecutedSql:false, applicationCallbacksInvoked:false };
}

function sameFile(a,b) {
  return a.isFile() && b.isFile() && ['dev','ino','size','mtimeNs','ctimeNs'].every(name => a[name] === b[name]);
}

async function compareClass(root, javaType, remainingBytes) {
  const candidate = path.join(root, ...javaType.split('.')) + '.class';
  if (pathKey(await fs.realpath(candidate)) !== pathKey(candidate)) throw Error('Use physical class files under the selected build output.');
  const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint:true });
    if (!before.isFile() || before.size < 4n || before.size > BigInt(Math.min(maxClassBytes,remainingBytes))) {
      throw Error('Compiled class outside the evidence bounds.');
    }
    const buffer = Buffer.alloc(Number(before.size));
    let read = 0;
    while (read < buffer.length) {
      const next = await handle.read(buffer,read,buffer.length-read,read);
      if (!next.bytesRead) break;
      read += next.bytesRead;
    }
    if (read !== buffer.length || !sameFile(before,await handle.stat({ bigint:true })) ||
        !sameFile(before,await fs.lstat(candidate,{ bigint:true })) ||
        pathKey(await fs.realpath(candidate)) !== pathKey(candidate) || buffer.readUInt32BE(0) !== 0xcafebabe) {
      throw Error('Compiled class is unavailable or changed during comparison.');
    }
    return { sha256:sha(buffer), bytes:buffer.length };
  } finally { await handle.close(); }
}

async function comparePersistenceBuild(build, directory, folders) {
  const verified = readBuild(build);
  if (verified.state !== 'known') return { state:'unavailable', reason:'incomplete_runtime_fingerprint', classes:[] };
  if (directory?.scheme !== 'file') throw Error('Select a local compiled output directory in this workspace.');
  const root = workspacePath(directory.toString(),workspaceRoots(folders || []));
  let used = 0;
  const checks = [];
  for (const expected of verified.classes) {
    let observed;
    try { observed = await compareClass(root,expected.javaType,maxBuildBytes-used); }
    catch { checks.push({ javaType:expected.javaType, state:'unavailable' }); continue; }
    used += observed.bytes;
    checks.push({ javaType:expected.javaType, state:observed.sha256 === expected.sha256 ? 'matched' : 'different' });
  }
  const state = checks.some(value => value.state === 'different') ? 'different' :
    checks.some(value => value.state === 'unavailable') ? 'unavailable' : 'matched';
  return { state, expectedFingerprint:verified.fingerprint, ...(state === 'matched' && { verifiedFingerprint:verified.fingerprint }),
    classes:checks, sameSourceRevisionVerified:false };
}

module.exports = { normalizePersistenceContexts, comparePersistenceBuild };
