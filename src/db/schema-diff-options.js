'use strict';

const { sourceTokens } = require('./sql-analysis');

const identifier = '(?:`(?:[^`\\r\\n]|``)+`|[A-Za-z_$][\\w$]*)';
const account = '(?:' + identifier + "|'(?:[^'\\\\\\r\\n]|'')*')";
const header = new RegExp('^(\\s*CREATE\\s+(?:(?:OR\\s+REPLACE|TEMPORARY)\\s+)?' +
  '(?:ALGORITHM\\s*=\\s*(?:UNDEFINED|MERGE|TEMPTABLE)\\s+)?)' +
  '(?:(DEFINER\\s*=\\s*' + account + '\\s*@\\s*' + account + '\\s+))?' +
  '((?:SQL\\s+SECURITY\\s+(?:DEFINER|INVOKER)\\s+)?(TABLE|VIEW|PROCEDURE|FUNCTION|TRIGGER|EVENT)' +
  '(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+)(' + identifier + ')(?:\\s*\\.\\s*(' + identifier + '))?(?=\\s|[(:]|$)', 'iu');
const code = 'ROCKETBRAIN_DIFF_OPTIONS';

function asciiFold(name) {
  return /^[\x20-\x7e]+$/u.test(name) ? name.replace(/[A-Z]/gu, letter => letter.toLowerCase()) : name;
}

function settings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['identifierCase', 'definer'].includes(key)) ||
      !['exact', 'ascii-insensitive'].includes(value.identifierCase) || !['include', 'ignore'].includes(value.definer)) {
    throw Object.assign(Error('Choose exact/ASCII-insensitive identifier comparison and include/ignore DEFINER account.'), { code });
  }
  return { identifierCase: value.identifierCase, definer: value.definer };
}

function group(values, key) {
  const result = new Map();
  for (const value of values) {
    const id = key(value);
    if (!result.has(id)) result.set(id, []);
    result.get(id).push(value);
  }
  return result;
}

function paired(current, desired, key) {
  const from = group(current, key), to = group(desired, key);
  return [...new Set([...from.keys(), ...to.keys()])].sort().map(id => ({ id, current: from.get(id) || [], desired: to.get(id) || [] }));
}

const decoded = token => token.startsWith('`') ? token.slice(1, -1).replaceAll('``', '`') : token;
const quote = name => '`' + name.replaceAll('`', '``') + '`';

function definition(object, source, policy) {
  if (!source) return { source, headerObserved: false };
  const match = header.exec(source);
  if (!match || object.kind !== match[4].toLowerCase() ||
      decoded(match[6] ?? match[5]) !== object.name) return { source, headerObserved: false };
  const [initial, prefix, owner = '', kind, , name, localName] = match;
  const fold = policy.identifierCase === 'ascii-insensitive';
  // Keep the exact spacing and source bytes when the user selected exact identifiers.
  const declaration = fold ? quote(asciiFold(decoded(name))) + (localName ? '.' + quote(asciiFold(decoded(localName))) : '')
    : initial.slice(prefix.length + owner.length + kind.length);
  return { source: prefix + (policy.definer === 'ignore' ? '' : owner) + kind + declaration + source.slice(initial.length), headerObserved: true };
}

function projectColumnDeclarations(source, columns, server) {
  let tokens;
  try { tokens = sourceTokens(source, { sqlMode: server.sqlMode.split(',') }); }
  catch { return source; }
  const end = header.exec(source)[0].length;
  const opening = tokens.findIndex(token => token.start >= end);
  const open = tokens[opening];
  if (open?.kind !== 'symbol' || open.value !== '(' || open.close === undefined) return source;
  const declarations = [opening + 1];
  for (let index = opening + 1; index < open.close; index++) {
    const token = tokens[index];
    if (token.kind !== 'symbol') continue;
    if (token.value === '(' && token.close !== undefined) index = token.close;
    else if (token.value === ',') declarations.push(index + 1);
  }
  const edits = [];
  for (const [index, column] of columns.entries()) {
    const at = declarations[index], declaration = tokens[at];
    if (declaration?.kind !== 'identifier' || declaration.value !== column.name || tokens[at + 1]?.kind !== 'word') return source;
    edits.push({ start: declaration.start, end: declaration.end, replacement: quote(asciiFold(column.name)) });
  }
  for (const edit of edits.reverse()) source = source.slice(0, edit.start) + edit.replacement + source.slice(edit.end);
  return source;
}

