'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { springJdbcClasspath } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');
const { runVarargsSpring } = require('./java-signature-varargs-fixture');

const targetPath = path.join('src', 'main', 'java', 'fixture', 'sigvarargs', 'VarargsClient.java');
const unrelatedPath = path.join('src', 'main', 'java', 'fixture', 'sigvarargs', 'Unrelated.java');
const callablePath = path.join(path.dirname(targetPath), 'TailCallable.java');
const marker = 'assemble(String';
const sources = new Map([[targetPath, [
  'package fixture.sigvarargs;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class VarargsClient {',
  '    private static String trace = "";',
  '    private static String take(String value) { trace += value; return value; }',
  '    private static Object[] supplied;',
  '    private static String assemble(String label, Object... values) {',
  '        return label + (values == null ? "N" : (values == supplied ? "same" : java.util.Arrays.deepToString(values)));',
  '    }',
  '    private static int sum(int... values) { return java.util.Arrays.stream(values).sum(); }',
  '    private static String collision(Object value, Object... rest) { return "spread"; }',
  '    private static String collision(String value, Object[] rest) { return "fixed"; }',
  '    private static String ambiguous() { return collision("sibling"); }',
  '    private static String referenceGuard(String label, int count, Object... values) { return "reference"; }',
  '    private static TailCallable retained() { return VarargsClient::referenceGuard; }',
  '    private static String polyGuard(Object... values) { return "generic"; }',
  '    private static String generic() { return polyGuard(java.util.List.of("generic")); }',
  '    private static String otherCaller() { return assemble(take("Q"), take("r")); }',
  '    public static void main(String[] args) {',
  '        var ds = new DriverManagerDataSource(System.getenv("RB_VARARGS_JDBC_URL"),',
  '            System.getenv("RB_VARARGS_JDBC_USER"), System.getenv("RB_VARARGS_JDBC_PASSWORD"));',
  '        var jdbc = new JdbcTemplate(ds);',
  '        supplied = new String[] {"shared"};',
  '        String result = assemble(take("A") /* untouched */)',
  '            + "/" + assemble(take("B"), /* first */ take("x"), take("y") /* last */)',
  '            + "/" + assemble("C", supplied)',
  '            + "/" + assemble("D", (Object) supplied)',
  '            + "/" + assemble("E", null)',
  '            + "/" + assemble("F", (Object[]) null)',
  '            + "/" + assemble("G", new Object[] {"explicit"})',
  '            + "/" + otherCaller();',
  '        System.out.println("RB_VARARGS=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|"',
  '            + jdbc.queryForObject("SELECT 42", Integer.class) + ":" + result + ":" + trace',
  '            + ":" + sum() + "." + sum(1, 2) + "." + sum(new int[] {4}));',
  '    }',
  '}', ''
].join('\n')], [unrelatedPath, 'package fixture.sigvarargs;\nfinal class Unrelated { String value() { return "original"; } }\n'],
[callablePath, 'package fixture.sigvarargs;\ninterface TailCallable { String call(String label, int count, Object[] values); }\n']]);

const expectedResult = '42:A[]/B[x, y]/Csame/D[[shared]]/EN/FN/G[explicit]/Q[r]:ABxyQr:0.3.4';
const rejected = [['referenceGuard(String', /Varargs method references/u],
  ['polyGuard(Object', /non-generic.*at least two|array conversion evidence/u]];
const facts = { from: 'varargs', to: 'array', componentType: 'java.lang.Object', spreadCalls: 4, fixedArrayCalls: 4 };
const primitiveFacts = { from: 'varargs', to: 'array', componentType: 'int', spreadCalls: 2, fixedArrayCalls: 1 };

async function populateArity(root, classpathFile, engine) {
  return populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), sources);
}

function runAritySpring(options) {
  return runVarargsSpring({ ...options, units: sources, expectedResult });
}

function assertArityPlan(info, plan, expectedFacts = facts) {
  assert.deepEqual(info.arityConversion, expectedFacts);
  assert.deepEqual(plan.signature.arityConversion, { ...expectedFacts, verified: true });
  assert.equal(plan.signature.resolvedReferences, expectedFacts.spreadCalls + expectedFacts.fixedArrayCalls);
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.equal(plan.signature.adaptedMethodReferences, 0);
  assert.equal(plan.documents.length, 1);
  assert.match(plan.signature.before.at(-1).type, /\.\.\.$/u);
  assert.match(plan.signature.after.at(-1).type, /\[\]$/u);
  const after = plan.documents[0].after;
  if (expectedFacts === primitiveFacts) {
    assert.match(after, /private static int sum\(int\[\] values\)/u);
    assert.match(after, /sum\(new int\[\] \{1, 2\}\)/u);
    assert.match(after, /sum\(new int\[\] \{\}\)/u);
    return;
  }
  assert.match(after, /private static String assemble\(String label, Object\[\] values\)/u);
  assert.ok(after.includes('assemble(take("A") /* untouched */, new java.lang.Object[] {})'));
  assert.ok(after.includes('assemble(take("B"), /* first */ new java.lang.Object[] {take("x"), take("y")} /* last */)'));
  assert.ok(after.includes('assemble("C", supplied)'));
  assert.ok(after.includes('assemble("D", new java.lang.Object[] {(Object) supplied})'));
  assert.ok(after.includes('assemble("E", null)'));
  assert.ok(after.includes('assemble("F", (Object[]) null)'));
  assert.ok(after.includes('assemble("G", new Object[] {"explicit"})'));
}

module.exports = { targetPath, unrelatedPath, sources, marker, selection, rejected, facts, primitiveFacts,
  populateArity, runAritySpring, assertArityPlan };
