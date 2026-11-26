'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath } = require('./instance-inline-fixture');

function typeRenameFixture(namespace, id) {
  const oldName = id + 'Service';
  const newName = id + 'BillingService';
  const additional = oldName + 'Extra';
  const caller = id + 'Client';
  const callerPackage = namespace + '.' + id.toLowerCase();
  const oldFqn = namespace + '.' + oldName;
  const newFqn = namespace + '.' + newName;
  const ownerText = [
    'package ' + namespace + ';',
    'public final class ' + oldName + ' {',
    '    public static final String CODE = "bill";',
    '    public ' + oldName + '() {}',
    '    public int amount() { return 19; }',
    '}', ''
  ].join('\n');
  const extraText = [
    'package ' + namespace + ';',
    'public final class ' + additional + ' {}', ''
  ].join('\n');
  const callerText = [
    'package ' + callerPackage + ';',
    'import ' + oldFqn + ';',
    'import ' + namespace + '.' + additional + ';',
    'import static ' + oldFqn + '.CODE;',
    'import org.springframework.context.support.GenericXmlApplicationContext;',
    'import org.springframework.core.io.FileSystemResource;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class ' + caller + ' {',
    '    public static void main(String[] args) {',
    '        var ds = new DriverManagerDataSource(System.getenv("RB_TYPE_RENAME_URL"),',
    '            System.getenv("RB_TYPE_RENAME_USER"), System.getenv("RB_TYPE_RENAME_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(ds);',
    '        try (var context = new GenericXmlApplicationContext()) {',
    '            context.load(new FileSystemResource(args[0]));',
    '            context.refresh();',
    '            ' + oldName + ' bean = context.getBean("stable-service", ' + oldFqn + '.class);',
    '            java.util.function.Supplier<' + oldName + '> lazy = ' + oldName + '::new;',
    '            int sql = jdbc.queryForObject("SELECT 4", Integer.class);',
    '            System.out.println("RB_TYPE_RENAME=" + jdbc.queryForObject("SELECT VERSION()", String.class) + "|" ',
    '                + CODE + ":" + (bean.amount() + lazy.get().amount() + sql) + ":"',
    '                + context.getBean("extra-service", ' + additional + '.class).getClass().getSimpleName());',
    '        }',
    '    }',
    '}', ''
  ].join('\n');
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<b:beans xmlns:b="http://www.springframework.org/schema/beans"',
    '         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
    '         xsi:schemaLocation="http://www.springframework.org/schema/beans https://www.springframework.org/schema/beans/spring-beans.xsd">',
    '    <!-- Retain the historic name ' + oldFqn + ' in this comment. -->',
    '    <b:bean id="stable-service" class=\'' + oldFqn + '\'/>',
    '    <b:bean id="extra-service" class="' + namespace + '.' + additional + '"/>',
    '</b:beans>', ''
  ].join('\n');
  return {
    namespace, callerPackage, caller, oldName, newName, oldFqn, newFqn, additional, ownerText, extraText, callerText,
    xml, expected: 'bill:42:' + additional, xmlFileName: id.toLowerCase() + '-beans.xml'
  };
}

async function springTypeRenameClasspath(file, engine) {
  const jdbc = await springJdbcClasspath(file, engine);
  const extra = new Set(['spring-context-7.0.10.jar', 'spring-aop-7.0.10.jar', 'spring-expression-7.0.10.jar',
    'micrometer-observation-1.17.2.jar', 'micrometer-commons-1.17.2.jar']);
  const entries = (await fs.readFile(file, 'utf8')).trim().split(path.delimiter)
    .filter(entry => extra.has(path.basename(entry)));
  assert.deepEqual(new Set(entries.map(file => path.basename(file))), extra);
  return [...jdbc, ...entries];
}

async function runSpringTypeRename({ javaHome, files, xmlFile, classpath, className, classes, config, engine }) {
  const tool = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(config.host, '127.0.0.1');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  assert.match(config.database, /^[a-z_]+$/u);
  env.RB_TYPE_RENAME_URL = 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_TYPE_RENAME_USER = config.user;
  env.RB_TYPE_RENAME_PASSWORD = config.password;
  const compiled = await execute(tool('javac'), ['-proc:none', '-encoding', 'UTF-8',
    '-classpath', classpath.join(path.delimiter), '-d', classes, ...files], { env, timeoutMs: 30000 });
  assert.equal(compiled.code, 0, compiled.output);
  const run = await execute(tool('java'), ['-classpath', [classes, ...classpath].join(path.delimiter), className, xmlFile],
    { env, timeoutMs: 30000 });
  assert.equal(run.code, 0, run.output);
  const match = /^RB_TYPE_RENAME=([^|\r\n]+)\|([^\r\n]+)$/mu.exec(run.output);
  assert.ok(match, run.output);
  const [, server, output] = match;
  assert.match(server, engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*MariaDB/u);
  return { engine, server, output };
}

module.exports = { typeRenameFixture, springTypeRenameClasspath, runSpringTypeRename };
