'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { jdbcReadback } = require('./java-source-analysis-host');

async function runDependencyAdvisoryChecks(api, vscode, checks) {
  const service = api.java.dependencyAdvisories;
  assert.ok(service?.resolveTree);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.mavenAdvisories'));
  const [workspace] = vscode.workspace.workspaceFolders || [];
  assert.equal(workspace?.uri.scheme, 'file');
  const fixture = await fs.mkdtemp(path.join(workspace.uri.fsPath, 'rb-maven-advisories-'));
  await fs.copyFile(path.join(__dirname, 'fixtures/maven-advisories/pom.xml'), path.join(fixture, 'pom.xml'));
  const uri = vscode.Uri.file(fixture);
  await assert.rejects(service.resolveTree(uri), /start dependency resolution explicitly/);
  const tree = await service.resolveTree(uri, { allowProjectExecution: true });
  const core = 'org.apache.logging.log4j:log4j-core@2.14.1';
  const transitive = 'org.apache.logging.log4j:log4j-api@2.14.1';
  assert.ok(tree.packages.some(item => item.key === core && item.direct));
  assert.ok(tree.packages.some(item => item.key === transitive && !item.direct && item.paths[0].includes(core)));
  assert.throws(() => service.audit(tree, [core, transitive]), /versions to send to OSV/);
  const report = await service.audit(tree, [core, transitive], { allowLookup: true });
  assert.ok(report.packages[0].advisories.includes('GHSA-jfh8-c2jp-5v3q'));
  assert.ok(report.packages[0].complete);
  const document = await vscode.workspace.openTextDocument(await service.publish(report));
  assert.match(document.getText(), /Maven dependency advisories/);
  assert.match(document.getText(), /https:\/\/osv\.dev\/vulnerability\/GHSA-jfh8-c2jp-5v3q/);
  const jdbc = await jdbcReadback();
  checks.push('The installed workspace resolved a real Maven tree, queried explicitly selected public versions, and opened OSV results with exact paths.');
  return { directResolved: true, transitiveResolved: true, liveOsv: true, nativeReport: true, jdbc };
}

module.exports = { runDependencyAdvisoryChecks };
