'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');

const className = 'fixture.sigthrows.CheckedClient';
const sourcePath = path.join('src', 'main', 'java', 'fixture', 'sigthrows', 'CheckedClient.java');
const sources = new Map([[sourcePath, [
  'package fixture.sigthrows;',
  'import java.io.IOException;',
  'import java.sql.SQLException;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class CheckedClient {',
  '    private static int trimDeclared(int value) throws IOException, SQLException { return value; }',
  '    private static int addDeclared(int value) { return value; }',
  '    private static int catchRequired(int value) throws IOException { return value; }',
  '    private static int unhandledCall(int value) { return value; }',
  '    private static int actualThrow(int value) throws IOException { throw new IOException(); }',
  '    private static int rejectUnchecked(int value) { return value; }',
  '    private static int withComment(int value) throws /* keep this explanation */ IOException { return value; }',
  '    public static int publicDecl(int value) throws IOException { return value; }',
  '    private static int addHandled(int value) throws IOException { return addDeclared(value); }',
  '    static int readsCatch(int value) {',
  '        try { return catchRequired(value); } catch (IOException expected) { return -1; }',
  '    }',
  '    static int readsUnhandled(int value) { return unhandledCall(value); }',
  '    public static void main(String[] args) throws IOException, SQLException {',
  '        var data = new DriverManagerDataSource(System.getenv("RB_THROWS_JDBC_URL"),',
  '            System.getenv("RB_THROWS_JDBC_USER"), System.getenv("RB_THROWS_JDBC_PASSWORD"));',
  '        var jdbc = new JdbcTemplate(data);',
  '        int stored = jdbc.queryForObject("SELECT 40", Integer.class);',
  '        int result = trimDeclared(stored) + addHandled(2);',
  '        System.out.println(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + result);',
  '    }',
  '}', ''
].join('\n')]]);

const io = 'java.io.IOException', sql = 'java.sql.SQLException';
const operations = [
  { marker: 'trimDeclared(int', before: [io, sql], after: [sql],
    oldClause: 'trimDeclared(int value) throws IOException, SQLException {',
    newClause: 'trimDeclared(int value) throws SQLException {' },
  { marker: 'addDeclared(int', before: [], after: [io],
    oldClause: 'addDeclared(int value) {', newClause: 'addDeclared(int value) throws IOException {' }
];
const failures = [
  ['catchRequired(int', [], /exception java\.io\.IOException is never thrown/u],
  ['unhandledCall(int', [io], /unreported exception java\.io\.IOException/u],
  ['actualThrow(int', [], /unreported exception java\.io\.IOException/u],
  ['rejectUnchecked(int', ['java.lang.IllegalStateException'], /exact checked exception classes/u],
  ['withComment(int', [], /editable throws clause/u],
  ['publicDecl(int', [], /concrete private/u]
];

async function populateCheckedThrows(root, classpathFile, engine) {
  await populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), sources);
}

async function runCheckedThrows({ javaHome, root, classes, database, engine, classpathFile }) {
  const result = await runJavaFixture({ javaHome, file: path.join(root, sourcePath), binaryDirectory: classes,
    className, classpath: await springJdbcClasspath(classpathFile, engine), config: database, engine, jdbcPrefix: 'RB_THROWS' });
  assert.equal(result.output.trim(), '42');
  return { ...result, output: result.output.trim() };
}

function assertCheckedThrowsPlan(info, plan, operation) {
  assert.deepEqual(info.checkedThrows, { before: operation.before });
  assert.deepEqual(plan.signature.checkedThrows, { before: operation.before, after: operation.after, verified: true });
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.deepEqual(plan.signature.before, plan.signature.after);
  assert.equal(plan.documents.length, 1);
  assert.ok(plan.documents[0].before.includes(operation.oldClause));
  assert.equal(plan.documents[0].after, plan.documents[0].before.replace(operation.oldClause, operation.newClause));
}

module.exports = { sourcePath, operations, failures, selection, populateCheckedThrows, runCheckedThrows, assertCheckedThrowsPlan };
