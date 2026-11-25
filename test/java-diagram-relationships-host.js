'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { springDiagramFixture } = require('./helpers/java-diagram-relationship-fixture');

function relationship(report, from, to, kind, match) {
  const edge = report.edges.find(item => item.from === from && item.to === to && item.kind === kind);
  const origin = edge?.origins.findIndex(match);
  assert.ok(edge && origin >= 0, from + ' ' + kind + ' ' + to);
  return [edge.id, origin];
}

async function stableClasspath(operation) {
  for (let attempt = 1; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt === 4 || !/classpath (?:file membership |entry |inputs? )?changed after|compiler inputs? changed after/iu.test(error.message)) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 650));
    }
  }
}

async function runJavaDiagramRelationshipChecks(api, vscode, checks) {
  const service = api.javaSourceAnalysis;
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project = await importedSpring(api, root);
  const name = 'RbDiagram' + randomBytes(5).toString('hex');
  const namespace = 'fixture.boot', id = namespace + '.' + name;
  const file = path.join(root, 'src/main/java/fixture/boot', name + '.java');
  const uri = vscode.Uri.file(file);
  const original = springDiagramFixture(namespace, name);
  const changed = springDiagramFixture(namespace, name, { alternate:true });
  const jdbcOwner = 'org.springframework.jdbc.core.JdbcTemplate';
  const field = origin => origin.role === 'field' && origin.member === 'lastResult';
  const call = origin => origin.role === 'call' && origin.signature.startsWith(jdbcOwner + '#queryForObject(');
  const temp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-class-relations-'));
  const exportFile = path.join(temp, 'associations.mmd');
  let panel, document, created = false;
  try {
    await fs.writeFile(file, original, { flag:'wx' });
    created = true;
    document = await vscode.workspace.openTextDocument(uri);
    const initial = await stableClasspath(async () => {
      const report = await service.diagram({ projectUri:project.uri });
      const fieldLink = relationship(report, id, 'java.sql.Date', 'associates', field);
      const methodLink = relationship(report, id, jdbcOwner, 'uses', call);
      const fieldEditor = await service.revealRelationship(report, ...fieldLink);
      assert.equal(path.relative(file, fieldEditor.document.uri.fsPath), '');
      assert.equal(fieldEditor.document.getText(fieldEditor.selection), 'Date');
      const callEditor = await service.revealRelationship(report, ...methodLink);
      assert.equal(callEditor.document.getText(callEditor.selection), 'jdbc.queryForObject');
      return { report, fieldLink };
    });
    relationship(initial.report, id + '.Request', id, 'associates', origin => origin.member === 'owner');
    relationship(initial.report, id, id + '.Request', 'uses', origin => origin.role === 'parameter');
    await assert.rejects(service.revealRelationship({ ...initial.report }, ...initial.fieldLink), /current Java class diagram/u);
    panel = service.showDiagram(initial.report, { focus:id });
    assert.equal(panel.viewType, 'rocketbrainJavaClassDiagram');
    assert.match(panel.webview.html, /Relationship source links/u);
    assert.match(panel.webview.html, /Field associations/u);
    assert.match(panel.webview.html, /Member dependencies/u);

    const first = original.indexOf('java.sql.Date'), edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(first), document.positionAt(first + 'java.sql.Date'.length)), 'java.util.Date');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    assert.equal(await document.save(), true);
    assert.equal((await fs.readFile(file, 'utf8')).replace(/\r\n/g, '\n'), changed);
    await assert.rejects(service.revealRelationship(initial.report, ...initial.fieldLink), /changed|Refresh/u);

    const fresh = await stableClasspath(async () => {
      const report = await service.refreshDiagram(initial.report);
      assert.ok(!report.edges.some(edge => edge.from === id && edge.to === 'java.sql.Date' && edge.kind === 'associates'));
      const link = relationship(report, id, 'java.util.Date', 'associates', field);
      const editor = await service.revealRelationship(report, ...link);
      assert.equal(editor.document.getText(editor.selection), 'Date');
      return report;
    });
    await service.exportMermaid(fresh, vscode.Uri.file(exportFile), { relationships:'associations' });
    const mermaid = await fs.readFile(exportFile, 'utf8');
    assert.match(mermaid, /--> Type\d+ : field type/u);
    assert.doesNotMatch(mermaid, /method call/u);
    const jdbc = await jdbcReadback();
    checks.push('The native Java class diagram resolved Spring JDBC member dependencies and field associations to exact source, rejected an outdated link after a saved import change, rebuilt the binding, and exported the selected Mermaid relationships.');
    return { associationBefore:'java.sql.Date', associationAfter:'java.util.Date', springCall:jdbcOwner + '#queryForObject',
      nativeDiagram:true, relationshipSource:true, staleLinkRefused:true, refreshed:true, associationExport:true, jdbc };
  } finally {
    panel?.dispose();
    if (document?.isDirty) await document.save();
    if (created) await fs.unlink(file);
    await fs.unlink(exportFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await fs.rmdir(temp);
  }
}

module.exports = { runJavaDiagramRelationshipChecks };
