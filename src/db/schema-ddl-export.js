'use strict';

const { createHash } = require('node:crypto');
const { normalizeSnapshot } = require('./schema-diff');
const { identifier } = require('./schema-rename');
const { tokenize } = require('./sql-policy');
const { parseView } = require('./schema-dependency-graph');
const { programId } = require('./schema-ddl-programs');

const maxBytes = 8 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = name => '`' + identifier(name, { table: true }).replaceAll('`', '``') + '`';
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const named = token => ['word', 'identifier'].includes(token?.kind);
const ordered = values => [...values].sort((a, b) => a.object.name < b.object.name ? -1 : a.object.name > b.object.name ? 1 : 0);
const unavailable = message => new Error(message);
const triggerGroup = value => JSON.stringify([value.table, value.timing, value.event]);
const programOrder = (a, b) => a.kind.localeCompare(b.kind, 'en') || a.name.localeCompare(b.name, 'en');

function reference(tokens, at, database) {
  const first = tokens[at];
  if (!named(first)) throw unavailable('A source definition has an unknown object identifier.');
  if (!symbol(tokens[at + 1], '.')) return { schema: database, name: first.value, next: at + 1 };
  const second = tokens[at + 2];
  if (!named(second)) throw unavailable('A source definition has an incomplete qualified object name.');
  return { schema: first.value, name: second.value, next: at + 3 };
}

function replayIdentity(snapshot, object, actual) {
  const equals = snapshot.server.tableNameCaseSensitive ? (a, b) => a === b : (a, b) => a.toLowerCase() === b.toLowerCase();
  if (!equals(actual.schema, snapshot.database) || !equals(actual.name, object.name)) {
    throw unavailable('SHOW CREATE did not identify the captured object.');
  }
}

function tableParts(tokens, start) {
  if (!symbol(tokens[start], '(')) throw unavailable('Only SHOW CREATE table definitions with explicit columns are supported.');
  const spans = [];
  let depth = 1, segment = start + 1;
  for (let at = start + 1; at < tokens.length; at++) {
    const token = tokens[at];
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    if (depth === 1 && symbol(token, ',') || depth === 0) {
      if (segment === at) throw unavailable('A table definition has an empty component.');
      spans.push(tokens.slice(segment, at));
      segment = at + 1;
      if (depth === 0) return { spans, close: at };
    }
  }
  throw unavailable('The table definition has unbalanced parentheses.');
}

function stripCounter(sql, tokens, from) {
  const options = tokens.slice(from);
  let depth = 0, removal;
  for (const token of options) {
    if (symbol(token, '(')) depth++;
    if (symbol(token, ')')) depth--;
    if (depth || !word(token, 'AUTO_INCREMENT')) continue;
    const match = /^AUTO_INCREMENT\s*=\s*\d+(?=\s|$)/i.exec(sql.slice(token.start));
    if (!match || removal) throw unavailable('The table has an unrecognized AUTO_INCREMENT option.');
    let start = token.start;
    while (start && /[ \t]/.test(sql[start - 1])) start--;
    removal = { start, end: token.start + match[0].length };
  }
  return removal ? sql.slice(0, removal.start) + sql.slice(removal.end) : sql;
}

function tableDefinition(snapshot, object, sql, tokens) {
  if (!word(tokens[1], 'TABLE')) throw unavailable('The source is not an ordinary CREATE TABLE statement.');
  const target = reference(tokens, 2, snapshot.database);
  replayIdentity(snapshot, object, target);
  const { spans, close } = tableParts(tokens, target.next);
  const clean = stripCounter(sql, tokens, close + 1);
  const clauses = [], constraints = [], dependencies = [];
  const foreignKeys = new Map(object.foreignKeys.map(key => [key.name, key]));
  for (const span of spans) {
    const body = sql.slice(span[0].start, span.at(-1).end);
    if (!span.some((token, index) => word(token, 'FOREIGN') && word(span[index + 1], 'KEY'))) {
      clauses.push(body);
      continue;
    }
    if (!word(span[0], 'CONSTRAINT') || !named(span[1]) || !word(span[2], 'FOREIGN') || !word(span[3], 'KEY')) {
      throw unavailable('A foreign key clause has an unsupported source form.');
    }
    const constraint = foreignKeys.get(span[1].value);
    const references = span.findIndex(token => word(token, 'REFERENCES'));
    if (references < 0 || !constraint) throw unavailable('Foreign key metadata does not match the source definition.');
    const parent = reference(span, references + 1, snapshot.database);
    const lookup = snapshot.server.tableNameCaseSensitive ? value => value : value => value.toLowerCase();
    if (lookup(constraint.referencedSchema) !== lookup(parent.schema) || lookup(constraint.referencedTable) !== lookup(parent.name)) {
      throw unavailable('Foreign key targets disagree between metadata and the source definition.');
    }
    dependencies.push({ schema: constraint.referencedSchema, name: constraint.referencedTable, kind: 'table' });
    constraints.push({ name: constraint.name, sql: 'ALTER TABLE ' + quote(object.name) + ' ADD ' + body });
    foreignKeys.delete(constraint.name);
  }
  if (!clauses.length || foreignKeys.size) throw unavailable('Foreign key and column metadata do not match SHOW CREATE.');
  const ddl = constraints.length
    ? clean.slice(0, tokens[target.next].end) + '\n  ' + clauses.join(',\n  ') + '\n' + clean.slice(tokens[close].start)
    : clean;
  return { object, ddl, constraints, dependencies };
}

