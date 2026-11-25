'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');
const { branchFixture, verifyBranchReports } = require('./helpers/java-branch-coverage-fixture');

async function runJavaBranchCoverageChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api, workspace);
  const suffix = randomBytes(5).toString('hex');
  const names = { main: 'RbCoverageChoice' + suffix, junit: 'RbJunitCoverageChoice' + suffix, testng: 'RbTestngCoverageChoice' + suffix };
  const source = branchFixture('fixture.boot', names);
  const created = [];
  try {
    for (const [key, text] of Object.entries(source)) {
      const root = key === 'main' ? 'main' : 'test';
      const file = path.join(workspace, 'src', root, 'java', 'fixture', 'boot', names[key] + '.java');
      await fs.writeFile(file, text, { flag: 'wx' });
      created.push(file);
      await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    const runtime = await vscode.commands.executeCommand('rocketbrain.java.testing.install');
    assert.equal(runtime.jacocoVersion, '0.8.16');
    const tree = await api.javaTesting.discover();
    const uri = vscode.Uri.file(created[0]);
    const doc = await vscode.workspace.openTextDocument(uri);
    const details = {};
    for (const framework of ['junit', 'testng']) {
      const item = tree.tests.find(item => item.framework === framework && item.className === 'fixture.boot.' + names[framework] &&
        !item.methodName && item.kind === 'container');
      assert.ok(item, 'Find the ' + framework + ' class in the imported fixture.');
      const measured = await api.javaTesting.run({ includeIds: [item.nativeId], perTestCoverage: true, build: false });
      assert.equal(measured.state, 'completed');
      assert.equal(measured.sourceChanged, false);
      assert.equal(measured.projects[0].summary.testsSucceeded, 3);
      const report = verifyBranchReports(measured.projects[0], 'fixture/boot/' + names.main + '.java');
      assert.equal(typeof vscode.BranchCoverage, 'function');
      const range = ({ start, end }) => new vscode.Range(start.line, start.character, end.line, end.character);
      assert.equal(doc.getText(range(report.condition)), 'if (value < 4)');
      assert.deepEqual(report.aggregateArms.map(arm => doc.getText(range(arm.range))), ['return 10;', 'return 20;']);
      details[framework] = report;
    }
    const jdbc = await jdbcReadback();
    checks.push('The installed Java coverage profile matches precise terminal if/else ranges in compiled Spring sources across opposite JUnit and TestNG intervals.');
    return { springProject: true, nativeBranchRanges: true, jacoco: runtime.jacocoVersion, frameworks: details, jdbc };
  } finally {
    for (const file of created) await fs.rm(file, { force: true });
  }
}

module.exports = { runJavaBranchCoverageChecks };
