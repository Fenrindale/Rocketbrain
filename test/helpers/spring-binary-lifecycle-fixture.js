'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');
const { runJavaFixture } = require('./instance-inline-fixture');
const { positionOf } = require('./stdio-lsp');

const base = path.join('src', 'main', 'java', 'fixture', 'lifecycle');
const beanPath = path.join(base, 'LifecycleValue.java'), factoryPath = path.join(base, 'LifecycleFactory.java');
const markers = { default: 'bootFromJar', explicit: 'sourceChosen', shutdown: 'stopFromJar', unused: 'unreferencedHelper' };
const bean = [
  'package fixture.lifecycle;',
  'public final class LifecycleValue {',
  '    private int value;',
  '    private void bootFromJar() { value += 1; }',
  '    private void sourceChosen() { value += 10; }',
  '    private void stopFromJar() { value += 100; }',
  '    private void unreferencedHelper() { value += 1000; }',
  '    public int value() { return value; }',
  '}', ''
].join('\n');
const factory = [
  'package fixture.lifecycle;',
  'import fixture.binary.ExternalLifecycle;',
  'import org.springframework.context.annotation.Configuration;',
  '@Configuration(proxyBeanMethods = false) public class LifecycleFactory {',
  '    @ExternalLifecycle public LifecycleValue fromDefaults() { return new LifecycleValue(); }',
  '    @ExternalLifecycle(warmStart = "sourceChosen")',
  '    public LifecycleValue fromSource() { return new LifecycleValue(); }',
  '}', ''
].join('\n');

const coordinate = (group, name, version, more = '') => '<dependency><groupId>' + group + '</groupId><artifactId>' +
  name + '</artifactId><version>' + version + '</version>' + more + '</dependency>';
function pom(binary = false) {
  return [
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>',
    '<groupId>fixture</groupId><artifactId>' + (binary ? 'rb-binary-lifecycle' : 'rb-lifecycle-vendors') + '</artifactId><version>1</version>',
    '<properties><maven.compiler.release>25</maven.compiler.release></properties><dependencies>',
    coordinate('org.springframework', 'spring-context', '7.0.10'), coordinate('org.springframework', 'spring-jdbc', '7.0.10'),
    coordinate('com.mysql', 'mysql-connector-j', '9.7.0'), coordinate('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10'),
    ...(binary ? [coordinate('fixture', 'external-lifecycle', '1',
      '<scope>system</scope><systemPath>${project.basedir}/lib/external-lifecycle.jar</systemPath>')] : []),
    '</dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>',
    '<artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version></plugin></plugins></build></project>', ''
  ].join('\n');
}

const annotationPreamble = [
  'package fixture.binary;', 'import java.lang.annotation.Retention;', 'import java.lang.annotation.RetentionPolicy;',
  'import java.lang.annotation.Target;', 'import java.lang.annotation.ElementType;',
  'import org.springframework.context.annotation.Bean;', 'import org.springframework.core.annotation.AliasFor;',
  '@Retention(RetentionPolicy.RUNTIME) @Target(ElementType.METHOD) @Bean(destroyMethod = "stopFromJar")'
];
const external = [
  ...annotationPreamble, 'public @interface ExternalLifecycle {',
  '  @AliasFor(annotation = Bean.class, attribute = "initMethod") String warmStart() default "bootFromJar";', '}', ''
].join('\n');
const ambiguous = [
  ...annotationPreamble, 'public @interface AmbiguousLifecycle {',
  '  @AliasFor(annotation = Bean.class, attribute = "initMethod") String warmStart() default "bootFromJar";',
  '  @AliasFor(annotation = Bean.class, attribute = "initMethod") String other() default "bootFromJar";', '}', ''
].join('\n');
const probe = [
  'package fixture.probe;',
  'import fixture.lifecycle.LifecycleFactory;',
  'import fixture.lifecycle.LifecycleValue;',
  'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class LifecycleProbe {',
  '    public static void main(String[] args) {',
  '        var ctx = new AnnotationConfigApplicationContext(LifecycleFactory.class);',
  '        var a = ctx.getBean("fromDefaults", LifecycleValue.class);',
  '        var b = ctx.getBean("fromSource", LifecycleValue.class);',
  '        String init = a.value() + "/" + b.value();',
  '        ctx.close();',
  '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_LIFECYCLE_JDBC_URL"),',
  '            System.getenv("RB_LIFECYCLE_JDBC_USER"), System.getenv("RB_LIFECYCLE_JDBC_PASSWORD")));',
  '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
  '            jdbc.queryForObject("SELECT 42", Integer.class) + ":" + init + ":" + a.value() + "/" + b.value());',
  '    }',
  '}', ''
].join('\n');

function project(root) { return { root, uri: pathToFileURL(root).href, tool: 'maven', name: path.basename(root) }; }

async function maven(tools, root, goals, flags = []) {
  const task = buildSpec(project(root), tools, goals);
  const result = await execute(task.command, [...task.args, '--non-recursive', '-Dstyle.color=never', ...flags],
    { cwd: task.cwd, env: task.env, timeoutMs: 90000 });
  assert.equal(result.code, 0, result.output);
}

async function writeMaven(root, binary) {
  await fs.mkdir(path.join(root, '.mvn'), { recursive: true });
  await fs.writeFile(path.join(root, '.mvn', 'maven.config'), '--offline\n', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'pom.xml'), pom(binary), { flag: 'wx' });
}

