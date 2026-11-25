'use strict';

const { sourceLayout, statementRanges } = require('./sql-analysis');

function quickFixContext(text, offset, catalog) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !catalog?.database ||
      ['tables', 'columns'].some(area => catalog.coverage?.[area] !== 'loaded')) return null;
  const options = { dialect: catalog.dialect, database: catalog.database, sqlMode: catalog.sqlMode,
    tableNameCaseSensitive: catalog.tableNameCaseSensitive, catalogComplete: true, joinOrigins: true };
  const { statements, unknown } = statementRanges(text, options);
  if (unknown.length) return null;
  const index = statements.findIndex(part => part.start <= offset && offset <= part.end);
  if (index < 0) return null;
  const part = statements[index], source = text.slice(part.start, part.end), local = offset - part.start;
  try {
    // A preceding USE, DDL or session directive can change catalog binding.
    for (const earlier of statements.slice(0, index)) {
      const { tokens } = sourceLayout(text.slice(earlier.start, earlier.end), options);
      if (tokens[0]?.kind !== 'word' || tokens[0].upper !== 'SELECT') return null;
    }
    const layout = sourceLayout(source, options);
    if (layout.nonCode.some(span => local >= span.start && local < span.end)) return null;
    return { part, source, local, options, ...layout };
  } catch { return null; }
}

module.exports = { quickFixContext };
