'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SaxesParser } = require('saxes');

const repoIdPattern = /^[A-Za-z0-9_][\w.-]{0,79}$/u;
const requiredShape = 'Use one literal, explicitly active Maven snapshot repository in the reviewed settings.';
const ordinaryOptions = 'Use a Maven reactor .mvn/maven.config with --offline and explicit repository, user settings and global settings.';
const fields = {
  settings: ['profiles', 'activeProfiles', 'offline', 'interactiveMode'],
  'settings/profiles': ['profile'],
  'settings/profiles/profile': ['id', 'repositories'],
  'settings/profiles/profile/repositories': ['repository'],
  'settings/profiles/profile/repositories/repository': ['id', 'url', 'releases', 'snapshots'],
  'settings/profiles/profile/repositories/repository/releases': ['enabled'],
  'settings/profiles/profile/repositories/repository/snapshots': ['enabled', 'updatePolicy', 'checksumPolicy'],
  'settings/activeProfiles': ['activeProfile']
};

function settingsTree(text) {
  if (/<!DOCTYPE|<!ENTITY|\$\{/u.test(text)) throw Error(requiredShape);
  const stack = [];
  let root;
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', tag => {
    const parent = stack.at(-1);
    const attributes = Object.keys(tag.attributes);
    if (parent ? attributes.length || !fields[parent.key]?.includes(tag.name) || parent.children.has(tag.name) :
        tag.name !== 'settings' || attributes.some(name => !['xmlns', 'xmlns:xsi', 'xsi:schemaLocation'].includes(name))) {
      throw Error(requiredShape);
    }
    const node = { key: parent ? parent.key + '/' + tag.name : tag.name, children: new Map(), text: '' };
    if (parent) parent.children.set(tag.name, node);
    else root = node;
    stack.push(node);
  });
  parser.on('text', text => { if (stack.length) stack.at(-1).text += text; });
  parser.on('cdata', () => { throw Error(requiredShape); });
  parser.on('closetag', () => {
    const node = stack.pop();
    node.text = node.text.trim();
    if (fields[node.key] && node.text || !fields[node.key] && !node.text) throw Error(requiredShape);
  });
  try { parser.write(text).close(); }
  catch { throw Error(requiredShape); }
  if (!root) throw Error(requiredShape);
  return root;
}

function snapshotRepositoryId(settings) {
  const get = (node, name) => node?.children.get(name);
  const text = (node, name) => get(node, name)?.text;
  const profile = get(get(settings, 'profiles'), 'profile');
  const id = text(profile, 'id');
  const enabled = text(get(settings, 'activeProfiles'), 'activeProfile');
  const repository = get(get(profile, 'repositories'), 'repository');
  const repositoryId = text(repository, 'id');
  const snapshots = get(repository, 'snapshots');
  const update = text(snapshots, 'updatePolicy');
  const checksum = text(snapshots, 'checksumPolicy');
  let url;
  try { url = new URL(text(repository, 'url')); } catch { /* Reject unresolved repository URLs. */ }
  if (!id || id !== enabled || !repoIdPattern.test(id) || !repoIdPattern.test(repositoryId ?? '') ||
      !url || url.username || url.password || url.hash || url.search ||
      url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) ||
      text(get(repository, 'releases'), 'enabled') !== 'false' || text(snapshots, 'enabled') !== 'true' ||
      update !== undefined && !['always', 'daily', 'never'].includes(update) ||
      checksum !== undefined && !['warn', 'fail'].includes(checksum) ||
      ['offline', 'interactiveMode'].some(key => text(settings, key) !== undefined && !/^(?:true|false)$/u.test(text(settings, key)))) {
    throw Error(requiredShape);
  }
  return repositoryId;
}

function modelSnapshotSettings({ reactor, read, hash }) {
  const directory = path.join(reactor, '.mvn'), config = path.join(directory, 'maven.config');
  const bytes = read(config, 16 * 1024);
  if (!bytes) throw Error(ordinaryOptions);
  const options = bytes.toString('utf8').split(/\r?\n/u).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const take = prefix => options.find(line => line.startsWith(prefix))?.slice(prefix.length);
  const values = [take('-Dmaven.repo.local='), take('--settings='), take('--global-settings=')];
  if (options.length !== 4 || !options.some(line => line === '--offline' || line === '-o') ||
      values.some(value => !value || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"']/u.test(value))) {
    throw Error(ordinaryOptions);
  }
  const [repository, settings, global] = values.map(value => path.resolve(value));
  if (process.platform === 'win32' && repository.startsWith('\\\\') || settings === global ||
      path.relative(directory, path.dirname(settings)) || path.relative(directory, path.dirname(global))) {
    throw Error('Choose a physical local repository and separate settings files directly inside the reactor .mvn folder.');
  }
  const location = fs.lstatSync(repository, { bigint: true });
  if (!location.isDirectory() || location.isSymbolicLink() || path.relative(repository, fs.realpathSync(repository))) {
    throw Error('Choose a physical local repository for Maven SNAPSHOT review.');
  }
  const userBytes = read(settings, 256 * 1024), globalBytes = read(global, 16 * 1024);
  if (!userBytes || !globalBytes || settingsTree(globalBytes.toString('utf8')).children.size) {
    throw Error('The explicit Maven global settings must be an empty settings document.');
  }
  const repositoryId = snapshotRepositoryId(settingsTree(userBytes.toString('utf8')));
  const files = [config, settings, global];
  const identity = hash(JSON.stringify([files, [bytes, userBytes, globalBytes].map(hash), repository,
    location.dev.toString(), location.ino.toString()]));
  return { repository, files, config, identity, repositoryId };
}

module.exports = { modelSnapshotSettings, repoIdPattern };
