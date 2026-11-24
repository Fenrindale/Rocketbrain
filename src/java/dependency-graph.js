'use strict';

const path = require('node:path');
const { lexJava, rangeAt } = require('../spring/java');

const MAX_WITNESSES = 12;

function dotted(tokens, { wildcard = false } = {}) {
  if (!tokens.length || tokens.length % 2 === 0) return null;
  if (!tokens.every((token, index) => index % 2 ? token.text === '.' :
    token.kind === 'id' || wildcard && index === tokens.length - 1 && token.text === '*')) return null;
  return tokens.map(token => token.text).join('');
}

function javaFacts(file) {
  const { tokens, issues } = lexJava(file.text);
  const name = path.basename(file.path ?? file.file ?? file.uri).toLowerCase();
  const result = { ...file, packageName: '', imports: [], types: [], issues, module: null };
  if (issues.length) return result;
  if (name === 'module-info.java') {
    const idx = tokens.findIndex(token => token.kind === 'id' && token.text === 'module');
    const open = tokens.findIndex((token, index) => index > idx && token.text === '{');
    const moduleName = idx >= 0 && open > idx ? dotted(tokens.slice(idx + 1, open)) : null;
    if (!moduleName || tokens.at(-1)?.text !== '}') {
      result.issues = ['Unable to read the named Java module declaration.'];
      return result;
    }
    const requires = [];
    let start = open + 1;
    for (let i = start; i < tokens.length; i++) {
      if (tokens[i].text !== ';') continue;
      const chunk = tokens.slice(start, i);
      if (chunk[0]?.text === 'requires') {
        let offset = 1;
        const modifiers = [];
        while (['static', 'transitive'].includes(chunk[offset]?.text) &&
               chunk[offset + 1] && chunk[offset + 1].text !== '.') {
          modifiers.push(chunk[offset++].text);
        }
        const target = dotted(chunk.slice(offset));
        if (!target || modifiers.length !== new Set(modifiers).size) {
          result.issues.push('Unable to read a Java requires directive.');
        } else {
          requires.push({ target, modifiers, range: rangeAt(file.text, chunk[0].start, tokens[i].end) });
        }
      }
      start = i + 1;
    }
    result.module = {
      name: moduleName, range: rangeAt(file.text, tokens[idx].start, tokens[open].start), requires
    };
    return result;
  }
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === '{') depth++;
    if (token.text === '}') depth--;
    if (depth !== 0 || token.kind !== 'id') continue;
    if (token.text === 'package' || token.text === 'import') {
      const end = tokens.findIndex((entry, index) => index > i && entry.text === ';');
      const isImport = token.text === 'import';
      const isStatic = isImport && tokens[i + 1]?.text === 'static';
      const target = end > i ? dotted(tokens.slice(i + (isStatic ? 2 : 1), end), { wildcard: isImport }) : null;
      if (!target) {
        result.issues.push('An import or package declaration could not be read.');
        continue;
      }
      if (isImport) result.imports.push({ target, static: isStatic, range: rangeAt(file.text, token.start, tokens[end].end) });
      else result.packageName = target;
      i = end;
    }
    if (['class', 'interface', 'enum', 'record'].includes(token.text) &&
        tokens[i + 1]?.kind === 'id' && tokens[i - 1]?.text !== '.') {
      const type = tokens[i + 1];
      const fqn = [result.packageName, type.text].filter(Boolean).join('.');
      result.types.push({ name: fqn, range: rangeAt(file.text, type.start, type.end) });
    }
  }
  return result;
}

function groupBy(values, keyOf) {
  const groups = new Map();
  for (const value of values) {
    const key = keyOf(value);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(value);
  }
  return groups;
}

function single(values = []) {
  return values.length === 1 ? values[0] : null;
}

function uniqueFolded(values, keyOf) {
  return [...new Map(values.map(value => [keyOf(value), value])).values()];
}

function evidenceOrder(left, right) {
  return (left.uri || '').localeCompare(right.uri || '') ||
    (left.range?.start?.line ?? -1) - (right.range?.start?.line ?? -1) ||
    (left.range?.start?.character ?? -1) - (right.range?.start?.character ?? -1) ||
    left.kind.localeCompare(right.kind);
}

function buildLayer(name, nodes, rawEdges) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const joined = new Map();
  for (const edge of rawEdges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) throw Error('Dependency edge points outside the reported layer.');
    const key = JSON.stringify([edge.from, edge.to]);
    if (!joined.has(key)) joined.set(key, { from: edge.from, to: edge.to, references: 0, evidence: [] });
    const item = joined.get(key);
    item.references++;
    if (item.evidence.length < MAX_WITNESSES) item.evidence.push(edge.evidence);
  }
  const edges = [...joined.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  for (const item of edges) item.evidence.sort(evidenceOrder);
  const components = findCycles([...byId.keys()], edges);
  return { name, nodes: [...byId.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id)), edges, cycles: components };
}

