'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execute} = require('../../src/java/testing/provision');
const {packageClasspath} = require('./java-package-rename-fixture');

const apiModule = 'fixture.service.api';
const consumerModule = 'fixture.service.client';
const leftModule = 'fixture.service.left';
const rightModule = 'fixture.service.right';
const modules = [['spi', apiModule], ['left', leftModule], ['right', rightModule], ['client', consumerModule]];
const oldPackage = apiModule + '.ledger';
const newPackage = 'fixture.contracts.settlement';
const main = path.join('src', 'main', 'java');
const sourceFolder = path.join('spi', main, ...oldPackage.split('.'));
const targetFolder = path.join('spi', main, ...newPackage.split('.'));
const selected = path.join(sourceFolder, 'Ledger.java');
const destination = path.join(targetFolder, 'Ledger.java');
const base = pkg => path.join(...pkg.split('.'));
const moduleFile = name => path.join(name, main, 'module-info.java');
const javaFile = (name, pkg, file) => path.join(name, main, base(pkg), file);
const expected = '[17, 29]';
const original = new Map([
  [moduleFile('spi'), 'module ' + apiModule + ' { exports ' + oldPackage + '; /* service contract */ }\n'],
  [moduleFile('left'), [
    'module ' + leftModule + ' { requires ' + apiModule + ';',
    '  provides ' + oldPackage + '.Ledger /* exact, keep comment */ with ' + leftModule + '.Direct;',
    '}', ''
  ].join('\n')],
  [moduleFile('right'), 'module ' + rightModule + ' { requires ' + apiModule + '; provides ' + oldPackage +
    '.Ledger with ' + rightModule + '.ProviderFactory; }\n'],
  [moduleFile('client'), 'module ' + consumerModule + ' { requires ' + apiModule + '; uses ' + oldPackage + '.Ledger; }\n'],
  [selected, 'package ' + oldPackage + '; public interface Ledger { int amount(); }\n'],
  [javaFile('left', leftModule, 'Direct.java'), 'package ' + leftModule + '; import ' + oldPackage +
    '.Ledger; public final class Direct implements Ledger { public int amount() { return 17; } }\n'],
  [javaFile('right', rightModule, 'ProviderFactory.java'), [
    'package ' + rightModule + ';',
    'import ' + oldPackage + '.Ledger;',
    'public final class ProviderFactory {',
    '  private ProviderFactory() {}',
    '  public static Ledger provider() { return new LedgerValue(); }',
    '}', ''
  ].join('\n')],
  [javaFile('right', rightModule, 'LedgerValue.java'), 'package ' + rightModule + '; public final class LedgerValue implements ' +
    oldPackage + '.Ledger { public int amount() { return 29; } }\n'],
  [javaFile('client', consumerModule, 'Probe.java'), [
    'package ' + consumerModule + ';',
    'import ' + oldPackage + '.Ledger;',
    'public final class Probe {',
    '    public static String run() {',
    '        return java.util.ServiceLoader.load(java.lang.ModuleLayer.boot(), Ledger.class)',
    '          .stream().map(provider -> provider.get().amount()).toList().stream().sorted().toList().toString();',
    '    }',
    '    public static void main(String[] args) { System.out.println("RB_SERVICES=" + run()); }',
    '}', ''
  ].join('\n')],
  [javaFile('client', consumerModule, 'Peer.java'), 'package ' + consumerModule + '; class Peer { int unchanged() { return 4; } }\n']
]);

const coordinate = artifact => '<groupId>org.rocketbrain.jpmsmove</groupId><artifactId>' + artifact + '</artifactId><version>1</version>';
const pom = body => '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>' + body + '</project>\n';
const outputPaths = root => modules.map(([name]) => path.join(root, name, 'target', 'classes'));

async function populate(root) {
  await fs.mkdir(root, {recursive: true});
  await fs.writeFile(path.join(root, 'pom.xml'), pom(coordinate('parent') + '<packaging>pom</packaging><modules>' +
    modules.map(([name]) => '<module>' + name + '</module>').join('') + '</modules><properties>' +
    '<maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>'), {flag: 'wx'});
  for (const [name] of modules) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    const dependencies = name === 'spi' ? '' : '<dependencies><dependency>' + coordinate('spi') + '</dependency></dependencies>';
    await fs.writeFile(path.join(directory, 'pom.xml'), pom('<parent>' + coordinate('parent') + '</parent><artifactId>' + name +
      '</artifactId>' + dependencies), {flag: 'wx'});
  }
  await fs.mkdir(path.join(root, targetFolder), {recursive: true});
  const resources = path.join(root, 'spi', 'src/main/resources');
  await fs.mkdir(resources, {recursive: true});
  await fs.writeFile(path.join(resources, 'owner.txt'), 'Service module resource stays in the same module.\n', {flag: 'wx'});
  for (const [file, text] of original) {
    await fs.mkdir(path.dirname(path.join(root, file)), {recursive: true});
    await fs.writeFile(path.join(root, file), text, {flag: 'wx'});
  }
}

function envForJvm() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|MAVEN_ARGS|MAVEN_OPTS)$/iu.test(key)));
}
const executable = (javaHome, name) => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));

