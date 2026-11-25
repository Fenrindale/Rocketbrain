'use strict';

const { randomUUID } = require('node:crypto');
const A = require('./schema-trigger-ast');
const D = require('./schema-designer-ddl');
const O = require('./object-editor-ddl');
const { loadSource } = require('./object-source');
const { sourceTokens } = require('./sql-analysis');

const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_TRIGGER_SOURCE' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const stageName = /^__rb_object_[0-9a-f]{24}(?:_t)?$/u;
const batches = { maxRows: 1, timeoutMs: 10000 };
const privateName = name => stageName.test(name) ? name : D.name(name);
const qualified = (schema, name) => D.q(schema) + '.' + D.q(name);
const versionNumber = version => /^(\d+)\.(\d+)/u.exec(version)?.slice(1).map(Number);
const knownStates = new Set(['compiling', 'validation-failed', 'reviewed', 'drop-pending', 'create-pending', 'needs-inspection',
  'applied', 'restore-pending', 'recovered']);

function supportedServer(server) {
  const [major, minor] = versionNumber(server.version) || [];
  if (!(server.dialect === 'mysql' && major === 8 && minor === 4 || server.dialect === 'mariadb' && major === 11 && minor === 4))
    throw fail('Reviewed trigger replacement is available for MySQL 8.4 and MariaDB 11.4.');
}

function parseBody(source, definition, columns) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > 32 * 1024 ||
      source.includes('\0') || /(?:^|,)ORACLE(?:,|$)/u.test(definition.sqlMode)) {
    throw fail('Use a standard SQL trigger body up to 32 KiB.');
  }
  const ast = A.parse(source, definition.schema, definition.table, { sqlMode: definition.sqlMode, allowDynamic: false });
  let rowAssignments = 0;
  A.walk(ast.statements, node => {
    if (!['block', 'declare', 'if', 'case', 'set'].includes(node.kind)) throw fail('Use local conditions and assignments to NEW columns.');
    if (!node.column) return;
    const column = columns.find(item => item.name === node.column);
    if (!column || column.generation || /auto_increment/iu.test(column.extra))
      throw fail('Use an existing writable NEW column without AUTO_INCREMENT or generation.');
    rowAssignments++;
  });
  if (!rowAssignments || ast.targets.length) throw fail('This reviewed trigger body must assign at least one NEW column without external table access.');
  A.validate(ast, { database: definition.schema, table: definition.table, timing: definition.timing, event: definition.event,
    tables: [{ schema: definition.schema, name: definition.table, columns }] });
  return ast;
}

function originalBoundary(ddl, definition) {
  const tokens = sourceTokens(ddl, { sqlMode: definition.sqlMode.split(',').filter(Boolean) });
  const word = (index, value) => tokens[index]?.kind === 'word' && tokens[index].upper === value;
  const tokenName = index => ['word', 'identifier'].includes(tokens[index]?.kind) ? tokens[index].value : undefined;
  function exactName(index, expected) {
    if (tokens[index + 1]?.value === '.') {
      if (tokenName(index) !== definition.schema) throw fail('The trigger definition changes the observed schema.');
      index += 2;
    }
    if (tokenName(index) !== expected) throw fail('The trigger definition changes the observed identity.');
    return index + 1;
  }
  if (!word(0, 'CREATE') || !word(1, 'DEFINER') || tokens[2]?.value !== '=' ||
      tokens[4]?.value !== '@' || tokenName(3) + '@' + tokenName(5) !== definition.definer || !word(6, 'TRIGGER')) {
    throw fail('The server trigger source does not expose its exact current definer header.');
  }
  let at = exactName(7, definition.name);
  if (!word(at++, 'BEFORE') || !word(at++, definition.event) || !word(at++, 'ON')) throw fail('The observed trigger event or timing changed.');
  at = exactName(at, definition.table);
  if (!word(at++, 'FOR') || !word(at++, 'EACH') || !word(at++, 'ROW') || !tokens[at] ||
      ddl.slice(tokens[at].start).trim() !== definition.body.trim()) {
    throw fail('The complete trigger body differs from its server metadata.');
  }
  return tokens[at - 1].end;
}

