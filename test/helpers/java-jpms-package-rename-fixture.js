'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { packageClasspath } = require('./java-package-rename-fixture');

const moduleName = 'fixture.jpmsrename';
const oldPackage = moduleName + '.billing', newPackage = moduleName + '.settlement';
const main = path.join('src', 'main', 'java');
const namespace = path.join(...moduleName.split('.'));
const sourceFolder = path.join(main, namespace, 'billing');
const targetFolder = path.join(main, namespace, 'settlement');
const owner = path.join(sourceFolder, 'Ledger.java');
const descriptor = path.join(main, 'module-info.java');
const client = path.join(main, namespace, 'client', 'ModuleProbe.java');
const unrelatedProvider = path.join(main, namespace, 'billings', 'Other.java');
const providers = '[29, 17]';

const moduleText = [
  'module ' + moduleName + ' {',
  '    requires java.base;',
  '    exports ' + oldPackage + '; // public ledger',
  '    exports ' + moduleName + '.client;',
  '    opens ' + oldPackage + '.impl; // ordinary reflection',
  '    uses ' + oldPackage + '.Ledger;',
  '    provides ' + oldPackage + '.Ledger with',
  '        ' + oldPackage + '.impl.FactoryProvider,',
  '        ' + moduleName + '.billings.Other;',
  '}', ''
].join('\n');

const fixtureSources = new Map([
  [descriptor, moduleText],
  [owner, 'package ' + oldPackage + '; public interface Ledger { int amount(); }\n'],
  [path.join(sourceFolder, 'impl', 'FactoryProvider.java'), [
    'package ' + oldPackage + '.impl;',
    'import ' + oldPackage + '.Ledger;',
    'public final class FactoryProvider {',
    '  private FactoryProvider() {}',
    '  public static Ledger provider() { return new FactoryValue(); }',
    '}', ''
  ].join('\n')],
  [path.join(sourceFolder, 'impl', 'FactoryValue.java'),
    'package ' + oldPackage + '.impl; public final class FactoryValue implements ' + oldPackage + '.Ledger { public int amount() { return 29; } }\n'],
  [unrelatedProvider,
    'package ' + moduleName + '.billings; public final class Other implements ' + oldPackage + '.Ledger { public int amount() { return 17; } }\n'],
  [client, [
    'package ' + moduleName + '.client;',
    'public final class ModuleProbe {',
    '  public static String values() {',
    '    return java.util.ServiceLoader.load(java.lang.ModuleLayer.boot(), ' + oldPackage + '.Ledger.class)',
    '      .stream().map(provider -> provider.get().amount()).toList().toString();',
    '  }',
    '  public static void main(String[] args) { System.out.println("RB_JPMS=" + values()); }',
    '}', ''
  ].join('\n')]
]);

async function populate(root) {
  await fs.mkdir(path.join(root, 'bin', 'main'), { recursive: true });
  await fs.mkdir(path.join(root, '.settings'));
  await fs.writeFile(path.join(root, '.project'),
    '<projectDescription><name>' + path.basename(root) + '</name><buildSpec>' +
    '<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' });
  await fs.writeFile(path.join(root, '.classpath'), '<classpath><classpathentry kind="src" path="src/main/java"/>' +
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER">' +
    '<attributes><attribute name="module" value="true"/></attributes></classpathentry>' +
    '<classpathentry kind="output" path="bin/main"/></classpath>', { flag: 'wx' });
  await fs.writeFile(path.join(root, '.settings', 'org.eclipse.jdt.core.prefs'), [
    'eclipse.preferences.version=1', 'org.eclipse.jdt.core.compiler.compliance=25',
    'org.eclipse.jdt.core.compiler.source=25', 'org.eclipse.jdt.core.compiler.codegen.targetPlatform=25', ''
  ].join('\n'), { flag: 'wx' });
  for (const [relative, text] of fixtureSources) {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, { flag: 'wx' });
  }
}

function javaTool(javaHome, tool) {
  return path.join(javaHome, 'bin', tool + (process.platform === 'win32' ? '.exe' : ''));
}

function runtimeEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(key)));
}

async function executeJava(javaHome, command, args, options) {
  const result = await execute(javaTool(javaHome, command), args, { timeoutMs: 34000, ...options });
  assert.equal(result.code, 0, result.output);
  return result.output;
}

