'use strict';
const crypto = require('node:crypto');
const { spreadsheetText } = require('./sql');
const { createResultExport } = require('./db/result-export');
const { createResultLayouts, resultTableKey } = require('./db/result-layouts');
const { createResultFilters, filterName } = require('./db/result-filters');
const { analyzeResult, numericColumns } = require('./db/result-analysis');
const { mapResult, mapColumns } = require('./db/result-map');
const { compareDatasets: compareCaptures, selectUpdates } = require('./db/dataset-comparison');
const tabActions = new Set(['closeResult', 'renameResult', 'setResultPin']);
function resultName(value) {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Error('Enter a result name of at most 80 characters without line breaks or control characters.');
  }
  return value.trim();
}
class ResultsView {
  constructor(vscode, context, { editAction, relatedAction, relatedReturn, datasetAction, resultClosed } = {}) {
    this.vscode = vscode; this.context = context; this.history = []; this.view = null; this.sequence = 0;
    this.editAction = editAction; this.relatedAction = relatedAction; this.relatedReturn = relatedReturn; this.resultClosed = resultClosed;
    this.datasetAction = datasetAction;
    this.comparisons = new WeakMap();
    this.resultSequence = 0;
    this.layouts = createResultLayouts(context.workspaceState);
    this.filters = createResultFilters(context.workspaceState);
    this.layoutKeys = new WeakMap();
  }
  resolveWebviewView(view) {
    this.view = view;
    const v = this.vscode, root = v.Uri.joinPath(this.context.extensionUri, 'dist');
    view.webview.options = { enableScripts: true, localResourceRoots: [root] };
    const nonce = crypto.randomBytes(18).toString('base64');
    const script = view.webview.asWebviewUri(v.Uri.joinPath(root, 'results.js'));
    const style = view.webview.asWebviewUri(v.Uri.joinPath(root, 'results.css'));
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"><title>Query Results</title></head><body>
<header><div class="brand">QUERY RESULTS</div><div id="source">Offline demo · SQLite</div><span class="spacer"></span><label for="result-view">View</label><select id="result-view" disabled><option value="grid">Grid</option><option value="record">Record</option><option value="tree">Tree</option><option value="text">Text</option><option value="transpose">Transpose</option><option value="chart">Chart</option><option value="compare">Compare</option><option value="map" disabled>Map</option></select><button id="copy" disabled>Copy TSV</button><label for="export-format">Format</label><select id="export-format" disabled><option value="csv">CSV</option><option value="json">JSON</option><option value="xlsx">Excel XLSX</option><option value="insert">SQL INSERT</option><option value="extractor">Custom Extractor</option></select><button id="export" disabled>Export CSV</button><button id="pin-result" aria-pressed="false" disabled>Pin Result</button><button id="rename-result" disabled>Rename Result</button><button id="close-result">Close Result</button></header>
<nav id="tabs" aria-label="Query result history"></nav>
<button id="return-source-row" type="button" hidden>Back to Source Row</button>
<section id="script-result-sets" aria-label="Captured statement results" hidden><label>Statement result <select id="script-result-selection"></select></label><button id="open-script-statement" type="button">Open Captured Statement</button></section>
<div id="message" role="status" aria-live="polite">Run SQL from the editor with Ctrl+Enter.</div>
<section id="result-layout" aria-label="Result view options" hidden><div id="result-row-navigation" hidden><button id="result-row-previous">Previous Row</button><span id="result-row-status" role="status"></span><button id="result-row-next">Next Row</button></div><button id="result-columns" aria-expanded="false">Columns</button></section>
<section id="result-column-panel" aria-label="Result columns" hidden><div id="result-column-list"></div><button id="result-column-reset">Reset Columns</button></section>
<form id="insert-export" hidden><label>Table <input id="export-table" required maxlength="64" autocomplete="off" spellcheck="false"></label><label>Schema <input id="export-schema" maxlength="64" autocomplete="off" spellcheck="false" placeholder="Optional"></label><label>Columns <input id="export-columns" autocomplete="off" spellcheck="false" placeholder="Optional JSON array in query order"></label><button type="submit">Save INSERT Script</button><button id="export-cancel" type="button">Cancel</button></form>
<section id="browse-tools" aria-label="Server table browsing" hidden><div class="browse-navigation"><button id="page-previous">Previous Page</button><span id="page-label"></span><button id="page-next">Next Page</button><label>Rows <select id="page-size" aria-label="Rows per page"><option>25</option><option>50</option><option>100</option><option selected>200</option><option>500</option></select></label><button id="browse-options" aria-expanded="false">Sort and Filter</button></div><form id="browse-form" hidden><div><strong>Sort columns</strong><div id="sort-rules"></div><button id="add-sort" type="button">Add Sort</button></div><div id="filter-presets" class="browse-actions" hidden><label>Saved filter <select id="saved-filter" aria-label="Saved filter"></select></label><button id="load-filter" type="button">Load Filter</button><button id="save-filter" type="button">Save Applied Filters</button><button id="remove-filter" type="button">Remove Saved Filter</button></div><div id="column-search" class="browse-rule"><label>Search column <select id="browse-search-column"></select></label><input id="browse-search-text" aria-label="Column search value" type="text" autocomplete="off" spellcheck="false"><button id="browse-search-add" type="button">Add Search Rule</button></div><div><strong>Filters (top-level conditions all match)</strong><div id="filter-rules"></div><div class="browse-actions"><button id="add-filter" type="button">Add Filter</button><button id="add-filter-group" type="button">Add Filter Group</button></div></div><div class="browse-actions"><button id="apply-browse" type="submit">Apply Sort and Filters</button><button id="clear-browse" type="button">Clear Sort and Filters</button></div></form><div id="browse-status" role="status"></div></section>
<section id="edit-tools" aria-label="Table editing" hidden><button id="enable-edit">Enable Editing</button><button id="restore-browsing" title="Roll back this session and switch to read-only browsing. Commit first to keep applied changes." hidden>Roll Back and Browse</button><button id="add-row">Add Row</button><button id="paste-cells">Paste Cells</button><button id="import-text">Import CSV/TSV</button><button id="import-file">Choose CSV/TSV File</button><button id="import-xlsx">Choose XLSX File</button><button id="discard">Discard Draft</button><button id="review">Review SQL</button><button id="apply">Apply Reviewed Changes</button><button id="commit">Commit</button><button id="rollback">Roll Back</button><button id="reload">Reload</button><span id="draft-count"></span></section>
<div id="edit-status" role="status" aria-live="polite" hidden></div>
<section id="review-panel" aria-label="SQL change review" hidden><strong>Review SQL and bound values</strong><pre id="review-sql"></pre></section>
<form id="cell-editor" hidden><label id="cell-label" for="cell-value">Value</label><label id="cell-format-label">Format <select id="cell-format"></select></label><label><input id="cell-null" type="checkbox">SQL NULL</label><textarea id="cell-value" rows="5" autocomplete="off" spellcheck="false" aria-describedby="cell-hint cell-error"></textarea><div id="cell-hint"></div><div id="cell-error" role="alert" hidden></div><button type="submit">Stage Cell</button><button id="cancel-cell" type="button">Cancel</button></form>
<section id="bulk-panel" aria-label="Bulk table changes" hidden><form id="bulk-form"><strong id="bulk-title">Paste cells</strong><label id="bulk-format-label">Format <select id="bulk-delimiter"><option value="tab">TSV (tabs)</option><option value="comma">CSV (commas)</option></select></label><label id="bulk-header-label"><input type="checkbox" id="bulk-header" checked>First row contains column headers</label><div id="bulk-anchor"><label>Start row <select id="bulk-row"></select></label><label>Start column <select id="bulk-column"></select></label></div><div id="xlsx-options" hidden><label>Worksheet <select id="xlsx-sheet" aria-label="XLSX worksheet"></select></label><label>Formulas <select id="xlsx-formulas"><option value="reject">Reject formula cells</option><option value="cached">Use stored cached results (may be stale)</option></select></label><label>Absent or blank cells <select id="xlsx-blanks"><option value="empty">Empty text</option><option value="null">SQL NULL</option></select></label><p>Formulas are never evaluated. Only stored values are imported. Explicit empty strings stay text. Numeric XML values retain their stored precision; formatting is not imported. Date styles convert with the workbook date system; fractions truncate to microseconds and hidden nonzero time is retained.</p></div><label id="bulk-text-label" for="bulk-text">Text data</label><textarea id="bulk-text" rows="6" spellcheck="false" placeholder="Paste CSV or TSV text here"></textarea><label id="bulk-null-label"><input id="bulk-null-enabled" type="checkbox">Use an unquoted token for SQL NULL</label><input id="bulk-null-token" value="\\N" aria-label="SQL NULL token" maxlength="100"><div id="bulk-mapping"></div><div id="bulk-summary" role="status"></div><button id="bulk-inspect" type="button">Inspect Input and Map Columns</button><button id="bulk-stage" type="submit">Stage Bulk Changes</button><button id="bulk-cancel" type="button">Close</button></form></section>
<section id="chart-tools" aria-label="Captured result analysis" hidden><label>Plot <select id="chart-shape"><option value="bar">Columns</option><option value="line">Line</option></select></label><label>Category <select id="chart-category"></select></label><label>Aggregate <select id="chart-operation"><option value="count">Count rows</option><option value="nonnull">Count non-NULL values</option><option value="values">Numeric values (one point per row)</option><option value="sum">Sum</option><option value="average">Average</option><option value="min">Minimum</option><option value="max">Maximum</option></select></label><label>Measure <select id="chart-measure"></select></label><button id="chart-export" disabled>Export Chart Data</button><div id="chart-status" role="status"></div></section>
<section id="compare-tools" aria-label="Compare captured results" hidden><div class="compare-top"><label>Source result <select id="compare-source"></select></label><button id="compare-add" type="button">Add Column Pair</button><button id="compare-run" type="button">Compare Captured Rows</button><button id="compare-stage" type="button" disabled>Stage Selected Updates</button></div><div id="compare-mappings"></div><div id="compare-status" role="status"></div></section>
<div id="grid" tabindex="0" aria-label="Database query results"></div><footer id="status">Ready</footer><script nonce="${nonce}" src="${script}"></script></body></html>`;
    this.context.subscriptions.push(view.webview.onDidReceiveMessage(async msg => {
      try {
      if (!msg || typeof msg.type !== 'string' || Buffer.byteLength(JSON.stringify(msg), 'utf8') > 1100000) return;
      if (msg.type === 'ready') { this.send(); return; }
      const record = this.history.find(h => h.id === msg.id);
      if (!record || (!record.result && !tabActions.has(msg.type))) return;
      if (msg.type === 'closeResult') {
        if (record.editBusy || record.state === 'running' || record.closing) return;
        record.closing = true;
        try {
          if (this.protectedResult(record)) {
            const accepted = await v.window.showWarningMessage('Close this result and discard its local draft? Its database session and any applied transaction remain open. Use Manage Console Sessions to commit, roll back or close the connection. Interrupted writes remain unresolved.', { modal: true }, 'Close Result');
            if (accepted !== 'Close Result') return;
          } else if (record.tabPinned) {
            const choice = await v.window.showWarningMessage('Close this pinned result and remove its retained preview?', { modal: true }, 'Close Result');
            if (choice !== 'Close Result') return;
          }
          if (record.editBusy || record.state === 'running') return;
          this.history = this.history.filter(item => item !== record); this.resultClosed?.(record.id);
        } finally { record.closing = false; this.send(); }
      } else if (msg.type === 'setResultPin') {
        if (typeof msg.pinned !== 'boolean') throw Error('Choose whether to pin the current result.');
        this.setResultTab(record.id, { pinned: msg.pinned });
      } else if (msg.type === 'renameResult') {
        const name = await v.window.showInputBox({ title: 'Rename query result', value: record.tabName || '',
          placeHolder: 'Leave blank to restore the default name', ignoreFocusOut: true, validateInput(value) {
            try { resultName(value); } catch (error) { return error.message; }
          } });
        if (name !== undefined) this.setResultTab(record.id, { name });
      } else if (msg.type === 'openScriptStatement') {
        if (!Number.isInteger(msg.index) || !record.result.scriptStatements?.some(statement => statement.index === msg.index)) {
          throw Error('Choose a retained statement from this script run.');
        }
        await v.commands.executeCommand('rocketbrain.sql.openScriptResult', { resultId: record.id, index: msg.index });
      } else if (msg.type === 'saveFilterPreset') {
        if (typeof msg.modelId !== 'string' || !this.filterRecord(record.id, msg.modelId)) throw Error('Choose the current named table and its applied filters.');
        const name = await v.window.showInputBox({ title: 'Save the applied table filters', value: typeof msg.name === 'string' ? msg.name : '',
          ignoreFocusOut: true, validateInput(value) { try { filterName(value); } catch (error) { return error.message; } } });
        if (name !== undefined) await this.saveFilterPreset(record.id, msg.modelId, name);
      } else if (msg.type === 'removeFilterPreset') {
        await this.removeFilterPreset(record.id, msg.modelId, msg.name);
      } else if(msg.type==='chooseImportFile'||msg.type==='chooseXlsxFile'){
        if(v.workspace?.isTrusted===false||record.readOnly||!record.result?.edit?.canEdit||record.hasDraft||record.review||record.editBusy)throw new Error('Enable editing and apply or discard existing drafts before choosing an import file.');
        const xlsx=msg.type==='chooseXlsxFile',sourceModel=record.result.edit.modelId,selected=await v.window.showOpenDialog({canSelectMany:false,filters:xlsx?{'Excel workbook':['xlsx']}:{'CSV or TSV text':['csv','tsv']},title:xlsx?'Choose an XLSX workbook to stage':'Choose a UTF-8 CSV or TSV file to stage'});
        if(selected?.length){if(record.result?.edit?.modelId!==sourceModel||record.hasDraft||record.review||record.closing)throw new Error('The table changed while choosing a file. Choose it again.');const uri=selected[0],fs=require('node:fs'),path=require('node:path');if(uri.scheme!=='file'||uri.authority)throw new Error('Choose a local import file.');const extension=path.extname(uri.fsPath).toLowerCase(),handle=fs.openSync(uri.fsPath,'r');let data;try{const stat=fs.fstatSync(handle),limit=xlsx?8*1024*1024:1024*1024;if(!stat.isFile()||stat.size>limit||!(xlsx?['.xlsx']:['.csv','.tsv']).includes(extension))throw new Error(xlsx?'Choose an ordinary XLSX file of at most 8 MiB. XLS and XLSM are not supported.':'Choose a CSV or TSV file of at most 1 MiB.');data=Buffer.alloc(limit+1);const size=fs.readSync(handle,data,0,data.length,0);if(size>limit)throw new Error('The import file exceeds its size limit.');data=data.subarray(0,size);}finally{fs.closeSync(handle);}await this.editAction?.(record.id,{type:xlsx?'inspectXlsx':'inspectBulk',modelId:sourceModel,...(xlsx?{buffer:data}:{text:new TextDecoder('utf-8',{fatal:true}).decode(data),delimiter:extension==='.tsv'?'\t':',',hasHeader:true}),label:path.basename(uri.fsPath),draftRevision:msg.draftRevision,requestId:msg.requestId});}
        else this.editState(record.id,{editResponseId:msg.requestId});
      } else if (['enableEdit', 'reviewChanges', 'applyChanges', 'commitChanges', 'rollbackChanges', 'reloadTable', 'browseTable', 'restoreBrowsing','inspectBulk','inspectXlsxSheet','prepareBulk', 'invalidateReview', 'draftChanged'].includes(msg.type)) {
        if (this.editAction) await this.editAction(record.id, msg);
      } else if (msg.type === 'saveLayout') {
        await this.saveLayout(record.id, msg.modelId, msg.columns);
      } else if (msg.type === 'openRelatedRows') {
        await this.relatedAction?.(record.id, { modelId:msg.modelId, rowId:msg.rowId });
      } else if (msg.type === 'returnToRelatedSource') {
        await this.relatedReturn?.(record.id);
      } else if (msg.type === 'analyzeResult') {
        const response = { type: 'resultAnalysis', id: record.id, revision: msg.revision, requestId: msg.requestId };
        try { response.analysis = this.analyzeSnapshot(record.id, msg.options, msg.revision); }
        catch (error) { response.error = error.message || String(error); }
        await view.webview.postMessage(response);
      } else if (msg.type === 'mapResult') {
        const response = { type: 'resultMap', id: record.id, revision: msg.revision, requestId: msg.requestId };
        try { response.map = this.mapSnapshot(record.id, msg.column, msg.revision); }
        catch (error) { response.error = error.message || String(error); }
        await view.webview.postMessage(response);
      } else if (msg.type === 'compareDatasets') {
        const response = { type: 'datasetComparison', id: record.id, requestId: msg.requestId };
        try { response.comparison = this.compareDatasets(record.id, msg.sourceId, msg.mapping, {
          target: msg.targetRevision, source: msg.sourceRevision
        }); }
        catch (error) { response.error = error.message || String(error); }
        await view.webview.postMessage(response);
      } else if (msg.type === 'stageDatasetComparison') {
        try { await this.stageDatasetComparison(record.id, msg); }
        catch (error) {
          this.editState(record.id, { editResponseId: msg.requestId });
          await view.webview.postMessage({ type: 'datasetStageError', id: record.id, error: error.message || String(error) });
        }
      } else if (msg.type === 'exportAnalysis') {
        const analysis = this.analyzeSnapshot(record.id, msg.options, msg.revision);
        const target = await v.window.showSaveDialog({ defaultUri: v.Uri.file('query-analysis.json'), filters: { JSON: ['json'] },
          title: 'Export captured result chart data' });
        if (!target) return;
        if (!this.exportable(record) || record.chart.revision !== msg.revision) throw Error('The result changed while choosing a file. Choose it again.');
        await v.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(analysis, null, 2) + '\n', 'utf8'));
      } else if (msg.type === 'export') {
        if (msg.format === 'extractor') {
          if (!this.exportable(record)) throw Error('Select completed result rows before running an extractor.');
          await v.commands.executeCommand('rocketbrain.db.exportWithExtractor', record.id);
          return;
        }
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
  begin(sql, source, { readOnly = true, sessionId, tableLayoutConnection, table, scriptCapture, relatedOrigin } = {}) {
    while (this.history.length >= 8) {
      const removable = this.history.findIndex(record => record.id !== relatedOrigin?.id && !record.closing && !record.tabPinned && !this.protectedResult(record));
      if (removable < 0) throw new Error('All eight result tabs are pinned or contain active work. Unpin or close a result before opening another.');
      const [removed] = this.history.splice(removable, 1); this.resultClosed?.(removed.id);
    }
    const record = { id: ++this.sequence, sql: sql.slice(0, 4000), source, state: 'running', readOnly, sessionId };
    if (scriptCapture) record.scriptCapture = scriptCapture;
    if (relatedOrigin) record.relatedOrigin = relatedOrigin;
    const key = resultTableKey(tableLayoutConnection, table);
    if (key) this.layoutKeys.set(record, { key, table });
    this.history.push(record); this.send(); return record.id;
  }
  protectedResult(record) { return Boolean(record.state === 'running' || record.editBusy || record.hasDraft || record.review || record.result?.edit && !record.readOnly || record.sessionState?.outcomeUnknown); }
  setResultTab(id, { name, pinned } = {}) {
    const record = this.history.find(item => item.id === id);
    if (!record || record.closing || record.state === 'running' || record.editBusy) throw Error('Choose a completed result tab.');
    const normalizedName = name === undefined ? undefined : resultName(name);
    if (pinned !== undefined && typeof pinned !== 'boolean') throw Error('Choose whether to pin the current result.');
    if (normalizedName !== undefined) record.tabName = normalizedName || undefined;
    if (pinned !== undefined) record.tabPinned = pinned || undefined;
    this.send();
    return { id, name: record.tabName, pinned: record.tabPinned === true };
  }
  hasResult(id) { return this.history.some(record => record.id === id); }
  findStatement(resultId, index) {
    return this.history.find(record => !record.closing && record.scriptCapture?.resultId === resultId && record.scriptCapture.index === index)?.id;
  }
  activateResult(id, selection) {
    if (this.hasResult(id)) return this.view?.webview.postMessage({ type: 'activateResult', id,
      ...(selection ? { modelId: selection.modelId, rowId: selection.rowId } : {}) });
  }
  exportable(record) {
    return Boolean(record?.state === 'done' && record.result?.columns.length && this.history.includes(record) && !record.closing &&
      !record.editBusy && !record.hasDraft && !record.review && !record.sessionState?.outcomeUnknown);
  }
  exportSnapshot(id, format, destination) {
    const record = this.history.find(item => item.id === id);
    if (!this.exportable(record)) throw Error('Select a completed result and apply or discard drafts before exporting.');
    return createResultExport(record.result, format, destination);
  }
  analyzeSnapshot(id, options, revision) {
    const record = this.history.find(item => item.id === id);
    if (!this.exportable(record) || (revision !== undefined && record.chart?.revision !== revision)) {
      throw Error('Choose a current captured result and apply or discard drafts before analysis.');
    }
    return analyzeResult(record.result, options);
  }
  mapSnapshot(id, column, revision) {
    const record = this.history.find(item => item.id === id);
    if (!this.exportable(record) || (revision !== undefined && record.chart?.revision !== revision)) {
      throw Error('Choose the current captured result and apply or discard drafts before opening its map.');
    }
    return mapResult(record.result, column);
  }
  compareDatasets(targetId, sourceId, mapping, revisions = {}) {
    const target = this.history.find(record => record.id === targetId);
    const source = this.history.find(record => record.id === sourceId);
    if (source === target || ![target, source].every(record => this.exportable(record)) ||
        (revisions.target !== undefined && revisions.target !== target.chart.revision) ||
        (revisions.source !== undefined && revisions.source !== source.chart.revision)) {
      throw Error('Choose two current completed results and apply or discard drafts before comparing.');
    }
    const comparison = compareCaptures(target.result, source.result, mapping);
    const reviewId = crypto.randomUUID();
    this.comparisons.set(target, { reviewId, comparison, source, sourceResult: source.result, targetResult: target.result });
    return { ...comparison.report, reviewId, sourceId, sourceRevision: source.chart.revision, targetRevision: target.chart.revision };
  }
  async stageDatasetComparison(id, { reviewId, rows, modelId, draftRevision, requestId } = {}) {
    const target = this.history.find(record => record.id === id);
    const saved = this.comparisons.get(target);
    if (!saved || saved.reviewId !== reviewId || !this.exportable(target)) {
      throw Error('Compare the current destination and source before staging changes.');
    }
    const assertFresh = () => {
      if (this.comparisons.get(target) !== saved || !this.exportable(saved.source) || saved.source.result !== saved.sourceResult ||
          saved.source.sessionState?.inTransaction || !this.history.includes(target) ||
          target.result !== saved.targetResult || target.hasDraft || target.review || target.closing) {
        throw Error('The compared results or their drafts changed. Compare again using a committed source capture.');
      }
    };
    assertFresh();
    if (!this.datasetAction) throw Error('Open an editable table to stage synchronization.');
    const changes = selectUpdates(saved.comparison, rows);
    await this.datasetAction(id, { changes, modelId, draftRevision, requestId, assertFresh });
    if (this.comparisons.get(target) === saved) this.comparisons.delete(target);
  }
  layoutKey(record) {
    if (this.vscode.workspace?.isTrusted === false || !this.layouts.available || !record?.result?.edit) return undefined;
    const layout = this.layoutKeys.get(record);
    return layout && layout.table === record.result.edit.table ? layout.key : undefined;
  }
  savedLayout(id) {
    const record = this.history.find(item => item.id === id), key = this.layoutKey(record);
    return key ? structuredClone(this.layouts.read(key)) : undefined;
  }
  async saveLayout(id, modelId, columns) {
    const record = this.history.find(item => item.id === id), key = this.layoutKey(record);
    if (!key || record.closing || record.result.edit.modelId !== modelId) throw Error('Open the current table preview before saving columns.');
    await this.layouts.write(key, columns, record.result.columns);
    this.send();
  }
  filterRecord(id, modelId) {
    const record = this.history.find(item => item.id === id), result = record?.result;
    const key = this.layoutKey(record);
    if (!key || !result.browse || record.closing || record.editBusy || (modelId !== undefined && result.edit.modelId !== modelId)) return undefined;
    return { key, result, columns: result.edit.columns };
  }
  savedFilters(id) {
    const entry = this.filterRecord(id);
    return entry ? this.filters.list(entry.key, entry.columns) : [];
  }
  async saveFilterPreset(id, modelId, name) {
    const entry = this.filterRecord(id, modelId);
    if (typeof modelId !== 'string' || !entry) throw Error('Choose the current table preview before saving its filters.');
    await this.filters.save(entry.key, name, entry.result.browse.filters, entry.columns);
    this.send();
  }
  async removeFilterPreset(id, modelId, name) {
    const entry = this.filterRecord(id, modelId);
    if (typeof modelId !== 'string' || !entry) throw Error('Choose the current table preview before removing saved filters.');
    await this.filters.remove(entry.key, name);
    this.send();
  }
  finish(id, result, error, sessionState) {
    const record = this.history.find(h => h.id === id);
    if (record) {
      record.state = error ? 'error' : 'done';
      record.result = result;
      record.error = error;
      record.sessionState = sessionState || result?.state;
      record.chart = result?.columns?.length ? { revision: ++this.resultSequence, numeric: numericColumns(result) } : undefined;
      record.mapColumns = mapColumns(result);
      this.send();
    }
  }
  editState(id, patch) {
    const record = this.history.find(item => item.id === id);
    if (record) { Object.assign(record, patch); this.send(); }
  }
  send() {
    if (!this.view) return;
    const history = this.history.map(record => {
      const { spatial, ...result } = record.result || {};
      if (spatial) record = { ...record, result };
      const key = this.layoutKey(record);
      return key ? { ...record, tableLayout: { columns: this.layouts.read(key) || [] },
        ...(record.result.browse && { filterPresets: this.filters.list(key, record.result.edit.columns) }) } : record;
    });
    this.view.webview.postMessage({ type: 'results', history });
  }
}
module.exports = { ResultsView };
