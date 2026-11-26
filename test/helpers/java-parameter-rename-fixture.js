'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath } = require('./instance-inline-fixture');
const { selection } = require('./java-signature-references-fixture');

const java = name => path.join('src', 'main', 'java', 'fixture', 'parametername', name + '.java');
const declaration = java('RenderContract');
const implementation = java('DefaultRenderer');
const second = java('LabelRenderer');
const caller = java('SignatureClient');
const chosen = 'render(String';
const renamed = 'payloadLabel';
const selected = { originalIndex: 0, name: renamed };
const sources = new Map([
  [declaration, [
    'package fixture.parametername;',
    'public interface RenderContract {',
    '    /**',
    '     * Formats the requested label.',
    '     * @param label label argument',
    '     * @param count number argument',
    '     * @return display text',
    '     */',
    '    String render(String label, int count);',
    '}', ''
  ].join('\n')],
  [implementation, [
    'package fixture.parametername;',
    'public final class DefaultRenderer implements RenderContract {',
    '    /** @param input selected argument */',
    '    @Override public String render(String input, int amount) {',
    '        String existing = "input";',
    '        return input + ":" + input.length() + ":" + amount + ":" + existing;',
    '    }',
    '    public String render(int amount, String input) { return "O" + amount + input; }',
    '    public String renderLocally(String label) {',
    '        return render(label, 5);',
    '    }',
    '}', ''
  ].join('\n')],
  [second, [
    'package fixture.parametername;',
    'public final class LabelRenderer implements RenderContract {',
    '    @Override public String render(String label, int count) { return label + "/" + count; }',
    '}', ''
  ].join('\n')],
  [caller, [
    'package fixture.parametername;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class SignatureClient {',
    '    public static void main(String[] args) {',
    '        var data = new DriverManagerDataSource(System.getenv("RB_PARAM_JDBC_URL"),',
    '            System.getenv("RB_PARAM_JDBC_USER"), System.getenv("RB_PARAM_JDBC_PASSWORD"));',
    '        var jdbc = new JdbcTemplate(data);',
    '        int stored = jdbc.queryForObject("SELECT 40", Integer.class);',
    '        var primary = new DefaultRenderer();',
    '        RenderContract publicApi = primary;',
    '        RenderContract another = new LabelRenderer();',
    '        String label = "row";',
    '        String result = publicApi.render(label, stored) + "|" + primary.render(label, stored) +',
    '          "|" + primary.render(stored, label) + "|" + primary.renderLocally(label) + "|" + another.render(label, stored);',
    '        System.out.println(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '          (stored + SharedOffset.offset()) + "|" + result);',
    '    }',
    '}', ''
  ].join('\n')]
]);

const dependency = (group, id, version) => '<dependency><groupId>' + group + '</groupId><artifactId>' + id +
  '</artifactId><version>' + version + '</version></dependency>';
const prefix = '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>';
const group = 'fixture.parametername';
const expected = '42|row:3:40:input|row:3:40:input|O40row|row:3:5:input|row/40';

async function write(root, relative, text) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
}

async function createParameterReactor(root) {
  const name = path.basename(root);
  assert.match(name, /^[A-Za-z0-9-]+$/u);
  const lib = name + '-base', app = name + '-app';
  const shared = '<groupId>' + group + '</groupId><artifactId>' + name + '</artifactId><version>1</version>';
  const parent = '<parent>' + shared + '</parent>';
  const rootPom = prefix + shared + '<packaging>pom</packaging><modules><module>base</module><module>app</module></modules>' +
    '<properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>' +
    '<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>' +
    '<version>3.15.0</version><configuration><parameters>true</parameters></configuration></plugin></plugins></build></project>\n';
  const appPom = prefix + parent + '<artifactId>' + app + '</artifactId><dependencies>' + dependency(group, lib, '1') +
    dependency('org.springframework', 'spring-jdbc', '7.0.10') + dependency('com.mysql', 'mysql-connector-j', '9.7.0') +
    dependency('org.mariadb.jdbc', 'mariadb-java-client', '3.5.10') + '</dependencies></project>\n';
  await Promise.all([
    write(root, 'pom.xml', rootPom), write(root, '.mvn/maven.config', '--offline\n'),
    write(root, 'base/pom.xml', prefix + parent + '<artifactId>' + lib + '</artifactId></project>\n'),
    write(root, path.join('base', java('SharedOffset')),
      'package fixture.parametername; public final class SharedOffset { public static int offset() { return 2; } }\n'),
    write(root, 'app/pom.xml', appPom),
    ...[...sources].map(([relative, content]) => write(root, path.join('app', relative), content))
  ]);
  return path.join(root, 'app');
}

