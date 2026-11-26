'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');
const { digest, plugin, version } = require('./maven-snapshot-fixture');

const repositoryId = 'rocketbrain-owned-models';
const group = 'fixture.rocketbrain';
const xml = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const pom = text => '<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n' +
  '<modelVersion>4.0.0</modelVersion>\n' + text + '\n</project>\n';
const gav = (group, artifact, version) => '<groupId>' + group + '</groupId><artifactId>' + artifact +
  '</artifactId><version>' + version + '</version>';
const dependency = (group, artifact, version, other = '') => '<dependency>' +
  (version ? gav(group, artifact, version) : '<groupId>' + group + '</groupId><artifactId>' + artifact + '</artifactId>') +
  other + '</dependency>';

async function modelRepository() {
  const name = randomUUID().slice(0, 8), parent = 'company-' + name, bom = 'platform-' + name;
  const fixtureGroup = 'fixture.rocketbrain.move' + name;
  const artifacts = new Map(), downloads = [];
  const server = http.createServer((request, response) => {
    const bytes = artifacts.get(request.url);
    if (!bytes || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404).end(); return; }
    downloads.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  function put(file, bytes) {
    artifacts.set(file, Buffer.from(bytes));
    artifacts.set(file + '.sha1', Buffer.from(digest(bytes, 'sha1')));
  }
  function publish(index) {
    assert.ok([1, 2].includes(index));
    const stamp = '20261126.04150' + index, resolvedVersion = '1.2-' + stamp + '-' + index;
    const release = index === 1 ? 17 : 21, jspecify = '1.0.' + (index - 1);
    const remote = model => '/' + [...group.split('.'), model, version].join('/') + '/';
    const parentBytes = pom(gav(group, parent, version) + '<packaging>pom</packaging>' +
      '<properties><maven.compiler.release>' + release + '</maven.compiler.release></properties>' +
      '<dependencyManagement><dependencies>' +
      dependency(group, bom, version, '<type>pom</type><scope>import</scope>') +
      '</dependencies></dependencyManagement>' + '<dependencies>' +
      dependency('org.springframework', 'spring-jdbc', '7.0.10') +
      dependency('com.mysql', 'mysql-connector-j', '9.7.0', '<scope>runtime</scope>') +
      dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10', '<scope>runtime</scope>') +
      '</dependencies>');
    const bomBytes = pom(gav(group, bom, version) + '<packaging>pom</packaging>' +
      '<dependencyManagement><dependencies>' +
      dependency(fixtureGroup, 'core', '1.0.0', '<scope>compile</scope>') +
      dependency('org.jspecify', 'jspecify', jspecify, '<scope>compile</scope>') +
      '</dependencies></dependencyManagement>');
    const models = [[parent, parentBytes], [bom, bomBytes]].map(([artifactId, bytes]) => {
      const file = remote(artifactId) + artifactId + '-' + resolvedVersion + '.pom';
      put(file, bytes);
      put(remote(artifactId) + 'maven-metadata.xml', '<?xml version="1.0" encoding="UTF-8"?><metadata>' +
        gav(group, artifactId, version) + '<versioning><snapshot><timestamp>' + stamp + '</timestamp><buildNumber>' + index +
        '</buildNumber></snapshot><snapshotVersions><snapshotVersion><extension>pom</extension><value>' + resolvedVersion +
        '</value><updated>' + stamp.replace('.', '') + '</updated></snapshotVersion></snapshotVersions><lastUpdated>' +
        stamp.replace('.', '') + '</lastUpdated></versioning></metadata>');
      return { groupId: group, artifactId, version, resolvedVersion, repositoryId, sha256: digest(bytes), file };
    });
    return { models, release, jspecify, resolvedVersion };
  }
  return { url, parent, bom, fixtureGroup, downloads, publish,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

async function reactorAt(root, remote, repository) {
  const config = path.join(root, '.mvn');
  await fs.mkdir(config, { recursive: true });
  const settings = path.join(config, 'snapshot-settings.xml'), global = path.join(config, 'global-settings.xml');
  await fs.writeFile(settings, '<settings><profiles><profile><id>snapshot-review</id><repositories><repository><id>' +
    repositoryId + '</id><url>' + xml(remote.url) + '</url><releases><enabled>false</enabled></releases>' +
    '<snapshots><enabled>true</enabled><updatePolicy>always</updatePolicy><checksumPolicy>fail</checksumPolicy></snapshots>' +
    '</repository></repositories></profile></profiles><activeProfiles><activeProfile>snapshot-review</activeProfile></activeProfiles></settings>\n');
  await fs.writeFile(global, '<settings/>\n');
  const argumentsFile = path.join(config, 'maven.config');
  const args = ['-Dmaven.repo.local=' + repository, '--settings=' + settings, '--global-settings=' + global].join('\n') + '\n';
  const setOffline = offline => fs.writeFile(argumentsFile, (offline ? '--offline\n' : '') + args);
  await setOffline(false);
  const reactorGav = gav(remote.fixtureGroup, 'reactor', '1.0.0');
  await fs.writeFile(path.join(root, 'pom.xml'), pom(reactorGav + '<packaging>pom</packaging>' +
    '<properties><maven.compiler.release>17</maven.compiler.release></properties><modules><module>core</module><module>app</module></modules>'));
  const core = path.join(root, 'core'), app = path.join(root, 'app');
  const addSource = async (module, name, source) => {
    const directory = path.join(module, 'src/main/java/fixture/snapshot');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, name + '.java'), source + '\n');
    return path.join(directory, name + '.java');
  };
  const target = await addSource(core, 'Marker', 'package fixture.snapshot; public final class Marker { public static int value() { return 42; } }');
  await fs.writeFile(path.join(core, 'pom.xml'), pom('<parent>' + reactorGav + '</parent><artifactId>core</artifactId>'));
  const source = await addSource(app, 'SnapshotApp', [
    'package fixture.snapshot;',
    'import java.nio.file.Path;',
    'import org.jspecify.annotations.Nullable;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SnapshotApp {',
    '  public static void main(String[] args) throws Exception {',
    '    var ds = new DriverManagerDataSource(System.getenv("RB_MODEL_JDBC_URL"), System.getenv("RB_MODEL_JDBC_USER"), System.getenv("RB_MODEL_JDBC_PASSWORD"));',
    '    var count = new JdbcTemplate(ds).queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);',
    '    var jar = Path.of(Nullable.class.getProtectionDomain().getCodeSource().getLocation().toURI()).getFileName();',
    '    System.out.println("RB_MODEL_PROOF=" + Marker.value() + "|" + count + "|" + jar);',
    '  }',
    '}'
  ].join('\n'));
  await fs.writeFile(path.join(app, 'pom.xml'), pom('<parent>' + gav(group, remote.parent, version) +
    '<relativePath/></parent>' + gav(remote.fixtureGroup, 'app', '1.0.0') + '<dependencies>' +
    dependency(remote.fixtureGroup, 'core') + dependency('org.jspecify', 'jspecify') + '</dependencies>'));
  return { root, uri: pathToFileURL(root).href, tool: 'maven', source, target, setOffline, config: argumentsFile, settings, global };
}

async function runMaven(project, tools, goals, options = []) {
  const spec = buildSpec(project, tools, goals);
  const result = await execute(spec.command, [...spec.args, '--show-version', '-Dstyle.color=never', ...options],
    { cwd: spec.cwd, env: spec.env, timeoutMs: 110000 });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Apache Maven 3\.9\.11/u);
  return result.output;
}

