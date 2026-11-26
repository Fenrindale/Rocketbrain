'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');

const javaPath = name => path.join('src', 'main', 'java', 'fixture', 'sigvarargs', name + '.java');
const targetPath = javaPath('VarargsTarget'), callerPath = javaPath('VarargsClient');
const marker = 'combine(String';
const negativeTargets = [
  ['effectGuard(String', /effectful or boxing fixed argument/u],
  ['unboxGuard(int', /effectful or boxing fixed argument/u],
  ['referenceGuard(String', /Varargs method references/u],
  ['genericGuard(String', /one non-generic/u]
];
const expected = '42:ab=[]/cd=[x, y]/ef=[array]/gh=[[array]]/ij=N/kl=N/mn=[explicit]/op=[returned]:xyR';

const sources = new Map([
  [targetPath, [
    'package fixture.sigvarargs;',
    'public final class VarargsTarget {',
    '    public static String combine(String left, String right, Object... tail) {',
    '        return left + right + "=" + (tail == null ? "N" : java.util.Arrays.deepToString(tail));',
    '    }',
    '    static String effectGuard(String left, String right, Object... tail) { return left + right; }',
    '    static int unboxGuard(int left, int right, Object... tail) { return left + right; }',
    '    static String referenceGuard(String left, String right, Object... tail) { return left + right; }',
    '    static <T> String genericGuard(String left, String right, Object... tail) { return left + right; }',
    '}', ''
  ].join('\n')],
  [javaPath('VarargFormat'), 'package fixture.sigvarargs;\npublic interface VarargFormat { String apply(String left, String right, Object[] tail); }\n'],
  [callerPath, [
    'package fixture.sigvarargs;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class VarargsClient {',
    '    private static String trace = "";',
    '    private static String take(String item) { trace += item; return item; }',
    '    private static Object[] getTail() { trace += "R"; return new Object[] {"returned"}; }',
    '    private static void refusedSites() {',
    '        Integer boxed = 3;',
    '        VarargsTarget.effectGuard(take("ignored"), "b", "tail");',
    '        VarargsTarget.unboxGuard(boxed, 2, "tail");',
    '        VarargFormat original = VarargsTarget::referenceGuard;',
    '    }',
    '    public static void main(String[] args) {',
    '        var data = new DriverManagerDataSource(System.getenv("RB_VARARGS_JDBC_URL"),',
    '            System.getenv("RB_VARARGS_JDBC_USER"), System.getenv("RB_VARARGS_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(data);',
    '        String[] supplied = new String[] {"array"};',
    '        String result = VarargsTarget.combine("a", "b")',
    '         + "/" + VarargsTarget.combine("c", "d", take("x"), take("y"))',
    '         + "/" + VarargsTarget.combine("e", "f", supplied)',
    '         + "/" + VarargsTarget.combine("g", "h", (Object) supplied)',
    '         + "/" + VarargsTarget.combine("i", "j", (Object[]) null)',
    '         + "/" + VarargsTarget.combine("k", "l", null)',
    '         + "/" + VarargsTarget.combine("m", "n", new Object[] {"explicit"})',
    '         + "/" + VarargsTarget.combine("o", "p", getTail());',
    '        System.out.println("RB_VARARGS=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '            jdbc.queryForObject("SELECT 42", Integer.class) + ":" + result + ":" + trace);',
    '    }',
    '}', ''
  ].join('\n')]
]);

async function populateVarargs(root, classpathFile, engine) {
  return populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), sources);
}

async function runVarargsSpring({ javaHome, root, classes, database, engine, classpathFile }) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const binary = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const dependencies = await springJdbcClasspath(classpathFile, engine);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_VARARGS_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_VARARGS_JDBC_USER = database.user;
  env.RB_VARARGS_JDBC_PASSWORD = database.password;
  const compiled = await execute(binary('javac'), ['-proc:none', '-encoding', 'UTF-8', '-classpath', dependencies.join(path.delimiter),
    '-d', classes, ...[...sources.keys()].map(source => path.join(root, source))], { env, cwd: root, timeoutMs: 30000 });
  assert.equal(compiled.code, 0, compiled.output);
  const run = await execute(binary('java'), ['-classpath', [classes, ...dependencies].join(path.delimiter),
    'fixture.sigvarargs.VarargsClient'], { env, cwd: root, timeoutMs: 30000 });
  assert.equal(run.code, 0, run.output);
  const parts = /^RB_VARARGS=([^|\r\n]+)\|([^\r\n]+)$/mu.exec(run.output);
  assert.ok(parts, run.output);
  assert.match(parts[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(parts[2], expected);
  return { engine, server: parts[1], output: parts[2] };
}

function parameters(info) { return [info.parameters[1], info.parameters[0], info.parameters[2]]; }

function assertVarargsPlan(info, plan) {
  assert.deepEqual(info.varargs, { fixedCount: 2, fixedArrayCalls: 5, spreadCalls: 3 });
  assert.deepEqual(plan.signature.varargs, { ...info.varargs, verified: true });
  assert.equal(plan.signature.resolvedReferences, 8);
  assert.equal(plan.signature.adaptedMethodReferences, 0);
  assert.deepEqual(plan.signature.before.map(value => value.name), ['left', 'right', 'tail']);
  assert.deepEqual(plan.signature.after.map(value => value.name), ['right', 'left', 'tail']);
  assert.equal(plan.signature.after.at(-1).type, 'Object...');
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.equal(plan.documents.length, 2);
}

module.exports = { sources, targetPath, callerPath, marker, negativeTargets, parameters,
  selection, populateVarargs, runVarargsSpring, assertVarargsPlan };