function projectTable(table, policy, server, pairedRelations, side) {
  const fold = policy.identifierCase === 'ascii-insensitive';
  const ddl = definition(table, table.createSql, policy);
  const fields = { ...table, createSql: ddl.source };
  if (!fold) return fields;
  if (table.kind === 'table' && ddl.headerObserved) fields.createSql = projectColumnDeclarations(ddl.source, table.columns, server);
  const byName = (a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const named = item => ({ ...item, name: item.name == null ? null : asciiFold(item.name) });
  const keyProjection = key => {
    const endpoint = pairedRelations.get(asciiFold(key.referencedTable))?.[side];
    return key.referencedSchema === server.database && endpoint?.name === key.referencedTable &&
      key.columns.every(column => endpoint.columns.some(target => target.name === column.referencedColumn));
  };
  return {
    ...fields, name: asciiFold(table.name),
    columns: table.columns.map(named),
    indexes: table.indexes.map(index => ({ ...named(index), columns: index.columns.map(named) })).sort(byName),
    checks: table.checks.map(named).sort(byName),
    foreignKeys: table.foreignKeys.map(key => {
      const resolved = keyProjection(key);
      return { ...named(key), referencedTable: resolved ? asciiFold(key.referencedTable) : key.referencedTable,
        columns: key.columns.map(column => ({ ...named(column), referencedColumn: resolved ? asciiFold(column.referencedColumn) : column.referencedColumn })) };
    }).sort(byName),
    partitions: table.partitions.map(([name, ...rest]) => [name == null ? null : asciiFold(name), ...rest])
  };
}

function localCollisions(table) {
  if (!table) return [];
  const namespaces = { columns: table.columns, indexes: table.indexes, checks: table.checks, foreignKeys: table.foreignKeys,
    partitions: table.partitions.filter(([name]) => name != null).map(([name]) => ({ name })) };
  return Object.entries(namespaces).flatMap(([namespace, items]) => [...group(items, value => asciiFold(value.name)).values()]
    .map(identifiers => [...new Set(identifiers.map(value => value.name))]).filter(names => names.length > 1)
    .map(names => ({ namespace, names })));
}

function projectTables(current, desired, value) {
  const policy = settings(value), fold = policy.identifierCase === 'ascii-insensitive';
  if (fold && (current.scope.kind !== 'database' || desired.scope.kind !== 'database')) {
    throw Object.assign(Error('Capture the complete account-visible database on both sides for ASCII-insensitive pairing.'), { code });
  }
  const name = fold ? asciiFold : value => value;
  const projected = { policy, current: [], desired: [], pairs: new Map(), collisions: [], unavailableViewDefinitions: [] };
  for (const item of paired(current.tables, desired.tables, table => name(table.name))) {
    const labels = sides => sides.map(({ name, kind }) => ({ name, kind }));
    if (item.current.length > 1 || item.desired.length > 1) {
      projected.collisions.push({ key: item.id, current: labels(item.current), desired: labels(item.desired) });
      continue;
    }
    const [before] = item.current, [after] = item.desired;
    if (fold) {
      const from = localCollisions(before), to = localCollisions(after);
      if (from.length || to.length) {
        projected.collisions.push({ key: item.id, current: from, desired: to });
        continue;
      }
    }
    projected.pairs.set(item.id, { before, after });
    if (before?.kind === 'view' && after?.kind === 'view' && (!before.createSql || !after.createSql)) {
      projected.unavailableViewDefinitions.push(item.id);
    }
  }
  const pairedRelations = new Map([...projected.pairs.entries()].filter(([, { before, after }]) =>
    before?.kind === 'table' && after?.kind === 'table'));
  for (const { before, after } of projected.pairs.values()) {
    if (before) projected.current.push(projectTable(before, policy, current.server, pairedRelations, 'before'));
    if (after) projected.desired.push(projectTable(after, policy, desired.server, pairedRelations, 'after'));
  }
  return projected;
}

module.exports = { asciiFold, settings, paired, definition, projectTables };
