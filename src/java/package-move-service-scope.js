'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {lexJava, parseJavaFile} = require('../spring/java');
const {inside} = require('./testing-projects');
const {projectFiles, resolveMoveProject} = require('./move');
const {mavenBuild} = require('./move-builds');
const {reviewClosedModule} = require('./package-module');
const {snapshotClasspath} = require('./signature-compiler');
const {key} = require('./move-scope');

const main = path.join('src', 'main', 'java');
const descriptor = path.join(main, 'module-info.java');
const moduleLimit = 6;
const utf8 = new TextDecoder('utf-8', {fatal: true});
const localPath = file => typeof file === 'string' && path.isAbsolute(file) &&
  !/^[/\\]{2}/u.test(file) && (process.platform !== 'win32' || /^[A-Za-z]:[\\/]/u.test(file));
const tokenName = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const modelError = () => Error('Service Package Move requires a closed imported Maven reactor of owned named Java modules.');
const request = (send, command, args, token) => send('workspace/executeCommand', {command, arguments: args}, token);
const classpaths = (send, uri, token) => request(send, 'java.project.getClasspaths', [uri, {scope: 'test'}], token);

function physical(file, kind) {
  const status = fs.lstatSync(file, {throwIfNoEntry: false});
  return status && !status.isSymbolicLink() && status[kind]() && key(fs.realpathSync(file)) === key(file);
}

function readBounded(file, bytes) {
  if (!physical(file, 'isFile') || fs.statSync(file).size > bytes) throw modelError();
  return utf8.decode(fs.readFileSync(file));
}

function namedSourceRoot(file) {
  for (let dir = path.dirname(file); path.dirname(dir) !== dir; dir = path.dirname(dir)) {
    const project = path.resolve(dir, '../../..');
    if (key(path.join(project, main)) === key(dir)) return {project, file: path.join(project, descriptor)};
  }
}

function serviceMoveCandidate(file) {
  const owner = namedSourceRoot(file);
  if (!owner || !fs.existsSync(owner.file)) return null;
  const aggregator = path.dirname(owner.project);
  const pom = path.join(aggregator, 'pom.xml');
  if (!fs.existsSync(pom) || !/<modules\s*>/u.test(readBounded(pom, 256 * 1024))) return null;
  const packageName = path.relative(path.join(owner.project, main), path.dirname(file)).split(path.sep).join('.');
  const {tokens, issues} = lexJava(readBounded(owner.file, 8192));
  if (issues.length) throw modelError();
  const exports = tokens.flatMap((token, index) => {
    if (token.text !== 'exports') return [];
    const rest = tokens.slice(index + 1);
    const end = rest.findIndex(t => t.text === ';' || t.text === 'to');
    return end < 0 ? [] : [rest.slice(0, end).map(t => t.text).join('')];
  });
  return exports.includes(packageName) ? {owner: owner.project, aggregator} : null;
}

function moduleName(file) {
  const {tokens, issues} = lexJava(readBounded(file, 8192));
  const end = tokens.findIndex(t => t.text === '{');
  const name = tokens.slice(1, end).map(t => t.text).join('');
  if (issues.length || tokens[0]?.text !== 'module' || end < 2 || !tokenName.test(name)) throw modelError();
  return name;
}

