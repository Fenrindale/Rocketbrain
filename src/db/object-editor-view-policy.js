'use strict';

const D = require('./schema-designer-ddl');
const { parseView } = require('./schema-dependency-graph');
const { hash } = require('./object-editor-ddl');

const viewCheckOptions = Object.freeze(['NONE', 'LOCAL', 'CASCADED']);
const fail = message => Object.assign(Error(message), { code: 'ROCKETBRAIN_OBJECT_EDITOR' });
const maxRelations = 8;
const visibleSqlBytes = 256 * 1024;
const exact = 'BINARY TABLE_SCHEMA=BINARY ? AND BINARY TABLE_NAME=BINARY ?';

function withCheckOption(definition, requested) {
  if (requested === undefined) return definition;
  if (definition.kind !== 'view' || !viewCheckOptions.includes(requested)) {
    throw fail('Choose NONE, LOCAL or CASCADED for an existing view.');
  }
  return { ...definition, checkOption: requested };
}

function policyChange(previous, proposed) {
  if (previous?.kind !== 'view' || previous.checkOption === proposed?.checkOption) return null;
  if (!viewCheckOptions.includes(previous.checkOption) || !viewCheckOptions.includes(proposed?.checkOption)) {
    throw fail('The reviewed view CHECK OPTION changed.');
  }
  return { from: previous.checkOption, to: proposed.checkOption };
}

function sameInput(previous, proposed) {
  if (previous.targets?.length !== 1 || proposed.targets?.length !== 1 ||
      previous.targets[0].schema !== proposed.targets[0].schema ||
      previous.targets[0].table !== proposed.targets[0].table) {
    throw fail('Change CHECK OPTION on an updatable single-relation view while preserving its observed input relation.');
  }
}

async function viewPolicyOf(read, schema, name) {
  const rows = await read('SELECT VIEW_DEFINITION,CHECK_OPTION,IS_UPDATABLE,SECURITY_TYPE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION ' +
    'FROM information_schema.VIEWS WHERE ' + exact + ' LIMIT 2', [schema, name]);
  const [row] = rows;
  if (rows.length !== 1 || typeof row?.[0] !== 'string' || !row[0] || row[2] !== 'YES' || !viewCheckOptions.includes(row[1])) {
    throw fail('CHECK OPTION changes require an observed updatable view and readable source for each underlying view.');
  }
  return row;
}

async function inspectViewPolicy(read, previous, proposed) {
  sameInput(previous, proposed);
  const root = previous.schema;
  const own = await viewPolicyOf(read, root, previous.name);
  if (own[1] !== previous.checkOption) throw fail('The live view CHECK OPTION changed. Inspect its source again.');
  let focus = previous.targets[0];
  const seen = new Set([previous.name]), chain = [];
  for (;;) {
    const { schema, table } = focus;
    if (schema !== root || seen.has(table) || seen.size > maxRelations) {
      throw fail('CHECK OPTION changes require a bounded set of unique same-schema view dependencies.');
    }
    D.name(table);
    seen.add(table);
    const matches = await read('SELECT TABLE_TYPE FROM information_schema.TABLES WHERE ' + exact + ' LIMIT 2', [schema, table]);
    const kind = matches[0]?.[0];
    if (matches.length !== 1 || !['BASE TABLE','VIEW'].includes(kind)) {
      throw fail('A CHECK OPTION dependency is absent or has an unsupported relation type.');
    }
    const quote = D.q(schema) + '.' + D.q(table);
    const shown = await read('SHOW CREATE ' + (kind === 'VIEW' ? 'VIEW ' : 'TABLE ') + quote);
    const ddl = shown[0]?.[1];
    if (shown.length !== 1 || shown[0][0] !== table || typeof ddl !== 'string' ||
        !ddl.startsWith('CREATE ') || Buffer.byteLength(ddl) > visibleSqlBytes) {
      throw fail('The exact CHECK OPTION dependency definition is unavailable.');
    }
    if (kind === 'BASE TABLE') {
      chain.push({ table, kind, sourceHash: hash(ddl) });
      const fenced = await read("SELECT EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE BINARY TRIGGER_SCHEMA=BINARY ? " +
        "AND BINARY EVENT_OBJECT_TABLE=BINARY ? AND LEFT(TRIGGER_NAME,7)='__rb_f_' LIMIT 1", [schema, table]);
      if (fenced.length) throw fail('A retained schema-recovery fence protects a CHECK OPTION dependency.');
      return { relations: chain.length, fingerprint: hash(chain) };
    }
    const row = await viewPolicyOf(read, schema, table);
    chain.push({ table, kind, sourceHash: hash([row, ddl]) });
    const refs = parseView(row[0], root, { sqlMode: previous.sqlMode }).refs;
    if (refs.length !== 1) throw fail('Observe a single underlying relation at every CHECK OPTION dependency.');
    focus = refs[0];
  }
}

async function checkCompiledViewPolicy(read, schema, name, requested) {
  if ((await viewPolicyOf(read, schema, name))[1] !== requested) {
    throw fail('Server compilation did not retain the selected CHECK OPTION.');
  }
}

function validatePolicyRecord(record) {
  const change = policyChange(record.original?.definition, record.replacement?.definition ?? record.proposed);
  const policy = record.viewPolicy;
  if (change === null && policy === undefined) return;
  if (!change || !policy || change.from !== policy.from || change.to !== policy.to ||
      !Number.isInteger(policy.relations) || policy.relations < 1 || policy.relations > maxRelations ||
      !/^[a-f0-9]{64}$/u.test(policy.fingerprint)) throw fail('The durable view CHECK OPTION review changed.');
  sameInput(record.original.definition, record.replacement?.definition ?? record.proposed);
}

module.exports = { viewCheckOptions, withCheckOption, policyChange, inspectViewPolicy, checkCompiledViewPolicy, validatePolicyRecord };
