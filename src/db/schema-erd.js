'use strict';

const { createHash } = require('node:crypto');

const maxNodes = 64;
const maxEdges = 256;
const maxColumns = 1400;
const maxPosition = 3650;
const maxLayoutBytes = 64 * 1024;
const maxLogical = 32;
const card = Object.freeze({ width: 224, height: 156, gap: 53, margin: 28, top: 64 });
const layoutFormat = 'RocketbrainSchemaDiagramLayout';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function label(value, limit = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/.test(value);
}

function tableInventory(catalog) {
  if (!label(catalog?.database) || !Array.isArray(catalog.tables) || !Array.isArray(catalog.views)) {
    throw new Error('Connect to MySQL or MariaDB and refresh its database catalog.');
  }
  return [...catalog.tables, ...catalog.views].filter(table => ['table', 'view'].includes(table.kind) &&
    label(table.name) && !/^__rb_/i.test(table.name)).sort((a, b) => compare(a.name, b.name));
}

function catalogIndex(catalog, inventory = tableInventory(catalog)) {
  const key = catalog.tableNameCaseSensitive === false ? value => value.toLowerCase() : value => value;
  const names = new Map();
  for (const table of inventory) {
    const identity = key(table.name);
    if (names.has(identity)) throw new Error('The catalog has ambiguous names. Refresh before opening the diagram.');
    names.set(identity, table);
  }
  return { names, key, resolve(name) { return label(name) ? names.get(key(name)) : undefined; } };
}

function observedEdges(catalog, inventory, index) {
  if (catalog.coverage?.foreignKeys !== 'loaded') return [];
  const edges = [];
  for (const child of inventory) {
    if (child.kind !== 'table') continue;
    for (const relation of child.foreignKeys || []) {
      const { name, referencedSchema, referencedTable, onDelete, onUpdate } = relation;
      if (![name, referencedSchema, referencedTable].every(value => label(value)) || !Array.isArray(relation.columns)) continue;
      const parent = index.key(referencedSchema) === index.key(catalog.database) ? index.resolve(referencedTable) : undefined;
      const ordered = [...relation.columns].sort((a, b) => a.ordinal - b.ordinal);
      if (!ordered.length || !ordered.every((pair, i) => pair.ordinal === i + 1 &&
        label(pair.name) && label(pair.referencedColumn))) continue;
      const pairs = ordered.map(pair => ({ child: pair.name, parent: pair.referencedColumn }));
      edges.push({ kind: 'physical', id: digest([child.name, name]), name, child: child.name,
        parent: parent?.name || referencedTable, parentSchema: parent ? catalog.database : referencedSchema,
        parentVisible: parent?.kind === 'table', pairs,
        onDelete: label(onDelete, 32) ? onDelete : null, onUpdate: label(onUpdate, 32) ? onUpdate : null });
    }
  }
  return edges;
}

function scopeKey(catalog, profile) {
  if (!profile || !label(profile.id) || !label(profile.host, 1024) || !Number.isInteger(profile.port) ||
      profile.port < 1 || profile.port > 65535 || profile.database !== catalog.database) return null;
  return digest(['profile-v1', profile.id, profile.host, profile.port, catalog.database]);
}

function logicalRelation(catalog, relation) {
  if (!exact(relation, ['id', 'name', 'child', 'parent', 'pairs']) || !label(relation.id) ||
      !label(relation.name, 80) || relation.name.trim() !== relation.name ||
      !Array.isArray(relation.pairs) || relation.pairs.length < 1 || relation.pairs.length > 8) {
    throw new Error('Choose a logical relationship name and 1–8 foreign and referenced columns.');
  }
  const index = catalogIndex(catalog);
  const child = index.resolve(relation.child), parent = index.resolve(relation.parent);
  if (child?.kind !== 'table' || parent?.kind !== 'table') throw new Error('Choose two visible tables in this database.');
  const childColumns = new Set(child.columns.map(column => column.name));
  const parentColumns = new Set(parent.columns.map(column => column.name));
  const pairs = relation.pairs.map(pair => {
    if (!exact(pair, ['child', 'parent']) || !childColumns.delete(pair.child) || !parentColumns.delete(pair.parent)) {
      throw new Error('Choose distinct visible columns for each side of the logical relationship.');
    }
    return { child: pair.child, parent: pair.parent };
  });
  return { id: relation.id, name: relation.name, child: child.name, parent: parent.name, pairs };
}

function sameMapping(a, b) {
  return a.child === b.child && a.parent === b.parent && a.pairs.length === b.pairs.length &&
    a.pairs.every(pair => b.pairs.some(other => pair.child === other.child && pair.parent === other.parent));
}

function logicalEdges(catalog, records) {
  if (!Array.isArray(records) || records.length > maxLogical) throw new Error('The logical relationships list has an unsupported shape.');
  const physical = buildDiagramEdges(catalog);
  const logical = [];
  for (const record of records) {
    let value;
    try { value = logicalRelation(catalog, record); }
    catch { continue; } // A saved relationship may refer to a removed table/column.
    if (logical.some(item => item.id === value.id || sameMapping(item, value)) ||
        physical.some(edge => edge.parentVisible && sameMapping(edge, value))) continue;
    logical.push({ ...value, parentSchema: catalog.database, parentVisible: true, kind: 'logical' });
  }
  return logical;
}

