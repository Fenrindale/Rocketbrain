'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { createHash, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');

const version = '1.2-SNAPSHOT';
const group = 'fixture.rocketbrain';
const repositoryId = 'rocketbrain-test-snapshots';
const plugin = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0';
const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
const dependency = (groupId, artifactId, version, scope = '') =>
  `<dependency><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version>` +
  (scope ? `<scope>${scope}</scope>` : '') + '</dependency>';

function javaBin(javaHome, tool) {
  return path.join(javaHome, 'bin', tool + (process.platform === 'win32' ? '.exe' : ''));
}

async function maven(project, tools, goals, options = []) {
  const spec = buildSpec(project, tools, goals);
  const result = await execute(spec.command, [...spec.args, '--non-recursive', '-Dstyle.color=never', ...options],
    { cwd: spec.cwd, env: spec.env, timeoutMs: 90000 });
  assert.equal(result.code, 0, result.output);
  return result;
}

async function fixtureRepository(t, tools, cache) {
  const artifact = 'snapshot-' + randomUUID().slice(0, 8);
  const relative = [...group.split('.'), artifact, version].join('/');
  const folder = path.join(cache, ...relative.split('/'));
  const files = new Map(), requests = [];
  const server = http.createServer((request, response) => {
    const content = files.get(request.url);
    if (!['GET', 'HEAD'].includes(request.method) || !content) {
      response.writeHead(404).end();
      return;
    }
    requests.push(request.url);
    response.writeHead(200, { 'Content-Length': content.length, 'Content-Type': 'application/octet-stream' });
    response.end(request.method === 'HEAD' ? undefined : content);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolve);
  });
  const url = 'http://127.0.0.1:' + server.address().port;

  function publishFile(name, bytes) {
    const address = '/' + relative + '/' + name;
    files.set(address, Buffer.from(bytes));
    files.set(address + '.sha1', Buffer.from(digest(bytes, 'sha1')));
  }

  async function publish(index) {
    assert.ok([1, 2].includes(index));
    const stamp = '20261126.01150' + index, resolved = '1.2-' + stamp + '-' + index, marker = 'owned-snapshot-' + index;
    const dir = path.join(t, 'publication-' + index), classes = path.join(dir, 'classes');
    await fs.mkdir(classes, { recursive: true });
    const source = path.join(dir, 'PublishedBuild.java'), jar = path.join(dir, 'payload.jar');
    await fs.writeFile(source, 'package fixture.snapshot; public class PublishedBuild { public static String marker() { return "' +
      marker + '"; } }\n');
    const compiler = await execute(javaBin(tools.javaHome, 'javac'), ['--release', '17', '-d', classes, source], { cwd: dir });
    assert.equal(compiler.code, 0, compiler.output);
    const packaging = await execute(javaBin(tools.javaHome, 'jar'), ['--create', '--file', jar, '-C', classes, '.'], { cwd: dir });
    assert.equal(packaging.code, 0, packaging.output);
    const jarBytes = await fs.readFile(jar);
    const jarName = artifact + '-' + resolved + '.jar';
    publishFile(jarName, jarBytes);
    publishFile(artifact + '-' + resolved + '.pom', '<project><modelVersion>4.0.0</modelVersion><groupId>' + group +
      '</groupId><artifactId>' + artifact + '</artifactId><version>' + version + '</version></project>');
    const updated = stamp.replace('.', '');
    const versions = ['jar', 'pom'].map(extension => '<snapshotVersion><extension>' + extension + '</extension><value>' +
      resolved + '</value><updated>' + updated + '</updated></snapshotVersion>').join('');
    publishFile('maven-metadata.xml', '<?xml version="1.0" encoding="UTF-8"?><metadata><groupId>' +
      group + '</groupId><artifactId>' + artifact + '</artifactId><version>' + version + '</version><versioning>' +
      '<snapshot><timestamp>' + stamp + '</timestamp><buildNumber>' + index + '</buildNumber></snapshot><lastUpdated>' +
      updated + '</lastUpdated><snapshotVersions>' + versions + '</snapshotVersions></versioning></metadata>');
    return { sha256: digest(jarBytes), resolved, marker, jarName, request: '/' + relative + '/' + jarName };
  }

  return { artifact, url, folder, requests, publish, close: () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) };
}

