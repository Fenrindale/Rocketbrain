'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const marker = '// rb-micronaut-breakpoint';
const configurations = {
  gradle: { folder: 'micronaut-gradle', controller: 'micronautgradlefixture/FixtureController.java',
    base: '/rocketbrain', greeting: '/hello', expected: 'gradle-dev', type: 'FixtureController', task: ':installDist' },
  maven: { folder: 'micronaut', controller: 'micronautfixture/GreetingController.java',
    base: '/greeting', greeting: '', expected: 'dev-world!;dev-world!;', type: 'GreetingController', task: 'package' }
};
const mavenEndpoint = [
  '',
  '    @Get(value = "/jdbc", produces = "text/plain")',
  '    public String jdbc() throws java.sql.SQLException {',
  '        try (var connection = java.sql.DriverManager.getConnection(System.getenv("RB_MICRONAUT_JDBC_URL"),',
  '                 System.getenv("RB_MICRONAUT_JDBC_USER"), System.getenv("RB_MICRONAUT_JDBC_PASSWORD"));',
  '             var statement = connection.prepareStatement("SELECT COUNT(*) FROM rb_spring_person");',
  '             var rows = statement.executeQuery()) {',
  '            rows.next();',
  '            int debuggerPeople = rows.getInt(1);',
  '            return String.valueOf(debuggerPeople); ' + marker,
  '        }',
  '    }',
  ''
].join('\n');

async function debugFixture(root, tool, { mavenRepository } = {}) {
  const selected = configurations[tool];
  const fixture = path.join(__dirname, '..', 'fixtures', 'java', selected.folder);
  const skipped = new Set(['build', 'bin', 'target', '.gradle', '.project', '.classpath', '.settings']);
  await fs.cp(fixture, root, { recursive: true, filter: file => !skipped.has(path.basename(file)) });
  const source = path.join(root, 'src', 'main', 'java', ...selected.controller.split('/'));
  let text = (await fs.readFile(source, 'utf8')).replace(/\r\n/gu, '\n');
  if (tool === 'maven') {
    text = text.replace(/\n\}\s*$/u, '\n' + mavenEndpoint + '}\n');
    const pom = path.join(root, 'pom.xml');
    const original = await fs.readFile(pom, 'utf8');
    const changed = original.replace('<properties>', '<properties>\n    <maven.compiler.debuglevel>lines,vars,source</maven.compiler.debuglevel>')
      .replace('<dependencies>', '<dependencies>\n' +
        '    <dependency><groupId>com.mysql</groupId><artifactId>mysql-connector-j</artifactId><version>26.7.0</version></dependency>\n' +
        '    <dependency><groupId>org.mariadb.jdbc</groupId><artifactId>mariadb-java-client</artifactId><version>3.5.10</version></dependency>');
    await fs.writeFile(pom, changed);
    if (mavenRepository) {
      await fs.mkdir(path.join(root, '.mvn'));
      await fs.writeFile(path.join(root, '.mvn', 'maven.config'), '-Dmaven.repo.local=' + path.resolve(mavenRepository) + '\n');
    }
  } else {
    text = text.replace('            return rows.getInt(1);',
      '            int debuggerPeople = rows.getInt(1);\n            return debuggerPeople; ' + marker);
    await fs.appendFile(path.join(root, 'build.gradle'),
      "\ntasks.withType(JavaCompile).configureEach { options.debugOptions.debugLevel = 'lines,vars,source' }\n");
  }
  const line = text.split('\n').findIndex(value => value.includes(marker)) + 1;
  assert.ok(line > 0);
  await fs.writeFile(source, text);
  return { ...selected, root, source, line, text };
}

async function verifyHttp(receipt, fixture) {
  const greeting = await get(receipt, fixture.base + fixture.greeting);
  const people = await get(receipt, fixture.base + '/jdbc');
  assert.equal(greeting, fixture.expected);
  assert.equal(people, '2');
  return { greeting, people: Number(people) };
}

async function get(receipt, route, ms = 50000) {
  const response = await fetch(receipt.baseUrl + route, { redirect: 'error', signal: AbortSignal.timeout(ms) });
  assert.equal(response.status, 200, await response.clone().text());
  return response.text();
}

async function assertClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error));
    socket.once('connect', () => { socket.destroy(); reject(Error('The former Micronaut listener still accepts connections.')); });
    socket.setTimeout(1500, () => { socket.destroy(); reject(Error('Closing the former Micronaut listener timed out.')); });
  });
}

async function pausedLocal(request, threadId, fixture) {
  const frame = (await request('stackTrace', { threadId })).stackFrames[0];
  assert.match(frame.name, new RegExp(fixture.type + '\\.jdbc', 'u'));
  assert.equal(frame.line, fixture.line);
  const sourcePath = frame.source.path.startsWith('file:') ? fileURLToPath(frame.source.path) : frame.source.path;
  assert.equal(path.relative(fixture.source, sourcePath), '');
  const scopes = (await request('scopes', { frameId: frame.id })).scopes;
  const locals = scopes.find(scope => /local/iu.test(scope.name));
  assert.ok(locals);
  const variables = (await request('variables', { variablesReference: locals.variablesReference })).variables;
  const count = variables.find(variable => variable.name === 'debuggerPeople');
  assert.equal(count?.type, 'int');
  assert.equal(count?.value, '2');
  return { method: frame.name, line: frame.line, name: count.name, type: count.type, value: count.value };
}

async function removeFixture(root, parent, identity) {
  const real = await fs.realpath(root), found = await fs.lstat(real, { bigint: true });
  assert.equal(path.relative(root, real), '');
  assert.equal(path.relative(parent, path.dirname(real)), '');
  assert.match(path.basename(real), /^rb-micronaut-debug-/u);
  assert.deepEqual([found.dev, found.ino], [identity.dev, identity.ino]);
  await fs.rm(real, { recursive: true, maxRetries: 12, retryDelay: 250 });
}

module.exports = { debugFixture, verifyHttp, get, assertClosed, pausedLocal, removeFixture };
