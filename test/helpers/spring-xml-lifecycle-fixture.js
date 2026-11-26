'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { runJavaFixture } = require('./instance-inline-fixture');
const { maven, position } = require('./spring-binary-lifecycle-fixture');

const beanPath = path.join('src', 'main', 'java', 'fixture', 'xmlhooks', 'DependencyXmlBean.java');
const configPath = path.join('src', 'main', 'java', 'fixture', 'xmlhooks', 'DependencyXmlConfig.java');
const owner = 'fixture.xmlhooks.DependencyXmlBean';
const entry = 'external-assets/entrypoints.xml';
const markers = { init: 'warmFromJar', destroy: 'coolFromJar', helper: 'unreferencedLocalHelper' };
const bean = [
  'package fixture.xmlhooks;',
  'public final class DependencyXmlBean {',
  '    private int number;',
  '    private void warmFromJar() { number += 7; }',
  '    private void coolFromJar() { number += 70; }',
  '    private void unreferencedLocalHelper() { number += 700; }',
  '    public int value() { return number; }',
  '}', ''
].join('\n');
const config = [
  'package fixture.xmlhooks;',
  'import org.springframework.context.annotation.Configuration;',
  'import org.springframework.context.annotation.ImportResource;',
  '@Configuration(proxyBeanMethods = false)',
  '@ImportResource("classpath:' + entry + '")',
  'public class DependencyXmlConfig {}', ''
].join('\n');
const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<beans xmlns="http://www.springframework.org/schema/beans"',
  '       xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  '       xsi:schemaLocation="http://www.springframework.org/schema/beans',
  '       https://www.springframework.org/schema/beans/spring-beans.xsd">',
  '    <bean id="externalXmlBean" class="' + owner + '"',
  '          init-method="' + markers.init + '" destroy-method="' + markers.destroy + '" />',
  '</beans>', ''
].join('\n');
const probe = [
  'package fixture.xmlprobe;',
  'import fixture.xmlhooks.DependencyXmlBean;',
  'import fixture.xmlhooks.DependencyXmlConfig;',
  'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class ExternalXmlProbe {',
  '    public static void main(String[] args) {',
  '        var spring = new AnnotationConfigApplicationContext(DependencyXmlConfig.class);',
  '        var bean = spring.getBean(DependencyXmlBean.class);',
  '        int warm = bean.value();',
  '        spring.close();',
  '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_XML_LIFECYCLE_JDBC_URL"),',
  '            System.getenv("RB_XML_LIFECYCLE_JDBC_USER"), System.getenv("RB_XML_LIFECYCLE_JDBC_PASSWORD")));',
  '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
  '            jdbc.queryForObject("SELECT 42", Integer.class) + ":" + warm + ":" + bean.value());',
  '    }',
  '}', ''
].join('\n');

function dependency(groupId, artifactId, version, extra = '') {
  return '<dependency><groupId>' + groupId + '</groupId><artifactId>' + artifactId + '</artifactId><version>' +
    version + '</version>' + extra + '</dependency>';
}

async function createJar(tools, archive, root, member) {
  const jar = path.join(tools.javaHome, 'bin', process.platform === 'win32' ? 'jar.exe' : 'jar');
  const result = await execute(jar, ['--create', '--file', archive, '-C', root, member], { timeoutMs: 30000 });
  assert.equal(result.code, 0, result.output);
}

async function jarResource(fixture, tools, text) {
  await fs.writeFile(path.join(fixture.assetRoot, entry), text);
  await createJar(tools, fixture.archive, fixture.assetRoot, entry);
}

