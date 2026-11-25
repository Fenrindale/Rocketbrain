'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { until } = require('./helpers/stdio-lsp');
const { staticImportFixture } = require('./helpers/java-static-import-fixture');
const { problems } = require('../src/java/static-import');

async function runJavaStaticImportChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api, workspace);
  const folder = path.join(workspace, 'src/main/java/fixture/boot');
  const suffix = randomBytes(5).toString('hex'), owner = 'RbStaticOwner' + suffix;
  const ownerFile = path.join(folder, owner + '.java');
  const diagnostics = uri => vscode.languages.getDiagnostics(uri).filter(item =>
    item.source === 'Java' && problems.has(String(item.code?.value ?? item.code)));
  const service = api.javaSourceAnalysis, evidence = {};
  let createdOwner = false;
  try {
    for (const [kind, token, member, options] of [
      ['method', 'max', 'java.lang.Math.max', { fqn: 'java.lang.Math.max' }],
      ['field', 'MAX_VALUE', 'java.lang.Integer.MAX_VALUE', { fqn: 'java.lang.Integer.MAX_VALUE' }],
      ['explicit', 'RB_STATIC_LIMIT', 'fixture.boot.' + owner + '.RB_STATIC_LIMIT', { owner: 'fixture.boot.' + owner }]
    ]) {
      if (kind === 'explicit') {
        await fs.writeFile(ownerFile, 'package fixture.boot;\npublic class ' + owner +
          ' { public static final int RB_STATIC_LIMIT = 42; }\n', { flag: 'wx' });
        createdOwner = true;
        await vscode.workspace.openTextDocument(vscode.Uri.file(ownerFile));
      }
      const name = 'RbStaticImport' + kind + suffix;
      const file = path.join(folder, name + '.java'), uri = vscode.Uri.file(file);
      const source = staticImportFixture('fixture.boot', name, kind);
      let document, created = false;
      try {
        await fs.writeFile(file, source, { flag: 'wx' });
        created = true;
        document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
        const start = source.indexOf(token);
        const range = new vscode.Range(document.positionAt(start), document.positionAt(start + token.length));
        await until(() => diagnostics(uri).some(item => item.range.start.isEqual(range.start)), 65000);
        const actions = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, range, 'quickfix', 14);
        assert.ok(actions.some(action => action.command?.command === 'rocketbrain.java.addStaticMemberImport'));
        const seen = await service.inspectStaticMemberImport({ document, range });
        if (kind === 'explicit') assert.equal(seen.candidates.length, 0);
        else assert.ok(seen.candidates.includes(member), JSON.stringify(seen));
        if (kind === 'method') assert.ok(seen.candidates.includes('java.lang.StrictMath.max'), JSON.stringify(seen));
        await assert.rejects(service.prepareStaticMemberImport({ ...seen }, options), /known Java import candidate/);
        let plan, applied;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const inspected = attempt === 0 ? seen : await service.inspectStaticMemberImport({ document, range });
            plan = await service.prepareStaticMemberImport(inspected, options);
            assert.equal(plan.import.member, member);
            assert.equal(plan.import.occurrences, 2);
            assert.equal(plan.import.kind, kind === 'method' ? 'method' : 'field');
            assert.equal(plan.documents.length, 1);
            assert.equal(plan.documents[0].edits.length, 1);
            assert.equal(plan.documents[0].after.replace(plan.documents[0].edits[0].newText, ''), source);
            const preview = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/' + plan.id + '/0/after.java'));
            assert.equal(preview.getText().replace(/\r\n/g, '\n'), plan.documents[0].after.replace(/\r\n/g, '\n'));
            applied = await api.java.refactoring.apply(plan.id);
            break;
          } catch (error) {
            if (attempt === 2 || document.isDirty || !/Compiler classpath file membership changed|A compiler runtime or classpath changed|classpath changed/.test(error.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 650));
          }
        }
        assert.equal(applied?.state, 'applied');
        assert.match(document.getText(), /^import static /m);
        assert.equal(document.getText(), plan.documents[0].after);
        assert.equal(await fs.readFile(file, 'utf8'), source);
        await until(() => !diagnostics(uri).length, 55000);
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('undo');
        await until(() => !document.isDirty && document.getText() === source, 10000);
        evidence[kind] = { member, candidates: seen.candidates, uses: plan.import.occurrences, signatures: plan.import.signatures };
      } finally {
        try {
          if (document?.isDirty) {
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            await editor.edit(edit => edit.replace(new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), source));
            await document.save();
          }
        } finally { if (created) await fs.rm(file, { force: true }); }
      }
    }
    const jdbc = await jdbcReadback();
    checks.push('The installed Java quick fix imported reviewed static overloads, a JDK constant, and a manually selected workspace declaration while preserving existing imports and native Undo.');
    return { springWorkspace: true, jdbc, ...evidence, nativeCodeAction: true, guardedReview: true, nativeUndo: true, diskUnchanged: true };
  } finally { if (createdOwner) await fs.rm(ownerFile, { force: true }); }
}

module.exports = { runJavaStaticImportChecks };
