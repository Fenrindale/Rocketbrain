'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { canonical, create, drop, hash, validate } = require('../src/db/object-editor-ddl');
const { SchemaObjectEditor } = require('../src/db/object-editor');
const { inspectFunctionDependents } = require('../src/db/object-editor-function');

const functionModel = {
  kind: 'function', schema: 'shop', name: 'calculate', parameters: [{ mode: 'IN', name: 'amount', type: 'DECIMAL(20,6)' }],
  returnType: 'DECIMAL(20,6)', security: 'INVOKER', definer: 'developer@localhost', sqlMode: 'STRICT_TRANS_TABLES',
  charset: 'utf8mb4', collation: 'utf8mb4_bin', databaseCollation: 'utf8mb4_bin', deterministic: 'YES', dataAccess: 'NO SQL',
  comment: 'Owned formula', source: 'RETURN ROUND(amount + 1.1, 6)'
};

test('scalar function authoring retains signature, security and definition fingerprint with a body-only edit', () => {
  const definition = canonical(functionModel);
  const changed = canonical(definition, 'RETURN ROUND(amount + 2.1, 6);');
  assert.notEqual(changed.definitionHash, definition.definitionHash);
  assert.match(create(changed), /^CREATE DEFINER=CURRENT_USER FUNCTION `shop`.`calculate` \(`amount` DECIMAL\(20,6\)\) RETURNS DECIMAL\(20,6\) LANGUAGE SQL DETERMINISTIC NO SQL SQL SECURITY INVOKER COMMENT 'Owned formula' RETURN ROUND\(amount \+ 2\.1, 6\)$/u);
  assert.deepEqual(validate(changed, { database: 'shop', currentUser: functionModel.definer }), changed);
  assert.throws(() => validate({ ...changed, returnType: 'INT' }, { database: 'shop', currentUser: functionModel.definer }), /typed object/);
  for (const body of ['RETURN shop.extra(amount)', 'RETURN (SELECT 1)', 'RETURN missing_value + 1', 'RETURN amount; DROP TABLE t', 'RETURN @value', 'RETURN NOW()']) {
    assert.throws(() => canonical(functionModel, body));
  }
  assert.throws(() => canonical({ ...functionModel, deterministic: 'NO' }), /deterministic/);
});

test('durable recovery ties the reviewed object kind to the fingerprinted definitions', () => {
  const editor = new SchemaObjectEditor({}), definition = canonical(functionModel), grants = { kind: 'function', rows: [] };
  const server = { currentUser: functionModel.definer, database: functionModel.schema };
  const record = { id: 'f'.repeat(32), format: 'RocketbrainObjectAuthoring', kind: 'function', name: functionModel.name, server,
    original: { definition, grants, hash: hash({ definition, grants }) },
    dependencies: { scope: 'visible-application-schemas', fingerprint: 'a'.repeat(64) } };
  assert.equal(editor._valid(record, record.id, server), record);
  assert.throws(() => editor._valid({ ...record, kind: 'view' }, record.id, server), /name or kind changed/);
  assert.throws(() => editor._valid({ ...record, dependencies: undefined }, record.id, server), /dependency fingerprint changed/);
  assert.throws(() => drop('other-kind', functionModel.schema, functionModel.name), /supported typed object kind/);
});

function catalog({ body = 'select 1', event = true } = {}) {
  return sql => {
    if (sql === 'SHOW GRANTS') return [['GRANT SELECT, SHOW VIEW, TRIGGER ON *.* TO `owner`@`localhost`'],
      ['GRANT ALL PRIVILEGES ON `shop`.* TO `owner`@`localhost`'], ...(event ? [['GRANT EVENT ON `related`.* TO `owner`@`localhost`']] : [])];
    if (sql.includes('SCHEMATA')) return [['related'], ['shop']];
    if (sql.includes('VIEWS')) return [['related', 'derived', body]];
    if (sql.includes('ROUTINES')) return [['shop', 'calculate', 'RETURN amount', 'FUNCTION']];
    if (sql.includes('TRIGGERS') || sql.includes('EVENTS')) return [];
    assert.fail('Unexpected dependency query');
  };
}

test('function review fingerprints all supported application definitions and rejects unsafe dependencies', async () => {
  const first = await inspectFunctionDependents(catalog(), functionModel);
  assert.equal(first.scope, 'visible-application-schemas');
  assert.equal(first.schemas, 2);
  assert.notEqual((await inspectFunctionDependents(catalog({ body: 'select 2' }), functionModel)).fingerprint, first.fingerprint);
  await assert.rejects(inspectFunctionDependents(catalog({ event: false }), functionModel), /verified EVENT visibility/);
  await assert.rejects(inspectFunctionDependents(catalog({ body: 'SELECT `shop`.`calculate`(1)' }), functionModel), /object may depend/);
  await assert.rejects(inspectFunctionDependents(catalog({ body: 'EXECUTE /* dynamic */ IMMEDIATE @source' }), functionModel), /opaque or dynamic/);
  await assert.rejects(inspectFunctionDependents(catalog({ body: null }), functionModel), /opaque or dynamic/);
});
