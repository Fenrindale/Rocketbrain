'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath } = require('./instance-inline-fixture');

const originalPackage = 'fixture.billing', renamedPackage = 'fixture.settlement';
const client = 'fixture.client.RunBilling';
const ownerPath = path.join('src', 'fixture', 'billing', 'Ledger.java');
const sourceFolder = path.dirname(ownerPath);
const targetFolder = path.join('src', 'fixture', 'settlement');
const clientPath = path.join('src', 'fixture', 'client', 'RunBilling.java');
const unrelated = path.join('src', 'fixture', 'billings', 'Other.java');
const resultText = 'invoice:42:prefix:8';
const bootProvider = path.join(sourceFolder, 'LedgerAutoConfiguration.java');
const bootRegistration = 'META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports';
const bootFiles = ['src/main/resources', 'src/test/resources'].map(root => path.join(root, bootRegistration));
const bootContents = [
  '# fixture.billing is retained in this comment\r\n  fixture.billing.LedgerAutoConfiguration  # ledger factory\r\nfixture.billings.OtherAutoConfiguration\r\n',
  '# test classpath entry\nfixture.billing.LedgerAutoConfiguration\n'
];

const sources = new Map([
  [ownerPath, [
    'package fixture.billing;',
    'import fixture.billing.detail.Amount;',
    'public final class Ledger {',
    '    public static final String TAG = "invoice";',
    '    public int amount() { return new Amount().get(); }',
    '}', ''
  ].join('\n')],
  [path.join(sourceFolder, 'detail', 'Amount.java'), [
    'package fixture.billing.detail;',
    'public final class Amount {',
    '    public int get() { return 39; }',
    '}', ''
  ].join('\n')],
  [clientPath, [
    'package fixture.client;',
    'import fixture.billing.*;',
    'import static fixture.billing.Ledger.TAG;',
    'import org.springframework.beans.factory.support.DefaultListableBeanFactory;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class RunBilling {',
    '    private record Shadow(Branch billing) {}',
    '    private record Branch(int marker) {}',
    '    private static int shadow() {',
    '        var fixture = new Shadow(new Branch(8));',
    '        return fixture.billing.marker;',
    '    }',
    '    public static void main(String[] args) {',
    '        var beans = new DefaultListableBeanFactory();',
    '        beans.registerSingleton("ledger", new fixture.billing.Ledger());',
    '        Ledger ledger = beans.getBean(Ledger.class);',
    '        java.util.function.IntSupplier amount = ledger::amount;',
    '        var ds = new DriverManagerDataSource(System.getenv("RB_PACKAGE_JDBC_URL"),',
    '            System.getenv("RB_PACKAGE_JDBC_USER"), System.getenv("RB_PACKAGE_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(ds);',
    '        int adjustment = jdbc.queryForObject("SELECT 3", Integer.class);',
    '        System.out.println("RB_PACKAGE=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|"',
    '            + TAG + ":" + (amount.getAsInt() + adjustment) + ":" + fixture.billings.Other.label() + ":" + shadow());',
    '    }',
    '}', ''
  ].join('\n')],
  [unrelated, 'package fixture.billings;\npublic final class Other { public static String label() { return "prefix"; } }\n'],
  [path.join('test', 'fixture', 'client', 'Probe.java'), [
    'package fixture.client;',
    'import fixture.billing.detail.Amount;',
    'public final class Probe {',
    '    public static int linked(fixture.billing.Ledger ledger) { return new Amount().get() + ledger.amount(); }',
    '}', ''
  ].join('\n')]
]);

function fixtureSources(withBoot = false) {
  if (!withBoot) return sources;
  const selected = new Map(sources);
  selected.set(bootProvider, [
    'package fixture.billing;',
    'import org.springframework.boot.autoconfigure.AutoConfiguration;',
    'import org.springframework.context.annotation.Bean;',
    '@AutoConfiguration',
    'public final class LedgerAutoConfiguration {',
    '    @Bean public Ledger ledger() { return new Ledger(); }',
    '}', ''
  ].join('\n'));
  selected.set(path.join('src', 'fixture', 'billings', 'OtherAutoConfiguration.java'), [
    'package fixture.billings;',
    '@org.springframework.boot.autoconfigure.AutoConfiguration',
    'public final class OtherAutoConfiguration {}', ''
  ].join('\n'));
  const caller = selected.get(clientPath)
    .replace('import org.springframework.beans.factory.support.DefaultListableBeanFactory;', [
      'import org.springframework.boot.SpringApplication;',
      'import org.springframework.boot.SpringBootConfiguration;',
      'import org.springframework.boot.WebApplicationType;',
      'import org.springframework.boot.autoconfigure.EnableAutoConfiguration;'
    ].join('\n'))
    .replace('public final class RunBilling {', '@SpringBootConfiguration(proxyBeanMethods = false)\n@EnableAutoConfiguration\npublic final class RunBilling {')
    .replace('        var beans = new DefaultListableBeanFactory();\n        beans.registerSingleton("ledger", new fixture.billing.Ledger());',
      '        var app = new SpringApplication(RunBilling.class);\n        app.setWebApplicationType(WebApplicationType.NONE);\n' +
      '        try (var beans = app.run("--spring.main.banner-mode=off", "--spring.main.log-startup-info=false")) {\n' +
      '        System.out.println("RB_BOOT_OWNER=" + beans.getBeanFactory().getBeanDefinition("ledger").getFactoryBeanName());')
    .replace('    }\n}', '        }\n    }\n}');
  selected.set(clientPath, caller);
  return selected;
}

