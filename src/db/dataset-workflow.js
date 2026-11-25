'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { SchemaRenamer, identifier } = require('./schema-rename');
const { newSession } = require('./import-stream');
const { boundedProjection } = require('./table-transfer-snapshot');
const { canonicalValue, describeType } = require('./schema-conversion');
const { typedCell } = require('./grid');

const limits = Object.freeze({ workflows: 24, columns: 32, keys: 4, rows: 50000, pageRows: 8,
  rowBytes: 64 * 1024, sampleRows: 100, sampleBytes: 1024 * 1024, durationMs: 10 * 60 * 1000, reviewMs: 10 * 60 * 1000 });
const storeKey = 'rocketbrain.database.datasetWorkflows.v1';
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_DATASET_WORKFLOW' });
const quote = name => '`' + identifier(name, { table: true }).replaceAll('`', '``') + '`';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const supported = column => !column.generated && /^(?:(?:tiny|small|medium|big)?int(?:eger)?|(?:decimal|numeric|varchar|varbinary|binary|datetime)(?:\(\d+(?:,\d+)?\))?|date)\b/i.test(column.type);

function describeTable(definition) {
  if (definition.kind !== 'BASE TABLE' || String(definition.engine).toUpperCase() !== 'INNODB') {
    throw fail('Choose two ordinary InnoDB tables for the saved comparison.');
  }
  const columns = definition.columns.filter(supported);
  const keys = definition.indexes.filter(row => row[0] === 'PRIMARY').map(row => row[3]);
  if (!keys.length || keys.length > limits.keys || keys.some(name => !columns.some(column => column.name === name && column.kind === 'integer'))) {
    throw fail('Choose tables with one to four exact integer primary-key columns.');
  }
  return { name: definition.name, keys, columns, definition: digest(definition) };
}

function matchingColumn(target, source) {
  return target && source && target.kind === source.kind && target.type.toLowerCase() === source.type.toLowerCase() &&
    target.charset === source.charset && target.collation === source.collation;
}

function prepareMapping(target, source, payload) {
  if (!Array.isArray(payload) || !payload.length || payload.length + target.keys.length > limits.columns ||
      target.keys.length !== source.keys.length) throw fail('Choose corresponding integer primary keys and at least one supported payload column.');
  const targetNames = new Set(), sourceNames = new Set();
  const keys = target.keys.map((name, index) => ({ target: name, source: source.keys[index], key: true }));
  return [...keys, ...payload.map(pair => ({ target: pair?.target, source: pair?.source, key: false }))].map(pair => {
    const left = target.columns.find(column => column.name === pair.target);
    const right = source.columns.find(column => column.name === pair.source);
    if (!matchingColumn(left, right) || targetNames.has(pair.target) || sourceNames.has(pair.source)) {
      throw fail('Map distinct columns with identical declared SQL types, character sets and collations.');
    }
    targetNames.add(pair.target);
    sourceNames.add(pair.source);
    return { ...pair, left, right, type: describeType(left) };
  });
}

function value(raw, type) {
  return raw === null ? null : canonicalValue(Buffer.isBuffer(raw) ? '0x' + raw.toString('hex') : String(raw), type);
}

