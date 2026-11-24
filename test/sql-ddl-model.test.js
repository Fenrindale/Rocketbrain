'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {parseSchema,analyzeDdlScript}=require('../src/db/ddl-model');
const {completionsAt}=require('../src/db/sql-analysis');

for(const dialect of ['mysql','mariadb']){
  test(dialect+' previews typed view and new columns with statement-order bindings',()=>{
    const {model}=parseSchema(`
      CREATE TABLE demo.people (id BIGINT NOT NULL PRIMARY KEY, nickname VARCHAR(32) DEFAULT 'a; b', amount DECIMAL(20,6) DEFAULT 12.345600) ENGINE=InnoDB;
      CREATE VIEW demo.selection AS SELECT id, nickname FROM demo.people;
    `,'demo',dialect);
    const before=structuredClone(model);
    const report=analyzeDdlScript(`
      SELECT s.nickname FROM demo.selection s;
      DROP VIEW demo.selection;
      ALTER TABLE demo.people ADD COLUMN active BOOLEAN NOT NULL, RENAME COLUMN nickname TO given_name;
      CREATE VIEW demo.current_view AS SELECT id,given_name,amount FROM people;
      SELECT v.given_name,v.amount FROM current_view v;
    `,model);
    assert.equal(report.state,'known',JSON.stringify(report.unknown));
    assert.deepEqual(report.changes.map(item=>item.action),['drop','alter','create']);
    const select=report.statements.at(-1).model;
    assert.deepEqual(select.projections.map(item=>item.type.dbType.toLowerCase()),['varchar(32)','decimal(20,6)']);
    assert.ok(completionsAt(select,select.text.indexOf('v.given_name')+3).some(item=>item.label==='given_name'));
    assert.deepEqual(model,before);
  });
}

test('unknown DDL removes certainty and never treats a cross-schema or live view as a local column binding',()=>{
  const {model}=parseSchema('CREATE TABLE person (id INT); CREATE VIEW person_v AS SELECT id FROM person;','fixture','mysql');
  const report=analyzeDdlScript('ALTER TABLE person DROP COLUMN id; SELECT p.made_up FROM person p;',model);
  assert.equal(report.state,'unknown');
  assert.match(report.unknown[0].reason,/depends/);
  assert.deepEqual(report.statements.at(-1).model.diagnostics,[]);
  assert.equal(report.statements.at(-1).model.projections[0].type.family,'unknown');
  assert.equal(analyzeDdlScript('ALTER TABLE other.person ADD extra INTEGER; SELECT extra FROM person;',model).state,'unknown');
  assert.throws(()=>parseSchema('CREATE TABLE clone (id BIGINT) SELECT id FROM person;','fixture','mariadb'),/table options/);
  assert.throws(()=>parseSchema('CREATE TABLE clone (id BIGINT GENERATED ALWAYS AS (1));','fixture','mysql'),/column option/);
  assert.throws(()=>parseSchema('/*!50000 CREATE TABLE clone (id INT) */;','fixture','mysql'),/lexical structure/);
});