function orderClause(siblings, name) {
  const index = siblings.findIndex(item => item.name === name);
  if (index < 0) throw fail('The trigger order is unobserved.');
  if (siblings[index + 1]) return ' PRECEDES ' + D.q(siblings[index + 1].name);
  if (siblings[index - 1]) return ' FOLLOWS ' + D.q(siblings[index - 1].name);
  return '';
}

function createReplacement(definition, body, name, table, clause = '') {
  return 'CREATE DEFINER=CURRENT_USER TRIGGER ' + qualified(definition.schema, name) + ' BEFORE ' + definition.event +
    ' ON ' + qualified(definition.schema, table) + ' FOR EACH ROW' + clause + ' ' + body;
}

function restoredOriginal(current, expected) {
  if (!current) return false;
  // MariaDB can retain an extra space around the removed PRECEDES/FOLLOWS clause.
  const normalize = definition => ({ ...definition,
    ddl: definition.ddl.slice(0, definition.boundary) + ' ' + definition.ddl.slice(definition.boundary).trimStart() });
  return same(normalize(current), normalize(expected));
}

class TriggerSourceEditor {
  constructor(editor, journal, limits) {
    this.editor = editor;
    this.journal = journal;
    this.limits = limits;
  }
  read(session, sql, values, options) {
    return this.editor.transport._read(session, sql, values, options);
  }
  write(session, sql) {
    return this.editor.db._stream(session, sql, [], batches, true);
  }
  async locate(session, server, name, missing = false) {
    supportedServer(server);
    privateName(name);
    const rows = await this.read(session, 'SELECT EVENT_OBJECT_SCHEMA,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION,' +
      'ACTION_ORIENTATION,ACTION_STATEMENT,DEFINER,SQL_MODE,CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION ' +
      'FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA=BINARY ? AND BINARY TRIGGER_NAME=BINARY ? LIMIT 2', [server.database, name]);
    if (!rows.length && missing) return null;
    if (rows.length !== 1) throw fail('The exact trigger is unavailable to the current account.');
    const [schema, table, timing, event, orientation, body, definer, sqlMode, charset, collation, databaseCollation] = rows[0];
    privateName(table);
    if (schema !== server.database || definer !== server.currentUser || timing !== 'BEFORE' ||
        !['INSERT', 'UPDATE'].includes(event) || orientation !== 'ROW' || typeof body !== 'string' ||
        typeof sqlMode !== 'string' || !/^[A-Za-z0-9_,]*$/u.test(sqlMode)) {
      throw fail('Choose a current-account BEFORE INSERT or UPDATE row trigger in the active schema.');
    }
    for (const value of [charset, collation, databaseCollation]) D.safe(value);
    const definition = { kind: 'trigger', schema, name, table, timing, event, body, definer, sqlMode, charset, collation, databaseCollation };
    const source = await loadSource((sql, values) => this.read(session, sql, values, { includeColumns: true }), server,
      { kind: 'trigger', schema, name });
    const ddl = source.source;
    const boundary = originalBoundary(ddl, definition);
    return { ...definition, ddl, boundary };
  }
  async siblings(session, definition) {
    const rows = await this.read(session, 'SELECT TRIGGER_NAME,ACTION_ORDER,ACTION_STATEMENT,DEFINER,SQL_MODE,' +
      'CHARACTER_SET_CLIENT,COLLATION_CONNECTION,DATABASE_COLLATION FROM information_schema.TRIGGERS ' +
      'WHERE BINARY TRIGGER_SCHEMA=BINARY ? AND BINARY EVENT_OBJECT_TABLE=BINARY ? AND ACTION_TIMING=? AND EVENT_MANIPULATION=? ' +
      'ORDER BY ACTION_ORDER LIMIT 33', [definition.schema, definition.table, definition.timing, definition.event]);
    if (rows.length > 32 || rows.some((row, index) => Number(row[1]) !== index + 1 || typeof row[2] !== 'string'))
      throw fail('The complete trigger order is unavailable within the review limit.');
    return rows.map(([name, order, ...source]) => {
      privateName(name);
      if (/^__rb_/iu.test(name)) throw fail('An internal recovery trigger is present on this table.');
      return { name, hash: O.hash(source) };
    });
  }
  async subject(session, definition) {
    const { schema, table } = definition;
    const rows = await this.read(session, 'SELECT ENGINE,TABLE_TYPE FROM information_schema.TABLES ' +
      'WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? LIMIT 2', [schema, table]);
    if (rows.length !== 1 || !same(rows[0], ['InnoDB', 'BASE TABLE'])) throw fail('Use a visible InnoDB subject table.');
    const columns = await this.read(session, 'SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,EXTRA,GENERATION_EXPRESSION ' +
      'FROM information_schema.COLUMNS WHERE BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ? ORDER BY ORDINAL_POSITION LIMIT 257', [schema, table]);
    if (!columns.length || columns.length > 256) throw fail('The trigger subject columns cannot be reviewed within the limit.');
    const ddl = (await this.read(session, 'SHOW CREATE TABLE ' + qualified(schema, table)))[0]?.[1];
    if (typeof ddl !== 'string') throw fail('The exact subject table source is unavailable.');
    return { columns: columns.map(([name, type, nullable, extra, generation]) => ({ name, type, nullable, extra, generation })),
      hash: O.hash([ddl.replace(/\bAUTO_INCREMENT=\d+\b/gu, 'AUTO_INCREMENT'), columns]) };
  }
  async compile(session, server, record) {
    const e = this.editor, definition = record.original.definition;
    const shadowDefinition = { ...definition, table: record.shadow }, shadow = qualified(definition.schema, record.shadow);
    await this.write(session, 'CREATE TABLE ' + shadow + ' LIKE ' + qualified(definition.schema, definition.table));
    const created = await this.subject(session, shadowDefinition);
    await e.db._control(session, 'LOCK TABLES ' + shadow + ' WRITE', 5000);
    let submitted = false;
    const owned = async () => {
      const detached = await this.subject(session, shadowDefinition);
      const triggers = await this.read(session, 'SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE ' +
        'BINARY EVENT_OBJECT_SCHEMA=BINARY ? AND BINARY EVENT_OBJECT_TABLE=BINARY ? LIMIT 2', [definition.schema, record.shadow]);
      const rows = await this.read(session, 'SELECT 1 FROM ' + shadow + ' LIMIT 1');
      if (!same(detached, created) || rows.length || triggers.length > 1 ||
          triggers.length === 1 && (!submitted || triggers[0][0] !== record.stage))
        throw fail('The isolated compilation table changed. Inspect the retained validation artifacts.');
    };
    try {
      await owned();
      if (!same(created.columns, record.scope.columns)) throw fail('The isolated compilation table has different columns.');
      await e._context(session, definition, () => {
        submitted = true;
        return this.write(session, createReplacement(definition, record.replacement.body, record.stage, record.shadow));
      });
      const compiled = await this.locate(session, server, record.stage);
      if (compiled.table !== record.shadow ||
          !same(parseBody(compiled.body, definition, record.scope.columns), parseBody(record.replacement.body, definition, record.scope.columns)))
        throw fail('The server compiled a different trigger body.');
    } finally {
      if (session.connected) {
        try {
          await owned();
          await this.write(session, 'DROP TABLE ' + shadow);
        } finally {
          if (session.connected) await e.db._control(session, 'UNLOCK TABLES', 5000);
        }
      }
    }
  }
  async inspect(input) {
    const e = this.editor;
    if (input.create === true) throw fail('Open an existing trigger.');
    D.name(input.name);
    return e.transport._withSession(async session => {
      e._check(input);
      const server = await e._start(session), definition = await this.locate(session, server, input.name);
      const scope = await this.subject(session, definition), siblings = await this.siblings(session, definition);
      parseBody(definition.body, definition, scope.columns);
      orderClause(siblings, definition.name);
      const id = randomUUID();
      while (e.models.size >= this.limits.models) e.models.delete(e.models.keys().next().value);
      e.models.set(id, { id, server, original: { definition }, definition, scope, siblings, expiresAt: Date.now() + this.limits.lifetimeMs });
      return { modelId: id, kind: 'trigger', name: definition.name, database: server.database, source: definition.body,
        table: definition.table, event: definition.event, timing: definition.timing, originalOrder: siblings.map(item => item.name),
        bodyOnly: true, validationCreatesOwnedObject: true };
    });
  }
  async preview(input, model) {
    const e = this.editor, definition = model.definition;
    const body = A.render(parseBody(input.source, definition, model.scope.columns));
    e.applying = true;
    try {
      return await e.transport._withSession(async session => {
        const server = await e._start(session);
        await e._locks(session, server);
        e._check(input);
        if (!same(server, model.server) || !same(await this.locate(session, server, definition.name), definition) ||
            !same(await this.subject(session, definition), model.scope) || !same(await this.siblings(session, definition), model.siblings))
          throw fail('The trigger, table, order or session context changed after source inspection.');
        await e._journal(session, true);
        const id = randomUUID().replaceAll('-', ''), stage = '__rb_object_' + id.slice(0, 24), shadow = stage + '_t';
        const record = { format: 'RocketbrainObjectAuthoring', formatVersion: 1, id, server, kind: 'trigger', name: definition.name,
          original: { definition }, replacement: { body }, scope: model.scope, siblings: model.siblings, stage, shadow, state: 'compiling' };
        record.fingerprint = this.fingerprint(record);
        await e._save(session, record);
        try {
          await this.compile(session, server, record);
        } catch (error) {
          record.state = 'validation-failed';
          if (session.connected) await e._save(session, record);
          throw error;
        }
        e._check(input);
        record.state = 'reviewed';
        await e._save(session, record);
        const reviewId = randomUUID(), clause = orderClause(record.siblings, record.name);
        const review = { reviewId, operationId: id, kind: 'trigger', name: record.name, table: definition.table,
          expiresAt: Date.now() + 120000, requiresImplicitCommitApproval: true, requiresTriggerReplacementApproval: true,
          validation: { compiled: true, executed: false, cleaned: true, isolatedSubject: true },
          sql: ['-- Pause table writers and external schema edits until the verified outcome.',
            '-- The extension takes a table write lock. A connection loss can interrupt DROP and CREATE.',
            'DROP TRIGGER ' + qualified(definition.schema, record.name) + ';',
            createReplacement(definition, body, record.name, definition.table, clause) + ';'].join('\n') };
        while (e.reviews.size >= this.limits.reviews) e.reviews.delete(e.reviews.keys().next().value);
        e.reviews.set(reviewId, { record: structuredClone(record), review: structuredClone(review) });
        return review;
      });
    } finally { e.applying = false; }
  }
  fingerprint(record) {
    return O.hash([record.server, record.id, record.original, record.replacement, record.scope, record.siblings, record.stage, record.shadow]);
  }
  validateRecord(record, server) {
    supportedServer(server);
    const definition = record.original?.definition;
    if (record.formatVersion !== 1 || !definition || definition.kind !== 'trigger' || definition.schema !== server.database || definition.name !== record.name ||
        definition.definer !== server.currentUser || definition.timing !== 'BEFORE' || !['INSERT', 'UPDATE'].includes(definition.event) ||
        !knownStates.has(record.state) || record.stage !== '__rb_object_' + record.id.slice(0, 24) || record.shadow !== record.stage + '_t' ||
        !Array.isArray(record.scope?.columns) || !Array.isArray(record.siblings) || record.siblings.length > 32 ||
        record.fingerprint !== this.fingerprint(record)) throw fail('The retained trigger review or environment changed.');
    D.name(definition.table);
    for (const sibling of record.siblings) D.name(sibling.name);
    for (const value of [definition.charset, definition.collation, definition.databaseCollation]) D.safe(value);
    if (!/^[A-Za-z0-9_,]*$/u.test(definition.sqlMode) || originalBoundary(definition.ddl, definition) !== definition.boundary)
      throw fail('The retained trigger source context changed.');
    parseBody(definition.body, definition, record.scope.columns);
    parseBody(record.replacement.body, definition, record.scope.columns);
    orderClause(record.siblings, record.name);
    return record;
  }
  async withLock(session, definition, action) {
    await this.editor.db._control(session, 'LOCK TABLES ' + qualified(definition.schema, definition.table) +
      ' WRITE, ' + qualified(definition.schema, this.journal) + ' WRITE', 10000);
    try { return await action(); }
    finally { if (session.connected) await this.editor.db._control(session, 'UNLOCK TABLES', 5000); }
  }
  async compare(session, record, server) {
    const definition = record.original.definition;
    const current = await this.locate(session, server, record.name, true), siblings = await this.siblings(session, definition);
    if (!same(await this.subject(session, definition), record.scope) ||
        !same(siblings.filter(item => item.name !== record.name), record.siblings.filter(item => item.name !== record.name)) ||
        current && !same(siblings.map(item => item.name), record.siblings.map(item => item.name))) {
      throw fail('The subject table or trigger order changed since review.');
    }
    return current;
  }
  isReplacement(current, record) {
    if (!current) return false;
    const fixed = ({ ddl, boundary, body, ...identity }) => identity;
    const original = record.original.definition;
    return same(fixed(current), fixed(original)) && current.body === record.replacement.body;
  }
  async apply(input, saved) {
    const e = this.editor;
    if (input.allowImplicitCommit !== true || input.allowTriggerReplacement !== true)
      throw fail('Acknowledge the exact reviewed trigger DDL and pause all subject-table writers until verification.');
    e._check(input);
    e.reviews.delete(input.reviewId);
    e.applying = true;
    try {
      return await e.transport._withSession(async session => {
        const server = await e._start(session);
        await e._locks(session, server);
        const record = await e._load(session, saved.record.id, server), definition = record.original.definition;
        if (!same(record, saved.record)) throw fail('The durable reviewed trigger changed.');
        return this.withLock(session, definition, async () => {
          if (!same(await this.compare(session, record, server), definition)) throw fail('The exact original trigger changed after review.');
          e._check(input);
          return this.replace(session, record, server, { input, restore: false, drop: true });
        });
      });
    } finally { e.applying = false; e.db._revision++; e.db._editor.models.clear(); e.db._editor.reviews.clear(); }
  }
  async replace(session, record, server, { input, restore, drop }) {
    const e = this.editor, definition = record.original.definition;
    const clause = orderClause(record.siblings, record.name);
    const previous = record.state;
    e._check(input);
    record.state = restore ? 'restore-pending' : 'drop-pending';
    await e._save(session, record);
    try { e._check(input); }
    catch (error) {
      record.state = previous;
      if (session.connected) await e._save(session, record);
      throw error;
    }
    try {
      if (drop) await this.write(session, 'DROP TRIGGER ' + qualified(definition.schema, record.name));
      if (!restore) { record.state = 'create-pending'; await e._save(session, record); }
      const ddl = restore ? definition.ddl.slice(0, definition.boundary) + clause + definition.ddl.slice(definition.boundary)
        : createReplacement(definition, record.replacement.body, record.name, definition.table, clause);
      // Complete the reviewed replacement while the subject is locked, even if UI cancellation arrives after DROP.
      await e._context(session, definition, () => this.write(session, ddl));
      const observed = await this.compare(session, record, server);
      if (restore ? !restoredOriginal(observed, definition) : !this.isReplacement(observed, record))
        throw fail('The reviewed trigger source, context or execution order could not be verified.');
      record.state = restore ? 'recovered' : 'applied';
      await e._save(session, record);
      return { operationId: record.id, state: record.state, verified: true, tableWriteLock: true, orderPreserved: true,
        originalRetained: true, nonAtomicReplacement: true, bodyExecuted: false, autoRetried: false };
    } catch (error) {
      record.state = 'needs-inspection';
      if (session.connected) await e._save(session, record);
      return { operationId: record.id, state: record.state, outcomeUnknown: true, originalRetained: true, bodyExecuted: false,
        autoRetried: false, errorCode: error.code || 'UNKNOWN_DDL_OUTCOME' };
    }
  }
  async recover(session, record, server, input) {
    if (input.allowTriggerReplacement !== true) throw fail('Pause table writers and explicitly approve guarded trigger restoration.');
    const definition = record.original.definition;
    return this.withLock(session, definition, async () => {
      const current = await this.compare(session, record, server);
      if (restoredOriginal(current, definition)) return { operationId: record.id, state: 'original-verified', bodyExecuted: false, autoRetried: false,
        ...(['compiling', 'validation-failed'].includes(record.state) &&
          { validationArtifactsMayRemain: true, validationObjects: [record.stage, record.shadow] }) };
      const mayBeMissing = ['drop-pending', 'create-pending', 'needs-inspection', 'restore-pending'].includes(record.state);
      if (current ? !this.isReplacement(current, record) : !mayBeMissing) throw fail('The live trigger changed outside the reviewed operation.');
      return this.replace(session, record, server, { input, restore: true, drop: Boolean(current) });
    });
  }
}

module.exports = { TriggerSourceEditor, parseBody, originalBoundary, orderClause, restoredOriginal };
