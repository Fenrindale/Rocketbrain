'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { until } = require('./helpers/stdio-lsp');
const { prepareGroovyProject, typedMemberScript, withGroovyDatabase, expectedOutput } = require('./helpers/groovy-project-fixture');

async function runGroovyStaticMemberChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(spring.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  const config = JSON.parse(await fs.readFile(spring.dbConfigPath, 'utf8'));
  const root = await fs.mkdtemp(path.join(workspace, 'rb-groovy-typed-'));
  const inside = file => {
    const relative = path.relative(root, file);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
  };
  const setup = vscode.workspace.getConfiguration('rocketbrain.java');
  const service = api.java.groovy.project;
  const { members } = service;
  const variable = 'RB_GROOVY_MEMBER_INITIALIZED', marker = path.join(root, 'initialized.txt'), prior = process.env[variable];
  let projectUri, document;
  try {
    await api.java.start();
    const fixture = await prepareGroovyProject(root, { javaHome: api.java.getState().javaHome, mavenHome: setup.get('mavenHome') });
    const script = path.join(root, 'scripts', 'typed.groovy');
    await fs.writeFile(script, typedMemberScript, { flag: 'wx' });
    const descriptor = vscode.Uri.file(path.join(root, 'pom.xml')).toString();
    const javaSource = vscode.Uri.file(path.join(root, fixture.nativeSource)).toString();
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [descriptor], [], []);
    projectUri = await until(async () => {
      const packet = await api.java.executeWorkspaceCommand('java.project.getClasspaths', javaSource, { scope: 'runtime' });
      return packet?.projectRoot && !path.relative(root, vscode.Uri.parse(packet.projectRoot).fsPath) &&
        packet.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar')) ? packet.projectRoot : undefined;
    }, 120000);
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.groovy.completeTypedMember'));
    assert.ok(commands.includes('rocketbrain.groovy.openTypedMemberDeclaration'));
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(script));
    const original = document.getText();
    const position = document.positionAt(original.indexOf('service.quer') + 'service.quer'.length);
    const inspect = () => members.inspect({ document, position, projectUri, scope: 'runtime' });
    process.env[variable] = marker;
    const result = await inspect();
    assert.equal(result.receiver.type, 'fixture.groovyproject.ProjectProbe');
    assert.equal(document.getText(new vscode.Range(result.receiver.start, result.receiver.end)), 'service');
    assert.deepEqual(result.members.map(member => [member.name, member.parameters.length]), [['query', 1], ['query', 3]]);
    const selection = result.members.find(member => member.parameters.length === 3);
    const found = await members.openDeclaration({ id: result.id, key: selection.key });
    const javaEditor = vscode.window.activeTextEditor;
    assert.equal(path.relative(path.join(root, fixture.nativeSource), found.file), '');
    assert.equal(javaEditor.document.getText(javaEditor.selection), 'query');
    assert.match(javaEditor.document.lineAt(javaEditor.selection.start.line).text, /String url, String user, String password/u);
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    await members.apply({ id: result.id, key: selection.key, editor });
    const completed = original.replace('service.quer(', 'service.query(');
    assert.equal(document.getText(), completed);
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    await vscode.commands.executeCommand('undo');
    await until(() => document.getText() === original, 15000);
    await vscode.commands.executeCommand('redo');
    await until(() => document.getText() === completed, 15000);
    assert.equal(await document.save(), true);
    await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
    const receipt = await withGroovyDatabase(config, spring.dbEngine, async () => {
      const review = await service.review({ document, range: new vscode.Range(document.positionAt(0), document.positionAt(completed.length)),
        projectUri, scope: 'runtime' });
      return expectedOutput(await service.run({ id: review.id, allowExecution: true }), spring.dbEngine);
    });
    assert.equal(await fs.readFile(marker, 'utf8'), 'initialized');
    checks.push('Groovy completes an attributed Java member on the exact editor token and opens the selected Java overload declaration.');
    checks.push('Undo and Redo preserve the exact edit. Compiler inspection leaves the project type uninitialized. Explicit execution returns 42.');
    return { receiver: result.receiver.type, overloads: result.members.length, exactSourceOverload: selection.key,
      noProjectTypeInitializationDuringAnalysis: true, nativeUndoRedo: true, jdbc: receipt };
  } finally {
    if (prior === undefined) delete process.env[variable]; else process.env[variable] = prior;
    try {
      if (document?.isDirty) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs)
        .filter(tab => tab.input?.uri?.scheme === 'file' && inside(tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (projectUri) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects', [], [], [projectUri]).catch(() => {});
    } finally {
      const owned = await fs.realpath(root);
      assert.equal(path.relative(workspace, path.dirname(owned)), '');
      assert.match(path.basename(owned), /^rb-groovy-typed-/u);
      await fs.rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    }
  }
}

module.exports = { runGroovyStaticMemberChecks };
