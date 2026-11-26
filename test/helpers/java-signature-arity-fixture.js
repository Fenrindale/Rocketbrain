'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { springJdbcClasspath } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');
const { runVarargsSpring } = require('./java-signature-varargs-fixture');

const targetPath = path.join('src', 'main', 'java', 'fixture', 'sigvarargs', 'VarargsClient.java');
const unrelatedPath = path.join('src', 'main', 'java', 'fixture', 'sigvarargs', 'Unrelated.java');
const callablePath = path.join(path.dirname(targetPath), 'TailCallable.java');
const contractsPath = path.join(path.dirname(targetPath), 'ReferenceContracts.java');
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
  '    private String[] previous;',
  '    private String collect(String label, String... values) {',
  '        String result = label + java.util.Arrays.toString(values) + ":" + (values == previous);',
  '        previous = values;',
  '        return result;',
  '    }',
  '    private static ZeroObjects emptyReference() { return (ZeroObjects) VarargsClient::assemble; }',
  '    private String referenceResults() {',
  '        TwoObjects pair = VarargsClient::assemble;',
  '        FixedObjects fixed = VarargsClient::assemble;',
  '        TwoInts numbers = VarargsClient::sum;',
  '        OneString spread = this::collect;',
  '        UnboundStrings unbound = VarargsClient::collect;',
  '        String[] shared = (String[]) supplied;',
  '        String result = pair.call("P", take("a"), take("b")) + "/" + emptyReference().call("Z")',
  '            + "/" + fixed.call("K", shared) + "/" + fixed.call("L", null) + "/" + numbers.call(3, 4)',
  '            + "/" + spread.call("S", "u") + "/" + spread.call("T", "u")',
  '            + "/" + unbound.call(this, "U", shared) + "/" + unbound.call(this, "V", shared);',
  '        try { unbound.call(null, "N", shared); }',
  '        catch (NullPointerException expected) { return result + "/null-receiver"; }',
  '        throw new AssertionError("The unbound reference accepted a null receiver");',
  '    }',
  '    private static String collision(Object value, Object... rest) { return "spread"; }',
  '    private static String collision(String value, Object[] rest) { return "fixed"; }',
  '    private static String ambiguous() { return collision("sibling"); }',
  '    private static String referenceGuard(String label, int count, Object... values) { return "reference"; }',
  '    private static TailCallable retained() { return VarargsClient::referenceGuard; }',
  '    private String receiverGuard(String label, String... values) { return label; }',
  '    private static OneString evaluatedReceiver() { return new VarargsClient()::receiverGuard; }',
  '    private String unboundGuard(String label, String... values) { return label; }',
  '    private static UnboundSpread nullableReceiver() { return VarargsClient::unboundGuard; }',
  '    private static int boxedGuard(int... values) { return values[0]; }',
  '    private static BoxedInt boxed() { return VarargsClient::boxedGuard; }',
  '    private static String inferredGuard(String label, String... values) { return label; }',
  '    private static OneString infer(OneString callback) { return callback; }',
  '    private static OneString indirect() { return infer(VarargsClient::inferredGuard); }',
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
  '            + ":" + sum() + "." + sum(1, 2) + "." + sum(new int[] {4})',
  '            + ":" + new VarargsClient().referenceResults() + ":" + trace);',
  '    }',
  '}', ''
].join('\n')], [unrelatedPath, 'package fixture.sigvarargs;\nfinal class Unrelated { String value() { return "original"; } }\n'],
[contractsPath, [
  'package fixture.sigvarargs;',
  'interface TwoObjects { String call(String label, Object first, Object second); }',
  'interface ZeroObjects { String call(String label); }',
  'interface FixedObjects { String call(String label, String[] values); }',
  'interface TwoInts { int call(int first, int second); }',
  'interface BoxedInt { int call(Integer value); }',
  'interface OneString { String call(String label, String value); }',
  'interface UnboundStrings { String call(VarargsClient client, String label, String[] values); }',
  'interface UnboundSpread { String call(VarargsClient client, String label, String value); }',
  ''
].join('\n')],
[callablePath, 'package fixture.sigvarargs;\ninterface TailCallable extends java.io.Serializable { String call(String label, int count, Object[] values); }\n']]);