function bootText(index, renamed) {
  return renamed ? bootContents[index].replace('fixture.billing.LedgerAutoConfiguration', 'fixture.settlement.LedgerAutoConfiguration') : bootContents[index];
}

async function packageClasspath(classpathFile, engine, withBoot = false) {
  const jdbc = await springJdbcClasspath(classpathFile, engine);
  if (!withBoot) return jdbc;
  const names = new Set(['spring-boot-4.1.2.jar', 'spring-boot-autoconfigure-4.1.2.jar',
    'spring-context-7.0.10.jar', 'spring-aop-7.0.10.jar', 'spring-expression-7.0.10.jar']);
  const boot = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter).filter(file => names.has(path.basename(file)));
  assert.deepEqual(new Set(boot.map(file => path.basename(file))), names);
  return [...jdbc, ...boot];
}

async function populatePackageRename(root, classpath, { withBoot = false } = {}) {
  await fs.mkdir(path.join(root, 'bin', 'test'), { recursive: true });
  await fs.mkdir(path.join(root, '.settings'));
  const javaVersion = 'eclipse.preferences.version=1\n' +
    'org.eclipse.jdt.core.compiler.compliance=25\norg.eclipse.jdt.core.compiler.source=25\n' +
    'org.eclipse.jdt.core.compiler.codegen.targetPlatform=25\n';
  await fs.writeFile(path.join(root, '.settings', 'org.eclipse.jdt.core.prefs'), javaVersion, { flag: 'wx' });
  const xml = value => value.replaceAll('\\', '/').replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  await fs.writeFile(path.join(root, '.project'), '<projectDescription><name>' + xml(path.basename(root)) +
    '</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' });
  const cp = '<classpath><classpathentry kind="src" path="src"/>' +
    '<classpathentry kind="src" path="test" output="bin/test"><attributes><attribute name="test" value="true"/></attributes></classpathentry>' +
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>' +
    classpath.map(file => '<classpathentry kind="lib" path="' + xml(file) + '"/>').join('') +
    '<classpathentry kind="output" path="bin"/></classpath>';
  await fs.writeFile(path.join(root, '.classpath'), cp, { flag: 'wx' });
  for (const [relative, text] of fixtureSources(withBoot)) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { flag: 'wx' });
  }
  if (withBoot) {
    for (const [index, relative] of bootFiles.entries()) {
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bootText(index, false), { flag: 'wx' });
    }
  }
}

async function runPackageSpring({ javaHome, root, classes, database, engine, classpathFile, renamed = false, withBoot = false }) {
  const java = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const classpath = await packageClasspath(classpathFile, engine, withBoot);
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_PACKAGE_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_PACKAGE_JDBC_USER = database.user;
  env.RB_PACKAGE_JDBC_PASSWORD = database.password;
  const files = [...fixtureSources(withBoot).keys()].map(file => renamed && file.startsWith(sourceFolder + path.sep)
    ? path.join(root, targetFolder, path.relative(sourceFolder, file)) : path.join(root, file));
  const compiled = await execute(java('javac'), ['-proc:none', '-encoding', 'UTF-8', '-classpath',
    classpath.join(path.delimiter), '-d', classes, ...files], { cwd: root, env, timeoutMs: 30000 });
  assert.equal(compiled.code, 0, compiled.output);
  const binary = path.join(classes, 'fixture', renamed ? 'settlement' : 'billing', 'Ledger.class');
  const retired = path.join(classes, 'fixture', renamed ? 'billing' : 'settlement', 'Ledger.class');
  assert.equal((await fs.lstat(binary)).isFile(), true);
  await assert.rejects(fs.stat(retired), { code: 'ENOENT' });
  const resources = withBoot ? [path.join(root, 'src/main/resources'),
    ...(engine === 'mariadb' ? [path.join(root, 'src/test/resources')] : [])] : [];
  const run = await execute(java('java'), ['-classpath', [classes, ...resources, ...classpath].join(path.delimiter), client],
    { cwd: root, env, timeoutMs: 30000 });
  assert.equal(run.code, 0, run.output);
  const observed = /^RB_PACKAGE=([^|\r\n]+)\|([^\r\n]+)$/mu.exec(run.output);
  assert.ok(observed, run.output);
  const [, server, output] = observed;
  assert.match(server, engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(output, resultText);
  if (withBoot) {
    assert.equal(/^RB_BOOT_OWNER=([^\r\n]+)$/mu.exec(run.output)?.[1],
      (renamed ? renamedPackage : originalPackage) + '.LedgerAutoConfiguration');
  }
  return { engine, server, output, ...(withBoot && { bootRegistrationResolved: true }) };
}

module.exports = { originalPackage, renamedPackage, ownerPath, sourceFolder, targetFolder, clientPath, unrelated,
  sources, populatePackageRename, runPackageSpring, fixtureSources, bootProvider, bootFiles, bootText, packageClasspath };
