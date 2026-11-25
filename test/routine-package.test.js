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
    ['procedure', 'apply_margin', true], ['function', 'helper', false]
  ]);
  assert.deepEqual(members[0].parameters.map(({ ordinal, mode, type, kind }) => [ordinal, mode, type, kind]), [
    [1, 'IN', 'BIGINT', 'integer'], [2, 'INOUT', 'DECIMAL(32,6)', 'decimal'], [3, 'OUT', 'VARCHAR(25)', 'text']
  ]);
  const implementation = head + 'BODY "accounting" DECLARE n INT DEFAULT 1; ' + declared + '; ' +
    'PROCEDURE hidden() BEGIN SELECT 1; END; ' + declared + ' BEGIN SELECT \'PROCEDURE apply_margin\'; END; END';
  assert.deepEqual(implementedMembers(body(implementation), members), members);
  const changed = implementation.replace('INOUT amount', 'OUT amount');
  assert.deepEqual(implementedMembers(body(changed.replace('INOUT amount', 'OUT amount')), members).map(member => member.supported), [false, false]);
});

test('unsupported, colliding and ambiguous package declarations are never callable candidates', () => {
  const loaded = spec(head + 'accounting PROCEDURE no_params(); PROCEDURE unsupported(v TYPE OF t.x); ' +
    'PROCEDURE overloaded(v INT); PROCEDURE Overloaded(v INT, w INT); END;');
  assert.deepEqual(specificationMembers(loaded).map(member => [member.name, member.supported]), [
    ['no_params', true], ['unsupported', false], ['overloaded', false], ['Overloaded', false]
  ]);
  assert.throws(() => specificationMembers({ ...loaded, settings: { sql_mode: 'ORACLE,ANSI_QUOTES' } }), /SQL\/PSM/);
  assert.throws(() => specificationMembers(spec(head + 'other PROCEDURE x; END')), /different package/);
  assert.throws(() => specificationMembers(spec(head + 'accounting /*! PROCEDURE bad(); */ END')), /lexer/);
  assert.throws(() => listPackages(() => assert.fail('SQL ran on MySQL'), { dialect: 'mysql', version: '8.4.13' }), /require MariaDB/);
});
