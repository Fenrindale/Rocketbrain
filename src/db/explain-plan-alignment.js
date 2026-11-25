'use strict';

const { createHash } = require('node:crypto');

const PLAN_TEXT_LIMIT = 2048;
const PATH_TEXT_LIMIT = 4096;
const RELATION = /^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?$/;
const TREE_ACCESS = /^((?:Covering )?[Ii]ndex (?:range scan|scan|lookup)|Single-row index lookup|Table scan) on (\S+)(?: using ([A-Za-z_][A-Za-z0-9_$]*)(?: (.+))?)?$/;

function operatorSignature(node) {
  const tags = node.tags.filter(tag => tag.label !== 'Execution');
  const fields = [...tags, ...node.expressions];
  // Values at the decoder's text cap may have lost their distinguishing suffix.
  if (node.name.length >= PLAN_TEXT_LIMIT || fields.some(field => field.value.length >= PLAN_TEXT_LIMIT)) return null;
  return JSON.stringify([node.kind, node.name, tags, node.expressions]);
}

function accessAnchor(node) {
  if (node.kind === 'table') {
    const value = label => node.tags.find(tag => tag.label === label)?.value;
    const table = value('Table or alias'), alias = value('Alias') || table, schema = value('Schema');
    const access = value('Access'), indexAccess = value('Index access');
    if (!RELATION.test(table || '') || !RELATION.test(alias || '') || schema && !RELATION.test(schema) || !access && !indexAccess) return null;
    const scope = JSON.stringify(['table', schema || '', table, alias]);
    return {
      scope, key:JSON.stringify([scope, access || '', indexAccess || '']),
      index:node.tags.filter(tag => tag.label === 'Index').map(tag => tag.value).join(', '),
      predicate:node.expressions.filter(item => /filter|condition/i.test(item.label))
        .map(item => item.value).join('\n')
    };
  }
  if (node.kind === 'iterator') {
    const parts = TREE_ACCESS.exec(node.name);
    if (!parts || !RELATION.test(parts[2]) || (parts[1] !== 'Table scan') !== Boolean(parts[3])) return null;
    const scope = JSON.stringify(['iterator', parts[2]]);
    return { scope, key:JSON.stringify([scope, parts[1]]), index:parts[3] || '', predicate:parts[4] || '' };
  }
  return null;
}

function indexOperators(plan) {
  const byId = new Map(), children = new Map(), slots = new Map(), operators = new Map();
  for (const node of plan.nodes) {
    const parent = byId.get(node.parentId);
    const slot = (slots.get(node.parentId) || 0) + 1;
    slots.set(node.parentId, slot);
    const parentPath = (parent?.path ?? '') + '/' + JSON.stringify([slot, node.kind, node.name]);
    // Deep saved plans must not expand their repeated ancestor text in every metric.
    const path = parentPath.length > PATH_TEXT_LIMIT ? '#' + createHash('sha256').update(parentPath).digest('hex') : parentPath;
    const address = parent ? parent.address + '.' + slot : String(slot);
    const entry = { path, address, signature:operatorSignature(node), anchor:accessAnchor(node), node };
    byId.set(node.id, entry);
    operators.set(path, entry);
    if (!children.has(node.parentId)) children.set(node.parentId, []);
    children.get(node.parentId).push(entry);
  }
  for (const entry of operators.values()) {
    const descendants = children.get(entry.node.id);
    const child = descendants?.length === 1 && descendants[0];
    if (entry.node.kind === 'iterator' && entry.node.name.startsWith('Filter: ') && child?.anchor) {
      entry.anchor = {
        scope:JSON.stringify(['filter', child.anchor.scope]),
        key:JSON.stringify(['filter', child.anchor.key]), relation:child.anchor.scope,
        index:'', predicate:entry.node.name.slice('Filter: '.length)
      };
      if (!child.signature) entry.anchorBlocked = true;
    }
  }
  return operators;
}

function uniqueOperators(operators, anchors = false) {
  const unique = new Map();
  for (const entry of operators.values()) {
    const keys = anchors ? entry.anchorScopes || [entry.anchor?.scope] : entry.signatures || [entry.signature];
    for (const key of keys) {
      if (!key) continue;
      // An unstable location can conflict with a stable location elsewhere in the series.
      const stable = anchors ? entry.signature && entry.anchor && !entry.anchorBlocked : Boolean(entry.signature);
      unique.set(key, stable && !unique.has(key) ? entry : null);
    }
  }
  return unique;
}

function accessChanges(before, after) {
  const changes = [];
  for (const [field, label] of [['index', 'Index'], ['predicate', 'Predicate']]) {
    if (before[field] !== after[field]) changes.push({ label, before:before[field], after:after[field] });
  }
  return changes;
}

function alignOperators(before, after) {
  const matches = new Map(), used = new Set();
  function match(left, right, alignment, changes = []) {
    matches.set(left.path, { before:left, after:right, alignment, changes });
    used.add(right.path);
  }
  for (const left of before.values()) {
    const right = after.get(left.path);
    if (right && left.signature && left.signature === right.signature) match(left, right, 'position');
  }
  const leftUnique = uniqueOperators(before), rightUnique = uniqueOperators(after);
  for (const [signature, left] of leftUnique) {
    const right = rightUnique.get(signature);
    if (!left || !right || left.address === right.address || matches.has(left.path) || used.has(right.path)) continue;
    match(left, right, 'moved');
  }
  const leftAnchors = uniqueOperators(before, true), rightAnchors = uniqueOperators(after, true);
  for (const [scope, left] of leftAnchors) {
    const right = rightAnchors.get(scope);
    if (!left || !right || left.anchor.key !== right.anchor.key || matches.has(left.path) || used.has(right.path)) continue;
    if (left.anchor.relation && (!leftAnchors.get(left.anchor.relation) || !rightAnchors.get(right.anchor.relation))) continue;
    const changes = accessChanges(left.anchor, right.anchor);
    if (changes.length) match(left, right, left.address === right.address ? 'position' : 'candidate-move', changes);
  }
  for (const left of before.values()) {
    const right = after.get(left.path);
    if (right && !matches.has(left.path) && !used.has(right.path)) match(left, right, 'position');
  }
  return [
    ...[...before.values()].map(entry => matches.get(entry.path) || { before:entry, alignment:'unmatched' }),
    ...[...after.values()].filter(entry => !used.has(entry.path)).map(entry => ({ after:entry, alignment:'unmatched' }))
  ];
}

module.exports = { PLAN_TEXT_LIMIT, indexOperators, alignOperators };
