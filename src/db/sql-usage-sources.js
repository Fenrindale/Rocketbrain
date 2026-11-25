'use strict';

const { scanJavaSql, javaSourceSpan } = require('./java-sql-usages');
const { SqlProjectError, analyzeProjectDocument, referencesInDocument, targetAtDocument, planCatalogDocumentRename } = require('./sql-project');
const { applySqlRename } = require('./sql-rename');
const { sourceRange } = require('./sql-analysis');

function embeddedIssue(text, fragment, issue) {
  const span = Number.isInteger(issue.start) && Number.isInteger(issue.end)
    ? javaSourceSpan(fragment, issue.start, issue.end) : null;
  const { start, end } = span || fragment;
  return { code: 'embedded-sql-unresolved', origin: fragment.origin, reason: issue.reason,
    start, end, range: sourceRange(text, start, end) };
}

function analyzeJavaUsageDocument(text, catalog, options) {
  const scanned = scanJavaSql(text), unknown = [...scanned.unknown];
  const fragments = scanned.fragments.map(fragment => {
    const report = analyzeProjectDocument(fragment.text, catalog, { ...options, usageParameters: true, dmlUsages: true });
    for (const issue of report.unknown) unknown.push(embeddedIssue(text, fragment, issue));
    return { ...fragment, report };
  });
  return { text, fragments, unknown };
}

function usagesInJava(report, target, options) {
  const references = [], unknown = [];
  for (const fragment of report.fragments) {
    for (const reference of referencesInDocument(fragment.report, target, options)) {
      const span = javaSourceSpan(fragment, reference.start, reference.end);
      if (!span) {
        unknown.push({ code: 'java-sql-split-token', origin: fragment.origin,
          reason: 'A bound SQL token crosses disjoint Java literal locations.',
          start: fragment.start, end: fragment.end, range: sourceRange(report.text, fragment.start, fragment.end) });
        continue;
      }
      references.push({ ...reference, ...span, range: sourceRange(report.text, span.start, span.end),
        origin: fragment.origin, language: 'java', editEligible: false });
    }
  }
  return { references, unknown };
}

function targetAtJava(report, offset, options) {
  const possible = [];
  for (const fragment of report.fragments) {
    if (fragment.start > offset || fragment.end <= offset) continue;
    const position = fragment.map.findIndex((start, index) => start <= offset && offset < fragment.ends[index]);
    if (position < 0) continue;
    const selected = targetAtDocument(fragment.report, position, options);
    if (!selected || selected.kind === 'local') continue;
    if (selected.kind === 'pending-dml') { possible.push(selected); continue; }
    const matching = referencesInDocument(fragment.report, selected, options).filter(ref => ref.start <= position && position < ref.end);
    if (matching.some(ref => javaSourceSpan(fragment, ref.start, ref.end))) possible.push(selected);
  }
  return possible.length === 1 ? possible[0] : null;
}

function planJavaCatalogRename(text, catalog, options, target, newName) {
  const before = scanJavaSql(text);
  if (before.unknown.length) {
    throw new SqlProjectError('SQL_PROJECT_INCOMPLETE', 'Some Java SQL fragments are unresolved. Review these sources before renaming.', { unknown: before.unknown });
  }
  const expected = [], edits = [];
  for (const fragment of before.fragments) {
    const planned = planCatalogDocumentRename(fragment.text, catalog, { ...options, usageParameters: true, dmlUsages: false }, target, newName);
    expected.push({ origin: fragment.origin, text: planned.resultText });
    for (const change of planned.edits) {
      const span = javaSourceSpan(fragment, change.start, change.end);
      if (!span) throw new SqlProjectError('SQL_PROJECT_EMBEDDED_SPLIT', 'The SQL identifier crosses Java literal boundaries. Review its spelling manually.');
      edits.push({ ...span, newText: JSON.stringify(change.newText).slice(1, -1) });
    }
  }
  edits.sort((left, right) => left.start - right.start);
  for (let index = 1; index < edits.length; index++) {
    if (edits[index].start < edits[index - 1].end) throw new SqlProjectError('SQL_PROJECT_OVERLAP', 'Java SQL rename edits overlap.');
  }
  const resultText = applySqlRename(text, edits), after = scanJavaSql(resultText);
  if (after.unknown.length || after.fragments.length !== expected.length ||
      after.fragments.some((fragment, index) => fragment.origin !== expected[index].origin || fragment.text !== expected[index].text)) {
    throw new SqlProjectError('SQL_PROJECT_EMBEDDED_REBIND', 'The source change does not preserve the expected embedded Java SQL fragments.');
  }
  return { edits, resultText };
}

module.exports = { analyzeJavaUsageDocument, usagesInJava, targetAtJava, planJavaCatalogRename };
