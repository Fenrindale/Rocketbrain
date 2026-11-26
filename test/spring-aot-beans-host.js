'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { createAotFixture, read } = require('./helpers/spring-aot-fixture');

async function runSpringAotChecks(api, vscode, checks) {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  assert.equal(workspace?.uri.scheme, 'file');
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.ok(['mysql', 'mariadb'].includes(engine));
  const database = await read(process.env.ROCKETBRAIN_MYSQL_TEST_CONFIG);
  const fixture = await createAotFixture({ parent: workspace.uri.fsPath,
    javaConfig: process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, gradleCache: process.env.ROCKETBRAIN_AOT_GRADLE_CACHE });
  const { aot } = api.springProjects;
  const { project, artifact } = fixture;
  const projectUri = vscode.Uri.file(project), artifactUri = vscode.Uri.file(artifact);
  try {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('rocketbrain.spring.inspectAotBeans'));
    assert.ok(commands.includes('rocketbrain.spring.openAotBeanSource'));

    await fixture.build('enabled');
    const before = aot.capture({ projectUri, artifactUri });
    assert.equal(before.unresolved.length, 0);
    assert.equal(before.executedProjectCode, false);
    assert.deepEqual(before.entries.find(row => row.name === 'fixedProbe').aliases, ['fixedAlias']);
    const report = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-spring-aot:/' + before.id + '.json'));
    assert.equal(JSON.parse(report.getText()).manifestSha256, before.manifestSha256);
    const editor = await aot.open({ id: before.id, name: 'activeProbe', which: 'factory' });
    assert.equal(editor.document.getText(editor.selection), 'activeProbe');
    const active = await fixture.run(engine, database, 'off');
    assert.equal(active.activeProbe, true);

    await fixture.build('off');
    const after = aot.capture({ projectUri, artifactUri });
    assert.equal(after.previousId, before.id);
    const diff = aot.compare({ beforeId: before.id, afterId: after.id });
    assert.deepEqual([diff.added, diff.removed, diff.changed], [[], ['activeProbe'], []]);
    assert.notEqual(diff.beforeSha256, diff.afterSha256);
    await assert.rejects(aot.open({ id: before.id, name: 'activeProbe' }), /source changed/u);
    const inactive = await fixture.run(engine, database, 'enabled');
    assert.equal(inactive.activeProbe, false);
    checks.push('The installed Spring AOT viewer compares real generated bean reports, opens the exact factory, and matches both real builds to Spring JDBC.');
    return { active, inactive, diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
      sourceNavigation: true, staleNavigationRefused: true, installedReportProvider: true };
  } finally {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const uri = tab.input?.uri;
      if (uri?.scheme !== 'file') return false;
      const relative = path.relative(project, uri.fsPath);
      return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
    });
    try {
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    } finally {
      await fixture.dispose();
    }
  }
}

module.exports = { runSpringAotChecks };
