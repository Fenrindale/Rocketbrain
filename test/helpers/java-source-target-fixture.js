'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');

const links = {
  maven: 'maven/service/src/main/java/fixture/maven/Probe.java',
  mavenTest: 'maven/service/src/test/java/fixture/maven/Scope.java',
  gradle: 'gradle/workbench/src/main/java/fixture/gradle/Probe.java',
  included: 'gradle/vendor/service/src/main/java/fixture/linked/Value.java',
  includedTest: 'gradle/vendor/service/src/test/java/fixture/linked/Scope.java'
};

const dependency = (group, name, version, scope = '') => '<dependency><groupId>' + group + '</groupId><artifactId>' +
  name + '</artifactId><version>' + version + '</version>' + (scope ? '<scope>' + scope + '</scope>' : '') + '</dependency>';
const marker = 'org.junit.jupiter.api.Test';
const probe = (namespace, value) => [
  'package ' + namespace + ';',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class Probe {',
  '  public static void main(String[] args) {',
  '    var data = new DriverManagerDataSource(System.getenv("RB_TARGET_JDBC_URL"),',
  '        System.getenv("RB_TARGET_JDBC_USER"), System.getenv("RB_TARGET_JDBC_PASSWORD"));',
  '    var jdbc = new JdbcTemplate(data);',
  '    System.out.println("RB_TARGET=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
  '        (' + value + ' + jdbc.queryForObject("SELECT 40", Integer.class)));',
  '  }',
  '}',
  ''
].join('\n');
const test = namespace => 'package ' + namespace + '; import ' + marker + '; public class Scope { @Test void scope() {} }\n';

function pom(name, extra, parent = false) {
  const header = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>';
  const scope = parent ? '<parent><groupId>fixture.targets</groupId><artifactId>reactor</artifactId><version>1</version></parent>' :
    '<groupId>fixture.targets</groupId><version>1</version>';
  return header + scope + '<artifactId>' + name + '</artifactId>\n' + extra + '\n</project>\n';
}

async function write(root, relative, text) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
}

async function populateTargets(root) {
  const dependencies = '<dependencies>' + dependency('fixture.targets', 'core', '1') +
    dependency('org.springframework', 'spring-jdbc', '7.0.10') + dependency('org.junit.jupiter', 'junit-jupiter-api', '6.1.3', 'test') +
    '</dependencies>';
  const reactor = '<packaging>pom</packaging>\n<modules>\n  <module>core</module>\n  <module>service</module>\n</modules>\n' +
    '<properties><maven.compiler.release>25</maven.compiler.release></properties>' +
    '<build><pluginManagement><plugins><plugin><groupId>org.apache.maven.plugins</groupId>' +
    '<artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version></plugin></plugins></pluginManagement></build>';
  const files = {
    'maven/pom.xml': pom('reactor', reactor), 'maven/.mvn/maven.config': '--offline\n',
    'maven/core/pom.xml': pom('core', '', true), 'maven/service/pom.xml': pom('reactor-service', dependencies, true),
    'maven/core/src/main/java/fixture/maven/Core.java':
      'package fixture.maven; public final class Core { public static int answer() { return 2; } }\n',
    [links.maven]: probe('fixture.maven', 'Core.answer()'), [links.mavenTest]: test('fixture.maven'),
    'gradle/settings.gradle': "rootProject.name = 'rb-target-main'\ninclude('workbench')\nincludeBuild('vendor') { name = 'linked-tools' }\n",
    'gradle/build.gradle': "plugins { id 'base' }\n",
    'gradle/vendor/settings.gradle.kts': 'rootProject.name = "physical-tools"\ninclude(":service")\n',
    'gradle/vendor/build.gradle.kts': 'plugins { base }\n',
    'gradle/vendor/service/build.gradle.kts': [
      'plugins { `java-library` }', 'group = "fixture.linked"', 'version = "1"', 'repositories { mavenLocal(); mavenCentral() }',
      'dependencies { testImplementation("org.junit.jupiter:junit-jupiter-api:6.1.3") }', ''
    ].join('\n'),
    'gradle/workbench/build.gradle': [
      "plugins { id 'java' }", 'repositories { mavenLocal(); mavenCentral() }', 'dependencies {',
      " implementation 'fixture.linked:service:1'", " implementation 'org.springframework:spring-jdbc:7.0.10'", '}', ''
    ].join('\n'),
    [links.included]: 'package fixture.linked; public final class Value { public static int answer() { return 2; } }\n',
    [links.includedTest]: test('fixture.linked'), [links.gradle]: probe('fixture.gradle', 'fixture.linked.Value.answer()')
  };
  await Promise.all(Object.entries(files).map(([relative, text]) => write(root, relative, text)));
  return Object.fromEntries(Object.entries(links).map(([key, name]) => [key, pathToFileURL(path.join(root, name)).href]));
}