function buildDiagramEdges(catalog) {
  const inventory = tableInventory(catalog);
  return observedEdges(catalog, inventory, catalogIndex(catalog, inventory));
}

function layoutFingerprint(catalog, nodes) {
  return digest([catalog.database, nodes.map(node => [node.name, node.kind])]);
}

function buildDiagram(catalog, { focus, logical = [] } = {}) {
  const inventory = tableInventory(catalog);
  const index = catalogIndex(catalog, inventory);
  const selected = focus === undefined ? undefined : index.resolve(focus);
  if (focus !== undefined && !selected) throw new Error('The diagram focus is no longer visible. Refresh and select it again.');
  const allEdges = [...observedEdges(catalog, inventory, index), ...logical];
  const names = new Set(selected ? [selected.name] : inventory.map(node => node.name));
  if (selected) for (const edge of allEdges) {
    if (edge.parentVisible && edge.child === selected.name) names.add(edge.parent);
    if (edge.parentVisible && edge.parent === selected.name) names.add(edge.child);
  }
  const visible = inventory.filter(node => names.has(node.name));
  const edges = allEdges.filter(edge => names.has(edge.child) || edge.parentVisible && names.has(edge.parent))
    .map(edge => ({ ...edge, childInDiagram: names.has(edge.child), parentInDiagram: edge.parentVisible && names.has(edge.parent) }));
  if (visible.length > maxNodes || edges.length > maxEdges || visible.reduce((sum, node) => sum + (node.columns?.length || 0), 0) > maxColumns) {
    throw Object.assign(new Error('The diagram exceeds 64 entities, 1,400 columns or 256 relationships. Choose a table and its related entities.'), { code: 'ROCKETBRAIN_DIAGRAM_SIZE' });
  }
  const nodes = visible.map(node => ({ name: node.name, kind: node.kind,
    columns: (node.columns || []).filter(col => label(col.name)).map(col => ({
      name: col.name, type: String(col.type || '').slice(0, 256), primaryKey: col.primaryKey === true, nullable: col.nullable === true
    })) }));
  const identity = layoutFingerprint(catalog, nodes);
  return { database: catalog.database, identity, focus: selected?.name || null, nodes, edges,
    visibleObjects: inventory.length, foreignKeysLoaded: catalog.coverage?.foreignKeys === 'loaded',
    accountLimited: true, capturedAt: catalog.loadedAt || null };
}

function makeLayout(diagram, positions) {
  return { format: layoutFormat, version: 1, diagram: diagram.identity, positions };
}

function defaultLayout(diagram) {
  const adjacency = new Map(diagram.nodes.map(node => [node.name, new Set()]));
  for (const edge of diagram.edges) if (edge.childInDiagram && edge.parentInDiagram && edge.child !== edge.parent) {
    adjacency.get(edge.child).add(edge.parent);
    adjacency.get(edge.parent).add(edge.child);
  }
  const pending = [...adjacency.keys()].sort((a, b) => adjacency.get(b).size - adjacency.get(a).size || compare(a, b));
  if (diagram.focus) pending.unshift(diagram.focus);
  const seen = new Set(), order = [];
  for (const start of pending) {
    if (seen.has(start)) continue;
    const queue = [start]; seen.add(start);
    for (const name of queue) {
      order.push(name);
      for (const other of [...adjacency.get(name)].sort(compare)) if (!seen.has(other)) {
        queue.push(other); seen.add(other);
      }
    }
  }
  const columns = Math.max(1, Math.ceil(Math.sqrt(order.length * 1.25)));
  const placements = new Map(order.map((name, index) => [name, {
    name, x: card.margin + index % columns * (card.width + card.gap),
    y: card.top + Math.floor(index / columns) * (card.height + card.gap)
  }]));
  return makeLayout(diagram, diagram.nodes.map(node => placements.get(node.name)));
}

function exact(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function normalizeLayout(diagram, value) {
  if (!exact(value, ['format', 'version', 'diagram', 'positions']) || value.format !== layoutFormat ||
      value.version !== 1 || value.diagram !== diagram.identity || !Array.isArray(value.positions) ||
      value.positions.length !== diagram.nodes.length) {
    throw new Error('Choose a version 1 layout for the same visible diagram entities.');
  }
  const names = new Set(diagram.nodes.map(node => node.name)), map = new Map();
  for (const item of value.positions) {
    if (!exact(item, ['name', 'x', 'y']) || !names.has(item.name) || map.has(item.name) ||
        !Number.isInteger(item.x) || item.x < card.margin || item.x > maxPosition ||
        !Number.isInteger(item.y) || item.y < card.top || item.y > maxPosition) {
      throw new Error('The layout has an invalid entity position.');
    }
    map.set(item.name, { name: item.name, x: item.x, y: item.y });
  }
  return makeLayout(diagram, diagram.nodes.map(node => map.get(node.name)));
}

function parseLayout(diagram, body) {
  if (!body.length || body.length > maxLayoutBytes) throw new Error('Choose a diagram layout of at most 64 KiB.');
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { throw new Error('The diagram layout is not UTF-8 JSON.'); }
  return normalizeLayout(diagram, value);
}

const logicalKey = 'rocketbrain.schemaDiagram.logical.v1';

module.exports = { tableInventory, buildDiagram, defaultLayout, normalizeLayout, parseLayout, card, logicalKey,
  maxPosition, maxLayoutBytes, maxLogical, digest, exact, label, scopeKey, logicalRelation, logicalEdges };