async function observeServiceMove(vscode, send, candidate, sourceUri, targetUri, token) {
  const {owner, aggregator} = candidate;
  const workspace = vscode.workspace.getWorkspaceFolder(sourceUri);
  if (!workspace || vscode.workspace.getWorkspaceFolder(targetUri)?.uri.toString() !== workspace.uri.toString() ||
      !inside(fs.realpathSync(workspace.uri.fsPath), aggregator) || !physical(aggregator, 'isDirectory')) throw modelError();
  const model = mavenBuild(aggregator);
  const ownerEntry = [...model.roots].find(([, root]) => key(root) === key(owner));
  if (!ownerEntry || model.roots.size < 4 || model.roots.size > moduleLimit || model.dynamicContracts || model.externalModels ||
      model.files.length !== model.roots.size + 1 ||
      model.modelContracts.some(contract => contract.bomImports?.length)) throw modelError();
  const [ownerProject] = ownerEntry;
  for (const [name, dependencies] of model.graph) {
    const expected = name === ownerProject ? [] : [ownerProject];
    if (dependencies.length !== expected.length || dependencies.some((dependency, i) => dependency !== expected[i]) ||
        dependencies.some(dependency => ![undefined, 'compile'].includes(model.edgeKinds.get(name)?.get(dependency)))) throw modelError();
  }

  const all = await request(send, 'java.project.getAll', [], token);
  if (!Array.isArray(all) || all.length > 40) throw modelError();
  const imported = new Map();
  for (const item of all) {
    const uri = typeof item === 'string' && vscode.Uri.parse(item);
    if (!uri || uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
        !localPath(uri.fsPath) || !physical(uri.fsPath, 'isDirectory') || imported.has(key(uri.fsPath))) throw modelError();
    imported.set(key(uri.fsPath), uri);
  }
  const projects = [];
  const modelFiles = ['.project', '.classpath', '.settings/org.eclipse.jdt.core.prefs'];
  for (const [artifact, projectRoot] of model.roots) {
    if (!imported.has(key(projectRoot))) throw modelError();
    const file = path.join(projectRoot, descriptor);
    const project = await resolveMoveProject(send, vscode, vscode.Uri.file(file), token, 'test');
    const output = path.join(projectRoot, 'target', 'classes');
    const expectedRoots = new Set([main, 'src/main/resources', 'src/test/resources']
      .map(relative => key(path.join(projectRoot, relative))));
    if (key(project.root) !== key(projectRoot) || project.sourceRoots.some(root => !expectedRoots.has(key(root))) ||
        key(project.sourceRoot) !== key(path.join(projectRoot, main)) || !physical(output, 'isDirectory') ||
        !physical(path.join(output, 'module-info.class'), 'isFile')) throw modelError();
    projects.push({...project, artifact, name: moduleName(file), output});
  }
  const source = projects.find(project => key(project.root) === key(owner));
  if (new Set(projects.map(project => project.name)).size !== projects.length ||
      !inside(source.sourceRoot, fs.realpathSync(targetUri.fsPath))) throw modelError();

  for (const project of projects) {
    const cp = await classpaths(send, imported.get(key(project.root)).toString(), token);
    const expected = project === source ? [project.output] : [project.output, source.output];
    if (!Array.isArray(cp?.classpaths) || !Array.isArray(cp.modulepaths) || cp.classpaths.length ||
        cp.modulepaths.length !== expected.length || cp.modulepaths.some(file => !localPath(file)) ||
        new Set(cp.modulepaths.map(key)).size !== expected.length ||
        expected.some(file => !cp.modulepaths.some(observed => key(observed) === key(file)))) throw modelError();
    project.modulepaths = cp.modulepaths;
    imported.delete(key(project.root));
  }
  const outsiders = [];
  for (const uri of imported.values()) {
    if (key(uri.fsPath) === key(aggregator)) continue;
    const cp = await classpaths(send, uri.toString(), token);
    if (!Array.isArray(cp?.classpaths) || !Array.isArray(cp.modulepaths)) throw modelError();
    const paths = [...cp.classpaths, ...cp.modulepaths];
    if (paths.length > 500 || paths.some(file => !localPath(file))) throw modelError();
    if (paths.some(file => projects.some(project => inside(project.root, file) ||
        fs.existsSync(file) && inside(project.root, fs.realpathSync(file))))) {
      throw Error('An additional imported Java project depends on the reviewed service modules.');
    }
    outsiders.push({root: uri.fsPath, paths});
  }

  function readBuildFiles() {
    const config = [...projects.map(project => project.root), aggregator].flatMap(root => {
      if (['.mvn', 'settings.gradle', 'build.gradle', 'settings.gradle.kts', 'build.gradle.kts'].some(
        name => fs.lstatSync(path.join(root, name), {throwIfNoEntry: false}))) throw modelError();
      return modelFiles.map(name => path.join(root, name)).filter(file => {
        if (!fs.lstatSync(file, {throwIfNoEntry: false})) return false;
        readBounded(file, 256 * 1024);
        return true;
      });
    });
    return [...model.files, ...config].sort();
  }
  const buildFiles = readBuildFiles();
  return {
    source, projects, buildFiles, includeClassRegistrations: true, classpathIdentity: [],
    metadata: JSON.stringify({projects, buildFiles, outsiders}),
    checkBuildFiles() {
      if (JSON.stringify(readBuildFiles()) !== JSON.stringify(buildFiles)) throw modelError();
    }
  };
}

