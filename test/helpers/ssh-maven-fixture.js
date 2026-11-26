'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('../../src/java/workbench-tasks');

const run = promisify(execFile);
const virtualPom = '/service with space/pom.xml';
const virtualSource = '/service with space/src/main/java/fixture/Counter.java';
const sourceText = 'package fixture; public final class Counter { public static int count() { return 2; } }\n';
const ordinaryPom = [
  '<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"',
  ' xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">',
  '<modelVersion>4.0.0</modelVersion><groupId>fixture.rocketbrain</groupId><artifactId>reviewed-remote</artifactId><version>1.0</version>',
  '<properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>',
  '<dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId><version>4.13.2</version><scope>test</scope></dependency></dependencies>',
  '<build><plugins><plugin><artifactId>maven-surefire-plugin</artifactId><version>3.5.4</version></plugin></plugins></build>',
  '</project>', ''
].join('\n');
const testSource = [
  'package fixture;',
  'import java.nio.charset.StandardCharsets;',
  'import java.net.HttpURLConnection;',
  'import java.net.URI;',
  'import org.junit.Test;',
  'import static org.junit.Assert.*;',
  'public class CounterTest {',
  '  @Test public void checksReviewedInputs() throws Exception {',
  '    assertEquals(2, Counter.count());',
  '    try (var resource = getClass().getResourceAsStream("/owned-spring-url")) {',
  '      if (resource == null) return;',
  '      String url = new String(resource.readNBytes(256), StandardCharsets.UTF_8).trim();',
  '      assertTrue(url.matches("http://127[.]0[.]0[.]1:[0-9]{4,5}"));',
  '      var connection = (HttpURLConnection) URI.create(url + "/probe/testing-state").toURL().openConnection();',
  '      connection.setConnectTimeout(3000); connection.setReadTimeout(3000); connection.setInstanceFollowRedirects(false);',
  '      try (var response = connection.getInputStream()) {',
  '        String result = new String(response.readNBytes(1024), StandardCharsets.UTF_8).replaceAll("\\\\s+", "");',
  '        assertTrue(result.contains((char) 34 + "people" + (char) 34 + ":2"));',
  '      } finally { connection.disconnect(); }',
  '    }',
  '  }',
  '}', ''
].join('\n');

async function stageMaven(fixture, tools, configuration, warmedRepository) {
  const root = fixture.profile.root, parent = path.dirname(root);
  const module = path.join(root, 'service with space');
  const main = path.join(module, 'src/main/java/fixture'), tests = path.join(module, 'src/test/java/fixture');
  await fs.mkdir(main, { recursive: true });
  await fs.mkdir(tests, { recursive: true });
  const source = path.join(main, 'Counter.java'), testFile = path.join(tests, 'CounterTest.java');
  const pom = path.join(module, 'pom.xml');
  await fs.writeFile(pom, ordinaryPom);
  await fs.writeFile(source, sourceText);
  await fs.writeFile(testFile, testSource);
  let database;
  if (configuration) {
    const spring = JSON.parse(await fs.readFile(configuration, 'utf8'));
    const dbHome = path.dirname(await fs.realpath(spring.dbConfigPath));
    const owner = JSON.parse(await fs.readFile(path.join(dbHome, 'owner.json'), 'utf8'));
    const marker = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' };
    assert.ok(marker[spring.dbEngine]);
    assert.deepEqual([owner.id, owner.kind], [path.basename(dbHome), marker[spring.dbEngine]]);
    assert.match(spring.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
    database = spring.dbEngine;
    await fs.mkdir(path.join(module, 'src/test/resources'));
    await fs.writeFile(path.join(module, 'src/test/resources/owned-spring-url'), spring.baseUrl);
  }
  const repository = path.join(parent, 'maven-repository');
  if (warmedRepository) await fs.cp(await fs.realpath(warmedRepository), repository, { recursive: true });
  else {
    await fs.mkdir(repository);
    const primer = path.join(parent, 'maven-primer');
    await fs.mkdir(primer);
    await fs.cp(path.join(module, 'src'), path.join(primer, 'src'), { recursive: true });
    await fs.writeFile(path.join(primer, 'pom.xml'), ordinaryPom);
    const settings = path.join(primer, 'settings.xml');
    await fs.writeFile(settings, '<settings/>\n');
    const command = buildSpec({ root: primer, tool: 'maven' }, tools, ['package']);
    await run(command.command, [...command.args, '--show-version', '--strict-checksums', '--non-recursive', '--no-transfer-progress',
      '--settings', settings, '--global-settings', settings, '-Dmaven.repo.local=' + repository, '-DforkCount=0',
      '-Dstyle.color=never'], { cwd: primer, env: command.env, windowsHide: true, timeout: 240000, maxBuffer: 1024 * 1024 });
  }
  return { module, source, testFile, pom, repository, database, virtualPom, virtualSource };
}

module.exports = { stageMaven, ordinaryPom, testSource, sourceText, virtualPom };