function xml(text) { return text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'); }

async function populateBinaryLifecycle(root, auxiliary, tools, { addEclipse = false } = {}) {
  const vendors = path.join(auxiliary, 'vendors'), artifactSource = path.join(auxiliary, 'annotation-sources');
  const artifactClasses = path.join(auxiliary, 'annotation-classes');
  await Promise.all([writeMaven(vendors, false), writeMaven(root, true), fs.mkdir(artifactSource, { recursive: true }),
    fs.mkdir(artifactClasses, { recursive: true }), fs.mkdir(path.join(root, base), { recursive: true }),
    fs.mkdir(path.join(root, 'lib'), { recursive: true })]);
  const pathFile = path.join(vendors, 'classpath.txt');
  await maven(tools, vendors, ['org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath'],
    ['-Dmdep.outputFile=' + pathFile]);
  const dependencies = (await fs.readFile(pathFile, 'utf8')).trim().split(path.delimiter);
  assert.ok(dependencies.some(file => file.endsWith('spring-context-7.0.10.jar')));
  const annotations = await Promise.all([['ExternalLifecycle.java', external], ['AmbiguousLifecycle.java', ambiguous]].map(async ([name, text]) => {
    const file = path.join(artifactSource, name);
    await fs.writeFile(file, text, { flag: 'wx' });
    return file;
  }));
  const tool = name => path.join(tools.javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const compiled = await execute(tool('javac'), ['-proc:none', '-cp', dependencies.join(path.delimiter),
    '-d', artifactClasses, ...annotations], { timeoutMs: 30000 });
  assert.equal(compiled.code, 0, compiled.output);
  const archive = path.join(root, 'lib', 'external-lifecycle.jar');
  const zipped = await execute(tool('jar'), ['--create', '--file', archive, '-C', artifactClasses, '.'], { timeoutMs: 30000 });
  assert.equal(zipped.code, 0, zipped.output);
  await Promise.all([[path.join(root, beanPath), bean], [path.join(root, factoryPath), factory],
    [path.join(auxiliary, 'LifecycleProbe.java'), probe]].map(([file, text]) => fs.writeFile(file, text, { flag: 'wx' })));
  if (addEclipse) {
    const contents = [
      '<?xml version="1.0" encoding="UTF-8"?>', '<classpath>',
      '<classpathentry kind="src" path="src/main/java"/>',
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
      ...[archive, ...dependencies].map(file => '<classpathentry kind="lib" path="' + xml(file.split(path.sep).join('/')) + '"/>'),
      '<classpathentry kind="output" path="bin"/></classpath>', ''
    ].join('\n');
    await Promise.all([fs.writeFile(path.join(root, '.project'), '<projectDescription><name>rb-binary-lifecycle</name><natures>' +
      '<nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>\n'),
    fs.writeFile(path.join(root, '.classpath'), contents)]);
  }
  await maven(tools, root, ['compile']);
  return { root, archive, dependencies, auxiliary, types: ['fixture.lifecycle.LifecycleValue', 'fixture.binary.ExternalLifecycle'] };
}

async function runBinaryLifecycle(fixture, tools, database, engine) {
  const output = await fs.mkdtemp(path.join(fixture.auxiliary, 'probe-classes-'));
  const result = await runJavaFixture({ javaHome: tools.javaHome, file: path.join(fixture.auxiliary, 'LifecycleProbe.java'),
    binaryDirectory: output, className: 'fixture.probe.LifecycleProbe', config: database, engine, jdbcPrefix: 'RB_LIFECYCLE',
    classpath: [path.join(fixture.root, 'target', 'classes'), fixture.archive, ...fixture.dependencies] });
  assert.equal(result.output, '42:1/10:101/110');
  return result;
}

function position(document, marker) {
  const found = positionOf(document.getText(), marker + '()');
  return { line: found.line, character: found.character + 1 };
}

function exactConflict(report, marker, expected) {
  assert.equal(report.verdict, 'blocked', JSON.stringify(report.unknowns));
  assert.equal(report.binaryLifecycle.state, 'inspected');
  assert.equal(report.binaryLifecycle.executedProjectCode, false);
  const match = report.conflicts.find(item => item.kind === 'spring.binary-bean-lifecycle' && item.lifecycle.name === marker);
  assert.ok(match, JSON.stringify(report));
  assert.equal(match.annotation, 'fixture.binary.ExternalLifecycle');
  assert.equal(match.lifecycle.origin, expected);
  assert.ok(match.uri.endsWith('/LifecycleFactory.java'));
  assert.equal(match.provenance.entry, 'fixture/binary/ExternalLifecycle.class');
  assert.match(match.provenance.archiveSha256, /^[\da-f]{64}$/u);
  assert.match(match.provenance.classSha256, /^[\da-f]{64}$/u);
  assert.match(report.binaryLifecycle.springBean.archive, /spring-context-7\.0\.10\.jar$/u);
  assert.match(report.binaryLifecycle.springAliasFor.archive, /spring-core-7\.0\.10\.jar$/u);
  return { ...match.lifecycle, range: match.range, entry: match.provenance.entry,
    archiveSha256: match.provenance.archiveSha256, classSha256: match.provenance.classSha256 };
}

module.exports = { beanPath, factoryPath, markers, bean, factory, maven, populateBinaryLifecycle, runBinaryLifecycle, position, exactConflict };
