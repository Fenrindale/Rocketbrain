'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');

const group = 'fixture.rocketbrain';
const probeClass = 'fixture.mediation.DependencyProbe';
const dependency = (group, artifact, version, scope = '') =>
  '    <dependency><groupId>' + group + '</groupId><artifactId>' + artifact + '</artifactId><version>' + version +
  '</version>' + (scope ? '<scope>' + scope + '</scope>' : '') + '</dependency>';
const jspecify = dependency('org.jspecify', 'jspecify', '1.0.0');
const pom = mode => [
  '<project xmlns="http://maven.apache.org/POM/4.0.0">',
  '  <modelVersion>4.0.0</modelVersion>',
  '  <groupId>' + group + '</groupId><artifactId>mediation-' + mode + '</artifactId><version>1</version>',
  '  <properties><maven.compiler.release>25</maven.compiler.release></properties>',
  ...(mode === 'managed' ? ['  <dependencyManagement><dependencies>', jspecify, '  </dependencies></dependencyManagement>'] : []),
  '  <dependencies>',
  dependency('org.springframework', 'spring-jdbc', '7.0.10'),
  dependency('com.mysql', 'mysql-connector-j', '9.7.0', 'runtime'),
  dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10', 'runtime'),
  ...(mode === 'nearest' ? [jspecify] : []),
  '  </dependencies>',
  '  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>',
  '    <artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version>',
  '  </plugin></plugins></build>',
  '</project>', ''
].join('\n');

async function populateMavenMediation(root, mode) {
  assert.ok(['nearest', 'managed'].includes(mode));
  const directory = path.join(root, 'src/main/java/fixture/mediation');
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(path.join(root, '.mvn'));
  await fs.writeFile(path.join(root, '.mvn/maven.config'), '--offline\n', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'pom.xml'), pom(mode), { flag: 'wx' });
  await fs.writeFile(path.join(directory, 'DependencyProbe.java'), [
    'package fixture.mediation;',
    'import java.nio.file.Path;',
    'import org.jspecify.annotations.Nullable;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class DependencyProbe {',
    '    public static void main(String[] args) throws Exception {',
    '        var ds = new DriverManagerDataSource(System.getenv("RB_MEDIATION_JDBC_URL"),',
    '            System.getenv("RB_MEDIATION_JDBC_USER"), System.getenv("RB_MEDIATION_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(ds);',
    '        var version = jdbc.queryForObject("SELECT VERSION()", String.class);',
    '        var count = jdbc.queryForObject("SELECT 42", Integer.class);',
    '        var origin = Path.of(Nullable.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getFileName();',
    '        System.out.println("RB_MVN_MEDIATION=" + version + "|" + count + "|" + origin);',
    '    }',
    '}', ''
  ].join('\n'), { flag: 'wx' });
  return { root, uri: pathToFileURL(root).href, tool: 'maven', name: 'Mediation ' + mode };
}

async function compileMavenProbe(project, tools) {
  const report = path.join(project.root, 'target', 'rb-runtime-classpath.txt');
  const goal = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath';
  const build = buildSpec(project, tools, ['compile', goal]);
  const built = await execute(build.command, [...build.args, '--non-recursive', '-Dstyle.color=never',
    '-DincludeScope=runtime', '-Dmdep.outputFile=' + report], { cwd: build.cwd, env: build.env, timeoutMs: 90000 });
  assert.equal(built.code, 0, built.output);
  const classpath = (await fs.readFile(report, 'utf8')).trim().split(path.delimiter);
  assert.deepEqual(classpath.filter(file => /^jspecify-/u.test(path.basename(file))).map(file => path.basename(file)),
    ['jspecify-1.0.0.jar']);
  return [path.join(project.root, 'target/classes'), ...classpath];
}

async function runMavenProbe({ project, tools, classpath, database, engine }) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const java = path.join(tools.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_MEDIATION_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_MEDIATION_JDBC_USER = database.user;
  env.RB_MEDIATION_JDBC_PASSWORD = database.password;
  const run = await execute(java, ['-cp', classpath.join(path.delimiter), probeClass],
    { cwd: project.root, env, timeoutMs: 25000 });
  assert.equal(run.code, 0, run.output);
  const actual = /^RB_MVN_MEDIATION=([^|\r\n]+)\|42\|(jspecify-1\.0\.0\.jar)$/mu.exec(run.output);
  assert.ok(actual, run.output);
  assert.match(actual[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  return { engine, server: actual[1], count: 42, loadedArtifact: actual[2] };
}

function resolutionAssertion(report, mode) {
  assert.equal(report.mavenVersion, '3.9.11');
  assert.equal(report.dependencyPlugin, '3.11.0');
  assert.equal(report.root.artifact, 'mediation-' + mode);
  const selected = report.nodes.find(node => node.group === 'org.jspecify' && node.state === 'selected');
  assert.equal(selected.version, '1.0.0');
  if (mode === 'nearest') {
    assert.equal(selected.parentId, 0);
    const omitted = report.nodes.find(node => node.group === 'org.jspecify' && node.state === 'conflict');
    assert.equal(omitted.version, '1.0.1');
    assert.equal(omitted.winnerVersion, '1.0.0');
    assert.equal(omitted.winnerId, selected.id);
    assert.equal(report.nodes[omitted.parentId - 1].artifact, 'spring-core');
    return { selected, omitted, sourceKind: 'direct' };
  }
  assert.equal(selected.managedFrom, '1.0.1');
  assert.equal(report.nodes[selected.parentId - 1].artifact, 'spring-core');
  return { selected, sourceKind: 'managed' };
}

module.exports = { populateMavenMediation, compileMavenProbe, runMavenProbe, resolutionAssertion };
