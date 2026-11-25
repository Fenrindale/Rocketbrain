'use strict';

const path = require('node:path');
const { fail, LIMITS, environment, argumentsList } = require('./workbench-model');
const { restoreSpringLaunch, describeSpringLaunch } = require('./spring-launch');

const format = 'RocketbrainSharedJavaRun';
const extension = '.rocketbrain-run.json';
const maximumBytes = 32 * 1024;

function shape(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertySymbols(value).length) {
    throw fail('Use a shared Java run object.');
  }
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(properties).some(key => !keys.includes(key) || !Object.hasOwn(properties[key], 'value'))) {
    throw fail('The shared Java run contains an unsupported field.');
  }
}

const validName = (value, maximum) =>
  typeof value === 'string' && value.trim() && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);

function validateSharedRun(value) {
  shape(value, ['format','version','name','project','mainClass','prelaunch','arguments','jvmOptions','environment','spring']);
  if (value.format !== format || value.version !== 1) throw fail('Choose a version 1 shared Java run file.');
  if (!validName(value.name, 120) ||
      typeof value.mainClass !== 'string' || value.mainClass.length > 1024 ||
      !/^(?:[\p{L}_$][\p{L}\p{N}_$]*\.)*[\p{L}_$][\p{L}\p{N}_$]*$/u.test(value.mainClass)) {
    throw fail('Choose a named Java run and a valid main class.');
  }
  const project = value.project;
  if (typeof project !== 'string' || project.length > 1024 ||
      project !== '.' && project.split('/').some(part => !validName(part, 255) ||
        part === '.' || part === '..' || /[\\:*?"<>|]/.test(part) || /[. ]$/.test(part))) {
    throw fail('Use a relative workspace project path in the shared run.');
  }
  const counts = [value.arguments, value.jvmOptions];
  if (counts.some(count => !Number.isInteger(count) || count < 0 || count > LIMITS.arguments)) {
    throw fail('A shared Java run supports at most 64 program or JVM argument slots.');
  }
  const keys = value.environment;
  if (!Array.isArray(keys) || keys.length > LIMITS.environment ||
      keys.some(key => typeof key !== 'string' || key.length > 128 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) ||
      new Set(keys.map(key => key.toUpperCase())).size !== keys.length) {
    throw fail('Use distinct environment variable names in a shared Java run.');
  }
  let prelaunch = null;
  if (value.prelaunch !== null) {
    shape(value.prelaunch, ['tool','name']);
    if (!['maven','gradle'].includes(value.prelaunch.tool) ||
        !validName(value.prelaunch.name, 256) || !/^[:A-Za-z0-9_.-]+$/.test(value.prelaunch.name)) {
      throw fail('Choose a named Maven or Gradle prelaunch task.');
    }
    prelaunch = { tool: value.prelaunch.tool, name: value.prelaunch.name };
  }
  let spring = null;
  if (value.spring !== null) {
    shape(value.spring, ['profiles','profileSource','properties']);
    if (!Array.isArray(value.spring.properties)) throw fail('Choose named Spring launch property slots.');
    for (const property of value.spring.properties) shape(property, ['key','source']);
    spring = describeSpringLaunch(restoreSpringLaunch(value.spring, value.spring.properties.map(() => '')));
  }
  return {
    format, version: 1, name: value.name.trim(), project, mainClass: value.mainClass, prelaunch,
    arguments: counts[0], jvmOptions: counts[1], environment: [...keys], spring
  };
}

function shareRunConfiguration(saved, root, project) {
  const relative = path.relative(root, project).split(path.sep).join('/') || '.';
  return validateSharedRun({
    format, version: 1, name: saved.name, project: relative, mainClass: saved.mainClass,
    prelaunch: saved.prelaunch || null, arguments: saved.args.length, jvmOptions: saved.vmArgs.length,
    environment: saved.environmentKeys || [], spring: saved.springBoot || null
  });
}

function bindSharedRun(value, bindings) {
  shape(bindings, ['args','vmArgs','env','springValues']);
  const args = argumentsList(bindings.args), vmArgs = argumentsList(bindings.vmArgs), env = environment(bindings.env);
  if (args.length !== value.arguments || vmArgs.length !== value.jvmOptions ||
      Object.keys(env).length !== value.environment.length || value.environment.some(key => !Object.hasOwn(env, key))) {
    throw fail('Supply the exact program, JVM and environment values requested in the shared run.');
  }
  const springValues = bindings.springValues ?? [];
  if (!Array.isArray(springValues) || springValues.length !== (value.spring?.properties.length ?? 0)) {
    throw fail('Supply the exact Spring property values requested in the shared run.');
  }
  const springBoot = value.spring ? restoreSpringLaunch(value.spring, springValues) : null;
  return { args, vmArgs, env, springBoot };
}

function parseSharedRun(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > maximumBytes) throw fail('Shared Java run files are limited to 32 KiB.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fail('Use a valid UTF-8 shared Java run JSON document.'); }
  return validateSharedRun(parsed);
}

module.exports = { extension, maximumBytes, shareRunConfiguration, bindSharedRun, parseSharedRun };
