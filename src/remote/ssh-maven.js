'use strict';

const { rootParts } = require('./ssh-java-mapping');

const digest = /^[0-9a-f]{64}$/u;
const tasks = new Set(['test', 'package']);
const pathPart = /^[A-Za-z0-9_$ .+-]{1,128}$/u;

function mavenConfig(root, requested = {}) {
  const { file, task, javaHome, mavenHome, repository } = requested;
  const windows = Boolean(rootParts(root).drive);
  for (const absolute of [javaHome, mavenHome, repository]) {
    if (Boolean(rootParts(absolute).drive) !== windows) throw Error('Choose absolute Maven, JDK and repository paths on the SSH host.');
  }
  if (typeof file !== 'string' || file.length > 1024 || !file.startsWith('/')) {
    throw Error('Choose the saved remote pom.xml of one Maven project.');
  }
  const parts = file.slice(1).split('/');
  if (parts.length > 24 || parts.at(-1) !== 'pom.xml' || parts.some(part =>
    !pathPart.test(part) || ['.', '..', '.git', '.mvn'].includes(part.toLowerCase()) || /[ .]$/u.test(part))) {
    throw Error('Choose the physical remote pom.xml of one Maven project.');
  }
  if (!tasks.has(task)) throw Error('Choose the standard Maven test or package task.');
  return { root, file, project: '/' + parts.slice(0, -1).join('/'), task, javaHome, mavenHome, repository };
}

function mavenProof(info) {
  const { descriptorSha256, projectSha256, toolSha256, jdkSha256, repositorySha256 } = info;
  return { descriptorSha256, projectSha256, toolSha256, jdkSha256, repositorySha256 };
}

const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
function validMavenReview(info, config) {
  return info?.project === config.project && info.task === config.task &&
    Object.values(mavenProof(info)).every(value => typeof value === 'string' && digest.test(value)) &&
    integer(info.sourceFiles, 512) && integer(info.repositoryFiles, 4000) && info.repositoryFiles > 0;
}

function validMavenResult(info, config) {
  if (info?.state === 'cancelled') return true;
  if (!['succeeded', 'failed'].includes(info?.state) || info.task !== config.task ||
      !integer(info.exitCode, 255) || (info.state === 'succeeded') !== (info.exitCode === 0)) return false;
  const { tests, failures, errors, skipped, reports } = info.tests || {};
  if (![tests, failures, errors, skipped].every(number => integer(number, 100000)) || !integer(reports, 128) ||
      failures + errors + skipped > tests || (info.state === 'succeeded' && failures + errors > 0)) return false;
  if (!info.artifact) return info.state === 'failed' || config.task === 'test';
  return info.state === 'succeeded' && config.task === 'package' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.jar$/u.test(info.artifact.name || '') &&
    digest.test(info.artifact.sha256 || '') && integer(info.artifact.size, 64 * 1024 * 1024) && info.artifact.size > 0;
}

module.exports = { mavenConfig, mavenProof, validMavenReview, validMavenResult };