const expectedResult = '42:A[]/B[x, y]/Csame/D[[shared]]/EN/FN/G[explicit]/Q[r]:ABxyQr:0.3.4'
  + ':P[a, b]/Z[]/Ksame/LN/7/S[u]:false/T[u]:false/U[shared]:false/V[shared]:true/null-receiver:ABxyQrab';
const rejected = [['referenceGuard(String', /Varargs method references/u],
  ['receiverGuard(String', /Varargs method references/u], ['unboundGuard(String', /Varargs method references/u],
  ['boxedGuard(int', /Varargs method references/u], ['inferredGuard(String', /Varargs method references/u],
  ['polyGuard(Object', /non-generic.*at least two|array conversion evidence/u]];
const facts = { from: 'varargs', to: 'array', componentType: 'java.lang.Object', spreadCalls: 4, fixedArrayCalls: 4,
  adaptedSpreadReferences: 2, retainedArrayReferences: 1 };
const primitiveFacts = { from: 'varargs', to: 'array', componentType: 'int', spreadCalls: 2, fixedArrayCalls: 1,
  adaptedSpreadReferences: 1, retainedArrayReferences: 0 };
const instanceFacts = { from: 'varargs', to: 'array', componentType: 'java.lang.String', spreadCalls: 0, fixedArrayCalls: 0,
  adaptedSpreadReferences: 1, retainedArrayReferences: 1 };

async function populateArity(root, classpathFile, engine) {
  return populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), sources);
}

function runAritySpring(options) {
  return runVarargsSpring({ ...options, units: sources, expectedResult });
}

function assertArityPlan(info, plan, expectedFacts = facts) {
  assert.deepEqual(info.arityConversion, expectedFacts);
  assert.deepEqual(plan.signature.arityConversion, { ...expectedFacts, verified: true });
  assert.equal(plan.signature.resolvedReferences, expectedFacts.spreadCalls + expectedFacts.fixedArrayCalls +
    expectedFacts.adaptedSpreadReferences + expectedFacts.retainedArrayReferences);
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.equal(plan.signature.adaptedMethodReferences, expectedFacts.adaptedSpreadReferences);
  assert.equal(plan.documents.length, 1);
  assert.match(plan.signature.before.at(-1).type, /\.\.\.$/u);
  assert.match(plan.signature.after.at(-1).type, /\[\]$/u);
  const after = plan.documents[0].after;
  if (expectedFacts === instanceFacts) {
    assert.match(after, /private String collect\(String label, String\[\] values\)/u);
    assert.match(after, /OneString spread = .* -> this\.collect\(signatureArgument\d+, new java\.lang\.String\[\] \{signatureArgument\d+\}\)/u);
    assert.ok(after.includes('UnboundStrings unbound = VarargsClient::collect;'));
    return;
  }
  if (expectedFacts === primitiveFacts) {
    assert.match(after, /private static int sum\(int\[\] values\)/u);
    assert.match(after, /sum\(new int\[\] \{1, 2\}\)/u);
    assert.match(after, /sum\(new int\[\] \{\}\)/u);
    assert.match(after, /TwoInts numbers = .* -> VarargsClient\.sum\(new int\[\] \{signatureArgument\d+, signatureArgument\d+\}\)/u);
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
  assert.match(after, /TwoObjects pair = .* -> VarargsClient\.assemble\(signatureArgument\d+, new java\.lang\.Object\[\] \{signatureArgument\d+, signatureArgument\d+\}\)/u);
  assert.match(after, /\(ZeroObjects\) \(signatureArgument\d+\) -> VarargsClient\.assemble\(signatureArgument\d+, new java\.lang\.Object\[\] \{\}\)/u);
  assert.ok(after.includes('FixedObjects fixed = VarargsClient::assemble;'));
}

module.exports = { targetPath, unrelatedPath, sources, marker, selection, rejected, facts, primitiveFacts, instanceFacts,
  populateArity, runAritySpring, assertArityPlan };
