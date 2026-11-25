'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);
const originalRegex = String.raw`(?<word>\p{Alpha}++)\d{2}`;
const editedRegex = String.raw`(?<word>\p{Alpha}++\p{Digit}{2})`;
const originalHtml = '<article id="result"><strong>%s</strong></article>\n';
const editedHtml = '<section id="result">\n  <strong data-role="java">%s</strong>  \n</section>';
const expectedOriginal = originalHtml.replace('%s', 'Alex');
const expectedEdited = editedHtml.replace('%s', 'Alex42');

function javaEmbeddedFixture(packageName, className) {
  return [
    'package ' + packageName + ';',
    'import java.nio.charset.StandardCharsets;',
    'import java.util.Base64;',
    'import java.util.regex.Pattern;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class ' + className + ' {',
    '    private static final String TOKEN = ' + JSON.stringify(originalRegex) + ';',
    '    private static final String MARKUP = """',
    '        ' + originalHtml.trimEnd(),
    '        """;',
    '    public static void main(String[] args) {',
    '        var source = new DriverManagerDataSource(System.getenv("RB_JAVA_LITERAL_JDBC_URL"),',
    '            System.getenv("RB_JAVA_LITERAL_JDBC_USER"), System.getenv("RB_JAVA_LITERAL_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(source);',
    '        String input = jdbc.queryForObject("SELECT ?", String.class, "Alex42");',
    '        var match = Pattern.compile(TOKEN).matcher(input);',
    '        if (!match.matches()) throw new IllegalStateException("unexpected pattern result");',
    '        String rendered = MARKUP.formatted(match.group("word"));',
    '        String version = jdbc.queryForObject("SELECT VERSION()", String.class);',
    '        System.out.println("EMBEDDED_JAVA:" + version + ":" + Base64.getEncoder()',
    '            .encodeToString(rendered.getBytes(StandardCharsets.UTF_8)));',
    '    }',
    '}', ''
  ].join('\n');
}

async function runEmbeddedFixture({ javaHome, classpathFile, file, config, engine }) {
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(config.host, '127.0.0.1');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  assert.match(config.database, /^[a-z_]+$/u);
  const required = new Set(['spring-jdbc-7.0.10.jar', 'spring-tx-7.0.10.jar', 'spring-core-7.0.10.jar',
    'spring-beans-7.0.10.jar', 'commons-logging-1.3.6.jar',
    engine === 'mysql' ? 'mysql-connector-j-9.7.0.jar' : 'mariadb-java-client-3.5.10.jar']);
  const classpath = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter)
    .filter(entry => required.has(path.basename(entry)));
  assert.deepEqual(new Set(classpath.map(entry => path.basename(entry))), required);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_JAVA_LITERAL_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_JAVA_LITERAL_JDBC_USER = config.user;
  env.RB_JAVA_LITERAL_JDBC_PASSWORD = config.password;
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const { stdout } = await run(java, ['--source', '25', '--class-path', classpath.join(path.delimiter), file],
    { cwd: path.dirname(file), env, windowsHide: true, timeout: 30000 });
  const observed = /^EMBEDDED_JAVA:([^:\r\n]+):([A-Za-z0-9+/=]+)$/mu.exec(stdout);
  assert.ok(observed, 'The owned Java program did not report its Spring JDBC and HTML result.');
  assert.match(observed[1], engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*MariaDB/u);
  return { engine, server: observed[1], html: Buffer.from(observed[2], 'base64').toString('utf8') };
}

module.exports = { javaEmbeddedFixture, runEmbeddedFixture, originalRegex, editedRegex, originalHtml, editedHtml,
  expectedOriginal, expectedEdited };