// Tarjan's strongly connected components retain membership while a single
// breadth-first witness gives a concrete sequence of source links to open.
function findCycles(nodeIds, edges) {
  const adjacency = groupBy(edges, edge => edge.from);
  const stack = [], active = new Set(), marks = new Map(), cycles = [];
  let index = 0;
  function visit(node) {
    const mark = { index, low: index++ };
    marks.set(node, mark);
    stack.push(node);
    active.add(node);
    for (const edge of adjacency.get(node) || []) {
      if (!marks.has(edge.to)) {
        visit(edge.to);
        mark.low = Math.min(mark.low, marks.get(edge.to).low);
      } else if (active.has(edge.to)) {
        mark.low = Math.min(mark.low, marks.get(edge.to).index);
      }
    }
    if (mark.low !== mark.index) return;
    const members = [];
    let entry;
    do {
      entry = stack.pop();
      active.delete(entry);
      members.push(entry);
    } while (entry !== node);
    if (members.length > 1 || (adjacency.get(node) || []).some(edge => edge.to === node)) {
      const ordered = members.sort();
      cycles.push({ members: ordered, witness: cycleWitness(ordered, adjacency) });
    }
  }
  for (const id of [...nodeIds].sort()) if (!marks.has(id)) visit(id);
  return cycles.sort((a, b) => a.members[0].localeCompare(b.members[0]));
}

