'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');

const run = promisify(execFile);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

async function runEmbeddedLanguageChecks(api, vscode, checks) {
  const runtime = await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  const serverOwner = await read(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'));
  const config = await read(runtime.dbConfigPath);
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(serverOwner.kind));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const name = 'RbEmbedded' + randomBytes(5).toString('hex');
  const java = path.join(workspace, 'src/main/java/fixture/boot', name + '.java');
  const mapper = path.join(workspace, name + '.xml');
  const sql = path.join(workspace, name + '.sql');
  const service = api.embeddedLanguage;
  const jarClasspath = (await fs.readFile(path.join(runtime.projectPath, 'build/runtime-classpath.txt'), 'utf8')).trim();
  assert.match(jarClasspath, /mybatis-3\.5\.19\.jar/);
  assert.match(jarClasspath, /spring-jdbc-/);
  const project = await importedSpring(api, workspace);
  const javaSource = `package fixture.boot;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
public final class ${name} {
    public static void main(String[] args) throws Exception {
        String statement = """
            WITH people AS (SELECT p.id, p.display_name AS display_name FROM rb_spring_person p)
            SELECT a.display_name FROM people a WHERE a.id > ?
            """;
        var source = new DriverManagerDataSource(System.getenv("RB_EMBEDDED_JDBC_URL"),
            System.getenv("RB_EMBEDDED_JDBC_USER"), System.getenv("RB_EMBEDDED_JDBC_PASSWORD"));
        var jdbc = new JdbcTemplate(source);
        var query = Class.forName("org.apache.ibatis.session.Configuration");
        var configuration = query.getConstructor().newInstance();
        var builder = Class.forName("org.apache.ibatis.builder.xml.XMLMapperBuilder");
        try (var input = Files.newInputStream(Path.of(args[0]))) {
            var compiled = builder.getConstructor(java.io.InputStream.class, query, String.class, java.util.Map.class)
                .newInstance(input, configuration, "owned-mapper.xml", query.getMethod("getSqlFragments").invoke(configuration));
            builder.getMethod("parse").invoke(compiled);
        }
        var declared = query.getMethod("getMappedStatement", String.class).invoke(configuration, "fixture.${name}.count");
        var bound = declared.getClass().getMethod("getBoundSql", Object.class).invoke(declared, (Object) null);
        String mappedSql = (String) bound.getClass().getMethod("getSql").invoke(bound);
        System.out.println("EMBEDDED_PROOF:" + jdbc.queryForObject(statement, String.class, 2)
            + ":" + jdbc.queryForObject(mappedSql, Integer.class));
    }
}
`;
  const xmlSource = '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">\n' +
    '<mapper namespace="fixture.' + name + '"><select id="count" resultType="int">\n' +
    'SELECT COUNT(*) FROM rb_spring_person WHERE id &lt; 10\n</select></mapper>\n';
  const sqlSource = `SELECT JSON_UNQUOTE(JSON_EXTRACT('{"message":"before"}', '$.message')) AS proof;\n`;
  const created = new Map();
  const open = async (file, source) => {
    await fs.writeFile(file, source, { flag: 'wx' });
    created.set(file, null);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    created.set(file, document);
    return document;
  };
  const edited = [];
  const change = async (document, value) => {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(await editor.edit(builder => builder.replace(new vscode.Range(document.positionAt(0),
      document.positionAt(document.getText().length)), value)), true);
  };
  const fixture = await mysql.createConnection(config);
  try {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.sql.editEmbedded') && commands.includes('rocketbrain.sql.applyEmbedded'));
    await api.connectMysql(config);
    assert.ok(Array.isArray(api.catalogSnapshot().sqlMode));
    const javaDoc = await open(java, javaSource);
    const javaSql = await service.open(javaDoc, javaDoc.positionAt(javaSource.indexOf('WITH people')), 'sql');
    edited.push(javaSql);
    assert.ok(service.isProjection(javaSql));
    assert.equal(javaSql.languageId, 'sql');
    const content = javaSql.getText();
    const completionOffset = content.indexOf('a.display_name') + 2;
    const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', javaSql.uri, javaSql.positionAt(completionOffset));
    assert.ok(completion.items.some(item => item.label === 'display_name'));
    const definition = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', javaSql.uri, javaSql.positionAt(completionOffset + 3));
    assert.ok(definition.some(location => {
      const found = location.targetSelectionRange || location.range;
      return (location.targetUri || location.uri)?.toString() === javaSql.uri.toString() &&
        javaSql.offsetAt(found.start) === content.indexOf('AS display_name') + 3 && javaSql.getText(found) === 'display_name';
    }));
    await change(javaSql, content.replace('a.id > ?', 'a.id < ?'));
    const javaPlan = service.prepare(javaSql);
    assert.ok(javaPlan.before.startsWith('"""') && javaPlan.after.includes('a.id < ?'));
    assert.equal((await service.apply(javaPlan.id)).applied, true);
    assert.equal(await fs.readFile(java, 'utf8'), javaSource);
    assert.equal(await javaDoc.save(), true);

    const xmlDoc = await open(mapper, xmlSource);
    const xmlEditor = await vscode.window.showTextDocument(xmlDoc, { preview: false });
    const point = xmlDoc.positionAt(xmlSource.indexOf('&lt;'));
    xmlEditor.selection = new vscode.Selection(point, point);
    await vscode.commands.executeCommand('rocketbrain.sql.editEmbedded');
    const xmlSql = vscode.window.activeTextEditor.document;
    edited.push(xmlSql);
    assert.equal(xmlSql.languageId, 'sql');
    assert.ok(service.isProjection(xmlSql));
    assert.match(xmlSql.getText(), /id < 10/);
    await change(xmlSql, xmlSql.getText().replace('id < 10', 'id < 2'));
    const xmlPlan = service.prepare(xmlSql);
    assert.match(xmlPlan.after, /id &lt; 2/);
    await service.apply(xmlPlan.id);
    assert.equal(await xmlDoc.save(), true);

    const sqlDoc = await open(sql, sqlSource);
    const json = await service.open(sqlDoc, sqlDoc.positionAt(sqlSource.indexOf('before')), 'json');
    edited.push(json);
    assert.equal(json.languageId, 'json');
    assert.equal(JSON.parse(json.getText()).message, 'before');
    const final = "Rock's path C:\\work";
    await change(json, JSON.stringify({ message: final + ': stale' }));
    const stale = service.prepare(json);
    await change(json, JSON.stringify({ message: final }));
    await assert.rejects(service.apply(stale.id), /embedded text changed after review/);
    await service.apply(service.prepare(json).id);
    assert.equal(await sqlDoc.save(), true);
    const [[row]] = await fixture.query(await fs.readFile(sql, 'utf8'));
    assert.equal(row.proof, final);

    const compile = await api.java.buildWorkspace();
    assert.ok(compile === 0 || compile === 1 || compile?.status === 'succeed');
    const env = { ...process.env, CLASSPATH: jarClasspath,
      RB_EMBEDDED_JDBC_URL: `jdbc:${runtime.dbEngine}://127.0.0.1:${config.port}/${config.database}` +
        (runtime.dbEngine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''),
      RB_EMBEDDED_JDBC_USER: config.user, RB_EMBEDDED_JDBC_PASSWORD: config.password };
    const { stdout } = await run(path.join(project.jdk || api.java.getState().javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'),
      [java, mapper], { cwd: workspace, env, windowsHide: true, timeout: 30000 });
    assert.match(stdout, /^EMBEDDED_PROOF:Alex:1\s*$/m);
    const jdbc = await jdbcReadback();
    checks.push('VS Code edited a Java SQL text block, static MyBatis mapper SQL, and SQL-quoted JSON. JDT built the Spring project and the new values executed through Spring JDBC, MyBatis, and the server.');
    return { engine: runtime.dbEngine, completion: true, definition: true, staleEditRejected: true, sourceUnsavedUntilExplicitSave: true,
      javaRows: ['Alex'], mapperCount: 1, jsonRoundTrip: true, springBuild: true, jdbc };
  } finally {
    for (const document of edited.filter(item => service.isProjection(item))) {
      if (document.isDirty && !document.isClosed) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    await api.disconnectMysql();
    await fixture.end();
    for (const [file, document] of created) {
      if (document?.isDirty) await document.save();
      await fs.unlink(file);
    }
  }
}

module.exports = { runEmbeddedLanguageChecks };
