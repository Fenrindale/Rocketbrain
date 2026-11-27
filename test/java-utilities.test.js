'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { listFileTemplates, validIdentifier, checkPackage, renderJavaFile, writeTemplateFile } =
  require('../src/java/file-templates');
const { runJavaScratch, scratchClasspath } = require('../src/java/scratch-engine');
const { registerJavaUtilities, COMMANDS } = require('../src/java/utilities-vscode');

const custom = {
  name: 'Custom probe', source: 'test',
  template: '${packageDeclaration}public class ${name} {\r\n  public static int value() { return 42; }\r\n}'
};
const service = listFileTemplates().find(template => template.name === 'Spring service');

async function ownedDirectory(t) {
  const temp = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temp, 'rocketbrain-java-utilities-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Project folder action anchors source and package choices to the selected directory', async t => {
  const root = await ownedDirectory(t);
  const source = path.join(root, 'src', 'main', 'java');
  const selected = path.join(source, 'demo', 'chosen');
  const other = path.join(root, 'src', 'test', 'java', 'demo', 'other');
  await Promise.all([fs.mkdir(selected, {recursive: true}), fs.mkdir(other, {recursive: true})]);
  const file = fsPath => ({scheme: 'file', fsPath});
  const folder = {uri: file(root), name: 'fixture'};
  const commands = new Map(), errors = [];
  let selectedPackage, selectedRoot;
  const vscode = {
    Uri: {file},
    workspace: {
      isTrusted: true, workspaceFolders: [folder],
      getWorkspaceFolder: () => folder, findFiles: async () => [],
      getConfiguration: () => ({get: (_key, fallback) => fallback})
    },
    window: {
      activeTextEditor: {document: {uri: file(path.join(other, 'UnrelatedTest.java'))}},
      createOutputChannel: () => ({dispose() {}}),
      async showQuickPick(items, options) {
        if (options.title === 'Java File Template · Source Root') selectedRoot = items[0].source.path;
        return items[0];
      },
      async showInputBox(options) {
        if (options.title === 'Java File Template · Type Name') return 'NewClass';
        selectedPackage = options.value;
      },
      async showErrorMessage(message) { errors.push(message); }
    },
    commands: {registerCommand(id, handler) {
      commands.set(id, handler);
      return {dispose: () => commands.delete(id)};
    }}
  };
  const tools = registerJavaUtilities({globalStorageUri: file(root)}, vscode, {java: {}});
  t.after(() => tools.dispose());
  const invoke = dir => commands.get(COMMANDS.newFile)({
    contextValue: 'rocketbrain.project.directory', resourceUri: file(dir)
  });
  await invoke(selected);
  assert.equal(selectedRoot, source);
  assert.equal(selectedPackage, 'demo.chosen');
  assert.deepEqual(await fs.readdir(selected), []);
  assert.deepEqual(errors, []);
  selectedPackage = undefined;
  await invoke(path.join(selected, 'deleted'));
  assert.equal(selectedPackage, undefined);
  assert.equal(errors.length, 1);
});

