'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { maven } = require('./refactoring-v24-maven');
const { effectiveReactorDependencies } = require('./refactoring-v25-maven');
const { mavenBuild } = require('../src/java/move-builds');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'test/fixtures/refactoring-v26-maven');
const group = 'org.rocketbrain.fixture.v26';
const modules = ['rb26-core', 'rb26-app', 'rb26-consumer'];
const metadata = ['rb26-company-parent', 'rb26-project-parent', 'rb26-base-bom', 'rb26-library-bom', 'rb26-conflict-bom'];
const routes = Object.freeze({
 base: [], runtime: ['-Prb26-runtime'], compile: ['-Prb26-compile'], both: ['-Prb26-compile,rb26-runtime']
});

function buildMavenV26(java, route) {
 assert.ok(Object.hasOwn(routes, route));
 const parent = path.join(root, 'test-output/v0.26-maven-build');
 fs.mkdirSync(parent, { recursive: true });
 const checkout = fs.mkdtempSync(path.join(parent, route + '-'));
 for (const name of ['', ...modules, ...metadata]) {
  const target = path.join(checkout, name);
  const source = path.join(project, name);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, 'pom.xml'), path.join(target, 'pom.xml'));
  if (modules.includes(name)) fs.cpSync(path.join(source, 'src'), path.join(target, 'src'), { recursive: true, errorOnExist: true, force: false });
 }
 const flags = routes[route];
 maven(java, checkout, [...flags, 'package', 'org.apache.maven.plugins:maven-dependency-plugin:3.8.1:build-classpath',
  '-Dmdep.outputFile=target/runtime-classpath.txt', '-DincludeScope=runtime', '-DskipTests'], 'package');
 const model = mavenBuild(checkout).scenarios[Object.keys(routes).indexOf(route)];
 const effective = {};
 for (const name of modules) {
  const pom = path.join(checkout, name + '-effective.xml');
  maven(java, checkout, [...flags, '-pl', name, 'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom',
   '-Doutput=' + pom], name + '-effective');
  const resolved = effectiveReactorDependencies(pom, group, modules);
  assert.deepEqual(resolved, model.edgeKinds.get(name));
  effective[name] = Object.fromEntries(resolved);
 }
 const app = path.join(checkout, 'rb26-app');
 const dependencies = fs.readFileSync(path.join(app, 'target/runtime-classpath.txt'), 'utf8').trim().split(path.delimiter);
 assert.ok(dependencies.every(file => path.isAbsolute(file) && fs.existsSync(file)));
 const core = fs.realpathSync(path.join(checkout, 'rb26-core/target/rb26-core-1.0.0.jar'));
 assert.ok(dependencies.some(file => path.relative(core, fs.realpathSync(file)) === ''));
 const testClass = path.join(checkout, 'rb26-consumer/target/test-classes/fixture/mavenv26/client/TestMoveUsage.class');
 assert.ok(fs.statSync(testClass).size > 0, 'Maven test consumer must compile.');
 return { classpath: [path.join(app, 'target/classes'), ...dependencies].join(path.delimiter), effective, testClientCompiled: true };
}

async function main() {
 const separator = process.argv.indexOf('--');
 if (separator < 0 || !process.argv[separator + 1]) throw Error('Pass the owned child Node script after --.');
 const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const config = { ...parent, projectPath: path.join(project, 'rb26-app'), mavenV26Root: project };
 const output = path.join(root, 'test-output', 'v0.26-maven-runtime-' + randomUUID() + '.json');
 fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
 process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, process.argv.slice(separator + 1), {
   cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_MAVEN_V26_CONFIG: output }
  });
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
 });
}

if (require.main === module) main().catch(error => {
 console.error(error.stack);
 process.exitCode = 1;
});
module.exports = { buildMavenV26, routes };
