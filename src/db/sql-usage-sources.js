'use strict';

const { scanJavaSql, javaSourceSpan } = require('./java-sql-usages');
const { analyzeProjectDocument, referencesInDocument, targetAtDocument } = require('./sql-project');
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
    const report = analyzeProjectDocument(fragment.text, catalog, { ...options, usageParameters: true });
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
    const matching = referencesInDocument(fragment.report, selected, options).filter(ref => ref.start <= position && position < ref.end);
    if (matching.some(ref => javaSourceSpan(fragment, ref.start, ref.end))) possible.push(selected);
  }
  return possible.length === 1 ? possible[0] : null;
}

module.exports = { analyzeJavaUsageDocument, usagesInJava, targetAtJava };
