'use strict';

const factory = /^factory-[1-9][0-9]{0,15}$/u;
const name = /^[A-Za-z0-9_.$: -]{1,128}$/u;
const part = '[A-Za-z_$][A-Za-z0-9_$]{0,127}';
const javaType = new RegExp('^' + part + '(?:\\.' + part + '){0,31}$', 'u');
const property = new RegExp('^' + part + '(?:\\.' + part + '){0,5}$', 'u');

function factoryId(value) {
  if (typeof value !== 'string' || !factory.test(value)) throw Error('Select an explicit observed JPA factory.');
  return value;
}

function graphName(value) {
  return typeof value === 'string' && value.trim() && name.test(value);
}

function graphDefinition(raw, named) {
  if (!raw || ((named || raw.name !== null) && !graphName(raw.name)) ||
      typeof raw.rootJavaType !== 'string' || raw.rootJavaType.length > 256 || !javaType.test(raw.rootJavaType) ||
      typeof raw.complete !== 'boolean' || !Array.isArray(raw.paths) || raw.paths.length > 64 ||
      raw.paths.some(path => typeof path !== 'string' || path.length > 256 || !property.test(path)) ||
      new Set(raw.paths).size !== raw.paths.length) return undefined;
  return { name: raw.name, rootJavaType: raw.rootJavaType, paths: [...raw.paths].sort(), complete: raw.complete };
}

function graphRegistry(raw, selectedId) {
  if (!raw || raw.factoryId !== selectedId || !['observed','partial','unknown'].includes(raw.state) ||
      raw.observerExecutedSql !== false || raw.valuesRetained !== false || raw.applicationCallbacksInvoked !== false ||
      !Array.isArray(raw.graphs) || raw.graphs.length > 24) throw Error('Invalid JPA entity graph registry metadata.');
  const result = { factoryId: selectedId, state: raw.state, graphs: [], observerExecutedSql: false,
    valuesRetained: false, applicationCallbacksInvoked: false };
  if (raw.state === 'unknown') {
    if (!['factory_unavailable','graph_registry_unavailable','graph_registry_limit'].includes(raw.reason) || raw.graphs.length) {
      throw Error('Invalid JPA entity graph registry state.');
    }
    return { ...result, reason: raw.reason };
  }
  const graphs = raw.graphs.map(value => graphDefinition(value, true));
  if (raw.basis !== 'jakarta-named-entity-graphs' || graphs.some(graph => !graph) ||
      new Set(graphs.map(graph => graph.name)).size !== graphs.length ||
      (raw.state === 'observed' && graphs.some(graph => !graph.complete))) throw Error('Invalid JPA registered graph definition.');
  return { ...result, basis: raw.basis, graphs, activity: graphActivity(raw.activity, selectedId) };
}

const phases = new Set(['request','callable-worker','async-dispatch','unattributed-dispatch']);

function graphActivity(raw, factoryId) {
  if (!raw || !['observed','disabled','awaiting-supported-hooks'].includes(raw.state) ||
      !Array.isArray(raw.applications) || raw.applications.length > 480 ||
      (raw.state !== 'observed' && raw.applications.length)) throw Error('Invalid JPA graph activity.');
  const applications = raw.applications.map(value => {
    const applied = appliedGraph(value?.applied);
    if (!applied || applied.factoryId !== factoryId || !Number.isSafeInteger(value.requestId) || value.requestId < 1 ||
        !Number.isInteger(value.select) || value.select < 1 || value.select > 40 || !phases.has(value.phase) ||
        typeof value.completeRequest !== 'boolean' ||
        (value.route !== undefined && (typeof value.route !== 'string' || !/^\/[A-Za-z0-9/_{}*.:\-]{0,159}$/u.test(value.route)))) {
      throw Error('Invalid scoped JPA graph application.');
    }
    return { applied, requestId: value.requestId, select: value.select, phase: value.phase,
      completeRequest: value.completeRequest, ...(value.route && { route: value.route }) };
  });
  if (new Set(applications.map(value => value.requestId + ':' + value.select)).size !== applications.length) throw Error('Duplicate JPA graph application.');
  return { state: raw.state, applications };
}

function appliedGraph(raw) {
  if (!raw || typeof raw.factoryId !== 'string' || !factory.test(raw.factoryId) ||
      !['FETCH','LOAD'].includes(raw.semantic)) return undefined;
  const graph = graphDefinition(raw.graph, false);
  return graph && { factoryId: raw.factoryId, semantic: raw.semantic, graph };
}

function registeredGraphApplications(registry, graph) {
  if (!graph.complete || !registry.activity) return [];
  return registry.activity.applications.flatMap(({ applied, ...evidence }) => {
    const actual = applied.graph;
    if (applied.factoryId !== registry.factoryId || !actual.complete || graph.name !== actual.name ||
        graph.rootJavaType !== actual.rootJavaType || graph.paths.length !== actual.paths.length ||
        graph.paths.some((path, index) => path !== actual.paths[index])) return [];
    return [{ ...evidence, semantic: applied.semantic }];
  });
}

module.exports = { factoryId, graphName, graphRegistry, appliedGraph, registeredGraphApplications };