function cycleWitness(members, adjacency) {
  const allowed = new Set(members), root = members[0], previous = new Map([[root, null]]), queue = [root];
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    for (const edge of adjacency.get(current) || []) {
      if (!allowed.has(edge.to)) continue;
      if (edge.to === root && (current !== root || members.length === 1)) {
        const result = [edge];
        for (let step = previous.get(current); step; step = previous.get(step.from)) result.push(step);
        return result.reverse().map(edge => ({ from: edge.from, to: edge.to, evidence: edge.evidence[0] }));
      }
      if (!previous.has(edge.to)) {
        previous.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
  }
  return [];
}

function packageKey(unit) {
  return JSON.stringify([unit.projectId, unit.sourceSet, unit.packageName]);
}

function packageNode(unit) {
  return {
    id: packageKey(unit), label: unit.packageName || '(default package)',
    project: unit.projectLabel, sourceSet: unit.sourceSet,
    uri: unit.uri
  };
}

function knownType(index, name, pool, { trim = '.' } = {}) {
  for (let value = name; value; value = value.includes(trim) ? value.slice(0, value.lastIndexOf(trim)) : '') {
    const exact = (index.get(value) || []).filter(entry => pool(entry.unit));
    if (exact.length) return single(exact);
  }
  return null;
}

function parseJdeps(output) {
  const pairs = [];
  // jdeps emits archive summary lines at column zero, then class references
  // under the corresponding archive. The source/target types are stable tokens.
  const pattern = /^\s+([\p{L}\p{N}._$]+)\s+->\s+([\p{L}\p{N}._$]+)\s+(.+?)\s*$/u;
  for (const line of output.split(/\r?\n/)) {
    const match = pattern.exec(line);
    if (match) pairs.push({ from: match[1], to: match[2], container: match[3] });
  }
  return pairs;
}

function analyzeDependencyGraph({ files, projects = [], buildEdges = [], bytecode = [], issues = [] }) {
  issues = [...issues];
  const units = files.map(javaFacts);
  const sources = units.filter(unit => !unit.module && !unit.issues.length);
  const packages = uniqueFolded(sources.map(packageNode), node => node.id);
  const byName = groupBy(sources, unit => unit.packageName);
  const types = groupBy(sources.flatMap(unit => unit.types.map(type => ({ ...type, unit }))), type => type.name);
  const named = units.filter(unit => unit.module);
  const modules = groupBy(named, unit => unit.module.name);
  const moduleKey = unit => JSON.stringify([unit.projectId, unit.module.name]);
  const jpmNodes = named.map(unit => ({ id: moduleKey(unit), label: unit.module.name, uri: unit.uri, range: unit.module.range }));
  const moduleEdges = [];
  const declaredProjects = groupBy(buildEdges, edge => edge.from);
  const declaredModules = groupBy(named, unit => unit.projectId);
  const declaredImports = [], observedReferences = [];
  let ambiguousImports = 0, unavailableCompiledReferences = 0;
  for (const unit of named) {
    for (const requirement of unit.module.requires) {
      const local = single(modules.get(requirement.target));
      if (!local && modules.has(requirement.target)) {
        issues.push({ uri: unit.uri, message: 'Multiple source descriptors declare ' + requirement.target + '.' });
        continue;
      }
      const target = local ? moduleKey(local) : JSON.stringify(['external', requirement.target]);
      if (!local) jpmNodes.push({ id: target, label: requirement.target, external: true });
      moduleEdges.push({ from: moduleKey(unit), to: target, evidence: {
        kind: ['requires', ...requirement.modifiers].join(' '), uri: unit.uri, range: requirement.range,
        symbol: requirement.target
      } });
    }
  }
  for (const unit of sources) {
    const visible = new Set([unit.projectId]);
    for (const edge of declaredProjects.get(unit.projectId) || []) {
      const scope = edge.evidence.kind.split(' ')[1];
      if (['compile', 'provided', 'api', 'implementation', 'compileOnly', 'compileOnlyApi'].includes(scope) ||
          unit.sourceSet === 'test' && ['test', 'testImplementation', 'testCompileOnly'].includes(scope)) {
        visible.add(edge.to);
      }
    }
    for (const module of declaredModules.get(unit.projectId) || []) {
      const context = named.filter(other => other.sourceSet === module.sourceSet);
      if (module.sourceSet !== unit.sourceSet && module.sourceSet !== 'main') continue;
      for (const declared of module.module.requires) {
        const required = single(context.filter(other => other.module.name === declared.target));
        if (required) visible.add(required.projectId);
      }
    }
    const pool = target => visible.has(target.projectId) &&
      (target.sourceSet === 'main' || target.projectId === unit.projectId && target.sourceSet === unit.sourceSet);
    for (const value of unit.imports) {
      const importName = value.target.replace(/\.\*$/, '');
      let target;
      if (!value.static && importName !== value.target) {
        const options = uniqueFolded((byName.get(importName) || []).filter(pool), packageKey);
        target = single(options);
      }
      target ??= knownType(types, importName, pool)?.unit;
      if (!target) {
        ambiguousImports++;
        continue;
      }
      if (packageKey(unit) === packageKey(target)) continue;
      declaredImports.push({ from: packageKey(unit), to: packageKey(target), evidence: {
        kind: value.static ? 'static import' : 'import', uri: unit.uri, range: value.range, symbol: value.target
      } });
    }
  }
  for (const entry of bytecode) {
    const origin = knownType(types, entry.from, unit => unit.projectId === entry.projectId &&
      (!entry.sourceSet || unit.sourceSet === entry.sourceSet), { trim: '$' });
    const target = knownType(types, entry.to, () => true, { trim: '$' });
    if (!origin || !target || /^not found$/i.test(entry.container)) {
      unavailableCompiledReferences++;
      continue;
    }
    const from = packageKey(origin.unit), to = packageKey(target.unit);
    if (from !== to) observedReferences.push({ from, to, evidence: {
      kind: 'compiled class reference', uri: origin.unit.uri, range: origin.range, symbol: entry.from + ' → ' + entry.to
    } });
  }
  const observedPackages = new Set(observedReferences.flatMap(edge => [edge.from, edge.to]));
  const projectLayer = (kind, label) => {
    const nodes = projects.filter(project => project.buildTools?.includes(kind)).map(({ id, label, uri, range }) => ({ id, label, uri, range }));
    const idSet = new Set(nodes.map(node => node.id));
    return buildLayer(label, nodes, buildEdges.filter(edge => edge.evidence.kind.startsWith(kind + ' ') &&
      idSet.has(edge.from) && idSet.has(edge.to)));
  };
  return {
    sourceFiles: files.length,
    issues: [...issues, ...units.flatMap(unit => unit.issues.map(message => ({ uri: unit.uri, message })))],
    ambiguousImports, unavailableCompiledReferences, compiledReferences: bytecode.length,
    layers: [
      projectLayer('Maven', 'Maven reactor modules'),
      projectLayer('Gradle', 'Gradle project modules'),
      buildLayer('JPMS requires', uniqueFolded(jpmNodes, node => node.id), moduleEdges),
      buildLayer('Declared package imports', packages, declaredImports),
      buildLayer('Compiled package references', packages.filter(node => observedPackages.has(node.id)), observedReferences)
    ]
  };
}

module.exports = { analyzeDependencyGraph, javaFacts, parseJdeps, buildLayer };
