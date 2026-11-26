'use strict';

const { rootParts } = require('./ssh-java-mapping');

const sha256 = /^[0-9a-f]{64}$/u;
const pathPart = /^[A-Za-z0-9_$ .+-]{1,128}$/u;
const sourcePart = /^(?:[A-Za-z_$][A-Za-z0-9_$]*|package-info|module-info)\.java$/u;
const packagePart = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function partsFor(value) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('/')) {
    throw Error('Choose workspace-relative Java and JAR paths beginning with /.');
  }
  const parts = value.slice(1).split('/');
  if (parts.length > 24 || parts.some(part => !pathPart.test(part) || ['..', '.', '.git'].includes(part.toLowerCase()) || /[ .]$/u.test(part))) {
    throw Error('Choose physical workspace-relative Java and JAR paths.');
  }
  return parts;
}

function compileConfig(root, requested) {
  const { file, javaHome, jars = [] } = requested || {};
  if (Boolean(rootParts(javaHome).drive) !== Boolean(rootParts(root).drive)) {
    throw Error('Use an absolute JDK path on the SSH host.');
  }
  const parts = partsFor(file);
  const matches = parts.flatMap((part, index) =>
    part === 'src' && parts[index + 1] === 'main' && parts[index + 2] === 'java' && index < parts.length - 3 ? [index] : []);
  if (matches.length !== 1 || !sourcePart.test(parts.at(-1)) ||
      parts.slice(matches[0] + 3, -1).some(part => !packagePart.test(part))) {
    throw Error('Choose a saved Java source under one conventional src/main/java directory.');
  }
  if (!Array.isArray(jars) || jars.length > 24 || jars.some(jar => !partsFor(jar).at(-1).endsWith('.jar')) ||
      new Set(jars.map(jar => rootParts(root).drive ? jar.toLowerCase() : jar)).size !== jars.length) {
    throw Error('Choose up to 24 distinct dependency JARs in this SSH workspace.');
  }
  return { root, javaHome, file, jars: [...jars], module: '/' + parts.slice(0, matches[0]).join('/') };
}

function compileProof(info) {
  const { inputSha256, jdkSha256, selectedSha256 } = info;
  return { inputSha256, jdkSha256, selectedSha256 };
}

function validCompileReview(info, config) {
  return info?.module === config.module && Number.isSafeInteger(info.sourceCount) && info.sourceCount > 0 &&
    info.sourceCount <= 128 && Object.values(compileProof(info)).every(value => typeof value === 'string' && sha256.test(value));
}

function validCompileResult(info) {
  if (info?.state === 'cancelled') return true;
  if (!['compiled', 'failed'].includes(info?.state) || typeof info.truncated !== 'boolean' ||
      !Array.isArray(info.diagnostics) || info.diagnostics.length > 80 || !info.diagnostics.every(item =>
        sourcePart.test(item?.file || '') && Number.isSafeInteger(item.line) && item.line > 0 &&
        Number.isSafeInteger(item.column) && item.column > 0 && /^compiler\.(?:err|warn)\.[a-z0-9_.]{1,160}$/u.test(item.code || '') &&
        (!item.path || typeof item.path === 'string' && item.path.split('/').slice(0, -1).every(part => packagePart.test(part)) &&
          item.path.split('/').at(-1) === item.file && typeof item.sha256 === 'string' && sha256.test(item.sha256)))) return false;
  return info.state === 'failed' || Number.isSafeInteger(info.classCount) && info.classCount >= 1 && info.classCount <= 1024 &&
    sha256.test(info.artifactSha256 || '') && Array.isArray(info.classes) && info.classes.length === Math.min(info.classCount, 32) &&
    info.classes.every(item => typeof item === 'string' && /^(?:[A-Za-z0-9_$-]+\/)*[A-Za-z0-9_$-]+\.class$/u.test(item));
}

module.exports = { compileConfig, compileProof, validCompileReview, validCompileResult };