function viewDefinition(snapshot, object, sql, tokens) {
  const view = tokens.findIndex(token => word(token, 'VIEW'));
  if (view < 1) throw unavailable('SHOW CREATE VIEW is unavailable.');
  const target = reference(tokens, view + 1, snapshot.database);
  replayIdentity(snapshot, object, target);
  const select = tokens.findIndex((token, index) => index >= target.next && word(token, 'AS') && word(tokens[index + 1], 'SELECT'));
  if (select < 0) throw unavailable('Only standard SELECT-based view definitions are ordered.');
  let end = tokens.at(-1).end;
  if (word(tokens.at(-1), 'OPTION') && word(tokens.at(-2), 'CHECK')) {
    const tail = word(tokens.at(-3), 'LOCAL') || word(tokens.at(-3), 'CASCADED') ? -4 : -3;
    if (word(tokens.at(tail), 'WITH')) end = tokens.at(tail).start;
  }
  let parsed;
  try { parsed = parseView(sql.slice(tokens[select + 1].start, end), snapshot.database, { sqlMode: snapshot.server.sqlMode }); }
  catch { throw unavailable('View dependencies are unavailable in the supported SELECT/JOIN subset.'); }
  const dependencies = parsed.refs.map(ref => ({ schema: ref.schema, name: ref.table }));
  return { object, ddl: sql, constraints: [], dependencies };
}

function definition(snapshot, object) {
  if (!object.createSql) throw unavailable('SHOW CREATE is unavailable for this object.');
  if (object.kind === 'table' && String(object.engine).toUpperCase() !== 'INNODB') throw unavailable('Only InnoDB tables are supported.');
  const sqlMode = snapshot.server.sqlMode.split(',').filter(Boolean);
  const sql = object.createSql.trim().replace(/;$/, '');
  let tokens;
  try { tokens = tokenize(sql, false, { sqlMode }); }
  catch { throw unavailable('The source exceeds the supported DDL lexer or size bounds.'); }
  if (!word(tokens[0], 'CREATE')) throw unavailable('The source definition is not CREATE DDL.');
  return object.kind === 'table' ? tableDefinition(snapshot, object, sql, tokens) : viewDefinition(snapshot, object, sql, tokens);
}