function order(left, right) {
  for (let i = 0; i < left.length; i++) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

async function* orderedRows(db, session, schema, table, mapped, side, check) {
  const columns = mapped.map(pair => side === 'target' ? pair.left : pair.right);
  const keys = columns.slice(0, table.keys.length);
  const field = name => 'rb_data.' + quote(name);
  const { fields, headers } = boundedProjection(columns, field, limits.rowBytes);
  const sql = 'SELECT ' + fields + ' FROM ' + quote(schema) + '.' + quote(table.name) + ' AS rb_data';
  const tail = ' ORDER BY ' + keys.map(key => field(key.name)).join(',') + ' LIMIT ' + limits.pageRows;
  const bound = (key, operator) => field(key.name) + operator + 'CAST(? AS ' + (/\bunsigned\b/i.test(key.type) ? 'UNSIGNED' : 'SIGNED') + ')';
  const alternatives = keys.map((key, index) => '(' + [...keys.slice(0, index).map(previous => bound(previous, '=')), bound(key, '>')].join(' AND ') + ')');
  const where = ' WHERE ' + alternatives.join(' OR ');
  let last, seen = 0;
  for (;;) {
    check();
    const values = last ? keys.flatMap((_, index) => last.slice(0, index + 1).map(String)) : [];
    const page = await db._stream(session, sql + (last ? where : '') + tail, values, { maxRows: limits.pageRows, timeoutMs: 10000 }, false);
    check();
    if (page.truncated || !session.connected || page.columns.length !== headers.length || page.columns.some((name, index) => name !== headers[index])) {
      throw fail('The bounded table projection changed during comparison. Refresh and replay.');
    }
    for (const raw of page.rows) {
      if (String(raw.at(-1)) !== '0') throw fail('A comparison row exceeds the 64 KiB wire-size limit. Choose smaller projected columns.');
      const values = mapped.map((pair, index) => value(raw[index], pair.type));
      const key = values.slice(0, keys.length).map(item => BigInt(item));
      if (++seen > limits.rows || last && order(last, key) >= 0) throw fail('The comparison exceeded 50,000 rows per table or lost exact key order.');
      last = key;
      yield { key, values };
    }
    if (page.rows.length < limits.pageRows) return;
  }
}

async function mergeOrdered(target, source, mapped, check, onProgress) {
  let left = await target.next(), right = await source.next(), sampleBytes = 0, examined = 0;
  const summary = { equal: 0, changed: 0, targetOnly: 0, sourceOnly: 0 }, sample = [];
  function record(state, row, changes, original) {
    summary[state]++;
    if (sample.length >= limits.sampleRows) return;
    const entry = { index: sample.length, state, key: row.key.map(String), ...(changes && { changes, original }) };
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (sampleBytes + bytes <= limits.sampleBytes) {
      sampleBytes += bytes;
      sample.push(entry);
    }
  }
  while (!left.done || !right.done) {
    check();
    const relation = left.done ? 1 : right.done ? -1 : order(left.value.key, right.value.key);
    if (relation < 0) { record('targetOnly', left.value); left = await target.next(); }
    else if (relation > 0) { record('sourceOnly', right.value); right = await source.next(); }
    else {
      const { values: old } = left.value;
      const changes = mapped.flatMap((pair, index) => !pair.key && old[index] !== right.value.values[index]
        ? [{ target: pair.target, source: pair.source, previous: old[index], value: right.value.values[index] }] : []);
      if (changes.length) record('changed', left.value, changes, old);
      else summary.equal++;
      left = await target.next(); right = await source.next();
    }
    if (++examined % 256 === 0) await onProgress?.(examined);
  }
  return { summary, sample, omitted: summary.changed + summary.targetOnly + summary.sourceOnly - sample.length };
}

function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80 || /[\x00-\x1f\x7f]/u.test(name)) {
    throw fail('Enter a comparison name of 1–80 characters.');
  }
  return name.trim();
}

