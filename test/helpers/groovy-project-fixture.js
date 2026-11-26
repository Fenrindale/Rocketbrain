'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execute } = require('../../src/java/testing/provision');
const { buildSpec } = require('../../src/java/workbench-tasks');

const mainClass = 'target/classes/fixture/groovyproject/ProjectProbe.class';
const resource = 'target/classes/probe-factor.txt';
const selectionText = [
  'import fixture.groovyproject.ProjectProbe',
  'assert !groovy.grape.Grape.enableGrapes',
  'assert ProjectProbe.codeLocation().contains("groovy-console-") && !ProjectProbe.codeLocation().contains("target/classes")',
  'ProjectProbe.read(System.getenv("RB_GROOVY_PROJECT_URL"), System.getenv("RB_GROOVY_PROJECT_USER"), System.getenv("RB_GROOVY_PROJECT_PASSWORD"))'
].join('\n');
const scripts = {
  query: 'throw new AssertionError("outside review before selection")\n' + selectionText +
    '\nthrow new AssertionError("outside review after selection")\n',
  scope: 'import fixture.groovyproject.TestOnly\nTestOnly.marker()\n',
  stop: [
    'new File(System.getenv("RB_GROOVY_PROJECT_STARTED")).text = "ready"',
    'Thread.sleep(30000)'
  ].join('\n') + '\n'
};

const dependency = (group, name, version) => '<dependency><groupId>' + group + '</groupId><artifactId>' + name +
  '</artifactId><version>' + version + '</version></dependency>';
async function put(root, relative, content) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { flag: 'wx' });
}

async function prepareGroovyProject(root, { javaHome, mavenHome, gradleHome, gradleCache, tool = 'maven' }) {
  const name = path.basename(root);
  assert.match(name, /^[A-Za-z0-9-]+$/u);
  const pom = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>' +
    '<groupId>fixture.groovyproject</groupId><artifactId>' + name + '</artifactId><version>1</version>' +
    '<properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>' +
    '<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>' +
    '<version>3.15.0</version></plugin></plugins></build>' +
    '<dependencies>' + dependency('org.springframework', 'spring-jdbc', '7.0.10') +
    dependency('com.mysql', 'mysql-connector-j', '9.7.0') + dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10') +
    '</dependencies></project>\n';
  const source = [
    'package fixture.groovyproject;',
    'import java.nio.charset.StandardCharsets;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class ProjectProbe {',
    '  public static String codeLocation() { return ProjectProbe.class.getProtectionDomain().getCodeSource().getLocation().toString(); }',
    '  public static String read(String url, String user, String password) throws Exception {',
    '    int factor;',
    '    try (var resource = ProjectProbe.class.getResourceAsStream("/probe-factor.txt")) {',
    '      factor = Integer.parseInt(new String(resource.readAllBytes(), StandardCharsets.UTF_8).trim());',
    '    }',
    '    var jdbc = new JdbcTemplate(new DriverManagerDataSource(url, user, password));',
    '    return jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '      (jdbc.queryForObject("SELECT 40", Integer.class) + factor);',
    '  }',
    '}', ''
  ].join('\n');
  const buildFiles = tool === 'gradle' ? [
    put(root, 'settings.gradle', "rootProject.name = '" + name + "'\n"),
    put(root, 'build.gradle', [
      "plugins { id 'java' }", 'repositories { mavenLocal(); mavenCentral() }',
      "dependencies { implementation 'org.springframework:spring-jdbc:7.0.10'",
      "  implementation 'com.mysql:mysql-connector-j:9.7.0'",
      "  implementation 'org.mariadb.jdbc:mariadb-java-client:3.5.10' }", ''
    ].join('\n'))
  ] : [put(root, 'pom.xml', pom), put(root, '.mvn/maven.config', '--offline\n')];
  await Promise.all([
    ...buildFiles,
    put(root, 'src/main/java/fixture/groovyproject/ProjectProbe.java', source),
    put(root, 'src/main/resources/probe-factor.txt', '2\n'),
    put(root, 'src/test/java/fixture/groovyproject/TestOnly.java',
      'package fixture.groovyproject; public final class TestOnly { public static String marker() { return "test-class"; } }\n'),
    ...Object.entries(scripts).map(([kind, code]) => put(root, 'scripts/' + kind + '.groovy', code))
  ]);
  const tasks = tool === 'gradle' ? ['classes', 'testClasses'] : ['test-compile'];
  const command = buildSpec({ root, uri: pathToFileURL(root).href, name, tool }, { javaHome, mavenHome, gradleHome }, tasks);
  const env = tool === 'gradle' ? { ...command.env, GRADLE_USER_HOME: gradleCache } : command.env;
  const result = await execute(command.command, [...command.args, '--offline'], { cwd: command.cwd, env, timeoutMs: 120000 });
  assert.equal(result.code, 0, result.output);
  const output = tool === 'gradle' ? mainClass.replace('target/classes/', 'build/classes/java/main/') : mainClass;
  assert.equal((await fs.readFile(path.join(root, output))).readUInt32BE(0), 0xcafebabe);
  return { uri: pathToFileURL(root).href, nativeSource: 'src/main/java/fixture/groovyproject/ProjectProbe.java' };
}

function rangeFor(document, kind) {
  const code = kind === 'query' ? selectionText : scripts[kind].trimEnd();
  const start = document.getText().indexOf(code);
  if (start < 0) throw Error('Expected owned Groovy source range.');
  return { start: document.positionAt(start), end: document.positionAt(start + code.length) };
}

function expectedOutput(receipt, engine) {
  assert.equal(receipt.state, 'ok', receipt.error);
  const [server, value] = receipt.value.split('|');
  assert.match(server, engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(value, '42');
  assert.equal(receipt.stdout, '');
  return { engine, server, value: Number(value) };
}

async function withGroovyDatabase(database, engine, operation) {
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const environment = {
    RB_GROOVY_PROJECT_URL: 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
      (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''),
    RB_GROOVY_PROJECT_USER: database.user,
    RB_GROOVY_PROJECT_PASSWORD: database.password
  };
  const before = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  try { return await operation(); }
  finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

module.exports = { resource, scripts, prepareGroovyProject, rangeFor, withGroovyDatabase, expectedOutput };