async function compileAndQuery(project, tools, database, engine, generation, reportFile) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.deepEqual([database.host, database.database], ['127.0.0.1', 'rocketbrain_fixture']);
  assert.ok(Number.isInteger(database.port) && database.port > 1024 && database.port < 65536);
  await runMaven(project, tools, ['clean', 'install'], ['-DskipTests=true']);
  const root = path.join(project.root, 'app');
  await runMaven(project, tools, [plugin + ':build-classpath'],
    ['--projects', 'app', '-DincludeScope=runtime', '-Dmdep.outputFile=' + reportFile]);
  const main = path.join(root, 'target', 'classes');
  const javaClass = await fs.readFile(path.join(main, 'fixture/snapshot/SnapshotApp.class'));
  assert.equal(javaClass.readUInt16BE(6), generation.release + 44);
  const classpath = [main, ...(await fs.readFile(reportFile, 'utf8')).trim().split(path.delimiter)];
  const java = path.join(tools.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_MODEL_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_MODEL_JDBC_USER = database.user;
  env.RB_MODEL_JDBC_PASSWORD = database.password;
  const actual = await execute(java, ['-cp', classpath.join(path.delimiter), 'fixture.snapshot.SnapshotApp'],
    { cwd: root, env, timeoutMs: 25000 });
  assert.equal(actual.code, 0, 'The compiled Spring JDBC application failed.');
  const jar = 'jspecify-' + generation.jspecify + '.jar';
  assert.ok(actual.output.split(/\r?\n/u).includes('RB_MODEL_PROOF=42|2|' + jar));
  return { javaRelease: generation.release, dependencyJar: jar, jdbcRows: 2 };
}

module.exports = { modelRepository, reactorAt, runMaven, compileAndQuery };