async function runMaven(root, javaHome, mavenHome, repository, {rebuild = false} = {}) {
  const goals = rebuild ? ['org.apache.maven.plugins:maven-clean-plugin:3.4.1:clean', 'compile'] : ['compile'];
  const boot = path.join(mavenHome, 'boot');
  const launchers = (await fs.readdir(boot)).filter(name => /^plexus-classworlds-[\d.]+\.jar$/u.test(name));
  assert.equal(launchers.length, 1);
  const result = await execute(executable(javaHome, 'java'), [
    '-Dmaven.home=' + mavenHome, '-Dclassworlds.conf=' + path.join(mavenHome, 'bin', 'm2.conf'),
    '-Dmaven.multiModuleProjectDirectory=' + root, '-Dmaven.repo.local=' + repository, '-cp', path.join(boot, launchers[0]),
    'org.codehaus.plexus.classworlds.launcher.Launcher', '--offline', '--batch-mode', '--no-transfer-progress', ...goals
  ], {cwd: root, env: envForJvm(), timeoutMs: 120000});
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Reactor Summary/);
  return result.output;
}

async function runModule(root, javaHome, moved = false) {
  const outputs = outputPaths(root);
  const result = await execute(executable(javaHome, 'java'), ['--module-path', outputs.join(path.delimiter), '--module',
    consumerModule + '/' + consumerModule + '.Probe'], {cwd: root, env: envForJvm(), timeoutMs: 20000});
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), 'RB_SERVICES=' + expected);
  const packageName = moved ? newPackage : oldPackage, absent = moved ? oldPackage : newPackage;
  await fs.access(path.join(outputs[0], base(packageName), 'Ledger.class'));
  assert.equal(await fs.readFile(path.join(outputs[0], 'owner.txt'), 'utf8'), 'Service module resource stays in the same module.\n');
  await assert.rejects(fs.access(path.join(outputs[0], base(absent), 'Ledger.class')), {code: 'ENOENT'});
  return {namedProviderValues: expected, fromSeparateProviderModules: true, staleClassAbsent: true};
}

async function runSpring({root, work, javaHome, cpFile, configFile, engine}) {
  const database = JSON.parse(await fs.readFile(configFile, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(configFile), 'owner.json'), 'utf8'));
  assert.equal(owner.kind, engine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isSafeInteger(database.port) && database.port >= 1024 && database.port <= 65535);
  assert.match(database.database, /^[A-Za-z0-9_]+$/u);
  const bridge = path.join(work, 'SpringServiceProof.java');
  await fs.writeFile(bridge, [
    'import ' + consumerModule + '.Probe;',
    'import org.springframework.beans.factory.support.DefaultListableBeanFactory;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SpringServiceProof {',
    '  public static void main(String[] args) {',
    '    var spring = new DefaultListableBeanFactory();',
    '    spring.registerSingleton("ledgerProviders", Probe.run());',
    '    var db = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_SERVICE_URL"),',
    '      System.getenv("RB_SERVICE_USER"), System.getenv("RB_SERVICE_PASSWORD")));',
    '    System.out.println("RB_SPRING_SERVICES=" + spring.getBean("ledgerProviders") + "|"',
    '      + db.queryForObject("SELECT VERSION()", String.class) + "|" + db.queryForObject("SELECT 46", Integer.class));',
    '  }',
    '}', ''
  ].join('\n'), {flag: 'wx'});
  const classpath = (await packageClasspath(cpFile, engine)).join(path.delimiter);
  const common = ['--module-path', outputPaths(root).join(path.delimiter), '--add-modules', consumerModule,
    '--add-exports', consumerModule + '/' + consumerModule + '=ALL-UNNAMED', '-classpath', classpath];
  const compile = await execute(executable(javaHome, 'javac'), ['-proc:none', ...common, '-d', work, bridge], {env: envForJvm(), timeoutMs: 25000});
  assert.equal(compile.code, 0, compile.output);
  const environment = envForJvm();
  environment.RB_SERVICE_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?sslMode=DISABLED&allowPublicKeyRetrieval=true' : '?sslMode=disable');
  environment.RB_SERVICE_USER = database.user;
  environment.RB_SERVICE_PASSWORD = database.password;
  const result = await execute(executable(javaHome, 'java'), [...common.slice(0, -1), [work, classpath].join(path.delimiter),
    'SpringServiceProof'], {env: environment, timeoutMs: 25000});
  assert.equal(result.code, 0, 'Spring ServiceLoader/JDBC process did not succeed.');
  const evidence = /^RB_SPRING_SERVICES=(\[[0-9, ]+\])\|([^|\r\n]+)\|(\d+)$/mu.exec(result.output);
  assert.ok(evidence);
  assert.equal(evidence[1], expected);
  assert.match(evidence[2], engine === 'mysql' ? /^8\.4\./u : /^11\.4\.[0-9]+-MariaDB/u);
  assert.equal(evidence[3], '46');
  return {engine, version: evidence[2], providerValues: evidence[1], jdbcValue: 46};
}

module.exports = {apiModule, consumerModule, leftModule, rightModule, modules, oldPackage, newPackage,
  main, sourceFolder, targetFolder, selected, destination, original, expected, populate, outputPaths, runMaven, runModule, runSpring};
