'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createGroovyFixture } = require('./groovy-fixture');
const { springJdbcClasspath } = require('./instance-inline-fixture');

const specPath = path.join('src', 'test', 'groovy', 'groovyfixture', 'SpringScoreSpec.groovy');
const siblingPath = path.join(path.dirname(specPath), 'UnselectedSpec.groovy');
const spockSource = [
  'package groovyfixture',
  'import groovy.json.JsonSlurper',
  'import org.springframework.jdbc.core.JdbcTemplate',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource',
  'import spock.lang.Specification',
  'import spock.lang.Ignore',
  'import spock.lang.Unroll',
  '',
  'class SpringScoreSpec extends Specification {',
  '    @Unroll',
  '    def "Spring JDBC on #expected validates each Spock report independently"() {',
  '        given:',
  "        def config = new JsonSlurper().parse(new File(System.getProperty('fixture.dbConfig')))",
  "        def engine = System.getProperty('fixture.dbEngine')",
  "        def suffix = engine == 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''",
  '        def url = "jdbc:${engine}://127.0.0.1:${config.port}/${config.database}${suffix}".toString()',
  '        def jdbc = new JdbcTemplate(new DriverManagerDataSource(url, config.user, config.password))',
  "        def actual = jdbc.queryForObject('SELECT 42', Integer)",
  "        def version = jdbc.queryForObject('SELECT VERSION()', String)",
  "        new File(System.getProperty('fixture.observations')).append(version + ':' + actual + '\\n', 'UTF-8')",
  '        expect:',
  '        actual == expected',
  '        where:',
  '        expected << [42, 99]',
  '    }',
  '',
  "    @Ignore('An explicit skip stays visible in the selected specification')",
  '    def "owned skipped scenario"() {',
  '        expect:',
  '        false',
  '    }',
  '}',
  ''
].join('\n');
const failureLine = spockSource.split('\n').findIndex(line => line.trim() === 'actual == expected') + 1;
const otherSource = [
  'package groovyfixture',
  'import spock.lang.Specification',
  'class UnselectedSpec extends Specification {',
  '    def "this test was outside the selection"() {',
  '        given:',
  "        new File(System.getProperty('fixture.unselected')).write('Unselected test was invoked.')",
  '        expect:',
  '        false',
  '    }',
  '}',
  ''
].join('\n');

const quote = file => JSON.stringify(file.replaceAll('\\', '/'));

async function populateSpockSpring(workspace, { classpathFile, configFile, engine, gradleHome }) {
  const root = await createGroovyFixture(workspace);
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(configFile), 'owner.json'), 'utf8'));
  const database = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.equal(owner.kind, engine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const groovyJson = path.join(gradleHome, 'lib', 'groovy-json-4.0.28.jar');
  assert.ok((await fs.stat(groovyJson)).isFile());
  const dependencies = [...await springJdbcClasspath(classpathFile, engine), groovyJson];
  const build = path.join(root, 'build.gradle');
  const fixtureSource = path.join(root, specPath);
  const observations = path.join(root, '.spock-observed.txt');
  const unselected = path.join(root, '.spock-unselected.txt');
  await fs.writeFile(fixtureSource, spockSource, { flag: 'wx' });
  await fs.writeFile(path.join(root, siblingPath), otherSource, { flag: 'wx' });
  await fs.appendFile(build, '\n' +
    'dependencies { testImplementation files(' + dependencies.map(quote).join(', ') + ') }\n' +
    'test {\n' +
    "    systemProperty 'fixture.dbConfig', " + quote(configFile) + '\n' +
    "    systemProperty 'fixture.dbEngine', " + JSON.stringify(engine) + '\n' +
    "    systemProperty 'fixture.observations', " + quote(observations) + '\n' +
    "    systemProperty 'fixture.unselected', " + quote(unselected) + '\n' +
    '}\n');
  return { root, build, fixtureSource, observations, unselected };
}

async function assertSpockSpring(result, fixture, engine, runs = 1) {
  assert.equal(result.state, 'failed');
  assert.equal(result.task, ':test');
  assert.equal(result.specification, 'groovyfixture.SpringScoreSpec');
  assert.equal(result.line, 9);
  assert.equal(result.cases.length, 3);
  const passing = result.cases.find(item => item.state === 'SUCCESS');
  const failure = result.cases.find(item => item.state === 'FAILURE');
  const skipped = result.cases.find(item => item.state === 'SKIPPED');
  assert.match(passing?.displayName, /Spring JDBC on 42 /u);
  assert.match(failure?.displayName, /Spring JDBC on 99 /u);
  assert.match(failure.message, /actual == expected/u);
  assert.equal(failure.line, failureLine);
  assert.equal(skipped?.displayName, 'owned skipped scenario');
  await assert.rejects(fs.stat(fixture.unselected), { code: 'ENOENT' });
  const observed = (await fs.readFile(fixture.observations, 'utf8')).trim().split(/\r?\n/u);
  assert.equal(observed.length, 2 * runs);
  const version = engine === 'mysql' ? /^8\.4\.13:42$/u : /^11\.4\.8.*MariaDB:42$/u;
  assert.ok(observed.every(value => version.test(value)));
  return { server: observed[0].slice(0, -3), jdbcValue: 42, failureLine,
    cases: result.cases.map(({ displayName, state }) => ({ displayName, state })), executedOnlySelected: true };
}

module.exports = { populateSpockSpring, assertSpockSpring, spockSource, failureLine };
