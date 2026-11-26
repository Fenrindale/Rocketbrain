'use strict';

const fs = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');
const { SaxesParser } = require('saxes');
const { rangeAt } = require('../spring/java');
const { fail, hash } = require('./workbench-model');
const { pomTree } = require('./dependency-builds');

const identifier = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;
const release = /^(?!.*SNAPSHOT$)[0-9][A-Za-z0-9_.-]{0,63}$/iu;
const defaultGroup = 'org.apache.maven.plugins';
const maxChoices = 80;

function mavenExecutionArgument(value) {
  if (typeof value !== 'string' || value.length > 256) return false;
  const fields = value.split(':');
  if (fields.length !== 4 || !identifier.test(fields[0]) || !identifier.test(fields[1]) || !release.test(fields[2])) return false;
  const tail = fields[3].split('@');
  return tail.length === 2 && tail.every(name => identifier.test(name));
}

function descriptorAccess(tree) {
  const children = (node, name) => node?.children.filter(item => item.name === name && item.namespace === tree.namespace) || [];
  function one(node, name) {
    const matches = children(node, name);
    if (matches.length > 1) throw fail('Resolve duplicate Maven <' + name + '> declarations first.');
    return matches[0];
  }
  function text(node, name) {
    const child = one(node, name);
    return child?.children.length ? '' : child?.text.trim() ?? '';
  }
  return { children, one, text };
}

function pluginExecutions(file, tree, owner, profile) {
  const { children, one, text } = descriptorAccess(tree);
  const plugins = children(one(one(owner, 'build'), 'plugins'), 'plugin');
  const pluginKeys = new Set(), options = [];
  for (const plugin of plugins) {
    const group = one(plugin, 'groupId') ? text(plugin, 'groupId') : defaultGroup;
    const artifact = text(plugin, 'artifactId'), version = text(plugin, 'version');
    if (!identifier.test(group) || !identifier.test(artifact)) continue;
    const key = group + ':' + artifact;
    if (pluginKeys.has(key)) throw fail('Resolve duplicate Maven plugin declarations for ' + key + '.');
    pluginKeys.add(key);

    const executions = children(one(plugin, 'executions'), 'execution');
    const ids = new Set();
    for (const entry of executions) {
      const declaredId = text(entry, 'id');
      const id = declaredId || 'default';
      if (ids.has(id)) throw fail('Resolve duplicate Maven execution IDs for ' + key + '.');
      ids.add(id);
      if (!declaredId || !identifier.test(id) || !release.test(version)) continue;
      const goals = children(one(entry, 'goals'), 'goal').filter(child => !child.children.length).map(child => child.text.trim());
      if (new Set(goals).size !== goals.length) throw fail('Resolve duplicate Maven goals in the selected execution.');
      for (const goal of goals) {
        if (!identifier.test(goal)) continue;
        const task = [group, artifact, version, goal + '@' + id].join(':');
        if (!mavenExecutionArgument(task)) continue;
        if (options.length >= maxChoices) throw fail('The selected Maven module has too many declared execution goals.');
        options.push({
          id: hash(profile ? [file.uri, file.digest, profile.name, task] : [file.uri, file.digest, task]),
          executionId: id, group, artifact, version, goal, task,
          ...(profile && { profile }),
          declaration: { uri: file.uri, range: rangeAt(file.text, entry.start, entry.end) }
        });
      }
    }
  }
  return options;
}

function declaredExecutions(file) {
  const tree = pomTree(file);
  return pluginExecutions(file, tree, tree);
}

function observedExecutionKeys(tree, owner, managedOnly = false) {
  const { children, one, text } = descriptorAccess(tree);
  const build = one(owner, 'build');
  const containers = [one(one(build, 'pluginManagement'), 'plugins')];
  if (!managedOnly) containers.push(one(build, 'plugins'));
  const keys = new Set();
  for (const container of containers) {
    for (const plugin of children(container, 'plugin')) {
      const group = one(plugin, 'groupId') ? text(plugin, 'groupId') : defaultGroup;
      const artifact = text(plugin, 'artifactId');
      for (const entry of children(one(plugin, 'executions'), 'execution')) {
        const id = one(entry, 'id') ? text(entry, 'id') : 'default';
        if (![group, artifact, id].every(value => identifier.test(value))) {
          throw fail('Resolve computed Maven execution identities before selecting a profile.');
        }
        keys.add([group, artifact, id].join(':'));
      }
    }
  }
  return keys;
}

function literalProfilePom(file) {
  const tree = pomTree(file);
  if (/\bxml:space\s*=/u.test(file.text)) throw fail('Use conventional Maven whitespace rules for reviewed profiles.');
  const pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (node.namespace !== tree.namespace) throw fail('Use one conventional XML namespace throughout the reviewed Maven reactor.');
    for (const child of node.children) pending.push(child);
  }
  return tree;
}

