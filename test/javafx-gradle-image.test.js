'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const { observeImage, planImage, readModule } = require('../src/java/javafx-gradle-image');
const { registerJavaFx } = require('../src/java/javafx-vscode');

function fixture() {
  const workspace = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(workspace, 'rb-javafx-unit-'));
  const fields = { module: 'dev.example.application', launcher: 'example-app',
    directory: path.join(root, 'build', 'custom-image'), intermediate: path.join(root, 'build', 'jlinkbase') };
  const descriptor = path.join(root, 'src/main/java/module-info.java');
  fs.mkdirSync(path.dirname(descriptor), { recursive: true });
  fs.writeFileSync(descriptor, 'module dev.example.application { requires transitive javafx.fxml; }');
  return { root, fields, descriptor, dispose() {
    const real = fs.realpathSync(root);
    assert.equal(path.relative(workspace, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-javafx-unit-/u);
    fs.rmSync(real, { recursive: true, force: true });
  } };
}

test('JavaFX image plan binds the exact local module and distinct output directories', () => {
  const { root, fields, descriptor, dispose } = fixture();
  try {
    const module = readModule(root);
    assert.equal(module.name, fields.module);
    assert.deepEqual(planImage(root, module, fields), fields);
    for (const proposal of [
      { directory: path.dirname(root) }, { directory: path.join(root, 'src') },
      { intermediate: path.join(fields.directory, 'inside') }, { intermediate: path.join(root, 'build') },
      { launcher: '../outside' }, { module: 'dev.example.other' },
    ]) assert.throws(() => planImage(root, module, { ...fields, ...proposal }), /module, image and launcher|build directory/u);
    fs.writeFileSync(descriptor, 'module dev.example.application { /* requires javafx.fxml; */ }');
    assert.throws(() => readModule(root), /explicitly requires JavaFX/u);
  } finally {
    dispose();
  }
});

test('a planned image refuses symlink redirection, missing launchers and mismatched runtime modules', () => {
  const { root, fields, dispose } = fixture();
  try {
    fs.mkdirSync(path.join(root, 'elsewhere'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'build'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => planImage(root, readModule(root), fields), /physical/u);
    fs.unlinkSync(path.join(root, 'build'));
    const plan = planImage(root, readModule(root), fields);
    for (const name of ['bin', 'lib']) fs.mkdirSync(path.join(fields.directory, name), { recursive: true });
    fs.writeFileSync(path.join(fields.directory, 'bin/java.exe'), 'java');
    assert.throws(() => observeImage(root, plan, 'win32'), /regular runtime files/u);
    fs.writeFileSync(path.join(fields.directory, 'bin/example-app.bat'), 'launcher');
    fs.writeFileSync(path.join(fields.directory, 'release'), 'MODULES="java.base javafx.fxml"');
    const image = Buffer.alloc(28);
    image.writeUInt32LE(0xCAFEDADA);
    fs.writeFileSync(path.join(fields.directory, 'lib/modules'), image);
    assert.throws(() => observeImage(root, plan, 'win32'), /reviewed application and JavaFX modules/u);
    fs.writeFileSync(path.join(fields.directory, 'release'), 'MODULES="java.base javafx.fxml dev.example.application"');
    assert.equal(observeImage(root, plan, 'win32').launcherUri,
      pathToFileURL(path.join(fields.directory, 'bin/example-app.bat')).href);
    fs.writeFileSync(path.join(fields.directory, 'lib/modules'), Buffer.alloc(28));
    assert.throws(() => observeImage(root, plan, 'win32'), /jlink runtime payload/u);
  } finally {
    dispose();
  }
});

test('the JavaFX command validates the selected folder before choosing a build mode', async () => {
  const { root, dispose } = fixture();
  const uri = folder => ({ scheme: 'file', fsPath: folder, toString: () => pathToFileURL(folder).href });
  const handle = { dispose() {} };
  const commands = new Map();
  let choicesShown = 0, error;
  const vscode = { workspace: { isTrusted: true, workspaceFolders: [{ uri: uri(root) }], textDocuments: [],
    onDidChangeWorkspaceFolders: () => handle,
    onDidOpenTextDocument: () => handle, onDidSaveTextDocument: () => handle, onDidCloseTextDocument: () => handle },
  commands: { registerCommand(id, callback) { commands.set(id, callback); return handle; } },
  languages: { createDiagnosticCollection: () => handle, registerDefinitionProvider: () => handle,
    registerDocumentSymbolProvider: () => handle },
  window: { showOpenDialog: async () => [uri(path.dirname(root))],
    showQuickPick: async () => { choicesShown++; }, showErrorMessage: async value => { error = value; } } };
  const service = registerJavaFx(vscode, { java: {} });
  try {
    await commands.get('rocketbrain.javafx.build')();
    assert.match(error, /inside an open local workspace/u);
    assert.equal(choicesShown, 0);
  } finally {
    await service.dispose();
    dispose();
  }
});
