'use strict';

const PLAN_TEXT_LIMIT = 2048;

function operatorSignature(node) {
  const tags = node.tags.filter(tag => tag.label !== 'Execution');
  const fields = [...tags, ...node.expressions];
  // Values at the decoder's text cap may have lost their distinguishing suffix.
  if (node.name.length >= PLAN_TEXT_LIMIT || fields.some(field => field.value.length >= PLAN_TEXT_LIMIT)) return null;
  return JSON.stringify([node.kind, node.name, tags, node.expressions]);
}

function indexOperators(plan) {
  const byId = new Map(), slots = new Map(), operators = new Map();
  for (const node of plan.nodes) {
    const parent = byId.get(node.parentId);
    const slot = (slots.get(node.parentId) || 0) + 1;
    slots.set(node.parentId, slot);
    const path = (parent?.path ?? '') + '/' + JSON.stringify([slot, node.kind, node.name]);
    const address = parent ? parent.address + '.' + slot : String(slot);
    const entry = { path, address, signature:operatorSignature(node), node };
    byId.set(node.id, entry);
    operators.set(path, entry);
  }
  return operators;
}

function uniqueSignatures(operators) {
  const unique = new Map();
  for (const entry of operators.values()) {
    for (const signature of entry.signatures || [entry.signature]) {
      if (!signature) continue;
      // An unstable location can conflict with a stable location elsewhere in the series.
      const stable = !entry.signatures || entry.signatures.length === 1;
      unique.set(signature, stable && !unique.has(signature) ? entry : null);
    }
  }
  return unique;
}

function alignOperators(before, after) {
  const matches = new Map(), used = new Set();
  function match(left, right, alignment) {
    matches.set(left.path, { before:left, after:right, alignment });
    used.add(right.path);
  }
  for (const left of before.values()) {
    const right = after.get(left.path);
    if (right && left.signature && left.signature === right.signature) match(left, right, 'position');
  }
  const leftUnique = uniqueSignatures(before), rightUnique = uniqueSignatures(after);
  for (const [signature, left] of leftUnique) {
    const right = rightUnique.get(signature);
    if (!left || !right || left.address === right.address || matches.has(left.path) || used.has(right.path)) continue;
    match(left, right, 'moved');
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