function bindServiceMove(scope, sources, tree, javaHome, oldPackage, newPackage) {
  const descriptors = scope.projects.map(project => reviewClosedModule(project.root,
    sources.filter(source => inside(project.root, source.file)), {allowVisibility: true, serviceOwner: scope.source.name}));
  if (descriptors.some((descriptor, index) => descriptor?.name !== scope.projects[index].name)) throw modelError();
  const owner = descriptors.find(item => item.name === scope.source.name);
  const moved = sources.find(source => key(source.file) === key(tree.files[0].file));
  const type = moved && parseJavaFile(moved).types;
  if (tree.files.length !== 1 || type?.length !== 1 || type[0].kind !== 'interface' ||
      type[0].fqn !== oldPackage + '.' + path.basename(moved.file, '.java') ||
      !owner.declarations.some(entry => entry.role === 'exports' && entry.name === oldPackage) ||
      owner.uses.size || owner.registrations.size) {
    throw Error('Choose the exact public exported service interface in its own main Java package.');
  }
  const service = type[0].fqn;
  const consumers = [], providers = [];
  for (const item of descriptors.filter(item => item !== owner)) {
    if (Number(item.uses.has(service)) + Number(item.registrations.has(service)) !== 1 ||
        item.uses.size + item.registrations.size !== 1) {
      throw Error('Every peer module needs one exact uses or provides directive for the selected service.');
    }
    for (const entry of item.declarations) {
      if (entry.role === 'uses' || entry.role === 'provides') entry.owner = owner.name;
      if (entry.role === 'with') entry.owner = item.name;
    }
    if (item.uses.size) consumers.push(item.name);
    else providers.push({module: item.name, implementations: item.registrations.get(service).providers.map(value => value.name)});
  }
  if (!consumers.length || providers.length < 2) throw Error('Review at least two provider modules and one consumer module for this service.');
  const sourceForCompile = record => {
    const file = record.file || fileURLToPath(record.uri);
    const project = scope.projects.find(project => inside(project.sourceRoot, file));
    if (!project) throw modelError();
    return {...record, moduleName: project.name, modulePath: path.relative(project.sourceRoot, file).split(path.sep).join('/')};
  };

  const beforeBinary = snapshotClasspath(javaHome, scope.projects.map(project => project.output));
  const prefixes = [oldPackage, newPackage].map(name => name.replaceAll('.', '/') + '/');
  const expectedClass = path.join(scope.source.output, ...service.split('.')) + '.class';
  let observedClass = false;
  for (const {file} of beforeBinary.files) {
    const project = scope.projects.find(project => inside(project.output, file));
    if (!project) continue;
    const relative = path.relative(project.output, file).split(path.sep).join('/');
    if (relative.startsWith(prefixes[1]) ||
        relative.startsWith(prefixes[0]) && key(file) !== key(expectedClass)) {
      throw Error('A compiled class competes with the service Move namespaces. Rebuild the reviewed modules.');
    }
    if (key(file) === key(expectedClass)) observedClass = true;
  }
  if (!observedClass) throw Error('Build the reviewed service interface before preparing Package Move.');
  function validate() {
    scope.checkBuildFiles();
    for (const project of scope.projects) {
      for (const output of ['generated-sources', 'generated-test-sources']) {
        const folder = path.join(project.root, 'target', output);
        if (fs.lstatSync(folder, {throwIfNoEntry: false}) &&
            (!physical(folder, 'isDirectory') || projectFiles(folder).length)) {
          throw Error('Generated Java or registration sources need a separate service Move review.');
        }
      }
      const locations = [project.output, path.join(project.root, 'src/main/resources'), path.join(project.root, 'src/test/resources')];
      if (locations.some(root => fs.lstatSync(path.join(root, 'META-INF', 'services'), {throwIfNoEntry: false}))) {
        throw Error('Named module services cannot mix with classpath service descriptors.');
      }
      const roots = locations.slice(1);
      if (roots.some(root => [oldPackage, newPackage].some(name =>
        fs.lstatSync(path.join(root, ...name.split('.')), {throwIfNoEntry: false})))) {
        throw Error('A resource directory shares one of the selected Java package names.');
      }
    }
    beforeBinary.validate();
  }
  validate();
  return {service, owner: owner.name, descriptors, consumers, providers, sourceForCompile, validate};
}

module.exports = {serviceMoveCandidate, observeServiceMove, bindServiceMove};
