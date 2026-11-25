'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { javaEmbeddedFixture, runEmbeddedFixture, originalRegex, editedRegex, originalHtml, editedHtml,
  expectedOriginal, expectedEdited } = require('./helpers/java-embedded-fixture');

async function runJavaEmbeddedLanguageChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, workspace);
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(runtime.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const name = 'RbJavaEmbedded' + randomBytes(5).toString('hex');
  const file = path.join(workspace, 'src/main/java/fixture/boot', name + '.java');
  const source = javaEmbeddedFixture('fixture.boot', name), service = api.embeddedLanguage;
  const execute = () => runEmbeddedFixture({ javaHome: project.jdk || api.java.getState().javaHome,
    classpathFile: path.join(runtime.projectPath, 'build/runtime-classpath.txt'), file, config, engine: runtime.dbEngine });
  const projections = [];
  let sourceDocument, created = false;
  const range = (document, start, end) => new vscode.Range(document.positionAt(start), document.positionAt(end));
  const edit = async (document, value) => {
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    assert.equal(await editor.edit(builder => builder.replace(range(document, 0, document.getText().length), value)), true);
  };
  const undoAndRedo = async (original, updated) => {
    await vscode.window.showTextDocument(sourceDocument, { preview: false });
    await vscode.commands.executeCommand('undo');
    await until(() => sourceDocument.getText() === original, 10000);
    await vscode.commands.executeCommand('redo');
    await until(() => sourceDocument.getText() === updated, 10000);
  };

  try {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['rocketbrain.sql.editEmbedded', 'rocketbrain.sql.applyEmbedded', 'rocketbrain.java.revealEmbeddedSource']) {
      assert.ok(commands.includes(command), command);
    }
    await fs.writeFile(file, source, { flag: 'wx' });
    created = true;
    sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    assert.equal((await execute()).html, expectedOriginal);
    await vscode.window.showTextDocument(sourceDocument, { preview: false });

    const regex = await service.open(sourceDocument, sourceDocument.positionAt(source.indexOf('word')), 'regex');
    projections.push(regex);
    assert.equal(regex.languageId, 'rocketbrain-java-regex');
    assert.equal(regex.getText(), originalRegex);
    const first = originalRegex.indexOf('\\p');
    const origin = await service.reveal(regex, range(regex, first, first + 2));
    assert.equal(origin.exact, true);
    assert.equal(origin.source.toString(), sourceDocument.uri.toString());
    assert.equal(sourceDocument.getText(origin.range), '\\\\p');
    await edit(regex, '(?<word>');
    await assert.rejects(service.prepareVerified(regex), /Java Pattern rejected/u);
    await until(() => vscode.languages.getDiagnostics(regex.uri).some(issue => issue.source === 'Java Pattern' &&
      /Unclosed group/u.test(issue.message)), 6000);
    const invalid = service.prepare(regex);
    await assert.rejects(service.apply(invalid.id), /Java Pattern rejected/u);
    assert.equal(sourceDocument.getText(), source);
    await edit(regex, editedRegex);
    const reviewed = await service.prepareVerified(regex);
    assert.deepEqual(vscode.languages.getDiagnostics(regex.uri).filter(issue => issue.source === 'Java Pattern'), []);
    assert.equal((await service.apply(reviewed.id)).applied, true);
    const patternOnly = sourceDocument.getText();
    assert.equal(patternOnly, source.replace(reviewed.before, reviewed.after));
    await undoAndRedo(source, patternOnly);
    assert.throws(() => service.prepare(regex), /source changed/u);

    const html = await service.open(sourceDocument, sourceDocument.positionAt(patternOnly.indexOf('<article')), 'html');
    projections.push(html);
    assert.equal(html.languageId, 'html');
    assert.equal(html.getText(), originalHtml);
    const htmlLanguage = vscode.extensions.getExtension('vscode.html-language-features');
    assert.ok(htmlLanguage, 'The installed VS Code needs its built-in HTML language features.');
    await htmlLanguage.activate();
    await until(async () => {
      const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', html.uri, html.positionAt(4));
      return completion?.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'article');
    }, 12000);
    const renamed = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', html.uri, html.positionAt(4), 'section');
    assert.equal(renamed?.entries().length, 1);
    assert.deepEqual(renamed.entries().map(([uri, changes]) => [uri.toString(), changes.length]), [[html.uri.toString(), 2]]);
    assert.equal(await vscode.workspace.applyEdit(renamed), true);
    assert.equal(html.getText(), originalHtml.replaceAll('article', 'section'));
    await edit(html, editedHtml);
    const htmlReview = await service.prepareVerified(html);
    assert.match(htmlReview.after, /^"""\n/u);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-embedded-review:/' + htmlReview.id + '/after.java'));
    assert.equal(diff.getText(), htmlReview.after);
    assert.equal((await service.apply(htmlReview.id)).applied, true);
    const final = sourceDocument.getText();
    assert.equal(final, patternOnly.replace(htmlReview.before, htmlReview.after));
    await undoAndRedo(patternOnly, final);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    assert.equal(await sourceDocument.save(), true);
    const observed = await execute();
    assert.equal(observed.html, expectedEdited);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Java regex and HTML projections used the configured JDK and built-in HTML completion, with exact navigation to Java source.');
    checks.push('Both reviewed literal edits supported Undo and preserved on-disk source until save. Spring JDBC rendered the edited values against the owned database.');
    return { ...observed, jdbc, regexDiagnostic: true, htmlCompletion: true, htmlTagRename: true, preciseSourceRange: true,
      staleRefused: true, nativeDiff: true, nativeUndo: true, diskUnchangedUntilSave: true, htmlTextBlockPreserved: true };
  } finally {
    for (const document of projections) {
      if (!document.isClosed && document.isDirty && service.isProjection(document)) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
    }
    if (sourceDocument?.isDirty) {
      await edit(sourceDocument, source);
      await sourceDocument.save();
    }
    if (created) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaEmbeddedLanguageChecks };
