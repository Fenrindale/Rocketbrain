'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { SaxesParser } = require('saxes');
const { maven } = require('./refactoring-v24-maven');
const { mavenBuild } = require('../src/java/move-builds');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'test/fixtures/refactoring-v25-maven');
const group = 'org.rocketbrain.fixture.v25';
const modules = ['rb25-core', 'rb25-app', 'rb25-consumer'];
const routes = Object.freeze({
 base: [], runtime: ['-Prb25-runtime'], compile: ['-Prb25-compile'], both: ['-Prb25-compile,rb25-runtime']
});

function effectiveReactorDependencies(file) {
 const parser = new SaxesParser({ xmlns: false });
 const stack = [];
 const edges = new Map();
 let current;
 parser.on('opentag', tag => {
  stack.push({ name: tag.name, text: '' });
  if (stack.map(node => node.name).join('/') === 'project/dependencies/dependency') current = {};
 });
 parser.on('text', text => {
  if (stack.length) stack.at(-1).text += text;
 });
 parser.on('closetag', () => {
  const item = stack.pop();
  if (current && stack.length === 3) current[item.name] = item.text.trim();
  if (current && stack.length === 2 && item.name === 'dependency') {
   if (current.groupId === group) {
    assert.ok(modules.includes(current.artifactId) && !edges.has(current.artifactId));
    assert.equal(current.version, '1.0.0');
    edges.set(current.artifactId, current.scope ?? 'compile');
   }
   current = undefined;
  }
 });
 parser.write(fs.readFileSync(file, 'utf8')).close();
 return edges;
}

function buildMavenV25(java, route) {
 assert.ok(Object.hasOwn(routes, route));
 const parent = path.join(root, 'test-output/v0.25-maven-build');
 fs.mkdirSync(parent, { recursive: true });
 const checkout = fs.mkdtempSync(path.join(parent, route + '-'));
 for (const module of ['', ...modules]) {
  const target = path.join(checkout, module);
  const source = path.join(project, module);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, 'pom.xml'), path.join(target, 'pom.xml'));
  if (module) fs.cpSync(path.join(source, 'src'), path.join(target, 'src'), { recursive: true, errorOnExist: true, force: false });
 }
 const flags = routes[route];
 maven(java, checkout, [...flags, 'package', 'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath',
  '-Dmdep.outputFile=target/runtime-classpath.txt', '-DincludeScope=runtime', '-DskipTests'], 'package');
 const model = mavenBuild(checkout).scenarios[Object.keys(routes).indexOf(route)];
 const effective = {};
 for (const module of modules) {
  const pom = path.join(checkout, module + '-effective.xml');
  maven(java, checkout, [...flags, '-pl', module, 'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom',
   '-Doutput=' + pom], module + '-effective');
  const result = effectiveReactorDependencies(pom);
  assert.deepEqual(result, model.edgeKinds.get(module));
  effective[module] = Object.fromEntries(result);
 }
 const app = path.join(checkout, 'rb25-app');
 const dependencies = fs.readFileSync(path.join(app, 'target/runtime-classpath.txt'), 'utf8').trim().split(path.delimiter);
 assert.ok(dependencies.every(file => path.isAbsolute(file) && fs.existsSync(file)));
 const core = fs.realpathSync(path.join(checkout, 'rb25-core/target/rb25-core-1.0.0.jar'));
 assert.ok(dependencies.some(file => path.relative(core, fs.realpathSync(file)) === ''));
 const testClass = path.join(checkout, 'rb25-consumer/target/test-classes/fixture/mavenv25/client/TestMoveUsage.class');
 assert.ok(fs.statSync(testClass).size > 0, 'The managed-scope Maven test consumer must compile.');
 return { classpath: [path.join(app, 'target/classes'), ...dependencies].join(path.delimiter), effective, testClientCompiled: true };
}

async function main() {
 const separator = process.argv.indexOf('--');
 if (separator < 0 || !process.argv[separator + 1]) throw Error('Pass the owned child Node script after --.');
 const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const config = { ...parent, projectPath: path.join(project, 'rb25-app'), mavenV25Root: project };
 const output = path.join(root, 'test-output', 'v0.25-maven-runtime-' + randomUUID() + '.json');
 fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
 process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, process.argv.slice(separator + 1), {
   cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_MAVEN_V25_CONFIG: output }
  });
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
 });
}

if (require.main === module) main().catch(error => {
 console.error(error.stack);
 process.exitCode = 1;
});
module.exports = { buildMavenV25, routes };
