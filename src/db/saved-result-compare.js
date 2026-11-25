'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { compareDatasets } = require('./dataset-comparison');
const { columnKind } = require('./result-export');

const maxKeyParts = 8;
const maxMapped = 64;
const scheme = 'rocketbrain-saved-result-diff';
const allowedKeys = new Set(['integer', 'decimal', 'text', 'temporal', 'binary-hex', 'bit']);
const unsupportedValues = new Set(['unknown', 'geometry-preview']);
const equivalent = (left, right) => left === right ||
  ['integer', 'decimal'].includes(left) && ['integer', 'decimal'].includes(right);

function columns(capture) {
  return capture.result.columns.map((name, index) => ({ name, index, kind: columnKind(capture.result.fields[index]) }));
}

function usingName(column, available, local) {
  if (local.filter(entry => entry.name === column.name).length !== 1) return undefined;
  const matches = available.filter(entry => entry.name === column.name);
  return matches.length === 1 ? matches[0] : undefined;
}

function compatibleValues(left, right) {
  return ![left, right].some(kind => unsupportedValues.has(kind)) &&
    (equivalent(left, right) || left === 'null' || right === 'null');
}

function sourceSummary(capture) {
  const { id, title, capturedAt, result } = capture;
  const coverage = result.captureCoverage ?? { kind: 'legacy-capture', truncated: result.truncated };
  const contentSha256 = createHash('sha256').update(JSON.stringify({
    columns: result.columns, fields: result.fields, coverage,
    rows: result.rows.map(row => row.map(value => Object.is(value, -0) ? ['-0'] : value))
  })).digest('hex');
  return { id, title, capturedAt: new Date(capturedAt).toISOString(), rows: result.rows.length, coverage, contentSha256 };
}

function compareSavedCaptures(baseline, candidate, keys) {
  if (baseline.id === candidate.id) throw Error('Choose two different saved query results.');
  const from = columns(baseline), to = columns(candidate);
  if (!Array.isArray(keys) || !keys.length || keys.length > maxKeyParts) {
    throw Error('Choose between one and eight explicitly mapped key columns.');
  }
  const usedFrom = new Set(), usedTo = new Set(), mapping = [];
  for (const key of keys) {
    const target = key?.target, source = key?.source;
    const left = Number.isInteger(target) ? from[target] : undefined, right = Number.isInteger(source) ? to[source] : undefined;
    if (!left || !right || usedFrom.has(target) || usedTo.has(source) || !allowedKeys.has(left.kind) ||
        !allowedKeys.has(right.kind) || !equivalent(left.kind, right.kind)) {
      throw Error('Map each key to a distinct compatible exact typed column by its position.');
    }
    usedFrom.add(target);
    usedTo.add(source);
    mapping.push({ target, source, key: true });
  }
  for (const left of from) {
    if (usedFrom.has(left.index)) continue;
    const right = usingName(left, to, from);
    if (!right || usedTo.has(right.index) || !compatibleValues(left.kind, right.kind)) continue;
    usedFrom.add(left.index);
    usedTo.add(right.index);
    mapping.push({ target: left.index, source: right.index, key: false });
    if (mapping.length > maxMapped) throw Error('Compare projections with at most 64 mapped columns.');
  }
  const { report } = compareDatasets(baseline.result, candidate.result, mapping);
  const omitted = (entries, used) => entries.filter(entry => !used.has(entry.index)).map(({ name, index, kind }) =>
    ({ ordinal: index + 1, name, kind }));
  return {
    format: 'RocketbrainSavedResultComparison', version: 1,
    readOnly: true, executedSql: false, independentCaptures: true,
    comparisonScope: 'Only the captured rows and mapped columns are compared.',
    keyEquality: 'Exact typed values. Text uses case-sensitive equality independent of server collations.',
    baseline: sourceSummary(baseline), candidate: sourceSummary(candidate),
    mappedColumns: report.mapped.map(pair => ({ key: pair.key, kind: pair.kind,
      baseline: { ordinal: pair.target + 1, name: pair.targetName }, candidate: { ordinal: pair.source + 1, name: pair.sourceName } })),
    omittedColumns: { baseline: omitted(from, usedFrom), candidate: omitted(to, usedTo) },
    summary: { equal: report.summary.equal, changed: report.summary.changed,
      baselineOnly: report.summary.targetOnly, candidateOnly: report.summary.sourceOnly },
    differences: report.rows.map(row => ({
      key: row.key,
      state: row.state === 'target-only' ? 'baseline-only' : row.state === 'source-only' ? 'candidate-only' : row.state,
      ...(row.fields && { fields: row.fields.map(field => ({
        baseline: { name: field.targetName, value: field.target }, candidate: { name: field.sourceName, value: field.source }
      })) })
    }))
  };
}

