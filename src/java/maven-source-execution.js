'use strict';

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

function declaredExecutions(file) {
  const tree = pomTree(file);
  const { children, one, text } = descriptorAccess(tree);
  const plugins = children(one(one(tree, 'build'), 'plugins'), 'plugin');
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
          id: hash([file.uri, file.digest, task]), executionId: id, group, artifact, version, goal, task,
          declaration: { uri: file.uri, range: rangeAt(file.text, entry.start, entry.end) }
        });
      }
    }
  }
  return options;
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

module.exports = { mavenExecutionArgument, declaredExecutions, reactorParent };
