'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');

const input = path.resolve(__dirname, '../fixtures/java/mixed-type-rename');
const ownerFile = path.join('src/main/kotlin/mixed/rename/domain/Invoice.kt');
const kotlinCaller = path.join('src/main/kotlin/mixed/rename/tool/Invoices.kt');
const javaCaller = path.join('src/main/java/mixed/rename/app/JdbcConsumer.java');
const sameName = path.join('src/main/java/mixed/rename/shadow/Invoice.java');
const resource = path.join('src/main/resources/proof.properties');
const newName = 'ReviewedInvoice';
const expected = 'bill:42/direct:42/prefix retained/second type';
const classes = ['build/classes/java/main', 'build/classes/kotlin/main'];

async function rebuild(root, tools) {
  const spec = buildSpec({ root, tool: 'gradle', uri: pathToFileURL(root).href, name: 'Mixed type rename' },
    tools, ['writeReviewClasspath']);
  const result = await execute(spec.command, spec.args, { cwd: spec.cwd,
    env: { ...spec.env, ...(tools.gradleUserHome ? { GRADLE_USER_HOME: tools.gradleUserHome } : {}) },
    timeoutMs: 140000 });
  assert.equal(result.code, 0, result.output.slice(-4500));
  assert.match(result.output, /BUILD SUCCESSFUL/u);
}

async function classpath(root, kind) {
  assert.ok(kind === 'compile' || kind === 'runtime');
  return (await fs.readFile(path.join(root, 'build/review-' + kind + '-path.txt'), 'utf8')).trim().split(/\r?\n/);
}

const xmlAttribute = text => text.replace(/\\/gu, '/').replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;');

async function populate(root, tools, beforeBuild) {
  await fs.cp(input, root, { recursive: true });
  await beforeBuild?.();
  await rebuild(root, tools);
  await configureJdt(root);
}

async function configureJdt(root, { deployedRoot = root } = {}) {
  const jars = await classpath(root, 'compile');
  await fs.writeFile(path.join(root, '.project'), '<projectDescription><name>' + xmlAttribute(path.basename(root)) +
    '</name><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>' +
    '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>', { flag: 'wx' });
  await fs.writeFile(path.join(root, '.classpath'), '<classpath><classpathentry kind="src" path="src/main/java"/>' +
    '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>' +
    [...classes.slice(1).map(value => path.join(deployedRoot, value)), ...jars].map(value =>
      '<classpathentry kind="lib" path="' + xmlAttribute(value) + '"/>').join('') +
    '<classpathentry kind="output" path="bin"/></classpath>', { flag: 'wx' });
}

async function runJdbc(root, tools, config, engine, {
  mainClass = 'mixed.rename.app.JdbcConsumer', expectedOutput = expected
} = {}) {
  assert.ok(engine === 'mysql' || engine === 'mariadb');
  assert.equal(config.host, '127.0.0.1');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  assert.match(config.database, /^[a-z_]+$/u);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/iu.test(name)));
  env.RB_KRENAME_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_KRENAME_JDBC_USER = config.user;
  env.RB_KRENAME_JDBC_PASSWORD = config.password;
  const java = path.join(tools.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const cp = [...classes.map(entry => path.join(root, entry)), ...await classpath(root, 'runtime')];
  const result = await execute(java, ['-cp', cp.join(path.delimiter), mainClass],
    { cwd: root, env, timeoutMs: 20000 });
  assert.equal(result.code, 0, result.output);
  const [server, output] = result.output.trim().split('|');
  assert.match(server, engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(output, expectedOutput);
  return { engine, server, output };
}

module.exports = { input, ownerFile, kotlinCaller, javaCaller, sameName, resource, newName, expected,
  populate, rebuild, configureJdt, runJdbc };
