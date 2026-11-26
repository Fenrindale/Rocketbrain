'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath } = require('./instance-inline-fixture');
const { positionOf } = require('./stdio-lsp');

const rootPackage = 'fixture.sigrefs';
const javaPath = name => path.join('src', 'main', 'java', 'fixture', 'sigrefs', name + '.java');
const targetPath = javaPath('SignatureTarget');
const clientPath = javaPath('SignatureClient');
const negativeTargets = [['mutableRender(String', 'mutable receiver'], ['effectRender(String', 'effectful receiver'],
  ['boxedConvert(String', 'boxed SAM input']];
const operations = [
  { marker: 'staticConvert(String', refs: 1, operation: 'reorder', references: ['SignatureTarget::staticConvert'] },
  { marker: 'SignatureTarget(String', refs: 1, operation: 'add', references: ['SignatureTarget::new'] },
  { marker: 'instanceRender(String', refs: 2, operation: 'reorder',
    references: ['SignatureTarget::instanceRender', 'this::instanceRender'] }
];

const sources = new Map([
  [targetPath, [
    'package fixture.sigrefs;',
    'public final class SignatureTarget {',
    '    private final String prefix;',
    '    private final int base;',
    '    public SignatureTarget(String prefix, int base) { this.prefix = prefix; this.base = base; }',
    '    public static String staticConvert(String label, int value) { return label + value; }',
    '    public String instanceRender(String label, int value) { return prefix + label + (base + value); }',
    '    public Format inside() { return this::instanceRender; }',
    '    public String mutableRender(String label, int value) { return prefix + label + value; }',
    '    public String effectRender(String label, int value) { return prefix + label + value; }',
    '    public static String boxedConvert(String label, int value) { return label + value; }',
    '}', ''
  ].join('\n')],
  [javaPath('Format'), 'package fixture.sigrefs;\npublic interface Format { String apply(String label, int value); }\n'],
  [javaPath('Factory'), 'package fixture.sigrefs;\npublic interface Factory { SignatureTarget make(String prefix, int base); }\n'],
  [javaPath('Unbound'), [
    'package fixture.sigrefs;',
    'public interface Unbound { String apply(SignatureTarget receiver, String label, int value); }', ''
  ].join('\n')],
  [javaPath('Boxed'), 'package fixture.sigrefs;\npublic interface Boxed { String apply(String label, Integer value); }\n'],
  [clientPath, [
    'package fixture.sigrefs;',
    'import java.util.function.Function;',
    'import org.springframework.beans.factory.support.DefaultListableBeanFactory;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SignatureClient {',
    '    private static SignatureTarget moving = new SignatureTarget("x", 1);',
    '    private static SignatureTarget next() { return new SignatureTarget("y", 2); }',
    '    private static Format mutableReference() { return moving::mutableRender; }',
    '    private static Format effectReference() { return next()::effectRender; }',
    '    private static Boxed boxedReference() { return SignatureTarget::boxedConvert; }',
    '    public static void main(String[] args) {',
    '        Format byStatic = SignatureTarget::staticConvert;',
    '        Factory constructor = SignatureTarget::new;',
    '        Unbound byInstance = SignatureTarget::instanceRender;',
    '        Function<String,String> retained = String::strip;',
    '        Function<String,String> retainedLambda = value -> value.toUpperCase(java.util.Locale.ROOT);',
    '        var ds = new DriverManagerDataSource(System.getenv("RB_SIGNATURE_REF_JDBC_URL"),',
    '            System.getenv("RB_SIGNATURE_REF_JDBC_USER"), System.getenv("RB_SIGNATURE_REF_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(ds);',
    '        int amount = jdbc.queryForObject("SELECT 4", Integer.class);',
    '        var beans = new DefaultListableBeanFactory();',
    '        beans.registerSingleton("target", constructor.make("B", amount));',
    '        var bean = beans.getBean(SignatureTarget.class);',
    '        int signatureArgument1 = 5;',
    '        System.out.println("RB_SIGNATURE_REF=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|"',
    '            + byStatic.apply("S", amount) + "/" + byInstance.apply(bean, "U", signatureArgument1)',
    '            + "/" + bean.inside().apply("T", amount) + "/" + SignatureTarget.staticConvert("D", 3)',
    '            + "/" + retainedLambda.apply(retained.apply(" keep ")) + "/"',
    '            + mutableReference().apply("M", 1) + "/" + effectReference().apply("E", 2) + "/"',
    '            + boxedReference().apply("Q", 3));',
    '    }',
    '}', ''
  ].join('\n')]
]);

