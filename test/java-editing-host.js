'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { local, inside } = require('../src/java/workbench-model');

async function observedProject(api, workspaceRoot) {
  const stop = Date.now() + 100000;
  while (Date.now() < stop) {
    const snapshot = await api.java.workbench.refresh();
    const project = snapshot.projects.find(project => !path.relative(project.root, workspaceRoot));
    if (project?.sourceRoots.length) return project;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw Error('JDT did not import the Spring Java editing fixture.');
}

async function buildProject(api) {
  const state = await api.java.buildWorkspace();
  assert.ok(state === 0 || state === 1 || state?.status === 'succeed', 'Actual JDT build status ' + JSON.stringify(state));
}

async function liveCompletion(vscode, editor, token, wantedLabel, expectedDetail) {
  const index = editor.document.getText().indexOf(token);
  assert.ok(index >= 0, 'Completion token ' + token);
  const position = editor.document.positionAt(index + token.length);
  const suggestions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', editor.document.uri, position);
  const match = suggestions.items.find(item => item.label === wantedLabel && item.detail === expectedDetail);
  assert.ok(match, JSON.stringify(suggestions.items.slice(0,15).map(item => ({ label:item.label, detail:item.detail }))));
  assert.equal(await editor.insertSnippet(match.insertText, match.range), true);
  return match;
}

async function nativeDbReadback() {
  if (!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) return null;
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const result = await fetch(config.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6500) });
  assert.equal(result.ok, true);
  const actual = await result.json();
  assert.deepEqual(actual, { people:2, departments:1, rolledBackNames:0 });
  return actual;
}

async function evaluateGeneratedClasses(api, project, model, target) {
  const runtime = api.java.getState();
  const classpaths = await api.java.requestWorkspaceCommand('java.project.getClasspaths',[project.uri,{scope:'runtime'}]);
  const matches = [];
  for (const value of classpaths.classpaths) {
    const directory = local(value);
    if (!inside(project.root, directory)) continue;
    const files = [model,target].map(name => path.join(directory, 'fixture/boot', name + '.class'));
    const exists = await Promise.all(files.map(file => fs.stat(file).then(stat => stat.isFile(), () => false)));
    if (exists.every(Boolean)) matches.push(directory);
  }
  assert.ok(matches.length, 'Find the observed compiled Spring output for both generated classes.');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-edit-proof-'));
  const probe = path.join(dir, 'GenerationProof.java');
  try {
    const source = 'import fixture.boot.' + model + ';\nimport fixture.boot.' + target + ';\n'
      + 'class GenerationProof { public static void main(String[] args) {\n'
      + 'var left = new ' + model + '(new int[]{1,2}, true, new ' + target + '());\n'
      + 'var right = new ' + model + '(new int[]{1,2}, true, new ' + target + '());\n'
      + 'System.out.println("RB " + left.equals(right) + " " + (left.hashCode() == right.hashCode()) '
      + '+ " " + left.getValues()[1] + " " + left.isActive() + " " + left.compute(21) + " " + left.negate(true));\n'
      + 'left.setActive(false);\n'
      + 'System.out.println("RB_SET " + !left.isActive() + " " + !left.equals(right));\n'
      + '} }\n';
    await fs.writeFile(probe, source, { flag:'wx' });
    const java = path.join(runtime.javaHome,'bin',process.platform === 'win32' ? 'java.exe' : 'java');
    const { stdout } = await execFile(java, ['--class-path',matches[0],'--source','25',probe],
      { cwd:dir, encoding:'utf8', windowsHide:true, timeout:20000 });
    assert.match(stdout, /RB true true 2 true 42 false/);
    assert.match(stdout, /RB_SET true true/);
    return matches.length;
  } finally {
    await fs.unlink(probe);
    await fs.rmdir(dir);
  }
}

