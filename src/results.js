'use strict';
const crypto = require('node:crypto');
const { spreadsheetText } = require('./sql');
const { createResultExport } = require('./db/result-export');
class ResultsView {
  constructor(vscode, context, { editAction, resultClosed } = {}) { this.vscode = vscode; this.context = context; this.history = []; this.view = null; this.sequence = 0; this.editAction = editAction; this.resultClosed = resultClosed; }
  resolveWebviewView(view) {
    this.view = view;
    const v = this.vscode, root = v.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = crypto.randomBytes(18).toString('base64');
    const script = view.webview.asWebviewUri(v.Uri.joinPath(root, 'results.js'));
    const style = view.webview.asWebviewUri(v.Uri.joinPath(root, 'results.css'));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Query Results</title></head><body>
<header><div class="brand">QUERY RESULTS</div><div id="source">Offline demo · SQLite</div><span class="spacer"></span><label for="result-view">View</label><select id="result-view" disabled><option value="grid">Grid</option><option value="record">Record</option><option value="tree">Tree</option><option value="text">Text</option><option value="transpose">Transpose</option></select><button id="copy" disabled>Copy TSV</button><label for="export-format">Format</label><select id="export-format" disabled><option value="csv">CSV</option><option value="json">JSON</option><option value="xlsx">Excel XLSX</option><option value="insert">SQL INSERT</option></select><button id="export" disabled>Export CSV</button><button id="close-result">Close Result</button></header>
<nav id="tabs" aria-label="Query result history"></nav>
<div id="message" role="status" aria-live="polite">Run SQL from the editor with Ctrl+Enter.</div>
<section id="result-layout" aria-label="Result view options" hidden><div id="result-row-navigation" hidden><button id="result-row-previous">Previous Row</button><span id="result-row-status" role="status"></span><button id="result-row-next">Next Row</button></div><button id="result-columns" aria-expanded="false">Columns</button></section>
<section id="result-column-panel" aria-label="Result columns" hidden><div id="result-column-list"></div><button id="result-column-reset">Reset Columns</button></section>
<form id="insert-export" hidden><label>Table <input id="export-table" required maxlength="64" autocomplete="off" spellcheck="false"></label><label>Schema <input id="export-schema" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Optional"></label><label>Columns <input id="export-columns" autocomplete="off" spellcheck="false" placeholder="Optional JSON array in query order"></label><button type="submit">Save INSERT Script</button><button id="export-cancel" type="button">Cancel</button></form>
<section id="browse-tools" aria-label="Server table browsing" hidden><div class="browse-navigation"><button id="page-previous">Previous Page</button><span id="page-label"></span><button id="page-next">Next Page</button><label>Rows <select id="page-size" aria-label="Rows per page"><option>25</option><option>50</option><option>100</option><option selected>200</option><option>500</option></select></label><button id="browse-options" aria-expanded="false">Sort and Filter</button></div><form id="browse-form" hidden><div><strong>Sort columns</strong><div id="sort-rules"></div><button id="add-sort" type="button">Add Sort</button></div><div><strong>Filters (all must match)</strong><div id="filter-rules"></div><button id="add-filter" type="button">Add Filter</button></div><div class="browse-actions"><button id="apply-browse" type="submit">Apply Sort and Filters</button><button id="clear-browse" type="button">Clear Sort and Filters</button></div></form><div id="browse-status" role="status"></div></section>
<section id="edit-tools" aria-label="Table editing" hidden><button id="enable-edit">Enable Editing</button><button id="restore-browsing" title="Roll back this session and switch to read-only browsing. Commit first to keep applied changes." hidden>Roll Back and Browse</button><button id="add-row">Add Row</button><button id="paste-cells">Paste Cells</button><button id="import-text">Import CSV/TSV</button><button id="import-file">Choose CSV/TSV File</button><button id="import-xlsx">Choose XLSX File</button><button id="discard">Discard Draft</button><button id="review">Review SQL</button><button id="apply">Apply Reviewed Changes</button><button id="commit">Commit</button><button id="rollback">Roll Back</button><button id="reload">Reload</button><span id="draft-count"></span></section>
<div id="edit-status" role="status" aria-live="polite" hidden></div>
<section id="review-panel" aria-label="SQL change review" hidden><strong>Review SQL and bound values</strong><pre id="review-sql"></pre></section>
<form id="cell-editor" hidden><label id="cell-label" for="cell-value">Value</label><input id="cell-value" type="text" autocomplete="off" spellcheck="false"><label><input id="cell-null" type="checkbox">NULL</label><button type="submit">Stage Cell</button><button id="cancel-cell" type="button">Cancel</button></form>
<section id="bulk-panel" aria-label="Bulk table changes" hidden><form id="bulk-form"><strong id="bulk-title">Paste cells</strong><label id="bulk-format-label">Format <select id="bulk-delimiter"><option value="tab">TSV (tabs)</option><option value="comma">CSV (commas)</option></select></label><label id="bulk-header-label"><input type="checkbox" id="bulk-header" checked>First row contains column headers</label><div id="bulk-anchor"><label>Start row <select id="bulk-row"></select></label><label>Start column <select id="bulk-column"></select></label></div><div id="xlsx-options" hidden><label>Worksheet <select id="xlsx-sheet" aria-label="XLSX worksheet"></select></label><label>Formulas <select id="xlsx-formulas"><option value="reject">Reject formula cells</option><option value="cached">Use stored cached results (may be stale)</option></select></label><label>Absent or blank cells <select id="xlsx-blanks"><option value="empty">Empty text</option><option value="null">SQL NULL</option></select></label><p>Formulas are never evaluated. Only stored values are imported. Explicit empty strings stay text. Numeric XML values retain their stored precision; formatting is not imported. Date styles convert with the workbook date system; fractions truncate to microseconds and hidden nonzero time is retained.</p></div><label id="bulk-text-label" for="bulk-text">Text data</label><textarea id="bulk-text" rows="6" spellcheck="false" placeholder="Paste CSV or TSV text here"></textarea><label id="bulk-null-label"><input id="bulk-null-enabled" type="checkbox">Use an unquoted token for SQL NULL</label><input id="bulk-null-token" value="\\N" aria-label="SQL NULL token" maxlength="100"><div id="bulk-mapping"></div><div id="bulk-summary" role="status"></div><button id="bulk-inspect" type="button">Inspect Input and Map Columns</button><button id="bulk-stage" type="submit">Stage Bulk Changes</button><button id="bulk-cancel" type="button">Close</button></form></section>
<div id="grid" tabindex="0" aria-label="Database query results"></div><footer id="status">Ready</footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(async msg => {
      try {
      if (!msg || typeof msg.type !== 'string' || Buffer.byteLength(JSON.stringify(msg), 'utf8') > 1100000) return;
      if (msg.type === 'ready') { this.send(); return; }
      const record = this.history.find(h => h.id === msg.id);
      if (!record || msg.type !== 'closeResult' && !record.result) return;
      if (msg.type === 'closeResult') {
        if (record.editBusy || record.state === 'running' || record.closing) return;
        record.closing = true;
        try {
          if (this.pinned(record)) {
            const accepted = await v.window.showWarningMessage('Close this result and discard its local draft? Its database session and any applied transaction remain open. Use Manage Console Sessions to commit, roll back or close the connection. Interrupted writes remain unresolved.', { modal: true }, 'Close Result');
            if (accepted !== 'Close Result') return;
          }
          if (record.editBusy || record.state === 'running') return;
          this.history = this.history.filter(item => item !== record); this.resultClosed?.(record.id);
        } finally { record.closing = false; this.send(); }
      } else if(msg.type==='chooseImportFile'||msg.type==='chooseXlsxFile'){
        if(v.workspace?.isTrusted===false||record.readOnly||!record.result?.edit?.canEdit||record.hasDraft||record.review||record.editBusy)throw new Error('Enable editing and apply or discard existing drafts before choosing an import file.');
        const xlsx=msg.type==='chooseXlsxFile',sourceModel=record.result.edit.modelId,selected=await v.window.showOpenDialog({canSelectMany:false,filters:xlsx?{'Excel workbook':['xlsx']}:{'CSV or TSV text':['csv','tsv']},title:xlsx?'Choose an XLSX workbook to stage':'Choose a UTF-8 CSV or TSV file to stage'});
        if(selected?.length){if(record.result?.edit?.modelId!==sourceModel||record.hasDraft||record.review||record.closing)throw new Error('The table changed while choosing a file. Choose it again.');const uri=selected[0],fs=require('node:fs'),path=require('node:path');if(uri.scheme!=='file'||uri.authority)throw new Error('Choose a local import file.');const extension=path.extname(uri.fsPath).toLowerCase(),handle=fs.openSync(uri.fsPath,'r');let data;try{const stat=fs.fstatSync(handle),limit=xlsx?8*1024*1024:1024*1024;if(!stat.isFile()||stat.size>limit||!(xlsx?['.xlsx']:['.csv','.tsv']).includes(extension))throw new Error(xlsx?'Choose an ordinary XLSX file of at most 8 MiB. XLS and XLSM are not supported.':'Choose a CSV or TSV file of at most 1 MiB.');data=Buffer.alloc(limit+1);const size=fs.readSync(handle,data,0,data.length,0);if(size>limit)throw new Error('The import file exceeds its size limit.');data=data.subarray(0,size);}finally{fs.closeSync(handle);}await this.editAction?.(record.id,{type:xlsx?'inspectXlsx':'inspectBulk',modelId:sourceModel,...(xlsx?{buffer:data}:{text:new TextDecoder('utf-8',{fatal:true}).decode(data),delimiter:extension==='.tsv'?'\t':',',hasHeader:true}),label:path.basename(uri.fsPath),draftRevision:msg.draftRevision,requestId:msg.requestId});}
        else this.editState(record.id,{editResponseId:msg.requestId});
      } else if (['enableEdit', 'reviewChanges', 'applyChanges', 'commitChanges', 'rollbackChanges', 'reloadTable', 'browseTable', 'restoreBrowsing','inspectBulk','inspectXlsxSheet','prepareBulk', 'invalidateReview', 'draftChanged'].includes(msg.type)) {
        if (this.editAction) await this.editAction(record.id, msg);
      } else if (msg.type === 'export') {
        const result = record.result;
        const { data, label, extension } = this.exportSnapshot(record.id, msg.format, msg.destination);
        const target = await v.window.showSaveDialog({ defaultUri: v.Uri.file('query-results.' + extension), filters: { [label]: [extension] },
          title: 'Export the captured result rows and columns' });
        if (!target) return;
        if (record.result !== result || !this.exportable(record)) throw Error('The result changed while choosing a file. Choose it again.');
        await v.workspace.fs.writeFile(target, data);
      } else if (msg.type === 'copy') {
        if (!this.exportable(record)) throw Error('Select completed result rows and apply or discard drafts before copying.');
        const clean = value => spreadsheetText(value).replace(/[\t\r\n]/g, ' ');
        await v.env.clipboard.writeText([record.result.columns, ...record.result.rows].map(row => row.map(clean).join('\t')).join('\n'));
      }
      } catch (error) {if(['chooseImportFile','chooseXlsxFile'].includes(msg?.type))this.editState(msg.id,{editError:error.message||String(error),editResponseId:msg.requestId});v.window.showErrorMessage(`Rocketbrain: ${error instanceof Error ? error.message : String(error)}`); }
    }));
    view.onDidDispose(() => { this.view = null; });
    this.send();
  }
  async show() { await this.vscode.commands.executeCommand('rocketbrain.results.focus'); this.view?.show(true); }
  begin(sql, source, { readOnly = true, sessionId } = {}) {
    while (this.history.length >= 8) {
      const removable = this.history.findIndex(record => !this.pinned(record));
      if (removable < 0) throw new Error('All eight result tabs contain active editing, running work or unresolved outcomes. Finish the work or explicitly close a result before opening another.');
      const [removed] = this.history.splice(removable, 1); this.resultClosed?.(removed.id);
    }
    const record = { id: ++this.sequence, sql: sql.slice(0, 4000), source, state: 'running', readOnly, sessionId };
    this.history.push(record); this.send(); return record.id;
  }
  pinned(record) { return Boolean(record.state === 'running' || record.editBusy || record.hasDraft || record.review || record.result?.edit && !record.readOnly || record.sessionState?.outcomeUnknown); }
  exportable(record) {
    return Boolean(record?.state === 'done' && record.result?.columns.length && this.history.includes(record) && !record.closing &&
      !record.editBusy && !record.hasDraft && !record.review && !record.sessionState?.outcomeUnknown);
  }
  exportSnapshot(id, format, destination) {
    const record = this.history.find(item => item.id === id);
    if (!this.exportable(record)) throw Error('Select a completed result and apply or discard drafts before exporting.');
    return createResultExport(record.result, format, destination);
  }
  finish(id, result, error, sessionState) {
    const record = this.history.find(h => h.id === id);
    if (record) { record.state = error ? 'error' : 'done'; record.result = result; record.error = error; record.sessionState = sessionState || result?.state; this.send(); }
  }
  editState(id, patch) {
    const record = this.history.find(item => item.id === id);
    if (record) { Object.assign(record, patch); this.send(); }
  }
  send() { this.view?.webview.postMessage({ type: 'results', history: this.history }); }
}
module.exports = { ResultsView };
