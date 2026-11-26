'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { observeRoutineUsages, procedureReferences } = require('../src/db/catalog-routine-usages');

const quote = name => String.fromCharCode(96) + name + String.fromCharCode(96);
const target = { schema: 'peer', name: 'entity', kind: 'table' };
const local = { schema: 'home', name: 'report', kind: 'procedure' };
const header = 'CREATE DEFINER=' + quote('actor') + '@' + quote('loopback') + ' PROCEDURE ' + quote(local.name) +
  '(IN data_limit INT) READS SQL DATA SQL SECURITY INVOKER COMMENT \'Location fit\' ';
const fullTarget = quote(target.schema) + '.' + quote(target.name);
const source = header + 'BEGIN\r\nSELECT x.id FROM ' + fullTarget + ' x;\r\nSELECT id FROM ' + quote('entity') + ';\r\nEND';
const context = { dialect: 'mysql', version: '8.4.13', database: 'home' };

test('catalog procedure discovery keeps creation context and exact reference offsets', () => {
  assert.deepEqual(procedureReferences({ object:local, source, settings:{ sql_mode:'STRICT_TRANS_TABLES' } }).map(hit =>
    [hit.schema, hit.name, source.slice(hit.start,hit.end)]), [
    ['peer','entity',fullTarget], ['home','entity',quote('entity')]
  ]);
});

test('opaque bodies and compatibility modes cannot establish procedure usages', () => {
  const loaded = { object:local, settings:{sql_mode:''}, dialect:'mysql' };
  for (const body of ['BEGIN SELECT id FROM ' + fullTarget + '; SET @state=1; END',
    "BEGIN SET @text='SELECT id FROM peer.entity'; END", 'SELECT id FROM (SELECT * FROM ' + fullTarget + ') s']) {
    assert.throws(() => procedureReferences({ ...loaded, source:header + body }));
  }
  assert.throws(() => procedureReferences({ ...loaded, source, settings:{sql_mode:'ORACLE,ANSI_QUOTES'} }), /compatibility mode/u);
});

test('bounded scan confirms exact relation, groups withheld and unsupported procedures and checks inventory again', async () => {
  const schemas = ['home','peer'];
  const routines = [['home','dynamic'],['home','report'],['peer','withheld']];
  const names = ['Procedure','sql_mode','Create Procedure','character_set_client','collation_connection','Database Collation'];
  const query = fake();
  function fake({changed=false, hidden=false}={}) {
    let snapshots=0;
    return async (sql, parameters=[]) => {
      assert.match(sql,/^(SELECT|SHOW CREATE PROCEDURE) /u);
      if (sql.startsWith('SELECT VERSION()')) {
        snapshots++;
        return {rows:[['8.4.13','home','fixture','NONE',0]]};
      }
      if (sql.startsWith('SELECT SCHEMA_NAME')) return {rows:(hidden?['home']:schemas).map(schema=>[schema])};
      if (sql.startsWith('SELECT TABLE_TYPE')) {
        assert.deepEqual(parameters,['peer','entity']);
        return {rows:[['BASE TABLE']]};
      }
      if (sql.startsWith('SELECT ROUTINE_SCHEMA')) return {rows:changed&&snapshots>1?routines.slice(0,-1):routines};
      if (sql.startsWith('SELECT ROUTINE_NAME')) return {rows:[[parameters[1]]]};
      const name = routines.find(([schema, procedure]) => sql.endsWith(quote(schema) + '.' + quote(procedure)))[1];
      const body = name === 'report' ? source : name === 'dynamic' ? header + "BEGIN SET @text='SELECT peer.entity'; END" : null;
      return {columns:names,rows:[[name,'',body,'utf8mb4','utf8mb4_bin','utf8mb4_bin']]};
    };
  }
  const request = { target, schemas };
  const report = await observeRoutineUsages(query,context,request);
  assert.equal(report.observedProcedures,3);
  assert.equal(report.hits.length,1);
  const hit=report.hits[0];
  assert.deepEqual(hit.object,local);
  assert.match(hit.sourceSha256,/^[\da-f]{64}$/u);
  assert.match(hit.settingsSha256,/^[\da-f]{64}$/u);
  assert.equal(source.slice(hit.start,hit.end),fullTarget);
  assert.deepEqual(report.opaque.map(item=>item.reason),['unsupported-procedure-body','definition-unavailable']);
  assert.equal(report.executedSql,false);
  await assert.rejects(observeRoutineUsages(fake({hidden:true}),context,request),/missing or hidden/u);
  await assert.rejects(observeRoutineUsages(fake({changed:true}),context,request),/inventory changed/u);
});
