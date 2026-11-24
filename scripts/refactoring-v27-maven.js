'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { maven } = require('./refactoring-v24-maven');
const { effectiveReactorDependencies } = require('./refactoring-v25-maven');
const { mavenBuild } = require('../src/java/move-builds');

const root = path.resolve(__dirname, '..');
const project = path.join(root, 'test/fixtures/refactoring-v27-maven');
const group = 'org.rocketbrain.fixture.v27';
const modules = ['rb27-core', 'rb27-app', 'rb27-consumer'];
const metadata = ['rb27-project-parent'];
const lockName = '.rocketbrain-maven-models.json';
const routes = Object.freeze({
 base: [], runtime: ['-Prb27-runtime'], compile: ['-Prb27-compile'], both: ['-Prb27-compile,rb27-runtime']
});

function seedExternalModels() {
 const pins = JSON.parse(fs.readFileSync(path.join(project,lockName),'utf8')).models;
 assert.deepEqual(pins.map(pin=>pin.artifactId).sort(),['rb27-base-bom','rb27-company-parent','rb27-conflict-bom','rb27-library-bom']);
 const files = {};
 for (const pin of pins) {
  assert.equal(pin.groupId,group+'.external');
  assert.equal(pin.version,'1.0.0');
  const model = path.join(root,'test/fixtures/refactoring-v27-maven-models',pin.artifactId,'pom.xml');
  const bytes = fs.readFileSync(model);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),pin.sha256);
  const target = path.join(os.homedir(),'.m2','repository',...pin.groupId.split('.'),pin.artifactId,pin.version,pin.artifactId+'-'+pin.version+'.pom');
  fs.mkdirSync(path.dirname(target),{recursive:true});
  assert.equal(path.relative(path.dirname(target),fs.realpathSync(path.dirname(target))),'');
  try {
   fs.writeFileSync(target,bytes,{flag:'wx'});
  } catch(error) {
   if(error.code!=='EEXIST')throw error;
  }
  const identity=fs.lstatSync(target);
  assert.ok(identity.isFile()&&!identity.isSymbolicLink());
  assert.deepEqual(fs.readFileSync(target),bytes,'The existing synthetic GAV must match the owned fixture.');
  files[pin.artifactId]=target;
 }
 return files;
}

function buildMavenV27(java, route) {
 seedExternalModels();
 assert.ok(Object.hasOwn(routes, route));
 const parent = path.join(root, 'test-output/v0.27-maven-build');
 fs.mkdirSync(parent, { recursive: true });
 const checkout = fs.mkdtempSync(path.join(parent, route + '-'));
 for (const name of ['', ...modules, ...metadata]) {
  const target = path.join(checkout, name);
  const source = path.join(project, name);
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(source, 'pom.xml'), path.join(target, 'pom.xml'));
  if (modules.includes(name)) fs.cpSync(path.join(source, 'src'), path.join(target, 'src'), { recursive: true, errorOnExist: true, force: false });
 }
 fs.copyFileSync(path.join(project,lockName),path.join(checkout,lockName));
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
 const app = path.join(checkout, 'rb27-app');
 const dependencies = fs.readFileSync(path.join(app, 'target/runtime-classpath.txt'), 'utf8').trim().split(path.delimiter);
 assert.ok(dependencies.every(file => path.isAbsolute(file) && fs.existsSync(file)));
 const core = fs.realpathSync(path.join(checkout, 'rb27-core/target/rb27-core-1.0.0.jar'));
 assert.ok(dependencies.some(file => path.relative(core, fs.realpathSync(file)) === ''));
 const testClass = path.join(checkout, 'rb27-consumer/target/test-classes/fixture/mavenv27/client/TestMoveUsage.class');
 assert.ok(fs.statSync(testClass).size > 0, 'Maven test consumer must compile.');
 return { classpath: [path.join(app, 'target/classes'), ...dependencies].join(path.delimiter), effective, testClientCompiled: true };
}

async function main() {
 const separator = process.argv.indexOf('--');
 if (separator < 0 || !process.argv[separator + 1]) throw Error('Pass the owned child Node script after --.');
 const parent = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));
 const externalModelFiles = seedExternalModels();
 const config = { ...parent, projectPath: path.join(project, 'rb27-app'), mavenV27Root: project, externalModelFiles };
 const output = path.join(root, 'test-output', 'v0.27-maven-runtime-' + randomUUID() + '.json');
 fs.writeFileSync(output, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
 process.exitCode = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, process.argv.slice(separator + 1), {
   cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, ROCKETBRAIN_MAVEN_V27_CONFIG: output }
  });
  child.once('error', reject);
  child.once('exit', code => resolve(code ?? 1));
 });
}

if (require.main === module) main().catch(error => {
 console.error(error.stack);
 process.exitCode = 1;
});
module.exports = { buildMavenV27, routes, seedExternalModels };