async function consumer(root, repository, cache) {
  const sources = path.join(root, 'src/main/java/fixture/snapshot');
  await fs.mkdir(sources, { recursive: true });
  await fs.mkdir(path.join(root, '.mvn'));
  const settings = path.join(root, 'fixture-settings.xml');
  await fs.writeFile(settings, '<settings><interactiveMode>false</interactiveMode></settings>\n');
  await fs.writeFile(path.join(root, '.mvn/maven.config'), '-Dmaven.repo.local=' + cache + '\n--settings\n' +
    settings + '\n--no-transfer-progress\n');
  await fs.writeFile(path.join(root, 'pom.xml'), [
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>',
    '<groupId>' + group + '</groupId><artifactId>snapshot-consumer</artifactId><version>1</version>',
    '<properties><maven.compiler.release>25</maven.compiler.release></properties>',
    '<repositories><repository><id>' + repositoryId + '</id><url>' + repository.url + '</url>',
    '<releases><enabled>false</enabled></releases><snapshots><enabled>true</enabled><updatePolicy>always</updatePolicy>',
    '<checksumPolicy>fail</checksumPolicy></snapshots></repository></repositories>',
    '<dependencies>', dependency(group, repository.artifact, version),
    dependency('org.springframework', 'spring-jdbc', '7.0.10'),
    dependency('com.mysql', 'mysql-connector-j', '9.7.0', 'runtime'),
    dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10', 'runtime'), '</dependencies>',
    '<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId>',
    '<artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version></plugin></plugins></build></project>', ''
  ].join('\n'));
  await fs.writeFile(path.join(sources, 'SnapshotConsumer.java'), [
    'package fixture.snapshot;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SnapshotConsumer {',
    '  public static void main(String[] args) {',
    '    var ds = new DriverManagerDataSource(System.getenv("RB_SNAPSHOT_JDBC_URL"),',
    '        System.getenv("RB_SNAPSHOT_JDBC_USER"), System.getenv("RB_SNAPSHOT_JDBC_PASSWORD"));',
    '    int people = new JdbcTemplate(ds).queryForObject("SELECT COUNT(*) FROM rb_spring_person", Integer.class);',
    '    System.out.println("RB_SNAPSHOT=" + PublishedBuild.marker() + "|" + people);',
    '  }',
    '}', ''
  ].join('\n'));
  return { root, uri: pathToFileURL(root).href, tool: 'maven', name: 'Snapshot consumer' };
}

async function resolveClasspath(project, tools) {
  const file = path.join(project.root, 'rb-snapshot-classpath.txt');
  await maven(project, tools, ['compile', plugin + ':build-classpath'], ['-U', '-DincludeScope=runtime', '-Dmdep.outputFile=' + file]);
  return [path.join(project.root, 'target/classes'), ...(await fs.readFile(file, 'utf8')).trim().split(path.delimiter)];
}

async function runConsumer(project, tools, classpath, database, engine, marker) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.deepEqual([database.host, database.database], ['127.0.0.1', 'rocketbrain_fixture']);
  assert.ok(Number.isInteger(database.port) && database.port > 1024 && database.port < 65536);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_SNAPSHOT_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_SNAPSHOT_JDBC_USER = database.user;
  env.RB_SNAPSHOT_JDBC_PASSWORD = database.password;
  const actual = await execute(javaBin(tools.javaHome, 'java'), ['-cp', classpath.join(path.delimiter), 'fixture.snapshot.SnapshotConsumer'],
    { cwd: project.root, env, timeoutMs: 25000 });
  assert.equal(actual.code, 0, 'The fixture Spring JDBC consumer failed.');
  assert.ok(actual.output.split(/\r?\n/u).includes('RB_SNAPSHOT=' + marker + '|2'), 'The expected snapshot Java code and JDBC rows were not observed.');
}

module.exports = { fixtureRepository, consumer, resolveClasspath, runConsumer, maven, version, repositoryId, plugin, digest };
