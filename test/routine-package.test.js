'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { specificationMembers, implementedMembers, listPackages } = require('../src/db/routine-package');

const settings = { sql_mode: 'ANSI_QUOTES,NO_BACKSLASH_ESCAPES' };
const spec = source => ({ object: { kind: 'package', schema: 'database', name: 'accounting' }, settings, source });
const body = source => ({ object: { kind: 'package-body', schema: 'database', name: 'accounting' }, settings, source });
const head = 'CREATE DEFINER="owner"@"127.0.0.1" PACKAGE ';
const declared = 'PROCEDURE "apply_margin"(IN record_id BIGINT, INOUT amount DECIMAL( 32, 6 ), OUT description VARCHAR(25))';

test('MariaDB package browse binds a public procedure to one matching body declaration', () => {
  const members = specificationMembers(spec(head + '"database"."accounting" SQL SECURITY INVOKER COMMENT \'routine; details\' ' +
    declared + '; FUNCTION helper() RETURNS INT; END'));
  assert.deepEqual(members.map(({ kind, name, supported }) => [kind, name, supported]), [
    ['procedure', 'apply_margin', true], ['function', 'helper', true]
  ]);
  assert.deepEqual(members[0].parameters.map(({ ordinal, mode, type, kind }) => [ordinal, mode, type, kind]), [
    [1, 'IN', 'BIGINT', 'integer'], [2, 'INOUT', 'DECIMAL(32,6)', 'decimal'], [3, 'OUT', 'VARCHAR(25)', 'text']
  ]);
  const implementation = head + 'BODY "accounting" DECLARE n INT DEFAULT 1; ' + declared + '; ' +
    'PROCEDURE hidden() BEGIN SELECT 1; END; ' + declared + ' BEGIN SELECT \'PROCEDURE apply_margin\'; END;' +
    ' FUNCTION helper() RETURNS INT BEGIN RETURN 1; END; END';
  assert.deepEqual(implementedMembers(body(implementation), members), members);
  const changed = implementation.replace('INOUT amount', 'OUT amount');
  assert.deepEqual(implementedMembers(body(changed.replace('INOUT amount', 'OUT amount')), members).map(member => member.supported), [false, true]);
});

test('unsupported, colliding and ambiguous package declarations are never callable candidates', () => {
  const loaded = spec(head + 'accounting PROCEDURE no_params(); PROCEDURE unsupported(v TYPE OF t.x); ' +
    'PROCEDURE overloaded(v INT); PROCEDURE Overloaded(v INT, w INT); END;');
  assert.deepEqual(specificationMembers(loaded).map(member => [member.name, member.supported]), [
    ['no_params', true], ['unsupported', false], ['overloaded', false], ['Overloaded', false]
  ]);
  assert.throws(() => specificationMembers({ ...loaded, settings: { sql_mode: 'ORACLE,ANSI_QUOTES' } }), /missing AS or IS/);
  assert.throws(() => specificationMembers(spec(head + 'other PROCEDURE x; END')), /different package/);
  assert.throws(() => specificationMembers(spec(head + 'accounting /*! PROCEDURE bad(); */ END')), /lexer/);
  assert.throws(() => listPackages(() => assert.fail('SQL ran on MySQL'), { dialect: 'mysql', version: '8.4.13' }), /require MariaDB/);
});

test('Oracle package declarations pin typed modes and scalar return across stored sources', () => {
  const oracle = factory => text => ({ ...factory(text), settings: { sql_mode: 'ORACLE,ANSI_QUOTES' } });
  const oracleSpec = oracle(spec), oracleBody = oracle(body);
  const proc = 'PROCEDURE apply_margin(v IN NUMBER(32, 6), m IN OUT NUMBER(32,6), note OUT VARCHAR2(24))';
  const fn = 'FUNCTION total(v NUMBER(32,6)) RETURN NUMBER(32,6)';
  const declaration = head + 'accounting SQL SECURITY INVOKER AS ' + proc + '; ' + fn + '; END accounting;';
  const implementation = head + 'BODY accounting IS ' + proc + ' AS BEGIN NULL; END; ' +
    'FUNCTION hidden(v IN INTEGER) RETURN INTEGER IS BEGIN RETURN v; END; ' + fn + ' IS BEGIN RETURN v; END; END accounting;';
  const members = specificationMembers(oracleSpec(declaration));
  assert.deepEqual(implementedMembers(oracleBody(implementation), members, 'oracle'), members);
  assert.deepEqual(members.map(member => member.name), ['apply_margin', 'total']);
  assert.deepEqual(members[0].parameters.map(({ name, mode, type, kind }) => [name, mode, type, kind]), [
    ['v', 'IN', 'NUMBER(32,6)', 'decimal'], ['m', 'INOUT', 'NUMBER(32,6)', 'decimal'], ['note', 'OUT', 'VARCHAR2(24)', 'text']
  ]);
  assert.deepEqual(members[1].returns, { type: 'NUMBER(32,6)', kind: 'decimal' });
  const returnChanged = implementation.replace(fn, fn.replace('RETURN NUMBER(32,6)', 'RETURN INTEGER'));
  assert.deepEqual(implementedMembers(oracleBody(returnChanged), members, 'oracle').map(member => member.supported), [true, false]);
  assert.throws(() => implementedMembers(body(implementation), members, 'oracle'), /different stored SQL dialects/);
  assert.throws(() => specificationMembers(oracleSpec(declaration.replace('END accounting', 'END another'))), /end boundary/);
});

test('Oracle typed function OUT parameters are discovered without allowing defaults, composite types or ambiguous overloads', () => {
  const source = head + 'accounting AS ' +
    'FUNCTION change_it(v OUT NUMBER) RETURN NUMBER; ' +
    'FUNCTION defaulted(v NUMBER DEFAULT 1) RETURN NUMBER; ' +
    'FUNCTION anchored RETURN t.value%TYPE; ' +
    'FUNCTION collide RETURN NUMBER; FUNCTION Collide(v NUMBER) RETURN NUMBER; END accounting';
  const inspected = specificationMembers({ ...spec(source), settings: { sql_mode: 'ORACLE' } });
  assert.deepEqual(inspected.map(({ name, supported }) => [name, supported]), [
    ['change_it', true], ['defaulted', false], ['anchored', false], ['collide', false], ['Collide', false]
  ]);
  assert.deepEqual(inspected[0].parameters,[{ordinal:1,name:'v',mode:'OUT',type:'NUMBER',kind:'decimal'}]);
  const psm = specificationMembers(spec(head + 'accounting FUNCTION change_it(OUT v DECIMAL(12,2)) RETURNS DECIMAL(12,2); END;'));
  assert.equal(psm[0].supported,false);
  const implemented = { ...body(head + 'BODY accounting AS FUNCTION change_it(v OUT NUMBER) RETURN NUMBER ' +
    'IS BEGIN v := 1; RETURN 2; END; END accounting;'), settings: { sql_mode: 'ORACLE' } };
  assert.equal(implementedMembers(implemented, inspected, 'oracle')[0].supported,true);
  assert.equal(implementedMembers({ ...implemented, source:implemented.source.replace('v OUT','v IN') }, inspected, 'oracle')[0].supported,false);
});
