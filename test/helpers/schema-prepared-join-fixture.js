'use strict';

const assert = require('node:assert/strict');
const fixture = require('./schema-cross-fixture');

const flags = { allowDestructive: true, allowImplicitCommit: true, allowUnverifiedDependencies: true, allowDependencyChanges: true };

async function create(config, related, { withCte = false } = {}) {
  const control = await fixture.createFixture(config, related);
  const { actor, main, base, src, names } = control;
  names.joinLookup = base + '_join_lookup';
  const lookup = fixture.qualified(related, names.joinLookup);
  const root = { schema: main, name: base + '_joined' };
  const contextual = { schema: main, name: base + '_contextual' };
  const alien = { schema: main, name: base + '_left_join' };
  const routine = ({ schema, name }) => fixture.qualified(schema, name);
  const columns = withCte ? ['tenant_key', 'item_key', 'next_value'] : ['tenant', 'item', 'delta'];
  const cte = withCte ? 'WITH selected_lookup AS (SELECT phys.tenant AS tenant_key, phys.item AS item_key, ' +
    'phys.delta AS next_value FROM ' + lookup + ' AS phys WHERE phys.tenant=?) ' : '';
  const sql = cte + 'UPDATE ' + src + ' AS dest INNER JOIN ' + (withCte ? 'selected_lookup' : lookup) + ' AS found ' +
    'ON dest.parent_id=found.' + columns[0] + ' AND found.' + columns[1] + '=dest.id SET dest.kind=found.' + columns[2] + '+? WHERE dest.id=?';
  const makeBody = prepare => 'BEGIN SET @rb_join_delta=p_delta; SET @rb_join_id=p_id; ' +
    (withCte ? 'SET @rb_join_tenant=p_tenant; ' : '') + prepare +
    '; EXECUTE rb_join_stmt USING ' + (withCte ? '@rb_join_tenant,' : '') +
    '@rb_join_delta,@rb_join_id; DEALLOCATE PREPARE rb_join_stmt; END';
  const parameterList = '(IN p_delta INT, IN p_id INT' + (withCte ? ', IN p_tenant INT' : '');
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
  return Object.assign(control, { lookup, root, contextual, alien, sql, kinds, lookupValues, show, withCte,
    removeLookupKey: () => actor.query('ALTER TABLE ' + lookup + ' DROP INDEX lookup_exact'),
    restoreLookupKey: () => actor.query('ALTER TABLE ' + lookup + ' ADD UNIQUE KEY lookup_exact (item, tenant)'),
    invokeFixtureProcedure: (extra, id, tenant = 10) => withCte ?
      actor.execute('CALL ' + routine(root) + '(?,?,?)', [extra, id, tenant]) :
      actor.execute('CALL ' + routine(root) + '(?,?)', [extra, id]),
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
  assert.equal(template.placeholders, control.withCte ? 3 : 2);
  assert.equal(template.returnsRows, false);
  assert.deepEqual(dynamic.readTargets.map(({ schema, table }) => schema + '/' + table).sort(),
    [control.main + '/' + control.base, control.related + '/' + control.names.joinLookup].sort());
  assert.deepEqual(dynamic.writeTargets, [{ schema: control.main, table: control.base }]);
  if (control.withCte) {
    assert.deepEqual(template.ast.cte, { name: 'selected_lookup',
      from: { table: { schema: control.related, table: control.names.joinLookup }, alias: 'phys' },
      projections: [{ column: 'tenant', output: 'tenant_key' }, { column: 'item', output: 'item_key' },
        { column: 'delta', output: 'next_value' }], filter: { column: 'tenant', value: { kind: 'parameter' } } });
    assert.deepEqual(template.ast.keys, [{ target: 'parent_id', lookup: 'tenant_key' }, { target: 'id', lookup: 'item_key' }]);
  } else {
    assert.deepEqual(template.ast.keys, [{ target: 'parent_id', lookup: 'tenant' }, { target: 'id', lookup: 'item' }]);
  }
}

function assertPlan(plan, control) {
  assert.ok(plan.dependencies.lockTables.some(ref => ref.schema === control.related && ref.table === control.names.joinLookup));
  const routine = plan.dependencies.before.routines.find(entry => entry.name === control.root.name);
  assert.ok(routine?.retained);
  assert.equal(routine.dynamic.templates[0].ast.format, 'RocketbrainPreparedJoinUpdate');
  if (control.withCte) {
    assert.deepEqual(plan.dependencies.preparedCteServer, {
      dialect: plan.currentServer.dialect,
      version: plan.currentServer.version
    });
    assert.equal(routine.dynamic.templates[0].ast.cte.name, 'selected_lookup');
    assert.equal(plan.dependencies.lockTables.some(ref => ref.table === 'selected_lookup'), false);
  }
  assert.match(plan.sql, /Analyzed prepared template/u);
}

module.exports = { ...fixture, create, assertReport, assertPlan, flags };