function createDatasetWorkflows(storage, withConnection) {
  let report, pendingUpdate = Promise.resolve();
  const read = () => {
    const records = storage.get(storeKey, []);
    return Array.isArray(records) ? records.filter(item => validId(item?.id) && Array.isArray(item.mapping)).slice(0, limits.workflows) : [];
  };
  const list = () => structuredClone(read().map(({ id, name, target, source, mapping }) => ({ id, name, target, source, mapping })));
  const update = change => {
    const operation = pendingUpdate.then(() => storage.update(storeKey, change(read())));
    pendingUpdate = operation.catch(() => {});
    return operation;
  };
  async function withTables({ target, source }, action) {
    if (target === source) throw fail('Choose distinct source and destination tables.');
    identifier(target, { table: true }); identifier(source, { table: true });
    return withConnection(async ({ db, guard }) => {
      const reader = new SchemaRenamer(db, { createSession: (id, _, schema) => newSession(id, true, schema) });
      try {
        return await reader._withSession(async session => {
          const check = () => { if (!guard() || !session.connected) throw fail('The connection or workspace changed. Reopen the comparison.'); };
          const fingerprint = async () => digest([await reader._identity(session), await db._sqlRelatedServer(session)]);
          const observe = async () => ({ target: describeTable(await db._editor.definition(target)), source: describeTable(await db._editor.definition(source)) });
          check();
          const scope = await fingerprint(), tables = await observe();
          check();
          const verify = async () => {
            const current = await observe();
            if (await fingerprint() !== scope || current.target.definition !== tables.target.definition || current.source.definition !== tables.source.definition) {
              throw fail('The table definition or physical connection changed during comparison. Refresh and replay.');
            }
            check();
          };
          return await action({ db, session, scope, tables, check, verify });
        });
      } finally { reader.dispose(); }
    });
  }
  return {
    list,
    inspect(selection) {
      return withTables(selection, async ({ tables, verify }) => {
        const payload = tables.target.columns.filter(left => !tables.target.keys.includes(left.name) &&
          tables.source.columns.some(right => right.name === left.name && !tables.source.keys.includes(right.name) && matchingColumn(left, right)))
          .map(({ name }) => ({ target: name, source: name }));
        if (!payload.length) throw fail('The tables have no same-name exact payload columns to compare.');
        prepareMapping(tables.target, tables.source, payload.slice(0, 1));
        await verify();
        return { payload, keys: tables.target.keys.map((name, index) => ({ target: name, source: tables.source.keys[index] })) };
      });
    },
    save(selection) {
      const name = validateName(selection.name);
      return withTables(selection, async ({ tables, scope, verify }) => {
        const mapping = prepareMapping(tables.target, tables.source, selection.mapping);
        await verify();
        const saved = { id: randomUUID(), name, scope, target: tables.target.name, source: tables.source.name,
          targetDefinition: tables.target.definition, sourceDefinition: tables.source.definition,
          mapping: mapping.filter(pair => !pair.key).map(({ target, source }) => ({ target, source })) };
        await update(current => {
          if (current.length >= limits.workflows) throw fail('Remove an unused saved comparison before saving another.');
          return [...current, saved];
        });
        return saved.id;
      });
    },
    async remove(id) {
      await update(current => {
        if (!validId(id) || !current.some(item => item.id === id)) throw fail('Choose a current saved comparison.');
        return current.filter(item => item.id !== id);
      });
      if (report?.workflow.id === id) report = undefined;
    },
    async replay(id, { cancellation, onProgress } = {}) {
      const workflow = validId(id) && read().find(item => item.id === id);
      if (!workflow) throw fail('Choose a current saved comparison.');
      report = undefined;
      return withTables(workflow, async ({ db, session, scope, tables, check, verify }) => {
        if (workflow.scope !== scope || workflow.targetDefinition !== tables.target.definition || workflow.sourceDefinition !== tables.source.definition) {
          throw fail('The saved comparison belongs to a different server, account or table definition. Choose the tables and mapping again.');
        }
        const deadline = performance.now() + limits.durationMs;
        const validate = () => {
          if (cancellation?.isCancellationRequested) throw fail('Comparison cancelled.');
          if (performance.now() > deadline) throw fail('The saved comparison exceeded its 10-minute read window.');
          check();
        };
        validate();
        const mapped = prepareMapping(tables.target, tables.source, workflow.mapping);
        await db._control(session, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        await db._control(session, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        await db._refreshState(session);
        if (!session.inTransaction) throw fail('The consistent comparison transaction could not be established.');
        const snapshotStartedAt = new Date().toISOString();
        const schema = db._options.database;
        const readers = ['target', 'source'].map(side => orderedRows(db, session, schema, tables[side], mapped, side, validate));
        let result;
        try { result = await mergeOrdered(...readers, mapped, validate, onProgress); }
        finally { await Promise.all(readers.map(reader => reader.return())); }
        validate();
        await verify();
        await db._control(session, 'ROLLBACK');
        await db._refreshState(session);
        if (session.inTransaction) throw fail('The read-only comparison transaction did not close.');
        validate();
        if (!read().some(item => item.id === id)) throw fail('The saved comparison was removed during replay.');
        report = { ...result, id: randomUUID(), created: new Date().toISOString(), workflow, mapped, db };
        return structuredClone({ id: report.id, created: report.created, snapshotStartedAt, target: workflow.target, source: workflow.source,
          summary: result.summary, sample: result.sample.map(({ original, ...visible }) => visible), omitted: result.omitted });
      });
    },
    async reconcile(id, target, indices, assertCurrent) {
      const saved = report;
      const check = () => {
        if (report !== saved || !saved || saved.id !== id || Date.now() - Date.parse(saved.created) > limits.reviewMs ||
            !read().some(item => item.id === saved.workflow.id)) throw fail('Replay the current saved comparison before staging changes.');
        assertCurrent(saved.db);
      };
      check();
      if (!Array.isArray(indices) || !indices.length || indices.length > limits.sampleRows || new Set(indices).size !== indices.length ||
          indices.some(index => !Number.isInteger(index) || saved.sample[index]?.state !== 'changed')) {
        throw fail('Choose distinct changed rows from the current comparison report.');
      }
      const model = target.edit;
      if (!model?.canEdit || model.table !== saved.workflow.target || !Array.isArray(model.rowIds) || model.rowIds.length !== target.rows.length) {
        throw fail('Open the destination in its current writable table grid before staging.');
      }
      const definition = await saved.db._editor.definition(model.table);
      if (digest(definition) !== saved.workflow.targetDefinition) throw fail('The destination definition changed. Replay the saved comparison.');
      check();
      const columns = saved.mapped.map(pair => model.columns.findIndex(column => column.name === pair.target && matchingColumn(column, pair.left)));
      if (columns.includes(-1)) throw fail('The destination columns changed. Replay the comparison.');
      const keyCount = saved.mapped.filter(pair => pair.key).length;
      const visible = new Map(target.rows.map((row, index) => {
        const values = saved.mapped.map((pair, i) => value(row[columns[i]], pair.type));
        return [JSON.stringify(values.slice(0, keyCount)), { index, values }];
      }));
      const updates = indices.map(index => {
        const sample = saved.sample[index], row = visible.get(JSON.stringify(sample.key));
        if (!row || row.values.some((item, i) => item !== sample.original[i])) throw fail('A selected destination row changed or is outside the current grid page.');
        const values = Object.fromEntries(sample.changes.map(change => {
          const column = model.columns.find(item => item.name === change.target);
          if (!column.editable) throw fail('A selected destination column is protected.');
          const cell = change.value === null ? { kind: 'null' } : { kind: 'value', text: change.value };
          typedCell(cell, column);
          return [column.name, cell];
        }));
        return { rowId: model.rowIds[row.index], values };
      });
      const changes = { updates, inserts: [], deletes: [] };
      if (Buffer.byteLength(JSON.stringify(changes)) > limits.sampleBytes) throw fail('Choose at most 1 MiB of staged changes.');
      return { changes, assertFresh: check };
    }
  };
}

module.exports = { createDatasetWorkflows, limits };
