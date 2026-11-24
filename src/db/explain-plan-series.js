'use strict';

const { createHash } = require('node:crypto');
const { comparablePlans, planPaths } = require('./explain-plan');
const { summarizeDecimalSamples } = require('./result-analysis');

const MIN_SAMPLES = 2;
const MAX_SAMPLES = 5;

function sampleCount(count) {
  if (!Number.isInteger(count) || count < MIN_SAMPLES || count > MAX_SAMPLES) {
    throw Error('Choose 2 to 5 executions per measurement series.');
  }
  return count;
}

function summarizeSeries(plans) {
  sampleCount(plans.length);
  const first = plans[0], nodes = new Map(), shapes = new Map(), warnings = new Set();
  if (plans.some(plan => !plan.measured || !comparablePlans(first, plan))) {
    throw Error('The measurement series returned an inconsistent server or plan format.');
  }
  for (const [index, plan] of plans.entries()) {
    const paths = planPaths(plan);
    const shape = createHash('sha256').update(JSON.stringify([...paths].map(([key, node]) => [
      key, node.tags.filter(tag => tag.label !== 'Execution'), node.expressions
    ]))).digest('hex');
    if (!shapes.has(shape)) shapes.set(shape, { label: shapes.size + 1, samples: [], decodedNodes: paths.size });
    shapes.get(shape).samples.push(index + 1);
    for (const warning of plan.warnings) warnings.add(warning);
    for (const [path, node] of paths) {
      if (!nodes.has(path)) {
        nodes.set(path, { path, name: node.name, depth: node.depth, observedSamples: 0, measures: new Map() });
      }
      const item = nodes.get(path);
      item.observedSamples++;
      for (const metric of node.actual || []) {
        if (!item.measures.has(metric.key)) item.measures.set(metric.key, { label: metric.label, values: [] });
        item.measures.get(metric.key).values.push(metric.value);
      }
    }
  }
  const metrics = [...nodes.values()].flatMap(node => [...node.measures].map(([key, measure]) => ({
    path: node.path, name: node.name, depth: node.depth, observedSamples: node.observedSamples, key, label: measure.label,
    ...summarizeDecimalSamples(measure.values)
  })));
  if (!metrics.some(metric => metric.count > 0)) throw Error('The server returned no decodable observed metrics for these plans.');
  return { engine:first.engine, version:first.version, database:first.database, format:first.format, measured:true,
    totalSamples:plans.length, metrics, shapes:[...shapes.values()], warnings:[...warnings] };
}

function compareSeries(baseline, candidate) {
  if (!comparablePlans(baseline, candidate)) throw Error('Choose two series from the same server and plan format.');
  const index = series => new Map(series.metrics.map(row => [JSON.stringify([row.path, row.key]), row]));
  const before = index(baseline), after = index(candidate);
  const metrics = [...new Set([...before.keys(), ...after.keys()])].map(key => ({
    baseline: before.get(key) || null, candidate: after.get(key) || null
  }));
  return { baseline:{ samples:baseline.totalSamples, shapes:baseline.shapes.length, warnings:baseline.warnings },
    candidate:{ samples:candidate.totalSamples, shapes:candidate.shapes.length, warnings:candidate.warnings },
    engine: baseline.engine, version: baseline.version, database: baseline.database, metrics };
}

module.exports = { sampleCount, MAX_SAMPLES, summarizeSeries, compareSeries };