async function compileModule(root, classes, javaHome, renamed = false) {
  const files = [...fixtureSources.keys()].map(file => file.startsWith(sourceFolder + path.sep) && renamed
    ? path.join(root, targetFolder, path.relative(sourceFolder, file)) : path.join(root, file));
  await executeJava(javaHome, 'javac', ['-proc:none', '-encoding', 'UTF-8', '-d', classes, ...files],
    { cwd: root, env: runtimeEnvironment() });
  const output = await executeJava(javaHome, 'java', ['--module-path', classes, '-m', moduleName + '/' + moduleName + '.client.ModuleProbe'],
    { cwd: root, env: runtimeEnvironment() });
  assert.equal(output.trim(), 'RB_JPMS=' + providers);
  await fs.stat(path.join(classes, 'module-info.class'));
  await fs.stat(path.join(classes, namespace, renamed ? 'settlement' : 'billing', 'Ledger.class'));
  await assert.rejects(fs.stat(path.join(classes, namespace, renamed ? 'billing' : 'settlement', 'Ledger.class')), { code: 'ENOENT' });
  return { module: moduleName, providers };
}

async function runSpring({ root, classes, javaHome, cpFile, data, engine, renamed }) {
  const packageName = renamed ? newPackage : oldPackage;
  const bridge = path.join(root, 'JpmsSpring.java');
  await fs.writeFile(bridge, [
    'import ' + packageName + '.Ledger;',
    'import ' + moduleName + '.client.ModuleProbe;',
    'import org.springframework.beans.factory.support.DefaultListableBeanFactory;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class JpmsSpring {',
    '  public static void main(String[] args) {',
    '    Class<?> type = Ledger.class;',
    '    var module = type.getModule();',
    '    if (!module.isExported(type.getPackageName()) || !module.isOpen(type.getPackageName() + ".impl")) throw new AssertionError();',
    '    var spring = new DefaultListableBeanFactory();',
    '    spring.registerSingleton("resolved", ModuleProbe.values());',
    '    var datasource = new DriverManagerDataSource(System.getenv("RB_JPMS_URL"), System.getenv("RB_JPMS_USER"), System.getenv("RB_JPMS_PASSWORD"));',
    '    var jdbc = new JdbcTemplate(datasource);',
    '    System.out.println("RB_JPMS_SPRING=" + jdbc.queryForObject("SELECT VERSION()", String.class)',
    '      + "|" + spring.getBean("resolved", String.class) + "|" + jdbc.queryForObject("SELECT 42", Integer.class));',
    '  }',
    '}', ''
  ].join('\n'), { flag: 'wx' });
  const cp = (await packageClasspath(cpFile, engine)).join(path.delimiter);
  const modulePath = ['--module-path', classes, '--add-modules', moduleName];
  const env = runtimeEnvironment();
  assert.equal(data.host, '127.0.0.1');
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.ok(Number.isInteger(data.port) && data.port > 0 && data.port < 65536);
  assert.match(data.database, /^[a-z_]+$/u);
  env.RB_JPMS_URL = 'jdbc:' + engine + '://127.0.0.1:' + data.port + '/' + data.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_JPMS_USER = data.user;
  env.RB_JPMS_PASSWORD = data.password;
  await executeJava(javaHome, 'javac', ['-proc:none', ...modulePath, '-classpath', cp, '-d', root, bridge], { cwd: root, env });
  const output = await executeJava(javaHome, 'java', [...modulePath, '-classpath', root + path.delimiter + cp, 'JpmsSpring'],
    { cwd: root, env });
  const result = /^RB_JPMS_SPRING=([^|\r\n]+)\|([^|\r\n]+)\|(\d+)$/mu.exec(output);
  assert.ok(result, output);
  assert.match(result[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(result[2], providers);
  assert.equal(Number(result[3]), 42);
  return { engine, server: result[1], providers: result[2], jdbc: 42, exportedAndOpen: true };
}

module.exports = { moduleName, oldPackage, newPackage, main, sourceFolder, targetFolder, owner, descriptor,
  client, unrelatedProvider, fixtureSources, populate, compileModule, runSpring };