function registerSavedResultComparison(context, vscode, store, choose, command) {
  const documents = new Map();
  const label = ({ name, index, kind }) => ({ label: name || '(unnamed)', description: 'Column ' + (index + 1) + ' · ' + kind });
  const compare = (baselineId, candidateId, keys) => compareSavedCaptures(store.get(baselineId), store.get(candidateId), keys);

  async function open(baselineId, candidateId, keys) {
    const report = compare(baselineId, candidateId, keys);
    const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/Saved query result comparison.json' });
    while (documents.size >= 4) documents.delete(documents.keys().next().value);
    const id = uri.toString();
    documents.set(id, JSON.stringify(report, null, 2) + '\n');
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      // A capture can be removed while VS Code opens the document.
      store.get(baselineId);
      store.get(candidateId);
      await vscode.window.showTextDocument(document, { preview: true });
      return { documentUri: id, ...report };
    } catch (error) {
      documents.delete(id);
      throw error;
    }
  }

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent(uri) {
        if (vscode.workspace.isTrusted) return documents.get(uri.toString());
        return undefined;
      }
    }),
    vscode.workspace.onDidCloseTextDocument(document => documents.delete(document.uri.toString()))
  );
  command('rocketbrain.results.compareSnapshots', async () => {
    const first = await choose('Choose Baseline Query Result');
    if (!first) return;
    const second = await choose('Choose Candidate Query Result', first.id);
    if (!second) return;
    const from = columns(store.get(first.id)), to = columns(store.get(second.id));
    const eligible = from.filter(column => allowedKeys.has(column.kind) && to.some(other => equivalent(column.kind, other.kind)));
    if (!eligible.length) throw Error('These captures have no compatible exact typed key columns.');
    const selection = await vscode.window.showQuickPick(eligible.map(column => ({ ...label(column), column })), {
      title: 'Choose Baseline Key Columns', canPickMany: true,
      placeHolder: 'Choose each part of a unique, non-NULL key'
    });
    if (!selection) return;
    if (!selection.length || selection.length > maxKeyParts) throw Error('Choose between one and eight key columns.');
    const keys = [], used = new Set();
    for (const { column } of selection.sort((left, right) => left.column.index - right.column.index)) {
      const available = to.filter(other => !used.has(other.index) && equivalent(column.kind, other.kind));
      if (!available.length) throw Error('No compatible candidate column remains for ' + column.name + '.');
      const named = usingName(column, to, from);
      const preferred = available.includes(named) ? named : undefined;
      const match = preferred ?? (await vscode.window.showQuickPick(available.map(other => ({ ...label(other), column: other })), {
        title: 'Map Key Column ' + (column.index + 1) + ' · ' + column.name
      }))?.column;
      if (!match) return;
      keys.push({ target: column.index, source: match.index });
      used.add(match.index);
    }
    return open(first.id, second.id, keys);
  });
  return { compare, open };
}

module.exports = { compareSavedCaptures, registerSavedResultComparison };
