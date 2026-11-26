'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');

const className = 'fixture.sigreturn.ReturnClient';
const sourcePath = path.join('src', 'main', 'java', 'fixture', 'sigreturn', 'ReturnClient.java');
const units = new Map([[sourcePath, [
  'package fixture.sigreturn;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class ReturnClient {',
  '    private static Number narrowValue(Integer value) { return value; }',
  '    private static Number inferredValue(Integer value) { return value; }',
  '    private static Number argumentValue(Integer value) { return value; }',
  '    private static Number widenGuard(Integer value) { return value; }',
  '    private static Number bodyGuard(Number value) { return value; }',
  '    private static Number computedValue(Integer value) { return Integer.valueOf(value); }',
  '    private static int primitiveValue(int value) { return value; }',
  '    private static int consumeInferred(Integer input) { var value = inferredValue(input); return value.intValue(); }',
  '    private static int overload(Number input) { return 42; }',
  '    private static int overload(Integer input) { return -1; }',
  '    private static int consumeArgument(Integer input) { return overload(argumentValue(input)); }',
  '    private static Number forwardValue(Integer input) { return narrowValue(input); }',
  '    public static void main(String[] args) {',
  '        var data = new DriverManagerDataSource(System.getenv("RB_NARROW_JDBC_URL"),',
  '            System.getenv("RB_NARROW_JDBC_USER"), System.getenv("RB_NARROW_JDBC_PASSWORD"));',
  '        var jdbc = new JdbcTemplate(data);',
  '        Integer db = jdbc.queryForObject("SELECT 40", Integer.class);',
  '        Number stable = narrowValue(db);',
  '        narrowValue(0);',
  '        int result = stable.intValue() + forwardValue(2).intValue();',
  '        System.out.println(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + result);',
  '    }',
  '}', ''
].join('\n')]]);

const before = 'java.lang.Number', after = 'java.lang.Integer';
const selected = 'narrowValue(Integer';
const failures = [
  ['inferredValue(Integer', after, /stable explicitly typed callers/u],
  ['argumentValue(Integer', after, /stable explicitly typed callers/u],
  ['computedValue(Integer', after, /stable explicitly typed callers/u],
  ['primitiveValue(int', after, /stable explicitly typed callers/u],
  ['widenGuard(Integer', 'java.lang.Object', /strict Java reference subtype/u],
  ['bodyGuard(Number', after, /cannot be converted to java\.lang\.Integer/u]
];

async function populateReturnNarrowing(root, classpathFile, engine) {
  await populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), units);
}

async function runReturnNarrowing({ javaHome, root, classes, database, engine, classpathFile }) {
  const result = await runJavaFixture({ javaHome, file: path.join(root, sourcePath), binaryDirectory: classes,
    className, classpath: await springJdbcClasspath(classpathFile, engine), config: database, engine, jdbcPrefix: 'RB_NARROW' });
  assert.equal(result.output.trim(), '42');
  return { ...result, output: result.output.trim() };
}

function assertReturnPlan(info, plan) {
  assert.deepEqual(info.returnNarrowing, { before });
  assert.deepEqual(plan.signature.returnNarrowing, { before, after, verified: true });
  assert.equal(plan.signature.resolvedReferences, 3);
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.deepEqual(plan.signature.before, plan.signature.after);
  assert.equal(plan.documents.length, 1);
  assert.ok(plan.documents[0].before.includes('Number narrowValue(Integer'));
  assert.equal(plan.documents[0].after, plan.documents[0].before.replace('Number narrowValue(Integer', 'Integer narrowValue(Integer'));
}

module.exports = { sourcePath, before, after, selected, failures, selection,
  populateReturnNarrowing, runReturnNarrowing, assertReturnPlan };
