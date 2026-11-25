'use strict';

const { createHash } = require('node:crypto');
const { comparablePlans } = require('./explain-plan');
const { indexOperators, alignOperators } = require('./explain-plan-alignment');
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
    const paths = indexOperators(plan);
    const shape = createHash('sha256').update(JSON.stringify([...paths].map(([key, { node }]) => [
      key, node.tags.filter(tag => tag.label !== 'Execution'), node.expressions
    ]))).digest('hex');
    if (!shapes.has(shape)) shapes.set(shape, { label: shapes.size + 1, samples: [], decodedNodes: paths.size });
    shapes.get(shape).samples.push(index + 1);
    for (const warning of plan.warnings) warnings.add(warning);
    for (const [path, { node, address, signature, anchor, anchorBlocked }] of paths) {
      if (!nodes.has(path)) {
        nodes.set(path, { path, address, signatures:new Set(), anchors:new Map(), anchorBlocked:false,
          name:node.name, depth:node.depth, observedSamples:0, measures:new Map() });
      }
      const item = nodes.get(path);
      item.signatures.add(signature);
      if (anchor) item.anchors.set(anchor.scope, anchor);
      if (!anchor || anchorBlocked) item.anchorBlocked = true;
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
  const operators = [...nodes.values()].map(item => {
    const signatures = [...item.signatures];
    const anchorScopes = [...item.anchors.keys()];
    const anchor = !item.anchorBlocked && anchorScopes.length === 1 && item.observedSamples === plans.length ?
      item.anchors.get(anchorScopes[0]) : null;
    return { path:item.path, address:item.address, name:item.name, signatures, signature:signatures.length === 1 ? signatures[0] : null,
      reviewEligible:item.observedSamples === plans.length,
      anchorScopes, anchor };
  });
  return { engine:first.engine, version:first.version, database:first.database, format:first.format, measured:true, operators,
    totalSamples:plans.length, metrics, shapes:[...shapes.values()], warnings:[...warnings] };
}

function compareSeries(baseline, candidate, decisions) {
  if (!comparablePlans(baseline, candidate)) throw Error('Choose two series from the same server and plan format.');
  function index(series) {
    const index = new Map(series.operators.map(row => [row.path, { ...row, metrics:new Map() }]));
    for (const metric of series.metrics) index.get(metric.path).metrics.set(metric.key, metric);
    return index;
  }
  const { rows:aligned, candidateReview } = alignOperators(index(baseline), index(candidate), decisions);
  const metrics = aligned.flatMap(({ before, after, alignment }) =>
    [...new Set([...(before?.metrics.keys() || []), ...(after?.metrics.keys() || [])])].map(key => ({
      baseline:before?.metrics.get(key) || null, candidate:after?.metrics.get(key) || null,
      alignment, baselinePosition:before?.address, candidatePosition:after?.address
    })));
  const changedAccess = aligned.filter(item => item.changes?.length).map(({ before, after, alignment, changes }) => ({
    baselineName:before.name, candidateName:after.name, baselinePosition:before.address, candidatePosition:after.address,
    alignment, changes
  }));
  return { baseline:{ samples:baseline.totalSamples, shapes:baseline.shapes.length, warnings:baseline.warnings },
    candidate:{ samples:candidate.totalSamples, shapes:candidate.shapes.length, warnings:candidate.warnings },
    engine: baseline.engine, version: baseline.version, database: baseline.database, metrics, changedAccess, candidateReview,
    movedCount:aligned.filter(item => item.alignment === 'moved').length,
    candidateMoveCount:aligned.filter(item => item.alignment === 'candidate-move').length,
    reviewedPairCount:aligned.filter(item => item.alignment === 'reviewed').length };
}

function serializeSamples(series, plans, capturedAt) {
  const { operators, ...summary } = series;
  const shapes = new Map(series.shapes.flatMap(shape => shape.samples.map(sample => [sample, shape.label])));
  return JSON.stringify({
    format:'RocketbrainSqlPlanSamples', version:1, capturedAt,
    summary,
    samples:plans.map((plan, index) => ({
      number:index + 1, shape:shapes.get(index + 1), format:plan.format, raw:plan.raw, warnings:plan.warnings
    }))
  }, null, 2) + '\n';
}

module.exports = { sampleCount, MAX_SAMPLES, summarizeSeries, compareSeries, serializeSamples };