async function buildTargets(root, tools, gradleCache) {
  const spec = (folder, tool, names) => {
    const directory = path.join(root, folder);
    return buildSpec({ root: directory, uri: pathToFileURL(directory).href, name: folder, tool }, tools, names);
  };
  const maven = spec('maven', 'maven', ['test-compile']);
  const gradle = spec('gradle', 'gradle', [':workbench:classes', ':linked-tools:service:testClasses']);
  const [reactor, composite] = await Promise.all([
    execute(maven.command, [...maven.args, '--offline', '-pl', 'service', '-am'], { cwd: maven.cwd, env: maven.env, timeoutMs: 120000 }),
    execute(gradle.command, [...gradle.args, '--offline'], { cwd: gradle.cwd,
      env: { ...gradle.env, GRADLE_USER_HOME: gradleCache }, timeoutMs: 180000 })
  ]);
  assert.equal(reactor.code, 0, reactor.output);
  assert.equal(composite.code, 0, composite.output);
  assert.match(composite.output, /:linked-tools:service:compileTestJava/u);
  assert.match(reactor.output, /Reactor Summary/u);
  for (const file of ['maven/core/target/classes/fixture/maven/Core.class',
    'maven/service/target/test-classes/fixture/maven/Scope.class',
    'gradle/vendor/service/build/classes/java/test/fixture/linked/Scope.class',
    'gradle/workbench/build/classes/java/main/fixture/gradle/Probe.class']) {
    assert.equal((await fs.readFile(path.join(root, file))).readUInt32BE(0), 0xcafebabe);
  }
}

async function runTargets(root, tools, classpathFile, database, engine) {
  const { springJdbcClasspath } = require('./instance-inline-fixture');
  const dependencies = await springJdbcClasspath(classpathFile, engine);
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_TARGET_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_TARGET_JDBC_USER = database.user;
  env.RB_TARGET_JDBC_PASSWORD = database.password;
  const java = path.join(tools.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const cases = [
    ['maven', 'maven/service/target/classes', 'maven/core/target/classes'],
    ['gradle', 'gradle/workbench/build/classes/java/main', 'gradle/vendor/service/build/classes/java/main']
  ];
  return Promise.all(cases.map(async ([kind, app, library]) => {
    const result = await execute(java, ['-cp', [path.join(root, app), path.join(root, library), ...dependencies].join(path.delimiter),
      'fixture.' + kind + '.Probe'], { cwd: root, env, timeoutMs: 30000 });
    assert.equal(result.code, 0, result.output);
    const marker = /^RB_TARGET=([^|\r\n]+)\|42$/mu.exec(result.output);
    assert.ok(marker, result.output);
    assert.match(marker[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
    return { kind, engine, server: marker[1], value: 42 };
  }));
}

const executionCases = [
  ['mavenTest', 'maven', 'service', 'test-compile', 'maven/service/target/test-classes/fixture/maven/Scope.class'],
  ['includedTest', 'gradle', ':linked-tools:service', ':linked-tools:service:testClasses',
    'gradle/vendor/service/build/classes/java/test/fixture/linked/Scope.class'],
  ['gradle', 'gradle', ':workbench', ':workbench:classes', 'gradle/workbench/build/classes/java/main/fixture/gradle/Probe.class']
];

module.exports = { links, populateTargets, buildTargets, runTargets, executionCases };