const expected = 'S4/BU9/BT8/D3/KEEP/xM1/yE2/Q3';

function selection(text, marker) {
  const start = positionOf(text, marker);
  return { start, end: { ...start, character: start.character + marker.indexOf('(') } };
}

function nextParameters(info, operation) {
  const parameters = structuredClone(info.parameters);
  assert.equal(parameters.length, 2);
  if (operation === 'add') parameters.push({ originalIndex: -1, type: 'String', name: 'note', defaultValue: '"new"' });
  else parameters.reverse();
  return parameters;
}

function assertPlan(plan, operation) {
  assert.equal(plan.signature.adaptedMethodReferences, operation.refs);
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.equal(plan.documents.length, 2);
  const current = plan.documents.map(doc => doc.after).join('\n');
  for (const token of operation.references) assert.ok(!current.includes(token), token);
  assert.match(current, /\(\s*signatureArgument\d+(?:,\s*signatureArgument\d+)+\)\s*->/u);
  assert.match(current, /String::strip/u);
  assert.match(current, /value -> value\.toUpperCase\(java\.util\.Locale\.ROOT\)/u);
  assert.match(current, /next\(\)::effectRender/u);
  assert.match(current, /moving::mutableRender/u);
  assert.match(current, /SignatureTarget::boxedConvert/u);
  return { method: plan.signature.methodName, operation: operation.operation, adapters: operation.refs,
    documents: plan.documents.length, references: plan.signature.resolvedReferences };
}

async function populateSignatureReferences(root, classpath, units = sources) {
  const xml = value => value.replaceAll('\\', '/').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  await fs.mkdir(path.join(root, 'bin'), { recursive: true });
  await fs.mkdir(path.join(root, '.settings'));
  await fs.writeFile(path.join(root, '.settings', 'org.eclipse.jdt.core.prefs'), 'eclipse.preferences.version=1\n' +
    'org.eclipse.jdt.core.compiler.compliance=25\norg.eclipse.jdt.core.compiler.source=25\n' +
    'org.eclipse.jdt.core.compiler.codegen.targetPlatform=25\n', { flag: 'wx' });
  const project = path.basename(root);
  await fs.writeFile(path.join(root, '.project'), '<projectDescription><name>' + xml(project) +
    '</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' });
  await fs.writeFile(path.join(root, '.classpath'), '<classpath><classpathentry kind="src" path="src/main/java"/>' +
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>' +
    classpath.map(file => '<classpathentry kind="lib" path="' + xml(file) + '"/>').join('') +
    '<classpathentry kind="output" path="bin"/></classpath>', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'build.gradle'), "plugins { id 'java' }\nrepositories { mavenCentral() }\n" +
    "dependencies { implementation 'org.springframework:spring-jdbc:7.0.10' }\n", { flag: 'wx' });
  for (const [relative, text] of units) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { flag: 'wx' });
  }
}

async function runSignatureSpring({ javaHome, root, classes, database, engine, classpathFile }) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const java = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const cp = await springJdbcClasspath(classpathFile, engine);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_SIGNATURE_REF_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_SIGNATURE_REF_JDBC_USER = database.user;
  env.RB_SIGNATURE_REF_JDBC_PASSWORD = database.password;
  const sourceFiles = [...sources.keys()].map(file => path.join(root, file));
  const compile = await execute(java('javac'), ['-proc:none', '-encoding', 'UTF-8', '-classpath', cp.join(path.delimiter),
    '-d', classes, ...sourceFiles], { env, cwd: root, timeoutMs: 30000 });
  assert.equal(compile.code, 0, compile.output);
  const run = await execute(java('java'), ['-cp', [classes, ...cp].join(path.delimiter), rootPackage + '.SignatureClient'],
    { env, cwd: root, timeoutMs: 30000 });
  assert.equal(run.code, 0, run.output);
  const match = /^RB_SIGNATURE_REF=([^|\r\n]+)\|([^\r\n]+)$/mu.exec(run.output);
  assert.ok(match, run.output);
  const [, server, output] = match;
  assert.match(server, engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(output, expected);
  return { engine, server, output };
}

module.exports = { sources, targetPath, clientPath, negativeTargets, operations, selection, nextParameters, assertPlan,
  populateSignatureReferences, runSignatureSpring };
