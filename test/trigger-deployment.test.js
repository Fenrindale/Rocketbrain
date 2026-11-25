'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBody, originalBoundary, orderClause, restoredOriginal } = require('../src/db/object-editor-trigger');

const q = String.fromCharCode(96);
const header = 'CREATE DEFINER=' + q + 'owner' + q + '@' + q + 'localhost' + q + ' TRIGGER normalizer BEFORE INSERT ON source FOR EACH ROW';
const body = 'BEGIN SET NEW.score = NEW.score + 1; END';
const value = { schema: 'fixture', name: 'normalizer', table: 'source', timing: 'BEFORE', event: 'INSERT',
  sqlMode: '', definer: 'owner@localhost', body, ddl: header + ' ' + body, boundary: header.length };
const columns = [
  { name: 'id', extra: 'auto_increment', generation: '' },
  { name: 'score', extra: '', generation: '' },
  { name: 'stored', extra: 'STORED GENERATED', generation: 'score * 2' }
];

test('structured trigger editing limits NEW assignments and validates event-aware row fields', () => {
  assert.equal(parseBody(body, value, columns).statements[0].kind, 'block');
  assert.ok(parseBody('SET NEW.score = OLD.score + 7', { ...value, event: 'UPDATE' }, columns));
  assert.throws(() => parseBody('SET NEW.score = OLD.score + 7', value, columns), /incompatible/);
  assert.throws(() => parseBody('SET NEW.id = 4', value, columns), /without AUTO_INCREMENT/);
  assert.throws(() => parseBody('SET NEW.stored = 4', value, columns), /without AUTO_INCREMENT/);
  assert.throws(() => parseBody('BEGIN SET NEW.score = 3; INSERT INTO audit (score) VALUES (1); END', value, columns), /assignments to NEW/);
  assert.throws(() => parseBody('SET NEW.score = app.calculate(NEW.score)', value, columns), /Stored or unsupported/);
});

test('exact original body and header are pinned and MariaDB restored separator formatting is tolerated', () => {
  assert.equal(originalBoundary(value.ddl, value), value.boundary);
  assert.throws(() => originalBoundary(value.ddl.replace('owner', 'peer'), value), /definer header/);
  assert.throws(() => originalBoundary(value.ddl.replace('source', 'another'), value), /identity/);
  assert.throws(() => originalBoundary(value.ddl.replace('NEW.score + 1', 'NEW.score + 2'), value), /differs from its server metadata/);
  assert.equal(restoredOriginal({ ...value, ddl: header + '  ' + body }, value), true);
  assert.equal(restoredOriginal({ ...value, ddl: header + ' ' + body.replace('+ 1', '+ 2') }, value), false);
});

test('order preserves a middle position and an end position with an explicit anchor', () => {
  const siblings = ['first', 'normalizer', 'last'].map(name => ({ name }));
  assert.equal(orderClause(siblings, 'normalizer'), ' PRECEDES ' + q + 'last' + q);
  assert.equal(orderClause(siblings, 'last'), ' FOLLOWS ' + q + 'normalizer' + q);
  assert.equal(orderClause([{ name: 'normalizer' }], 'normalizer'), '');
  assert.throws(() => orderClause(siblings, 'missing'), /unobserved/);
});
