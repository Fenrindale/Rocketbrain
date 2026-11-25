'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout:delay } = require('node:timers/promises');

const kind = 'rocketbrain-sql-notebook';

async function until(predicate, description) {
  const deadline = Date.now() + 9000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('Timed out waiting for ' + description + '.');
    await delay(50);
  }
}

function output(cell, mime = 'text/plain') {
  const item = cell.outputs.flatMap(entry => entry.items).find(entry => entry.mime === mime);
  return item && Buffer.from(item.data).toString('utf8');
}

async function runSqlNotebookChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const config = JSON.parse(await fs.readFile(runtime.dbConfigPath, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(runtime.dbConfigPath), 'owner.json'), 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  const file = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'notebook-' + randomUUID() + '.rbsql');
  const uri = vscode.Uri.file(file);
  const shared = file.replace(/\.rbsql$/, '-shared.rbsql');
  const cells = [
    { type:'markdown', source:'### Server checks' },
    { type:'sql', source:"SELECT CAST('18446744073709551615' AS UNSIGNED) AS exact_id, NULL AS missing, '<b>표본</b>' AS caption;" },
    { type:'sql', source:'SELECT DATABASE() AS current_schema;' },
    { type:'sql', source:'DELETE FROM rocketbrain_unused_notebook_table WHERE 1 = 0;' },
    { type:'sql', source:'SELECT 404 AS should_not_run;' }
  ];
  const initial = JSON.stringify({ version:1, cells }) + '\n';
  await fs.writeFile(file, initial, { flag:'wx' });
  try {
    await api.connectMysql(config);
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    assert.equal(notebook.notebookType, kind);
    assert.equal(notebook.cellCount, cells.length);
    await vscode.window.showNotebookDocument(notebook, { preview:false });
    await vscode.commands.executeCommand('notebook.selectKernel', {
      id:'rocketbrain-sql-read', extension:'rocketbrain-local.rocketbrain'
    });
    const [note, first, second, refused, skipped] = notebook.getCells();
    await vscode.commands.executeCommand('notebook.execute', uri);
    await until(() => refused.executionSummary?.success === false, 'the read-only cell rejection');
    assert.equal(first.executionSummary.success, true);
    assert.equal(second.executionSummary.success, true);
    assert.deepEqual([first.executionSummary.executionOrder, second.executionSummary.executionOrder], [1, 2]);
    assert.match(output(first), /18446744073709551615/);
    assert.match(output(first, 'text/html'), /<em>NULL<\/em>.*&lt;b&gt;표본&lt;\/b&gt;/s);
    assert.ok(output(second).includes(config.database));
    assert.match(output(refused), /read.only/i);
    assert.equal(note.outputs.length, 0);
    assert.equal(skipped.outputs.length, 0);
    assert.equal(notebook.isDirty, false);
    assert.equal(await fs.readFile(file, 'utf8'), initial);
    assert.equal(await vscode.commands.executeCommand('rocketbrain.sqlNotebook.pinResult', first), true);
    assert.equal(await notebook.save(), true);
    const saved = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(saved.cells[1].result.rows, [['18446744073709551615', null, '<b>표본</b>']]);
    assert.equal(saved.cells.filter(cell => cell.result).length, 1);
    assert.ok(!Object.hasOwn(saved, 'connection'));
    await api.disconnectMysql();
    await fs.copyFile(file, shared, fs.constants.COPYFILE_EXCL);
    const reopened = await vscode.workspace.openNotebookDocument(vscode.Uri.file(shared));
    await vscode.window.showNotebookDocument(reopened, { preview:false });
    assert.match(output(reopened.cellAt(1)), /18446744073709551615/);
    assert.equal(reopened.cellAt(2).outputs.length, 0);
    assert.equal(await vscode.commands.executeCommand('rocketbrain.sqlNotebook.unpinResult', reopened.cellAt(1)), true);
    assert.equal(await reopened.save(), true);
    assert.deepEqual(JSON.parse(await fs.readFile(shared, 'utf8')).cells, cells);
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(8000) });
    assert.ok(response.ok);
    assert.deepEqual(await response.json(), { people:2, departments:1, rolledBackNames:0 });
    checks.push('Native notebook ran in document order and refused write SQL, then saved, reopened disconnected and removed the selected output.');
    return { engine:runtime.dbEngine, ran:2, refused:1, skippedAfterFailure:1, disconnectedReopen:true, pinnedExactlyOne:true,
      safeOutput:true, unpinned:true, externalStateUnchanged:true };
  } finally {
    await api.disconnectMysql();
    for (const artifact of [file, shared]) {
      await fs.unlink(artifact).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

module.exports = { runSqlNotebookChecks };