function storedOrder(snapshot, capture, relations, key) {
  const library = new Map(capture.candidates.filter(row => row.kind !== 'trigger').map(row => [programId(row.kind, row.name), row]));
  const omitted = capture.omitted.filter(row => snapshot.scope.kind === 'database' || row.kind === 'trigger');
  const selected = new Map();
  function select(program) {
    if (!program) return;
    const id = programId(program.kind, program.name);
    if (selected.has(id)) return;
    selected.set(id, program);
    for (const child of program.dependencies.filter(dep => dep.kind === 'procedure' && key(dep.schema) === key(snapshot.database))) {
      select(library.get(programId(child.kind, child.name)));
    }
  }
  for (const program of capture.candidates) {
    if (snapshot.scope.kind === 'database' || program.kind === 'trigger') select(program);
  }
  const procedures = new Map([...selected].filter(([, row]) => row.kind !== 'trigger').sort(([, a], [, b]) => programOrder(a, b)));
  const emitted = new Set();
  const unavailableDependency = row => row.dependencies.find(dep => {
    if (key(dep.schema) !== key(snapshot.database)) return true;
    if (dep.kind === 'procedure') return !emitted.has(programId(dep.kind, dep.name));
    const relation = relations.get(key(dep.name));
    return !relation || dep.kind === 'table' && relation !== 'table';
  });
  const omit = ({ kind, name }, reason) => omitted.push({ kind, name, reason });
  const definitions = [];
  while (procedures.size) {
    const next = [...procedures].find(([, row]) => !unavailableDependency(row));
    if (!next) break;
    const [id, row] = next;
    definitions.push(row);
    emitted.add(id);
    procedures.delete(id);
  }
  for (const row of procedures.values()) {
    const dep = unavailableDependency(row);
    omit(row, 'A required object is unavailable or cyclic: ' + quote(dep.schema) + '.' + quote(dep.name) + '.');
  }
  const groups = new Map();
  for (const row of selected.values()) if (row.kind === 'trigger') {
    const id = triggerGroup(row);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(row);
  }
  for (const [id, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    rows.sort((a, b) => a.actionOrder - b.actionOrder);
    const unsupportedGroup = omitted.some(row => row.kind === 'trigger' && triggerGroup(row) === id) ||
      rows.some((row, index) => row.actionOrder !== index + 1 || unavailableDependency(row));
    if (unsupportedGroup) {
      for (const row of rows) {
        const dep = unavailableDependency(row);
        omit(row, dep ? 'Required trigger dependency missing from the export: ' + quote(dep.schema) + '.' + quote(dep.name) + '.'
          : 'The trigger action group has an unavailable sibling or incomplete action order.');
      }
    } else definitions.push(...rows);
  }
  const databaseCollations = [...new Set(definitions.map(row => row.context.databaseCollation))].sort();
  if (databaseCollations.length > 1) {
    for (const row of definitions) omit(row, 'The stored programs disagree on their original schema collation; prepare a compatible source scope.');
    definitions.length = 0;
  }
  return { definitions, omitted, databaseCollation: databaseCollations.length === 1 ? databaseCollations[0] : undefined };
}

function storedStatements(programs) {
  const delimiters = ['$$', '//', ...Array.from({ length: 16 }, (_, index) => '~rb' + index + '~')];
  return programs.flatMap(({ context, sql }) => {
    const delimiter = delimiters.find(value => !sql.includes(value));
    if (!delimiter) throw unavailable('No unused SQL client delimiter could be selected for a stored definition.');
    return [
      "SET SESSION sql_mode='" + context.sqlMode + "';",
      "SET SESSION character_set_client='" + context.charset + "';",
      "SET SESSION collation_connection='" + context.collation + "';",
      'DELIMITER ' + delimiter,
      sql + '\n' + delimiter,
      'DELIMITER ;', ''
    ];
  });
}

function buildDdlExport(value) {
  const snapshot = normalizeSnapshot(value);
  if (!/^[A-Z0-9_,]*$/i.test(snapshot.server.sqlMode)) throw unavailable('The captured SQL mode has an unsupported form.');
  const key = snapshot.server.tableNameCaseSensitive ? name => name : name => name.toLowerCase();
  const candidates = new Map(), omitted = [];
  for (const object of snapshot.tables) {
    if (/^__rb_/i.test(object.name)) continue;
    try { candidates.set(key(object.name), definition(snapshot, object)); }
    catch (error) { omitted.push({ kind: object.kind, name: object.name, reason: error.message }); }
  }
  const observed = new Set(snapshot.tables.map(object => key(object.name)));
  for (const name of snapshot.scope.tables) if (!observed.has(key(name))) omitted.push({ kind: 'object', name, reason: 'The selected object is no longer visible.' });

  let removed = true;
  while (removed) {
    removed = false;
    for (const [id, candidate] of candidates) {
      const missing = candidate.dependencies.find(dep => {
        const related = candidates.get(key(dep.name));
        return key(dep.schema) !== key(snapshot.database) || !related || dep.kind && related.object.kind !== dep.kind;
      });
      if (!missing) continue;
      candidates.delete(id);
      const { kind, name } = candidate.object;
      omitted.push({ kind, name, reason: 'Required definition missing from the export: ' + quote(missing.schema) + '.' + quote(missing.name) + '.' });
      removed = true;
    }
  }

  const tables = new Map(ordered([...candidates.values()].filter(entry => entry.object.kind === 'table')).map(entry => [key(entry.object.name), entry]));
  const views = new Map(ordered([...candidates.values()].filter(entry => entry.object.kind === 'view')).map(entry => [key(entry.object.name), entry]));
  const tableOrder = [], viewOrder = [];
  while (tables.size) {
    // Cyclic foreign keys are emitted later, after all their tables exist.
    const [id, entry] = [...tables].find(([name, item]) => item.dependencies.every(dep => key(dep.name) === name || !tables.has(key(dep.name)))) || tables.entries().next().value;
    tableOrder.push(entry); tables.delete(id);
  }
  while (views.size) {
    const next = [...views].find(([, item]) => item.dependencies.every(dep => !views.has(key(dep.name))));
    if (!next) {
      for (const { object } of views.values()) omitted.push({ kind: 'view', name: object.name, reason: 'View dependency order could not be established.' });
      break;
    }
    viewOrder.push(next[1]); views.delete(next[0]);
  }
  const unavailableAreas = Object.keys(snapshot.coverage).filter(area => snapshot.coverage[area] !== 'loaded').sort();
  const baseStatements = [
    ...tableOrder.map(entry => ({ kind: 'table', name: entry.object.name, sql: entry.ddl })),
    ...tableOrder.flatMap(entry => entry.constraints.map(constraint => ({ kind: 'foreignKey', name: constraint.name, table: entry.object.name, sql: constraint.sql }))),
    ...viewOrder.map(entry => ({ kind: 'view', name: entry.object.name, sql: entry.ddl }))
  ];
  const capture = value.ddlPrograms;
  const relations = new Map([...tableOrder, ...viewOrder].map(({ object }) => [key(object.name), object.kind]));
  const programs = capture ? storedOrder(snapshot, capture, relations, key) : { definitions: [], omitted: [] };
  if (capture?.unavailable) unavailableAreas.push('stored programs');
  omitted.push(...programs.omitted.map(({ kind, name, reason }) => ({ kind, name, reason })));
  omitted.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const statements = [...baseStatements, ...programs.definitions.map(({ kind, name, sql, context }) => ({ kind, name, sql, context }))];
  const replayPrograms = programs.definitions.length > 0;
  const replay = [
    ...baseStatements.map(statement => '\n' + statement.sql + ';'),
    ...(replayPrograms ? [
      '', '-- Restore stored programs in a dedicated UTF-8 client session.',
      'SET @__rb_saved_mode=@@SESSION.sql_mode, @__rb_saved_cs=@@SESSION.character_set_client,',
      '    @__rb_saved_collation=@@SESSION.collation_connection;',
      ...storedStatements(programs.definitions),
      'SET SESSION sql_mode=@__rb_saved_mode, character_set_client=@__rb_saved_cs,',
      '    collation_connection=@__rb_saved_collation;',
      'SET @__rb_saved_mode=NULL, @__rb_saved_cs=NULL, @__rb_saved_collation=NULL;'
    ] : [])
  ];
  const complete = !omitted.length && !unavailableAreas.length;
  const sql = [
    '-- Rocketbrain schema DDL export ' + (capture ? 'v2' : 'v1'),
    '-- Account-visible ' + snapshot.scope.kind + ' scope on ' + snapshot.server.dialect + '.',
    '-- Source SQL mode ' + (snapshot.server.sqlMode || '(default)') + '. Review target schema and context before execution.',
    capture ? '-- Table data, grants, events, sequences and packages are outside this export.'
      : '-- Table data, privileges, triggers and stored programs are outside this export.',
    '-- Definitions can contain comments, literals and definers. Review them before committing.',
    '-- AUTO_INCREMENT counters omitted. Foreign keys are added after base tables.',
    ...(replayPrograms ? ['-- Use the same schema name and default collation ' + programs.databaseCollation + ' on a compatible server.',
      '-- Definitions preserve the original DEFINER. Provide the appropriate accounts and existing restore privileges.'] : []),
    ...unavailableAreas.map(area => '-- Unavailable metadata ' + area),
    ...omitted.map(item => '-- Omitted ' + item.kind + ' ' + quote(item.name) + ' · ' + item.reason),
    ...(statements.length ? ['', 'USE ' + quote(snapshot.database) + ';', ...replay] : []),
    ''
  ].join('\n');
  if (Buffer.byteLength(sql) > maxBytes) throw unavailable('The generated DDL exceeds 8 MiB. Select fewer objects.');
  return { state: complete ? 'account-visible-scope' : 'partial', database: snapshot.database,
    scope: snapshot.scope, statements, omitted, unavailableAreas, sql,
    fingerprint: digest(sql), sourceIdentity: digest(JSON.stringify(capture ? [snapshot.server, capture.observation] : snapshot.server)),
    rowDataIncluded: false, executedSql: false };
}

module.exports = { buildDdlExport };
