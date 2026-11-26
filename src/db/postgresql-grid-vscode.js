'use strict';

const { randomBytes } = require('node:crypto');

function escape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function cell(value) { return value === null ? 'SQL NULL' : JSON.stringify(value); }

function gridHtml(grid, nonce) {
  const titles = grid.columns.map(({ name, type }, index) =>
    '<th scope="col">' + escape(name) + '<small>' + escape(type) + (index === 0 ? ' · primary key' : '') + '</small></th>').join('');
  const rows = grid.rows.map((row, line) => '<tr>' + row.values.map((value, field) => {
    const display = escape(value === null ? 'NULL' : value.slice(0, 240) + (value.length > 240 ? '…' : ''));
    return field === 0 ? '<th scope="row">' + display + '</th>' :
      '<td><button type="button" data-row="' + line + '" data-field="' + field + '" aria-label="' +
      escape('Edit ' + grid.columns[field].name + ' for key ' + row.values[0] + ', current value ' + (value === null ? 'SQL NULL' : value.slice(0, 80))) +
      '">' + (display || '<i>empty</i>') + '</button></td>';
  }).join('') + '</tr>').join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:1rem}
table{border-collapse:collapse}th,td{border:1px solid var(--vscode-panel-border);text-align:left;padding:.25rem .5rem}
small{display:block;color:var(--vscode-descriptionForeground);white-space:nowrap}
button{font:inherit;display:block;max-width:30rem;text-overflow:ellipsis;overflow:hidden;white-space:pre;
border:1px solid transparent;background:none;color:inherit;text-align:left;cursor:pointer;padding:.15rem}
button:hover{border-color:var(--vscode-focusBorder)}button:focus-visible{outline:2px solid var(--vscode-focusBorder)}
.viewport{overflow:auto}
</style></head><body>
<h1>${escape(grid.schema)}.${escape(grid.table)}</h1>
<p>Choose an integer or text cell to review a single-row change. ${grid.truncated ? 'Showing the first 100 rows. ' : ''}
The key and the displayed original value are part of the review.</p>
<p id="status" aria-live="polite"></p>
<div class="viewport"><table><thead><tr>${titles}</tr></thead><tbody>${rows}</tbody></table></div>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi();
document.addEventListener('click',event=>{
  const button=event.target.closest('button[data-row]');
  if(button&&!button.disabled) vscode.postMessage({type:'edit',row:Number(button.dataset.row),field:Number(button.dataset.field)});
});
window.addEventListener('message',event=>{
  if(event.data?.type!=='completed')return;
  for(const button of document.querySelectorAll('button')) button.disabled=true;
  document.getElementById('status').textContent=event.data.message;
});
</script></body></html>`;
}

async function openPostgreSqlGrid({ vscode, api, progress, table }) {
  if (!api.supportsPostgreSqlGrid()) throw Error('Open a PostgreSQL profile approved for reviewed cell edits.');
  if (table === undefined) {
    const items = api.catalog().objects.filter(item => ['TABLE', 'BASE TABLE'].includes(item.kind))
      .map(item => ({ label: item.name, description: item.schema }));
    const selected = await vscode.window.showQuickPick(items, { title: 'Choose an Observed PostgreSQL Table' });
    if (!selected) return;
    table = selected.label;
  }
  const grid = await progress('Reading PostgreSQL Grid', signal => api.previewPostgreSqlGrid(table, { signal }));
  const panel = vscode.window.createWebviewPanel('rocketbrain.postgresqlGrid', 'PostgreSQL · ' + grid.table, vscode.ViewColumn.Active,
    { enableScripts: true, localResourceRoots: [] });
  panel.webview.html = gridHtml(grid, randomBytes(24).toString('base64'));
  let editing = false, open = true;
  const receiver = panel.webview.onDidReceiveMessage(async message => {
    if (!open || editing || message?.type !== 'edit' || !Number.isInteger(message.row) || !Number.isInteger(message.field) ||
        message.field < 1 || !grid.rows[message.row] || !grid.columns[message.field]) return;
    editing = true;
    try {
      const previous = grid.rows[message.row].values[message.field], field = grid.columns[message.field];
      const action = field.nullable ? await vscode.window.showQuickPick(['Enter value', 'Set SQL NULL'], { title: 'Edit PostgreSQL Cell' }) : 'Enter value';
      if (!action || !open) return;
      const value = action === 'Set SQL NULL' ? null : await vscode.window.showInputBox({ title: 'New ' + field.name + ' Value',
        value: previous?.includes('\n') || previous?.includes('\r') ? '' : previous ?? '', ignoreFocusOut: true, prompt: field.type });
      if (value === undefined || !open) return;
      const edit = api.preparePostgreSqlGridEdit(grid.id, message.row, message.field, value);
      const button = 'Commit One Cell';
      const accepted = await vscode.window.showWarningMessage('Commit this exact PostgreSQL cell change?',
        { modal: true, detail: [edit.database + '.' + edit.schema + '.' + edit.table, edit.identity.column + ' = ' + edit.identity.value,
          edit.column.name + ' before  ' + cell(edit.original), edit.column.name + ' after  ' + cell(edit.replacement)].join('\n') }, button);
      if (accepted !== button || !open) return;
      try {
        await progress('Committing PostgreSQL Cell', signal => api.applyPostgreSqlGridEdit(edit.id, true, { signal }));
        if (open) await panel.webview.postMessage({ type: 'completed', message: 'Committed. Reopen the grid to see the current row.' });
      } catch (cause) {
        if (open) await panel.webview.postMessage({ type: 'completed', message: 'Reopen the grid and confirm the current row.' });
        throw cause;
      }
    } catch (cause) {
      void vscode.window.showErrorMessage('Rocketbrain PostgreSQL: ' + cause.message);
    } finally { editing = false; }
  });
  const stop = panel.onDidDispose(() => { open = false; receiver.dispose(); stop.dispose(); });
  return grid;
}

module.exports = { gridHtml, openPostgreSqlGrid };
