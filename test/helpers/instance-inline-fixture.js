'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');

const output = '49:9123/69:9123/89:9123/99';

function instanceInlineFixture(namespace, name, { spring = false } = {}) {
  const call = 'new ' + name + '(10).calculate(step(1), step(2), step(input))';
  const explicit = 'this.calculate(step(1), step(2), step(input))';
  const implicit = 'calculate(step(1), step(2), step(input))';
  const nullable = 'candidate.calculate(step(1), step(2), step(input))';
  const constant = 'this.readConstant()';
  const source = [
    'package ' + namespace + ';',
    ...(spring ? ['import org.springframework.jdbc.core.JdbcTemplate;', 'import org.springframework.jdbc.datasource.DriverManagerDataSource;'] : []),
    'public final class ' + name + ' {',
    '    private static final int NEVER_CHANGE = 42;',
    '    private static int trace;',
    '    private static ' + name + ' last;',
    '    private volatile int offset;',
    '    private final int bias;',
    '    private int backup;',
    '    private ' + name + '(int value) {',
    '        offset = value;',
    '        bias = value + 1;',
    '        trace = trace * 10 + 9;',
    '        last = this;',
    '    }',
    '    private static int step(int digit) {',
    '        trace = trace * 10 + digit;',
    '        last.offset += digit;',
    '        return digit;',
    '    }',
    '    private int calculate(int left, int right, int ignored) {',
    '        return offset + this.bias + right * 10 + left + left;',
    '    }',
    '    private int calculate(String value) { return 99; }',
    '    private int readConstant() { return NEVER_CHANGE; }',
    '    static int newSite(int input) {',
    '        int rbInlineReceiver1 = -1;',
    '        return ' + call + ';',
    '    }',
    '    int implicitSite(int input) { return ' + implicit + '; }',
    '    int explicitSite(int input) {',
    '        int offset = -100;',
    '        var value = ' + explicit + ';',
    '        return value;',
    '    }',
    '    static int maybeNull(' + name + ' candidate, int input) { return ' + nullable + '; }',
    '    int constantSite() { return ' + constant + '; }',
    '    public static void main(String[] args) {',
    ...(spring ? [
      '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_INLINE_JDBC_URL"),',
      '            System.getenv("RB_INLINE_JDBC_USER"), System.getenv("RB_INLINE_JDBC_PASSWORD")));',
      '        int input = jdbc.queryForObject("SELECT 3", Integer.class);',
      '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");'
    ] : ['        int input = 3;']),
    '        trace = 0;',
    '        String constructed = newSite(input) + ":" + trace;',
    '        trace = 0;',
    '        String implicit = new ' + name + '(20).implicitSite(input) + ":" + trace;',
    '        trace = 0;',
    '        String explicit = new ' + name + '(30).explicitSite(input) + ":" + trace;',
    '        System.out.print(constructed + "/" + implicit + "/" + explicit + "/" + last.calculate("other"));',
    '    }',
    '}', ''
  ].join('\n');
  return { source, call, explicit, implicit, nullable, constant, output };
}

async function springJdbcClasspath(classpathFile, engine) {
  const required = new Set(['spring-jdbc-7.0.10.jar', 'spring-tx-7.0.10.jar', 'spring-core-7.0.10.jar',
    'spring-beans-7.0.10.jar', 'commons-logging-1.3.6.jar', engine === 'mysql' ? 'mysql-connector-j-9.7.0.jar' : 'mariadb-java-client-3.5.10.jar']);
  const entries = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter).filter(entry => required.has(path.basename(entry)));
  assert.deepEqual(new Set(entries.map(entry => path.basename(entry))), required);
  return entries;
}

async function runJavaFixture({ javaHome, file, files = [file], binaryDirectory, className, classpath = [], config, engine, jdbcPrefix = 'RB_INLINE' }) {
  const tool = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  if (config) {
    assert.ok(['mysql','mariadb'].includes(engine));
    assert.equal(config.host, '127.0.0.1');
    assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
    assert.match(config.database, /^[a-z_]+$/u);
    env[jdbcPrefix+'_JDBC_URL'] = 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
      (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
    env[jdbcPrefix+'_JDBC_USER'] = config.user;
    env[jdbcPrefix+'_JDBC_PASSWORD'] = config.password;
  }
  const compile = await execute(tool('javac'), ['-proc:none', '-encoding', 'UTF-8',
    ...(classpath.length ? ['-classpath',classpath.join(path.delimiter)] : []),'-d',binaryDirectory,...files], {env,timeoutMs:30000});
  assert.equal(compile.code, 0, compile.output);
  const run = await execute(tool('java'), ['-classpath',[binaryDirectory,...classpath].join(path.delimiter),className], {env,timeoutMs:30000});
  assert.equal(run.code, 0, run.output);
  if (!config) return {output:run.output};
  const [server,result] = run.output.split('|');
  assert.match(server, engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*MariaDB/u);
  return {engine,server,output:result};
}

module.exports = { instanceInlineFixture, springJdbcClasspath, runInstanceInline:runJavaFixture,runJavaFixture };
