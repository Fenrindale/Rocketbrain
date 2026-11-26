'use strict';

const { rootParts } = require('./ssh-java-mapping');

const digest = /^[0-9a-f]{64}$/u;
const pathPart = /^[A-Za-z0-9_$ .+-]{1,128}$/u;
const lifecycle = new Set(['test', 'build']);
const graphNames = new Set([':compileJava', ':processResources', ':classes', ':compileTestJava', ':processTestResources',
  ':testClasses', ':test', ':jar', ':assemble', ':check', ':build']);
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

function gradleConfig(root, requested = {}) {
  const { file, task, javaHome, gradleHome, repository } = requested;
  const windows = Boolean(rootParts(root).drive);
  for (const absolute of [javaHome, gradleHome, repository]) {
    if (Boolean(rootParts(absolute).drive) !== windows) throw Error('Choose absolute Gradle, JDK and mirror paths on the SSH host.');
  }
  if (typeof file !== 'string' || file.length > 1024 || !file.startsWith('/')) throw Error('Select one saved remote build.gradle.');
  const parts = file.slice(1).split('/');
  if (parts.length > 24 || parts.at(-1) !== 'build.gradle' || parts.some(part =>
    !pathPart.test(part) || ['.', '..', '.git', '.gradle'].includes(part.toLowerCase()) || /[ .]$/u.test(part))) {
    throw Error('Select one physical remote Groovy build.gradle.');
  }
  if (!lifecycle.has(task)) throw Error('Choose the standard Gradle test or build task.');
  return { root, file, project: '/' + parts.slice(0, -1).join('/'), task, javaHome, gradleHome, repository };
}

function gradleProof(info) {
  const { descriptorSha256, settingsSha256, projectSha256, toolSha256, jdkSha256, repositorySha256 } = info;
  return { descriptorSha256, settingsSha256, projectSha256, toolSha256, jdkSha256, repositorySha256 };
}

function validGradleReview(info, config) {
  return info?.project === config.project && info.task === config.task &&
    /^9\.\d{1,2}\.\d{1,2}$/u.test(info.gradleVersion || '') &&
    Object.values(gradleProof(info)).every(value => typeof value === 'string' && digest.test(value)) &&
    integer(info.sourceFiles, 512) && integer(info.repositoryFiles, 4000);
}

function validGradleResult(info, config) {
  if (info?.state === 'cancelled') return true;
  if (!['succeeded', 'failed'].includes(info?.state) || info.task !== config.task ||
      !integer(info.exitCode, 255) || (info.state === 'succeeded') !== (info.exitCode === 0)) return false;
  const { taskGraph } = info;
  if (!Array.isArray(taskGraph) || taskGraph.length > graphNames.size || new Set(taskGraph).size !== taskGraph.length ||
      !taskGraph.every(name => graphNames.has(name)) ||
      ((info.state === 'succeeded' || taskGraph.length > 0) && taskGraph.at(-1) !== ':' + config.task)) return false;
  const { tests, failures, errors, skipped, reports } = info.tests || {};
  if (![tests, failures, errors, skipped].every(number => integer(number, 100000)) || !integer(reports, 128) ||
      failures + errors + skipped > tests || (info.state === 'succeeded' && failures + errors > 0)) return false;
  if (!info.artifact) return info.state === 'failed' || config.task === 'test';
  return info.state === 'succeeded' && config.task === 'build' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,179}\.jar$/u.test(info.artifact.name || '') &&
    digest.test(info.artifact.sha256 || '') && integer(info.artifact.size, 64 * 1024 * 1024) && info.artifact.size > 0;
}

module.exports = { gradleConfig, gradleProof, validGradleReview, validGradleResult };