function namedProfileExecutions(file, ancestors, peers = []) {
  const tree = literalProfilePom(file);
  for (const peer of peers) literalProfilePom(peer);
  const { children, one, text } = descriptorAccess(tree);
  const profiles = children(one(tree, 'profiles'), 'profile');
  const names = profiles.map(profile => text(profile, 'id'));
  if (names.length > 24 || names.some(name => !identifier.test(name)) || new Set(names).size !== names.length) {
    throw fail('Use at most 24 uniquely and literally named profiles in this Maven module.');
  }
  if (profiles.some(profile => one(profile, 'modules'))) {
    throw fail('Maven profiles that change reactor membership require separate execution.');
  }

  const outside = observedExecutionKeys(tree, tree);
  for (const ancestor of ancestors) {
    const parent = literalProfilePom(ancestor);
    for (const key of observedExecutionKeys(parent, parent)) outside.add(key);
  }
  const result = [];
  profiles.forEach((profile, index) => {
    if (one(profile, 'activation')) return;
    const name = names[index];
    const managed = observedExecutionKeys(tree, profile, true);
    const evidence = { name, inactive: names.filter(other => other !== name),
      declaration: { uri: file.uri, range: rangeAt(file.text, profile.start, profile.end) } };
    for (const execution of pluginExecutions(file, tree, profile, evidence)) {
      const key = [execution.group, execution.artifact, execution.executionId].join(':');
      if (outside.has(key) || managed.has(key)) {
        throw fail('An execution with this ID also appears outside the selected Maven profile.');
      }
      if (result.length >= maxChoices) throw fail('The selected Maven module has too many declared execution goals.');
      result.push(execution);
    }
  });
  return result;
}

function conventionalMavenConfig(file, root) {
  if (!file || /<!\s*(?:DOCTYPE|ENTITY)/iu.test(file.text)) throw fail('Use physical profile-free Maven distribution configuration.');
  const parser = new SaxesParser({ xmlns: true });
  let depth = 0, valid = true;
  parser.on('opentag', tag => {
    ++depth;
    if (depth === 1) {
      valid &&= tag.local === root && (!tag.uri || tag.uri.startsWith('http://maven.apache.org/' + root.toUpperCase() + '/'));
    } else if (depth > 32 || root === 'toolchains' || ['profile', 'activeProfile', 'localRepository'].includes(tag.local)) {
      valid = false;
    }
  });
  parser.on('closetag', () => { --depth; });
  try { parser.write(file.text).close(); }
  catch { valid = false; }
  if (!valid) throw fail('Use profile-free Maven settings and an empty toolchains catalog for this reviewed execution.');
}

function bindMavenProfileRuntime(home, execution, read, repository = path.resolve(homedir(), '.m2', 'repository')) {
  const settings = path.join(home, 'conf', 'settings.xml');
  const toolchains = path.join(home, 'conf', 'toolchains.xml');
  conventionalMavenConfig(read(settings), 'settings');
  conventionalMavenConfig(read(toolchains), 'toolchains');
  const extensions = path.join(home, 'lib', 'ext');
  const extStat = fs.lstatSync(extensions, { throwIfNoEntry: false });
  if (extStat && (!extStat.isDirectory() || extStat.isSymbolicLink() || path.relative(extensions, fs.realpathSync(extensions)) ||
      fs.readdirSync(extensions).some(name => name.toLowerCase().endsWith('.jar')))) {
    throw fail('Maven installation extensions require separate execution.');
  }
  const group = execution.group.split('.');
  if (group.some(part => !identifier.test(part))) throw fail('Use a conventional Maven plugin group for profile execution.');
  const baseName = execution.artifact + '-' + execution.version;
  const plugin = path.join(repository, ...group, execution.artifact, execution.version, baseName);
  const pom = read(plugin + '.pom');
  const jar = read(plugin + '.jar', 64 * 1024 * 1024, true);
  if (!pom || !jar) throw fail('Cache the exact released Maven plugin in the conventional local repository before review.');
  const profile = execution.profile;
  return {
    args: ['--activate-profiles=' + [profile.name, ...profile.inactive.map(name => '!' + name)].join(','),
      '--settings', settings, '--global-settings', settings, '--toolchains', toolchains, '--global-toolchains', toolchains,
      '-Dmaven.repo.local=' + repository],
    artifacts: { pomSha256: pom.digest, jarSha256: jar.digest }
  };
}

function reactorParent(file) {
  const document = pomTree(file);
  const { one, text } = descriptorAccess(document);
  const parent = one(document, 'parent');
  if (!parent) return;
  return {
    relative: one(parent, 'relativePath') ? text(parent, 'relativePath') : '../pom.xml',
    group: text(parent, 'groupId'), artifact: text(parent, 'artifactId'), version: text(parent, 'version')
  };
}

module.exports = { mavenExecutionArgument, declaredExecutions, namedProfileExecutions, bindMavenProfileRuntime, reactorParent };