async function runJavaEditingChecks(api, vscode, checks) {
  assert.ok(api.javaEditing);
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await observedProject(api, workspace);
  const pkg = path.join(workspace, 'src/main/java/fixture/boot');
  const id = randomBytes(5).toString('hex');
  const model = 'RbEditModel' + id, target = 'RbEditTarget' + id;
  const targetPath = path.join(pkg, target + '.java');
  const modelPath = path.join(pkg, model + '.java');
  const modelUri = vscode.Uri.file(modelPath);
  const config = vscode.workspace.getConfiguration('rocketbrain.java', modelUri);
  const globalTarget = vscode.ConfigurationTarget.Global;
  const originalTemplates = config.inspect('liveTemplates')?.globalValue;
  const ownedFiles = [];
  const mark = (doc, name) => doc.positionAt(doc.getText().indexOf(name));
  try {
    await config.update('liveTemplates', [{
      prefix:'rbPrint', description:'Spring editing proof',
      body:'System.out.println(${1:33});$0'
    }], globalTarget);
    await fs.writeFile(targetPath, 'package fixture.boot;\npublic final class ' + target +
      ' { public int compute(int n) { return n * 2; } public int compute(String n) { return n.length(); } }\n', { flag:'wx' });
    ownedFiles.push(targetPath);
    await vscode.workspace.openTextDocument(vscode.Uri.file(targetPath));
    await buildProject(api);
    const skeleton = 'package fixture.boot;\npublic final class ' + model + ' {\n'
      + '    private final int[] values;\n    private boolean active;\n    private ' + target + ' target;\n'
      + '    public void print() {\n        rbPri\n    }\n'
      + '    public boolean negate(boolean flag) { return flag.not; }\n}\n';
    await fs.writeFile(modelPath, skeleton, { flag:'wx' });
    ownedFiles.push(modelPath);
    const document = await vscode.workspace.openTextDocument(modelUri);
    const editor = await vscode.window.showTextDocument(document, { preview:false });
    await liveCompletion(vscode, editor, 'rbPri', 'rbPrint', 'Spring editing proof');
    assert.match(document.getText(), /System\.out\.println\(33\);/);
    assert.equal(document.getText(editor.selection), '33');
    await liveCompletion(vscode, editor, 'flag.not', '.not', 'Negate expression');
    assert.match(document.getText(), /return !\(flag\);/);
    assert.equal(await document.save(), true);
    // Wait for the editor build that follows Save before freezing compiler
    // inputs. The uninitialized final field is fixed by the next action.
    await api.java.buildWorkspace();

    async function preview(kind, fields, options = {}) {
      return api.javaEditing.previewGeneration({ document, position: mark(document, 'private final'),
        kind, fields, ...options });
    }
    async function apply(plan) {
      const result = await api.java.refactoring.apply(plan.id);
      assert.equal(result.state, 'applied');
      assert.equal(plan.generation.compileErrors, 0);
      assert.equal(await document.save(), true);
      await buildProject(api);
      return plan.generation.members;
    }
    const cancelled = new vscode.CancellationTokenSource();
    cancelled.cancel();
    try {
      await assert.rejects(preview('constructor', ['values','active','target'], { cancellation: cancelled.token }), /cancelled/);
    } finally { cancelled.dispose(); }
    const constructor = await apply(await preview('constructor', ['values','active','target']));
    assert.equal(constructor.length, 1);
    const accessors = await apply(await preview('accessors', ['values','active']));
    assert.equal(accessors.length, 3);
    await assert.rejects(preview('accessors', ['active']), /collides with existing Java method/);
    const equality = await apply(await preview('equalsHashCode', ['values','active']));
    assert.equal(equality.length, 2);
    const methods = await api.javaEditing.listDelegates({
      document, position: mark(document, 'private final'), field:'target'
    });
    const method = methods.find(method => method.signature === 'compute(int)');
    assert.ok(method && methods.some(choice => choice.signature === 'compute(java.lang.String)'));
    const generated = await preview('delegate', ['target'], { methodKey: method.key });
    const beforeApply = document.getText();
    assert.equal(generated.generation.delegate, method.key);
    assert.equal((await api.java.refactoring.apply(generated.id)).state, 'applied');
    await vscode.commands.executeCommand('undo');
    assert.equal(document.getText(), beforeApply);
    await vscode.commands.executeCommand('redo');
    assert.match(document.getText(), /return this.target.compute\(n\);/);
    assert.equal(await document.save(), true);
    await buildProject(api);

    const compiledOutputs = await evaluateGeneratedClasses(api, project, model, target);
    const jdbc = await nativeDbReadback();
    checks.push('Native Java completion inserted an editable configured snippet and a postfix expression. The reviewed generator compiled a constructor, boolean and array accessors, equals/hashCode, and one exact delegate overload; undo/redo and real generated behavior passed.');
    if (jdbc) checks.push('The Spring fixture connected to the selected server and retained all live data counts.');
    return { liveTemplate:true, placeholder:true, postfix:true, generated:7, cancelled:true, collision:true,
      undoRedo:true, delegateValue:42, compiledOutputs, jdbc };
  } finally {
    for (const owned of ownedFiles.reverse()) {
      const open = vscode.workspace.textDocuments.find(document => !path.relative(document.uri.fsPath, owned));
      if (open?.isDirty) await open.save();
      await fs.unlink(owned);
    }
    await config.update('liveTemplates', originalTemplates, globalTarget);
  }
}

module.exports = { runJavaEditingChecks };
