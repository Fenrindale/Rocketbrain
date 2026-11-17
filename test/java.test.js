'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { parseSpringEndpoints, metadataProperties, yamlPrefix } = require('../src/java/spring');

test('Spring source scan combines literal class paths, HTTP methods and path arrays', () => {
  const source = fs.readFileSync(path.join(__dirname, 'fixtures/java/spring/PingController.java'), 'utf8');
  const endpoints = parseSpringEndpoints(source, 'file:///fixture.java');
  assert.deepEqual(endpoints.map(item => item.name), ['GET /api/ping', 'POST /api/messages', 'POST /api/notes']);
  assert.equal(endpoints[0].method, 'ping');
  assert.equal(endpoints[0].range.start.line, 10);
});

test('Spring source scan ignores commented mappings and unresolved constants', () => {
  const source = '@RestController class Api {\n// @GetMapping("/fake") public String nope() {}\n/* @PostMapping("/other") public void other() {} */\n@GetMapping(API_PATH) public void dynamic() {}\n@org.springframework.web.bind.annotation.GetMapping("/real") public String real() { return "@GetMapping(\\\"/text\\\")"; }\n}';
  assert.deepEqual(parseSpringEndpoints(source).map(item => item.name), ['GET /real']);
  assert.deepEqual(parseSpringEndpoints('@Service class Service { @GetMapping("/no") public void x(){} }'), []);
});

test('Spring metadata and nested YAML completion support local application properties', () => {
  const properties = metadataProperties({ properties: [{ name: 'app.greeting', type: 'java.lang.String', description: 'Greeting' }, { name: 12 }] }, 'local');
  assert.deepEqual(properties.map(item => item.name), ['app.greeting']);
  assert.equal(yamlPrefix('spring:\n  datasource:\n    ur\nserver:\n  po', 2), 'spring.datasource');
  assert.equal(yamlPrefix('spring:\n  datasource:\n    url: x\nserver:\n  po', 4), 'server');
});

test('Spring scan excludes annotations inside strings/text blocks and skips multiple Java types', () => {
  const fake = 'class Plain { String text = "@RestController @GetMapping(\\\"/fake\\\")"; }';
  assert.deepEqual(parseSpringEndpoints(fake), []);
  const controller = '@RestController class Real { String documentation = """\n@GetMapping("/fake") public String falseMethod() {}\n"""; @GetMapping("/real") public String real() { return "ok"; } }';
  assert.deepEqual(parseSpringEndpoints(controller).map(item => item.name), ['GET /real']);
  assert.deepEqual(parseSpringEndpoints('@RestController class Outer { @GetMapping("/outer") public void x(){} class Nested {} }'), []);
});

test('Java launch rejects missing explicit paths, old JDKs, and invalid project runtimes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-java-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const jdk = path.join(dir, 'jdk'); fs.mkdirSync(jdk);
  fs.writeFileSync(path.join(jdk, 'release'), 'JAVA_VERSION="21.0.1"\n');
  assert.throws(() => resolveLaunch({ javaHome: '', serverPath: dir, storagePath: dir }), /explicit/);
  assert.throws(() => resolveLaunch({ javaHome: jdk, serverPath: dir, storagePath: dir }), /JDK 25/);
  fs.writeFileSync(path.join(jdk, 'release'), 'JAVA_VERSION="25.0.1"\nIMPLEMENTOR="JetBrains s.r.o."\n');
  assert.throws(() => resolveLaunch({ javaHome: jdk, serverPath: dir, storagePath: dir }), /JetBrains Runtime/);
  assert.throws(() => serverSettings([{ name: '21', path: jdk }]), /JavaSE-N/);
  assert.throws(() => serverSettings([{ name: 'JavaSE-21', path: jdk, default: true }, { name: 'JavaSE-25', path: jdk, default: true }]), /Only one/);
});
test('build-file configuration updates require explicit resync while initial import and source autobuild stay enabled',()=>{const settings=serverSettings();assert.equal(settings.java.configuration.updateBuildConfiguration,'disabled');assert.equal(settings.java.import.maven.enabled,true);assert.equal(settings.java.import.gradle.enabled,true);assert.equal(settings.java.autobuild.enabled,true);});