async function buildParameterReactor(root, tools) {
  const spec = buildSpec({ root, uri: pathToFileURL(root).href, name: path.basename(root), tool: 'maven' }, tools, ['compile']);
  const built = await execute(spec.command, [...spec.args, '--offline', '--projects', 'app', '--also-make'],
    { cwd: spec.cwd, env: spec.env, timeoutMs: 90000 });
  assert.equal(built.code, 0, built.output);
  assert.match(built.output, /Reactor Summary/u);
  for (const file of ['app/target/classes/fixture/parametername/SignatureClient.class',
    'base/target/classes/fixture/parametername/SharedOffset.class']) {
    assert.equal((await fs.readFile(path.join(root, file))).readUInt32BE(0), 0xcafebabe);
  }
}

async function runParameterSpring({ javaHome, root, database, engine, classpathFile }) {
  assert.equal(database.host, '127.0.0.1');
  assert.ok(Number.isInteger(database.port) && database.port > 0 && database.port < 65536);
  assert.match(database.database, /^[a-z_]+$/u);
  const runtime = await springJdbcClasspath(classpathFile, engine);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(name)));
  env.RB_PARAM_JDBC_URL = 'jdbc:' + engine + '://127.0.0.1:' + database.port + '/' + database.database +
    (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : '');
  env.RB_PARAM_JDBC_USER = database.user;
  env.RB_PARAM_JDBC_PASSWORD = database.password;
  const binary = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const classpath = [...['app/target/classes', 'base/target/classes'].map(file => path.join(root, file)), ...runtime];
  const run = await execute(binary, ['-cp', classpath.join(path.delimiter), group + '.SignatureClient'],
    { cwd: root, env, timeoutMs: 30000 });
  assert.equal(run.code, 0, run.output);
  const match = /^([^|\r\n]+)\|([^\r\n]+)$/mu.exec(run.output.trim());
  assert.ok(match, run.output);
  assert.match(match[1], engine === 'mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  assert.equal(match[2], expected);
  return { engine, server: match[1], value: match[2] };
}

function assertParameterPlan(info, plan) {
  assert.equal(info.familyDeclarations, 3);
  assert.deepEqual(info.parameterRename.slots[0].declarations.map(item => item.name).sort(), ['input', 'label', 'label']);
  const result = plan.signature.parameterRename;
  assert.equal(result.after, renamed);
  assert.equal(result.originalIndex, 0);
  assert.equal(result.declarations, 3);
  assert.equal(result.references, 3);
  assert.equal(result.javadoc, 2);
  assert.ok(result.providerSpans >= 1 && result.providerSpans < 8);
  assert.equal(result.verified, true);
  assert.equal(plan.signature.resolvedReferences, 4);
  assert.equal(plan.signature.overloadBindingsVerified, true);
  assert.equal(plan.documents.length, 3);
  const reviewed = new Map(plan.documents.map(item => [path.basename(new URL(item.uri).pathname), item.after]));
  assert.match(reviewed.get('RenderContract.java'), /@param payloadLabel label argument[\s\S]*render\(String payloadLabel, int count\)/u);
  assert.match(reviewed.get('DefaultRenderer.java'), /@param payloadLabel selected argument[\s\S]*String existing = "input";[\s\S]*return payloadLabel \+ ":" \+ payloadLabel.length\(\)/u);
  assert.match(reviewed.get('DefaultRenderer.java'), /render\(int amount, String input\) \{ return "O" \+ amount \+ input; \}/u);
  assert.match(reviewed.get('DefaultRenderer.java'), /return render\(label, 5\);/u);
  assert.match(reviewed.get('LabelRenderer.java'), /render\(String payloadLabel, int count\) \{ return payloadLabel \+ "\/" \+ count;/u);
  assert.equal(reviewed.has('SignatureClient.java'), false);
}

module.exports = { declaration, implementation, second, caller, chosen, selected, sources, selection, createParameterReactor,
  buildParameterReactor, runParameterSpring, assertParameterPlan };
