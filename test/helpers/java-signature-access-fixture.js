'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');
const { populateSignatureReferences, selection } = require('./java-signature-references-fixture');

const className = 'fixture.sigaccess.AccessClient';
const packagePath = name => path.join('src', 'main', 'java', 'fixture', 'sigaccess', name + '.java');
const sourcePath = packagePath('AccessClient');
const sharedPath = packagePath('SharedApi');
const siblingPath = packagePath('SiblingClient');
const units = new Map([
  [sourcePath, [
    'package fixture.sigaccess;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class AccessClient {',
    '    private static final class Holder {',
    '        static int hiddenValue(int value) { return value + 2; }',
    '        public static int publicValue(int value) { return value; }',
    '    }',
    '    private static class OpenHolder {',
    '        static int openValue(int value) { return value; }',
    '    }',
    '    static int noClosure(int value) { return OpenHolder.openValue(value); }',
    '    public static void main(String[] args) {',
    '        var data = new DriverManagerDataSource(System.getenv("RB_ACCESS_JDBC_URL"),',
    '            System.getenv("RB_ACCESS_JDBC_USER"), System.getenv("RB_ACCESS_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(data);',
    '        int stored = jdbc.queryForObject("SELECT 40", Integer.class);',
    '        int result = Holder.hiddenValue(stored);',
    '        System.out.println(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + result);',
    '    }',
    '}', ''
  ].join('\n')],
  [sharedPath, 'package fixture.sigaccess;\npublic final class SharedApi { static int siblingValue(int value) { return value; } }\n']
]);
const selected = 'hiddenValue(int';
const failures = [
  ['publicValue(int', /package-private method in an unannotated private static final nested class/u],
  ['openValue(int', /package-private method in an unannotated private static final nested class/u]
];
const sibling = new Map([[siblingPath,
  'package fixture.sigaccess;\npublic final class SiblingClient { public static int read() { return SharedApi.siblingValue(42); } }\n']]);

async function populateAccessProject(root, classpathFile, engine) {
  return populateSignatureReferences(root, await springJdbcClasspath(classpathFile, engine), units);
}

async function populateAccessSibling(root, projectName) {
  await populateSignatureReferences(root, [], sibling);
  const file = path.join(root, '.classpath');
  const text = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, text.replace('<classpathentry kind="output"',
    '<classpathentry kind="src" path="/' + projectName + '"/><classpathentry kind="output"'));
}

async function compareSeparateCaller({ javaHome, base, root, siblingRoot, makePrivate = false }) {
  const filename = path.join(base, 'SharedApi.java');
  const shared = await fs.readFile(path.join(root, sharedPath), 'utf8');
  await fs.writeFile(filename, makePrivate ? shared.replace('static int siblingValue', 'private static int siblingValue') : shared);
  const javac = path.join(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(key)));
  const lib = path.join(base, 'lib'), client = path.join(base, 'app');
  await fs.mkdir(lib);
  await fs.mkdir(client);
  const library = await execute(javac, ['-proc:none', '-d', lib, filename], { env, cwd: base, timeoutMs: 30000 });
  assert.equal(library.code, 0, library.output);
  const invoked = await execute(javac, ['-J-Duser.language=en', '-J-Duser.country=US', '-proc:none', '-cp', lib, '-d', client, path.join(siblingRoot, siblingPath)],
    { env, cwd: base, timeoutMs: 30000 });
  if (makePrivate) {
    assert.notEqual(invoked.code, 0);
    assert.match(invoked.output, /siblingValue\(int\) has private access in SharedApi/u);
  } else assert.equal(invoked.code, 0, invoked.output);
}

async function runAccessProject({ javaHome, root, classes, database, engine, classpathFile }) {
  const result = await runJavaFixture({ javaHome, file: path.join(root, sourcePath), binaryDirectory: classes,
    className, classpath: await springJdbcClasspath(classpathFile, engine), config: database, engine, jdbcPrefix: 'RB_ACCESS' });
  assert.equal(result.output.trim(), '42');
  return { ...result, output: result.output.trim() };
}

function assertAccessPlan(info, plan) {
  assert.deepEqual(info.visibilityChange, { before: 'package', after: 'private' });
  assert.deepEqual(plan.signature.visibilityChange, { before: 'package', after: 'private', verified: true });
  assert.equal(plan.signature.resolvedReferences, 1);
  assert.ok(plan.signature.overloadBindingsVerified);
  assert.deepEqual(plan.signature.before, plan.signature.after);
  assert.equal(plan.documents.length, 1);
  assert.ok(plan.documents[0].before.includes('        static int hiddenValue'));
  assert.equal(plan.documents[0].after, plan.documents[0].before.replace('        static int hiddenValue', '        private static int hiddenValue'));
}

module.exports = { sourcePath, sharedPath, siblingPath, selected, failures, selection, populateAccessProject, populateAccessSibling,
  compareSeparateCaller, runAccessProject, assertAccessPlan };