async function populateResourceLifecycle(root, auxiliary, tools, { addEclipse = false } = {}) {
  const fixture = { root, auxiliary, assetRoot: path.join(auxiliary, 'archive-content'), archive: path.join(root, 'lib', 'xml-entrypoints.jar') };
  await Promise.all(['.mvn', 'lib', path.dirname(beanPath), 'bin'].map(dir => fs.mkdir(path.join(root, dir), { recursive: true })));
  await fs.mkdir(path.join(fixture.assetRoot, path.dirname(entry)), { recursive: true });
  await jarResource(fixture, tools, xml);
  const pom = [
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>',
    '<groupId>fixture</groupId><artifactId>' + path.basename(root) + '</artifactId><version>1</version>',
    '<properties><maven.compiler.release>25</maven.compiler.release></properties><dependencies>',
    dependency('org.springframework', 'spring-context', '7.0.10'), dependency('org.springframework', 'spring-jdbc', '7.0.10'),
    dependency('com.mysql', 'mysql-connector-j', '9.7.0'), dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10'),
    dependency('separate.resources', 'xml-entrypoints', '1',
      '<scope>system</scope><systemPath>${project.basedir}/lib/xml-entrypoints.jar</systemPath>'),
    '</dependencies><build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>',
    '<artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version></plugin></plugins></build></project>', ''
  ].join('\n');
  await Promise.all([
    [path.join(root, 'pom.xml'), pom], [path.join(root, '.mvn', 'maven.config'), '--offline\n'],
    [path.join(root, beanPath), bean], [path.join(root, configPath), config], [path.join(auxiliary, 'ExternalXmlProbe.java'), probe]
  ].map(([file, content]) => fs.writeFile(file, content, { flag: 'wx' })));
  const classpath = path.join(auxiliary, 'dependencies.txt');
  await maven(tools, root, ['org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath'], ['-Dmdep.outputFile=' + classpath]);
  fixture.dependencies = (await fs.readFile(classpath, 'utf8')).trim().split(path.delimiter)
    .filter(file => path.relative(file, fixture.archive));
  assert.ok(fixture.dependencies.some(file => file.endsWith('spring-context-7.0.10.jar')));
  if (addEclipse) {
    const escape = value => value.replaceAll('\\', '/').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const values = [
      '<classpath><classpathentry kind="src" path="src/main/java"/>',
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>',
      ...[fixture.archive, ...fixture.dependencies].map(file => '<classpathentry kind="lib" path="' + escape(file) + '"/>'),
      '<classpathentry kind="output" path="bin"/></classpath>'
    ].join('\n');
    await Promise.all([
      fs.writeFile(path.join(root, '.project'), '<projectDescription><name>' + path.basename(root) + '</name><natures>' +
        '<nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' }),
      fs.writeFile(path.join(root, '.classpath'), values, { flag: 'wx' })
    ]);
  }
  await maven(tools, root, ['compile']);
  return fixture;
}

async function runXmlLifecycle(fixture, tools, database, engine) {
  const compiled = await fs.mkdtemp(path.join(fixture.auxiliary, 'probe-classes-'));
  const result = await runJavaFixture({ javaHome: tools.javaHome, file: path.join(fixture.auxiliary, 'ExternalXmlProbe.java'),
    binaryDirectory: compiled, className: 'fixture.xmlprobe.ExternalXmlProbe', config: database, engine, jdbcPrefix: 'RB_XML_LIFECYCLE',
    classpath: [path.join(fixture.root, 'target', 'classes'), fixture.archive, ...fixture.dependencies] });
  assert.equal(result.output, '42:7:77');
  return result;
}

function assertXmlCallback(report, name, attribute) {
  assert.equal(report.verdict, 'blocked', JSON.stringify({
    unknowns: report.unknowns, binaryResourceLifecycle: report.binaryResourceLifecycle
  }));
  assert.equal(report.javaReferences, 0);
  assert.equal(report.binaryResourceLifecycle.state, 'inspected');
  assert.equal(report.binaryResourceLifecycle.executedProjectCode, false);
  assert.match(report.binaryResourceLifecycle.springAnnotation.archive, /spring-context-7\.0\.10\.jar$/u);
  const call = report.conflicts.find(item => item.kind === 'spring.binary-xml-lifecycle' && item.callback.name === name);
  assert.ok(call, JSON.stringify(report));
  assert.equal(call.callback.owner, owner);
  assert.equal(call.callback.attribute, attribute);
  assert.equal(call.signature, owner + '#' + name + '()');
  assert.equal(call.provenance.entry, entry);
  assert.match(call.provenance.archiveSha256, /^[\da-f]{64}$/u);
  assert.match(call.provenance.entrySha256, /^[\da-f]{64}$/u);
  const line = xml.split('\n')[call.callback.range.start.line];
  assert.equal(line.slice(call.callback.range.start.character, call.callback.range.end.character), name);
  assert.equal(call.range.start.line, 4);
  assert.match(call.uri, /DependencyXmlConfig\.java$/u);
  return { owner, name, attribute, sourceRange: call.range, xmlRange: call.callback.range,
    signature: call.signature, entry, archiveSha256: call.provenance.archiveSha256, entrySha256: call.provenance.entrySha256 };
}

module.exports = { bean, config, xml, owner, entry, beanPath, configPath, markers, populateResourceLifecycle,
  runXmlLifecycle, jarResource, createJar, assertXmlCallback, position, maven };
