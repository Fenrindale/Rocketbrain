'use strict';

const { randomUUID } = require('node:crypto');
const { supportedPath, maxChanges } = require('./changelist-git');

const key = 'rocketbrain.vcs.changelists.v1';
const maxRepositories = 32;
const maxLists = 32;
const maxEditors = 32;

function validLabel(value, maximum = 80) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!validLabel(name)) throw Error('Enter a changelist name of at most 80 characters.');
  return name;
}

const point = value => value && Number.isInteger(value.line) && value.line >= 0 && Number.isInteger(value.character) && value.character >= 0;

function validateContext(context) {
  if (context === null) return true;
  if (!context || !Array.isArray(context.editors) || context.editors.length > maxEditors ||
      !context.editors.every(editor => editor && supportedPath(editor.path) && (!editor.selection ||
        /^[a-f0-9]{64}$/.test(editor.selection.hash) && point(editor.selection.anchor) && point(editor.selection.active)))) return false;
  if (new Set(context.editors.map(editor => editor.path)).size !== context.editors.length ||
      context.activePath !== null && !context.editors.some(editor => editor.path === context.activePath)) return false;
  return context.launch === null || validLabel(context.launch?.name, 200) && validLabel(context.launch.type, 100) &&
    ['launch', 'attach'].includes(context.launch.request);
}

function persisted(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.repositories) || raw.repositories.length > maxRepositories ||
      !raw.repositories.every(repo => /^[a-f0-9]{64}$/.test(repo?.id) && Array.isArray(repo.lists) && repo.lists.length <= maxLists &&
        repo.lists.every(list => typeof list?.id === 'string' && /^[a-f0-9-]{36}$/.test(list.id) && validLabel(list.name) &&
          Array.isArray(list.paths) && list.paths.length <= maxChanges && list.paths.every(supportedPath) && validateContext(list.context)))) {
    throw Error('Saved changelist data is unsupported or invalid.');
  }
  for (const repo of raw.repositories) {
    const members = repo.lists.flatMap(list => list.paths);
    if (members.length > maxChanges || new Set(members).size !== members.length ||
        new Set(repo.lists.map(list => list.id)).size !== repo.lists.length) throw Error('Saved changelist membership is inconsistent.');
  }
  return structuredClone(raw);
}

function createChangelistState(storage) {
  let queue = Promise.resolve();
  const read = () => persisted(storage.get(key, { version: 1, repositories: [] }));
  const repoOf = (state, repoId) => state.repositories.find(repo => repo.id === repoId);
  const listOf = (state, repoId, listId) => {
    const list = repoOf(state, repoId)?.lists.find(candidate => candidate.id === listId);
    if (!list) throw Error('Choose a saved changelist in the current repository.');
    return list;
  };

  function change(action) {
    const operation = queue.then(async () => {
      const state = read();
      const value = action(state);
      persisted(state);
      if (Buffer.byteLength(JSON.stringify(state)) > 2 * 1024 * 1024) throw Error('Saved changelists exceed the workspace data limit.');
      await storage.update(key, state);
      return structuredClone(value);
    });
    queue = operation.catch(() => {});
    return operation;
  }

  return {
    async lists(repoId) { await queue; return repoOf(read(), repoId)?.lists ?? []; },
    async list(repoId, id) { await queue; return listOf(read(), repoId, id); },
    create(repoId, name) {
      return change(state => {
        const checked = normalizeName(name);
        let repo = repoOf(state, repoId);
        if (!repo) {
          if (state.repositories.length === maxRepositories) throw Error('Remove unused changelists to add another repository.');
          repo = { id: repoId, lists: [] };
          state.repositories.push(repo);
        }
        if (repo.lists.length === maxLists) throw Error('This repository already has 32 changelists.');
        if (repo.lists.some(list => list.name.toLowerCase() === checked.toLowerCase())) throw Error('A changelist already uses that name.');
        const list = { id: randomUUID(), name: checked, paths: [], context: null };
        repo.lists.push(list);
        return list;
      });
    },
    assign(repoId, id, paths, changed, guard) {
      return change(state => {
        guard();
        const list = listOf(state, repoId, id), selected = new Set(paths);
        if (!selected.size || selected.size > maxChanges || [...selected].some(path => !supportedPath(path) || !changed.has(path))) {
          throw Error('Select files that are still changed in the current Git working tree.');
        }
        for (const other of repoOf(state, repoId).lists) other.paths = other.paths.filter(path => !selected.has(path));
        list.paths.push(...selected);
        return list;
      });
    },
    unassign(repoId, id, paths) {
      return change(state => {
        const list = listOf(state, repoId, id), selected = new Set(paths);
        if (!selected.size || [...selected].some(path => !list.paths.includes(path))) throw Error('Choose paths in this changelist.');
        list.paths = list.paths.filter(path => !selected.has(path));
        return list;
      });
    },
    rename(repoId, id, name) {
      return change(state => {
        const list = listOf(state, repoId, id), checked = normalizeName(name);
        if (repoOf(state, repoId).lists.some(other => other !== list && other.name.toLowerCase() === checked.toLowerCase())) {
          throw Error('A changelist already uses that name.');
        }
        list.name = checked;
        return list;
      });
    },
    remove(repoId, id) {
      return change(state => {
        listOf(state, repoId, id);
        const repo = repoOf(state, repoId);
        repo.lists = repo.lists.filter(list => list.id !== id);
        if (!repo.lists.length) state.repositories = state.repositories.filter(candidate => candidate !== repo);
        return { removed: true, id };
      });
    },
    capture(repoId, id, context) {
      return change(state => {
        const list = listOf(state, repoId, id);
        if (!validateContext(context)) throw Error('The editor context exceeds its supported bounds.');
        list.context = structuredClone(context);
        return list;
      });
    }
  };
}

module.exports = { createChangelistState, validLabel, maxEditors };