test('Java file templates render Spring, JUnit and workspace-defined Java with safe file names and package substitutions', () => {
  assert.equal(listFileTemplates().length, 10);
  assert.match(renderJavaFile(service, 'ExampleService', 'demo.api'), /^package demo\.api;\n\nimport org\.springframework\.stereotype\.Service;\n\n@Service\npublic class ExampleService/);
  assert.match(renderJavaFile(listFileTemplates().find(template => template.source === 'test'), 'ExampleTest', 'demo'), /@Test/);
  assert.match(renderJavaFile(listFileTemplates([custom]).at(-1), 'Probe', 'fixture.boot'), /^package fixture\.boot;\n\npublic class Probe \{\n.*return 42;/s);
  assert.equal(renderJavaFile(service, '한글', '').startsWith('import '), true);
  const replace = { ...custom, name: service.name };
  assert.equal(listFileTemplates([replace]).filter(template => template.name === service.name).length, 1);
  assert.equal(listFileTemplates([replace]).find(template => template.name === service.name).source, 'test');
  assert.throws(() => listFileTemplates([{ ...custom, template: custom.template + '${unknown}' }]), /support \$\{name\}/);
  assert.throws(() => listFileTemplates([{ ...custom, source: 'resource' }]), /allowed source kind/);
  assert.throws(() => renderJavaFile({ ...custom, template: 'class ${name} {}' }, 'Probe', 'demo.api'), /declare the selected package/);
  for (const value of ['class','../Probe','CON','LPT1','x.java','a b','_']) assert.equal(validIdentifier(value), false, value);
  for (const value of ['foo..bar','foo.aux','foo.bar/../baz']) assert.throws(() => checkPackage(value), /Java package/);
});

test('template creation supports absent conventional roots, refuses symlinks and races, and never rewrites an existing source', async t => {
  const root = await ownedDirectory(t);
  const sourceRoot = path.join(root, 'src', 'test', 'java');
  const params = { workspaceRoot: root, sourceRoot, template: custom, name: 'Probe', packageName: 'fixture.boot',
    createSourceRoot: true, assertTrusted() {} };
  const outcomes = await Promise.allSettled([writeTemplateFile(params), writeTemplateFile(params)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /already exists/);
  const created = outcomes.find(item => item.status === 'fulfilled').value;
  assert.equal(await fs.readFile(created.path, 'utf8'), renderJavaFile(custom, 'Probe', 'fixture.boot'));
  await assert.rejects(writeTemplateFile({ ...params, sourceRoot: path.dirname(root) }), /inside the open workspace/);
  const outside = path.join(root, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(sourceRoot, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeTemplateFile({ ...params, packageName: 'alias' }), /physical directories/);
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(writeTemplateFile({ ...params, name: 'Dirty', assertTarget: () => { throw Error('pending editor'); } }), /pending editor/);
  await assert.rejects(fs.stat(path.join(sourceRoot, 'fixture', 'boot', 'Dirty.java')), { code: 'ENOENT' });
});

test('scratch classpath inspection rejects non-local paths and unsupported archives before execution', async t => {
  const root = await ownedDirectory(t);
  const file = path.join(root, 'notes.txt');
  await fs.writeFile(file, 'Fixture');
  assert.deepEqual(await scratchClasspath([root, root]), [root]);
  await assert.rejects(scratchClasspath([file]), /class directories and JAR dependencies/);
  await assert.rejects(scratchClasspath(['relative.jar']), /absolute local paths/);
  await assert.rejects(scratchClasspath(['\\\\unknown-machine\\share']), /absolute local paths/);
});

test('actual JShell preserves snippets, reports syntax errors, and stops on cancellation and output limits',
  { skip: !process.env.ROCKETBRAIN_JAVA_TEST_CONFIG && 'Independent Java test runtime is not configured.' }, async t => {
    const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
    const storagePath = await ownedDirectory(t);
    const run = options => runJavaScratch({ javaHome: runtime.javaHome, storagePath, ...options });
    const success = await run({ source: 'var n = 2;\nn + 3\nSystem.out.print("한글");' });
    assert.equal(success.state, 'finished');
    assert.equal(success.classpathEntries, 0);
    assert.match(success.output.replaceAll('\r', ''), /^2\n5\n한글/);
    const error = await run({ source: 'n + 3' });
    assert.equal(error.state, 'failed');
    assert.equal(error.snippetErrors, 1);
    assert.match(error.output, /cannot find symbol/);
    const incomplete = await run({ source: 'class Unterminated {' });
    assert.equal(incomplete.state, 'failed');
    assert.match(incomplete.output, /Incomplete Java snippet/);
    const controller = new AbortController();
    const cancel = run({ source: 'Thread.sleep(20000);', signal: controller.signal });
    setTimeout(() => controller.abort(), 1200);
    assert.equal((await cancel).state, 'cancelled');
    const limited = await run({ source: 'System.out.print("x".repeat(300000));' });
    assert.equal(limited.state, 'output-limit');
    assert.equal(Buffer.byteLength(limited.output), 256 * 1024);
    assert.deepEqual(await fs.readdir(storagePath), []);
  });
