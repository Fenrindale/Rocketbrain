'use strict';

const assert = require('node:assert/strict');
const fixture = require('./schema-cross-fixture');

const flags = { allowDestructive: true, allowImplicitCommit: true, allowUnverifiedDependencies: true, allowDependencyChanges: true };

async function create(config, related) {
  const control = await fixture.createFixture(config, related);
  const { actor, main, base, src, names } = control;
  names.joinLookup = base + '_join_lookup';
  const lookup = fixture.qualified(related, names.joinLookup);
  const root = { schema: main, name: base + '_joined' };
  const contextual = { schema: main, name: base + '_contextual' };
  const alien = { schema: main, name: base + '_left_join' };
  const routine = ({ schema, name }) => fixture.qualified(schema, name);
  const sql = 'UPDATE ' + src + ' AS dest INNER JOIN ' + lookup + ' AS found ' +
    'ON dest.parent_id=found.tenant AND found.item=dest.id SET dest.kind=found.delta+? WHERE dest.id=?';
  const makeBody = prepare => 'BEGIN SET @rb_join_delta=p_delta; SET @rb_join_id=p_id; ' + prepare +
    '; EXECUTE rb_join_stmt USING @rb_join_delta,@rb_join_id; DEALLOCATE PREPARE rb_join_stmt; END';
  const parameterList = '(IN p_delta INT, IN p_id INT';
  const install = (reference, body, params = parameterList + ')') =>
    actor.query('CREATE PROCEDURE ' + routine(reference) + params + ' MODIFIES SQL DATA SQL SECURITY INVOKER ' + body);
  const close = control.close.bind(control);
  control.close = async () => {
    try {
      for (const entry of [root, contextual, alien]) await actor.query('DROP PROCEDURE IF EXISTS ' + routine(entry));
    } finally { await close(); }
  };
  try {
    await actor.query('CREATE TABLE ' + lookup + ' (tenant INT NOT NULL, item INT NOT NULL, delta INT NOT NULL, ' +
      'UNIQUE KEY lookup_exact (item, tenant)) ENGINE=InnoDB');
    await actor.query('INSERT INTO ' + lookup + ' VALUES(10,1,30),(10,2,77),(20,1,901)');
    await install(root, makeBody("PREPARE rb_join_stmt FROM '" + sql + "'"));
    await install(contextual, makeBody('SET @rb_join_source=p_sql; PREPARE rb_join_stmt FROM @rb_join_source'), parameterList + ', IN p_sql TEXT)');
    await install(alien, makeBody("PREPARE rb_join_stmt FROM '" + sql.replace('INNER JOIN', 'LEFT JOIN') + "'"));
  } catch (error) {
    await control.close();
    throw error;
  }
  async function kinds() {
    const [rows] = await actor.query('SELECT kind FROM ' + src + ' ORDER BY id');
    return rows.map(row => Number(row.kind));
  }
  async function lookupValues() {
    const [rows] = await actor.query('SELECT tenant,item,delta FROM ' + lookup + ' ORDER BY tenant,item');
    return rows.map(row => [Number(row.tenant), Number(row.item), Number(row.delta)]);
  }
  const show = async () => (await actor.query('SHOW CREATE PROCEDURE ' + routine(root)))[0];
  return Object.assign(control, { lookup, root, contextual, alien, sql, kinds, lookupValues, show,
    removeLookupKey: () => actor.query('ALTER TABLE ' + lookup + ' DROP INDEX lookup_exact'),
    restoreLookupKey: () => actor.query('ALTER TABLE ' + lookup + ' ADD UNIQUE KEY lookup_exact (item, tenant)'),
    invokeFixtureProcedure: (extra, id) => actor.execute('CALL ' + routine(root) + '(?,?)', [extra, id]),
    dropAlien: () => actor.query('DROP PROCEDURE ' + routine(alien)) });
}

function assertReport(report, control) {
  assert.equal(report.analysisOnly, true);
  assert.equal(report.executed, false);
  assert.equal(report.routines.length, 1);
  const dynamic = report.routines[0].dynamic;
  assert.equal(dynamic.templates.length, 1);
  const [template] = dynamic.templates;
  assert.equal(template.ast.format, 'RocketbrainPreparedJoinUpdate');
  assert.equal(template.text, control.sql);
  assert.equal(template.placeholders, 2);
  assert.equal(template.returnsRows, false);
  assert.deepEqual(dynamic.readTargets.map(({ schema, table }) => schema + '/' + table).sort(),
    [control.main + '/' + control.base, control.related + '/' + control.names.joinLookup].sort());
  assert.deepEqual(dynamic.writeTargets, [{ schema: control.main, table: control.base }]);
  assert.deepEqual(template.ast.keys, [{ target: 'parent_id', lookup: 'tenant' }, { target: 'id', lookup: 'item' }]);
}

function assertPlan(plan, control) {
  assert.ok(plan.dependencies.lockTables.some(ref => ref.schema === control.related && ref.table === control.names.joinLookup));
  const routine = plan.dependencies.before.routines.find(entry => entry.name === control.root.name);
  assert.ok(routine?.retained);
  assert.equal(routine.dynamic.templates[0].ast.format, 'RocketbrainPreparedJoinUpdate');
  assert.match(plan.sql, /Analyzed prepared template/u);
}

module.exports = { ...fixture, create, assertReport, assertPlan, flags };
