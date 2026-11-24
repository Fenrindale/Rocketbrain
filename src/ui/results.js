'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  let history = [], currentId = null, editingCell = null, requestSequence = 0;
  const drafts = new Map(), browseForms = new Map(),bulkForms=new Map(), layouts = new Map();
  const charts = new Map();
  const viewModes = ['grid', 'record', 'tree', 'text', 'transpose', 'chart'];
  const editableModes = new Set(['grid', 'record']);
  let insertExport;
  let chartObserver;
  const savedLayouts = new Map(vscode.getState?.()?.layouts || []);
  for (const [id, item] of vscode.getState?.()?.drafts || []) drafts.set(id, { ...item, updates: new Map(item.updates), deletes: new Set(item.deletes) });
  const $ = id => document.getElementById(id);
  function options(control, values, selected) {
    control.replaceChildren(...values.map(({ value, label }) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }));
    control.value = selected ?? '';
  }
  const text = value => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : Object.is(value, -0) ? '-0' : String(value);
  const current = () => history.find(row => row.id === currentId) || history.at(-1);
  function draft(record) {
    const key = record.result?.edit?.modelId;
    let item = drafts.get(record.id);
    if (!item || item.modelId !== key || item.lastApplied !== record.lastAppliedReviewId) {
      item = { modelId: key, lastApplied: record.lastAppliedReviewId, updates: new Map(), deletes: new Set(), inserts: [], next: 0, revision: 0 };
      drafts.set(record.id, item);
    }
    if (item.pendingRequestId && record.editResponseId === item.pendingRequestId) item.pendingRequestId = undefined;
    return item;
  }
  function persist() {
    const layoutState = [...layouts].map(([id, layout]) => [id, { ...layout, hidden: [...layout.hidden], pinned: [...layout.pinned] }]);
    vscode.setState?.({ drafts: [...drafts].map(([id, item]) => [id, { ...item, updates: [...item.updates], deletes: [...item.deletes] }]),
      layouts: layoutState });
  }
  const count = item => [...item.updates.keys()].filter(id => !item.deletes.has(id)).length + item.deletes.size + item.inserts.length;
  function changes(item) {
    return { updates: [...item.updates].filter(([rowId]) => !item.deletes.has(rowId)).map(([rowId, values]) => ({ rowId, values })), deletes: [...item.deletes], inserts: item.inserts.map(row => ({ values: row.values })) };
  }
  function send(type, payload = {}) {
    const record = current(); if (!record) return;
    if (['copy', 'export', 'closeResult', 'openRelatedRows'].includes(type)) { vscode.postMessage({ type, id: record.id, ...payload }); return; }
    const item = draft(record);
    if (item.pendingRequestId || record.editBusy) return;
    const requestId=`${record.id}:${Date.now()}:${++requestSequence}`,message={type,id:record.id,requestId,draftRevision:item.revision,...payload};
    if(new TextEncoder().encode(JSON.stringify(message)).length>1100000){record.editError='This request exceeds the table input limit. Use a smaller batch; no data was staged.';render();return;}
    item.pendingRequestId = requestId; persist(); render();
    vscode.postMessage(message);
  }
  function changed(record) {
    const item = draft(record); item.revision++; record.review = undefined;
    vscode.postMessage({ type: 'draftChanged', id: record.id,modelId:record.result.edit.modelId,count: count(item), draftRevision: item.revision });
    persist(); render();
  }
  const cellLimit = 128 * 1024;
  const lineEndings = { lf: '\n', crlf: '\r\n', cr: '\r' };
  const cellModes = {
    raw: { label: 'Value', hint: 'The value is staged as entered and validated by the SQL review.' },
    lf: { label: 'Text · LF', hint: 'Stage line breaks as LF.' },
    crlf: { label: 'Text · CRLF', hint: 'Stage line breaks as CRLF.' },
    cr: { label: 'Text · CR', hint: 'Stage line breaks as CR.' },
    escaped: { label: 'Escaped text', hint: 'Edit a JSON string literal. Escapes preserve mixed line endings and control characters.' },
    hex: { label: 'Hex bytes', hint: 'Use pairs of hexadecimal digits, with an optional 0x prefix. Spaces and line breaks between digits are ignored.' },
    base64: { label: 'Base64 bytes', hint: 'Use standard Base64 including any padding. An empty byte sequence is valid.' }
  };
  function cellError(error) {
    $('cell-error').textContent = error || '';
    $('cell-error').hidden = !error;
    $('cell-value').setAttribute('aria-invalid', String(Boolean(error)));
  }
  function preferredTextMode(value) {
    const breaks = new Set(value.match(/\r\n|\r|\n/g));
    if (breaks.size > 1 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return 'escaped';
    if (breaks.has('\r\n')) return 'crlf';
    if (breaks.has('\r')) return 'cr';
    return 'lf';
  }
  function decodeCell(value, mode) {
    if (value.length > 6 * cellLimit + 2) throw Error('This cell exceeds its input size limit. Use a smaller value.');
    if (mode === 'escaped') {
      let decoded;
      try { decoded = JSON.parse(value); } catch { /* Use the actionable error below. */ }
      if (typeof decoded !== 'string') throw Error('Enter a valid JSON string literal, with double quotes and escaped control characters.');
      return decoded;
    }
    if (mode === 'hex') {
      const hex = value.replace(/[ \t\r\n]/g, '').replace(/^0x/i, '');
      if (!/^(?:[\da-f]{2})*$/i.test(hex)) throw Error('Hex bytes require an even number of hexadecimal digits.');
      return '0x' + hex.toLowerCase();
    }
    if (mode === 'base64') {
      const source = value.replace(/[ \t\r\n]/g, '');
      let bytes;
      try { bytes = atob(source); } catch { /* Use the actionable error below. */ }
      if (bytes === undefined || btoa(bytes) !== source) throw Error('Enter standard Base64 with its exact padding.');
      const pairs = [];
      for (let i = 0; i < bytes.length; i++) pairs.push(bytes.charCodeAt(i).toString(16).padStart(2, '0'));
      return '0x' + pairs.join('');
    }
    return lineEndings[mode] ? value.replace(/\n/g, lineEndings[mode]) : value;
  }
  function encodeCell(value, mode) {
    if (mode === 'escaped') return JSON.stringify(value);
    if (mode === 'base64') {
      const hex = decodeCell(value, 'hex').slice(2), bytes = [];
      for (let i = 0; i < hex.length; i += 2) bytes.push(String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16)));
      return btoa(bytes.join(''));
    }
    return value;
  }
  function showCellMode(mode) {
    const editor = $('cell-value'), selection = $('cell-format');
    selection.value = mode;
    editor.disabled = selection.disabled = $('cell-null').checked;
    $('cell-hint').textContent = cellModes[mode].hint + (editingCell?.column.kind === 'json' ?
      ' JSON syntax is checked without rewriting the supplied text. JSON null is a value separate from SQL NULL.' : '');
  }
  function openCell(record, rowId, column, value, inserted = false) {
    if (editingCell) { $('cell-value').focus(); return; }
    const source = value === null || value === undefined ? '' : String(value);
    const modes = column.kind === 'binary' ? ['hex', 'base64'] :
      !column.kind || ['text', 'json'].includes(column.kind) ? ['lf', 'crlf', 'cr', 'escaped'] : ['raw'];
    const mode = modes[0] === 'lf' ? preferredTextMode(source) : modes[0];
    editingCell = { id: record.id, rowId, column, inserted, modelId: record.result.edit.modelId, mode };
    $('cell-label').textContent = `${column.name} · ${column.type}`;
    $('cell-value').value = encodeCell(source, mode);
    $('cell-null').checked = value === null;
    $('cell-null').disabled = !column.nullable;
    options($('cell-format'), modes.map(value => ({ value, label: cellModes[value].label })), mode);
    $('cell-format-label').hidden = modes.length === 1;
    showCellMode(mode);
    cellError();
    $('cell-editor').hidden = false; render(); $('cell-value').focus(); $('cell-value').select();
  }
  function editableCell(td, record, rowId, column, value, inserted) {
    td.tabIndex = 0; td.classList.add('editable'); td.setAttribute('role', 'button');
    td.setAttribute('aria-label', `Edit ${inserted ? 'new row' : 'row'} ${rowId} column ${column.name}`);
    const edit = () => openCell(record, rowId, column, value, inserted);
    td.ondblclick = edit;
    td.onkeydown = event => { if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); edit(); } };
    if(!inserted){td.onfocus=()=>{const form=bulkForm(record);form.anchorRowId=rowId;form.anchorColumn=column.name;};td.onpaste=event=>{if(record.editBusy||draft(record).pendingRequestId||count(draft(record)))return;const value=event.clipboardData?.getData('text/plain');if(typeof value==='string'){event.preventDefault();send('prepareBulk',{operation:'paste',modelId:record.result.edit.modelId,text:value,delimiter:'\t',anchorRowId:rowId,anchorColumn:column.name});}};}
  }
  function bulkForm(record){
    const model=record.result?.edit;let form=bulkForms.get(record.id);
    if(!form||form.modelId!==model?.modelId){form={modelId:model?.modelId,open:false,mode:'paste',format:'text',text:'',delimiter:'\t',hasHeader:true,formulaPolicy:'reject',blankPolicy:'empty',anchorRowId:model?.rowIds[0],anchorColumn:model?.columns.find(c=>c.editable)?.name,mapping:[],nullToken:'\\N',nullEnabled:false};bulkForms.set(record.id,form);}return form;
  }
  function renderBulk(record){
    const model=record.result?.edit,form=bulkForm(record),item=draft(record),blocked=Boolean(record.editBusy||item.pendingRequestId||record.editExpired||record.readOnly||count(item)||editingCell?.id===record.id);
    $('bulk-panel').hidden=!form.open||!model||record.readOnly;if($('bulk-panel').hidden)return;
    const xlsx=form.format==='xlsx';$('bulk-title').textContent=form.mode==='import'?(xlsx?'Import XLSX rows as staged inserts':'Import rows as staged inserts'):'Paste into loaded cells';$('bulk-header-label').hidden=form.mode!=='import';$('bulk-anchor').hidden=form.mode!=='paste';$('bulk-inspect').hidden=form.mode!=='import';$('xlsx-options').hidden=!xlsx;$('bulk-format-label').hidden=xlsx;$('bulk-null-label').hidden=$('bulk-null-token').hidden=xlsx;$('bulk-text').readOnly=xlsx;$('bulk-text-label').textContent=xlsx?'Preview of the first five data rows (values only)':'Text data';$('bulk-inspect').textContent=xlsx?'Inspect Worksheet and Map Columns':'Inspect Input and Map Columns';
    $('bulk-delimiter').value=form.delimiter===','?'comma':'tab';$('bulk-text').value=form.text;$('bulk-header').checked=form.hasHeader;$('bulk-null-enabled').checked=form.nullEnabled;$('bulk-null-token').value=form.nullToken;
    if(xlsx){options($('xlsx-sheet'),(form.sheets||[]).map(sheet=>({value:sheet.id,label:sheet.name+(sheet.state!=='visible'?' ('+sheet.state+')':'')})),form.sheetId);$('xlsx-formulas').value=form.formulaPolicy;$('xlsx-blanks').value=form.blankPolicy;}
    options($('bulk-row'),(model.rowIds||[]).map((id,index)=>({value:id,label:String(index+1+(record.result.browse?.page||0)*(record.result.browse?.pageSize||0))})),form.anchorRowId);
    options($('bulk-column'),model.columns.filter(c=>c.editable).map(c=>({value:c.name,label:c.name})),form.anchorColumn);
    $('bulk-mapping').replaceChildren();
    if(form.mode==='import'&&form.sourceId)for(const entry of form.mapping){const row=document.createElement('label');row.className='bulk-map';row.append(document.createTextNode((form.headers?.[entry.source]||'Field '+(entry.source+1))+' → '));const select=document.createElement('select');select.setAttribute('aria-label','Map source field '+(entry.source+1));options(select,[{value:'',label:'Ignore this source field'},...model.columns.filter(c=>c.insertable&&!c.generated&&!c.autoIncrement).map(c=>({value:c.name,label:c.name+' · '+c.type}))],entry.target);select.disabled=blocked;select.onchange=()=>{entry.target=select.value||null;};row.append(select);$('bulk-mapping').append(row);}
    $('bulk-summary').textContent=form.mode==='import'?(form.sourceId?(xlsx?`${form.rowCount} source rows from ${form.sheetName}; ${form.dateSystem} date system, ${form.formulaCount} formula cells. Stored cached results can be stale and are never recalculated. Explicit empty strings remain text; absent blanks use the selected policy. Missing mapped columns use server defaults.`:`${form.rowCount} source rows. Empty text stays empty; only the chosen unquoted token becomes SQL NULL. Missing mapped columns use server defaults.`):'Inspect the input, then explicitly map or ignore each source field.'): 'The rectangle must fit this page and cannot include protected columns. Existing drafts must be applied or discarded first.';
    for(const id of ['bulk-delimiter','bulk-header','bulk-text','bulk-null-enabled','bulk-row','bulk-column','bulk-inspect','xlsx-sheet','xlsx-formulas','xlsx-blanks'])$(id).disabled=blocked;
    $('bulk-null-token').disabled=blocked||!form.nullEnabled;$('bulk-stage').disabled=blocked||!xlsx&&!form.text||(form.mode==='import'&&!form.sourceId)||form.mode==='paste'&&(!form.anchorRowId||!form.anchorColumn);
  }
  function renderBrowse(record, result) {
    const browse = result.browse, model = result.edit;
    $('browse-tools').hidden = !browse || !model;
    if (!browse || !model) return;
    let form = browseForms.get(record.id);
    if (!form || form.modelId !== model.modelId) {
      form = { modelId: model.modelId, expanded: form?.expanded || false, sort: (browse.sort || []).map(item => ({ ...item })), filters: (browse.filters || []).map(item => ({ ...item, value: item.value ? { ...item.value } : undefined })) };
      browseForms.set(record.id, form);
    }
    const session = record.sessionState || result.state, item = draft(record);
    const pending = record.editBusy || item.pendingRequestId || record.editExpired || session?.needsReconnect || session?.outcomeUnknown;
    const localChanges = count(item) > 0 || record.review || editingCell?.id === record.id;
    const blocked = Boolean(pending || localChanges || session?.inTransaction || session?.transactionState === 'unknown');
    $('page-previous').disabled = blocked || !browse.pageable || !browse.hasPrevious;
    $('page-next').disabled = blocked || !browse.pageable || browse.hasNext !== true || browse.page >= 2000;
    $('page-size').disabled = blocked;
    $('page-size').value = String(browse.pageSize);
    if (!$('page-size').value) {
      const option = document.createElement('option'); option.value = option.textContent = String(browse.pageSize); $('page-size').append(option); $('page-size').value = option.value;
    }
    $('page-label').textContent = `Page ${browse.page + 1} · ${result.rowCount} rows`;
    $('browse-options').disabled = Boolean(pending); $('browse-options').setAttribute('aria-expanded', String(form.expanded));
    $('browse-form').hidden = !form.expanded;
    const scalar = model.columns.filter(column => !['binary', 'json', 'unsupported'].includes(column.kind));
    const select = (label, choices, value, change) => {
      const control = document.createElement('select'); control.setAttribute('aria-label', label); control.disabled = blocked;
      for (const choice of choices) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; control.append(option); }
      control.value = value; control.onchange = () => change(control.value); return control;
    };
    const remove = (label, action) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Remove'; button.setAttribute('aria-label', label); button.disabled = blocked; button.onclick = action; return button; };
    $('sort-rules').replaceChildren(...form.sort.map((rule, index) => {
      const row = document.createElement('div'); row.className = 'browse-rule';
      row.append(select(`Sort column ${index + 1}`, scalar.map(column => ({ value: column.name, label: column.name })), rule.column, value => { rule.column = value; }),
        select(`Sort direction ${index + 1}`, [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], rule.direction, value => { rule.direction = value; }),
        remove(`Remove sort ${index + 1}`, () => { form.sort.splice(index, 1); render(); })); return row;
    }));
    const labels = { eq: 'Equals', ne: 'Does not equal', lt: 'Less than', lte: 'At most', gt: 'Greater than', gte: 'At least', contains: 'Contains text', startsWith: 'Starts with', endsWith: 'Ends with', isNull: 'Is NULL', isNotNull: 'Is not NULL' };
    const filterOperators = column => ['json', 'binary', 'unsupported'].includes(column?.kind) ? ['isNull', 'isNotNull'] : ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', ...(column?.kind === 'text' ? ['contains', 'startsWith', 'endsWith'] : []), 'isNull', 'isNotNull'];
    $('filter-rules').replaceChildren(...form.filters.map((rule, index) => {
      const row = document.createElement('div'); row.className = 'browse-rule';
      const column = model.columns.find(column => column.name === rule.column), operators = filterOperators(column);
      row.append(select(`Filter column ${index + 1}`, model.columns.map(column => ({ value: column.name, label: column.name })), rule.column, value => { rule.column = value; const next = model.columns.find(column => column.name === value); if (!filterOperators(next).includes(rule.operator)) rule.operator = filterOperators(next)[0]; render(); }),
        select(`Filter operator ${index + 1}`, operators.map(value => ({ value, label: labels[value] })), rule.operator, value => { rule.operator = value; render(); }));
      const value = document.createElement('input'); value.type = 'text'; value.autocomplete = 'off'; value.spellcheck = false; value.setAttribute('aria-label', `Filter value ${index + 1}`); value.placeholder = column?.type || 'Value';
      value.value = rule.value?.text || ''; value.disabled = blocked || ['isNull', 'isNotNull'].includes(rule.operator); value.oninput = () => { rule.value = { kind: 'value', text: value.value }; };
      row.append(value, remove(`Remove filter ${index + 1}`, () => { form.filters.splice(index, 1); render(); })); return row;
    }));
    $('add-sort').disabled = blocked || !scalar.length || form.sort.length >= Math.min(scalar.length, 8);
    $('add-filter').disabled = blocked || !model.columns.length || form.filters.length >= 20;
    $('apply-browse').disabled = $('clear-browse').disabled = blocked;
    $('browse-status').textContent = localChanges ? 'Apply or discard staged changes before changing pages, sorting or filters.' : session?.inTransaction ? 'Commit or roll back the current transaction before changing pages, sorting or filters.' : !browse.pageable ? 'First page only: this table has no primary key.' : 'Server-side results. Concurrent data changes may move rows between pages.';
    $('add-sort').onclick = () => { const column = scalar.find(column => !form.sort.some(rule => rule.column === column.name)); if (column) { form.sort.push({ column: column.name, direction: 'asc' }); render(); } };
    $('add-filter').onclick = () => { const column = scalar[0] || model.columns[0]; form.filters.push({ column: column.name, operator: filterOperators(column)[0], value: { kind: 'value', text: '' } }); render(); };
  }
  function renderTools(record, result) {
    const model = result.edit, item = draft(record), session = record.sessionState || result.state;
    $('edit-tools').hidden = !model; $('edit-status').hidden = !model; $('review-panel').hidden = !model || !record.review;
    if (!model) return;
    const cellOpen = editingCell?.id === record.id;
    const blocked = Boolean(record.editBusy || item.pendingRequestId || record.editExpired || session?.needsReconnect || session?.outcomeUnknown);
    const enabled = model.canEdit && !record.readOnly && !blocked;
    const dirty = count(item) > 0;
    $('enable-edit').hidden = !record.readOnly;
    $('enable-edit').disabled = blocked || !model.canEdit;
    $('restore-browsing').hidden = record.readOnly;
    $('restore-browsing').disabled = blocked || dirty || cellOpen;
    $('add-row').disabled = !enabled || cellOpen || model.insertable === false || count(item) >= 500;
    $('add-row').title = model.insertable === false ? 'A required column cannot be inserted safely.' : 'Stage a new row';
    for(const id of ['paste-cells','import-text','import-file','import-xlsx'])$(id).disabled=!enabled||dirty||cellOpen||(id!=='paste-cells'&&model.insertable===false);
    $('discard').disabled = !dirty || cellOpen || record.editBusy || Boolean(item.pendingRequestId);
    $('review').disabled = !enabled || !dirty || cellOpen;
    $('apply').disabled = !enabled || !record.review || cellOpen;
    $('commit').disabled = !enabled || dirty || !session?.inTransaction || cellOpen;
    $('rollback').disabled = !enabled || dirty || !session?.inTransaction || cellOpen;
    $('reload').disabled = blocked || dirty || cellOpen;
    if (dirty || cellOpen) {
      $('copy').disabled = $('export').disabled = true;
      $('copy').title = $('export').title = 'Apply or discard local drafts before copying the server result.';
    } else $('copy').title = $('export').title = 'Use all captured rows and columns, including hidden columns.';
    $('draft-count').textContent = `${count(item)} staged row changes`;
    $('edit-status').className = record.editError || session?.outcomeUnknown ? 'error' : '';
    $('edit-status').textContent = record.editError || record.editMessage || model.reason || (record.readOnly ? 'Enable Editing to stage changes. Apply and Commit are separate actions.' : 'Double-click a cell or press Enter/F2. Values remain local until Review and Apply.');
    if (session?.outcomeUnknown) $('edit-status').textContent += ' Write outcome unknown. Inspect the server before retrying.';
    if (session?.needsReconnect) $('edit-status').textContent += ' Reconnect this console explicitly; then discard drafts and reload.';
    if (record.review) $('review-sql').textContent = record.review.statements.map((statement, index) => `${index + 1}. ${statement.sql}\nBound values: ${JSON.stringify(statement.parameters)}\n`).join('\n');
    return enabled;
  }
  function resultLayout(record) {
    const columns = record.result.columns;
    const signature = JSON.stringify(columns);
    let layout = layouts.get(record.id);
    const saved = savedLayouts.get(record.id);
    if (record.tableLayout) {
      const preference = JSON.stringify(record.tableLayout.columns);
      if (layout?.pendingPreference === preference) {
        layout.preference = preference;
        delete layout.pendingPreference;
      }
      if (layout?.signature !== signature || (!layout.pendingPreference && layout.preference !== preference)) {
        const previous = layout || saved;
        const indices = new Map(columns.map((column, index) => [column, index]));
        const matched = record.tableLayout.columns.filter(column => indices.has(column.name));
        const order = matched.map(column => indices.get(column.name));
        const existing = new Set(order);
        for (const index of indices.values()) if (!existing.has(index)) order.push(index);
        const hidden = new Set(matched.filter(column => column.hidden).map(column => indices.get(column.name)));
        if (hidden.size === order.length) hidden.delete(order[0]);
        layout = { signature, preference, order, hidden,
          pinned: new Set(matched.filter(column => column.pinned).map(column => indices.get(column.name))),
          widths: Object.fromEntries(matched.filter(column => column.width !== undefined).map(column => [indices.get(column.name), column.width])),
          mode: viewModes.includes(previous?.mode) ? previous.mode : 'grid',
          row: previous?.row || 0, open: previous?.open === true };
        layouts.set(record.id, layout);
      }
      savedLayouts.delete(record.id);
      return layout;
    }
    if (layout?.signature === signature) return layout;
    const validIndex = index => Number.isInteger(index) && index >= 0 && index < columns.length;
    if (saved?.signature === signature && Array.isArray(saved.order) && saved.order.length === columns.length &&
        new Set(saved.order).size === columns.length && saved.order.every(validIndex)) {
      const hidden = new Set(Array.isArray(saved.hidden) ? saved.hidden.filter(validIndex) : []);
      layout = { signature, order: saved.order, hidden: hidden.size < columns.length ? hidden : new Set(),
        pinned: new Set(Array.isArray(saved.pinned) ? saved.pinned.filter(validIndex) : []),
        widths: Object.fromEntries(Object.entries(saved.widths || {}).filter(([index, width]) =>
          validIndex(Number(index)) && Number.isInteger(width) && width >= 96 && width <= 600)),
        mode: viewModes.includes(saved.mode) ? saved.mode : 'grid', row: 0, open: false };
    } else {
      layout = { signature, order: columns.map((_, index) => index), hidden: new Set(), pinned: new Set(),
        widths: {}, mode: 'grid', row: 0, open: false };
    }
    savedLayouts.delete(record.id);
    layouts.set(record.id, layout);
    return layout;
  }

  const rowNumber = (result, index) => (result.browse?.page || 0) * (result.browse?.pageSize || 0) + index + 1;
  const columnWidth = (layout, index) => layout.widths[index] || 180;
  const columnOrder = layout => [true, false].flatMap(pinned => layout.order.filter(index => layout.pinned.has(index) === pinned));

  function saveColumnLayout(record, layout, reset = false) {
    if (!record.tableLayout) return;
    const columns = reset ? [] : layout.order.map(index => ({ name: record.result.columns[index],
      hidden: layout.hidden.has(index), pinned: layout.pinned.has(index), width: layout.widths[index] }));
    layout.pendingPreference = JSON.stringify(columns);
    vscode.postMessage({ type: 'saveLayout', id: record.id, modelId: record.result.edit.modelId, columns });
  }

  function renderColumns(record, layout, order, visible) {
    const result = record.result;
    $('result-columns').setAttribute('aria-expanded', String(layout.open));
    $('result-column-panel').hidden = !layout.open;
    const list = $('result-column-list');
    list.replaceChildren();
    if (!layout.open) return;
    function update(action) {
      const focus = document.activeElement?.getAttribute('aria-label'), scrollTop = list.scrollTop;
      action();
      saveColumnLayout(record, layout);
      persist();
      render();
      list.scrollTop = scrollTop;
      if (focus) [...list.querySelectorAll('[aria-label]')].find(control => control.getAttribute('aria-label') === focus)?.focus({ preventScroll: true });
    }
    for (const [position, index] of order.entries()) {
      const line = document.createElement('div'), name = result.columns[index];
      line.className = 'result-column-settings';
      const heading = document.createElement('strong');
      heading.textContent = name;
      heading.title = name;
      line.append(heading);
      for (const [label, selected] of [['Show', !layout.hidden.has(index)], ['Pin', layout.pinned.has(index)]]) {
        const container = document.createElement('label'), control = document.createElement('input');
        control.type = 'checkbox';
        control.checked = selected;
        control.disabled = label === 'Show' && selected && visible.length === 1;
        control.setAttribute('aria-label', label + ' column ' + (index + 1) + ' ' + name);
        control.onchange = () => update(() => {
          const members = label === 'Show' ? layout.hidden : layout.pinned;
          const include = label === 'Show' ? !control.checked : control.checked;
          if (include) members.add(index); else members.delete(index);
        });
        container.append(control, label);
        line.append(container);
      }
      const sizeLabel = document.createElement('label'), size = document.createElement('input');
      size.type = 'number';
      size.min = '96';
      size.max = '600';
      size.value = String(columnWidth(layout, index));
      size.setAttribute('aria-label', 'Column ' + (index + 1) + ' width in pixels');
      size.onchange = () => {
        if (!size.value || !size.checkValidity()) size.value = String(columnWidth(layout, index));
        else update(() => { layout.widths[index] = Number(size.value); });
      };
      sizeLabel.append('Width', size);
      line.append(sizeLabel);
      for (const [distance, label] of [[-1, 'Earlier'], [1, 'Later']]) {
        const button = document.createElement('button'), other = order[position + distance];
        button.textContent = label;
        button.setAttribute('aria-label', 'Move column ' + (index + 1) + ' ' + label.toLowerCase());
        button.disabled = other === undefined || layout.pinned.has(other) !== layout.pinned.has(index);
        button.onclick = () => update(() => {
          const from = layout.order.indexOf(index), to = layout.order.indexOf(other);
          [layout.order[from], layout.order[to]] = [layout.order[to], layout.order[from]];
        });
        line.append(button);
      }
      list.append(line);
    }
  }

  function presentValue(cell, value) {
    cell.textContent = text(value);
    cell.title = cell.textContent;
    if (value === null) cell.classList.add('null');
    else if (typeof value === 'number') cell.classList.add('numeric');
  }

  function resultRows(record) {
    const model = record.result.edit, draftItem = draft(record);
    const rows = record.result.rows.map((values, index) => {
      const id = model?.rowIds[index];
      return { id, values, number: rowNumber(record.result, index), deleted: draftItem.deletes.has(id),
        pending: draftItem.updates.get(id), inserted: false };
    });
    if (model) for (const [index, row] of draftItem.inserts.entries()) {
      rows.push({ id: row.id, values: [], number: index + 1, pending: row.values, inserted: true, deleted: false });
    }
    return rows;
  }

  function presentDataCell(cell, record, row, index, enabled) {
    const column = record.result.edit?.columns[index];
    const pending = column && row.pending && Object.hasOwn(row.pending, column.name) ? row.pending[column.name] : undefined;
    const value = pending ? pending.kind === 'null' ? null : pending.text : row.values[index];
    presentValue(cell, row.inserted && !pending ? 'DEFAULT' : value);
    if (pending) cell.classList.add('modified');
    if (enabled && column && !row.deleted && (row.inserted ? column.insertable ?? column.editable : column.editable)) {
      editableCell(cell, record, row.id, column, value, row.inserted);
    }
  }

  function addRowEditActions(target, record, row) {
    const item = draft(record), model = record.result.edit, cellOpen = editingCell?.id === record.id;
    const remove = document.createElement('button');
    remove.textContent = row.deleted ? 'Undo' : '−';
    remove.title = row.deleted ? 'Undo row deletion' : 'Stage row deletion';
    remove.setAttribute('aria-label', `${row.deleted ? 'Restore' : 'Delete'} ${row.inserted ? 'new row' : 'row'} ${row.id}`);
    remove.disabled = cellOpen;
    remove.onclick = () => {
      if (row.inserted) item.inserts = item.inserts.filter(value => value.id !== row.id);
      else if (row.deleted) item.deletes.delete(row.id); else item.deletes.add(row.id);
      changed(record);
    };
    target.append(remove);
    if (row.inserted) return;
    const duplicate = document.createElement('button');
    duplicate.textContent = '⧉';
    duplicate.title = 'Stage a duplicate row without primary/generated keys';
    duplicate.setAttribute('aria-label', 'Duplicate row ' + row.id);
    duplicate.disabled = count(item) > 0 || model.insertable === false || cellOpen;
    duplicate.onclick = () => send('prepareBulk', { operation: 'duplicate', modelId: model.modelId, rowId: row.id });
    target.append(duplicate);
  }

  function addRelatedRowAction(target, record, row, compact = false) {
    const model = record.result.edit;
    const session = record.sessionState;
    if (!model || !row.id || row.inserted || !record.readOnly || session?.inTransaction || session?.needsReconnect ||
        session?.outcomeUnknown || record.closing || record.editBusy || record.hasDraft || record.review ||
        draft(record).pendingRequestId) return;
    const open = document.createElement('button');
    open.textContent = compact ? '↗' : 'Related Rows';
    open.title = 'Follow a foreign key from this row';
    open.setAttribute('aria-label', 'Open related rows for row ' + row.number);
    open.onclick = () => send('openRelatedRows', { modelId:model.modelId, rowId:row.id });
    target.append(open);
  }

  function renderRecord(record, row, columns, enabled) {
    if (!row) return;
    const card = document.createElement('section'), fields = document.createElement('dl');
    card.className = 'result-record';
    if (row.deleted) card.classList.add('result-record-deleted');
    fields.className = 'result-fields';
    const actions = document.createElement('div');
    actions.className = 'result-record-actions';
    if (enabled) addRowEditActions(actions, record, row);
    addRelatedRowAction(actions, record, row);
    if (actions.childElementCount) card.append(actions);
    for (const index of columns) {
      const name = document.createElement('dt'), value = document.createElement('dd');
      name.textContent = record.result.columns[index];
      presentDataCell(value, record, row, index, enabled);
      fields.append(name, value);
    }
    card.append(fields);
    $('grid').append(card);
  }

  function columnPairs(result, values, columns) {
    const fields = document.createElement('dl');
    fields.className = 'result-fields';
    for (const index of columns) {
      const name = document.createElement('dt'), value = document.createElement('dd');
      name.textContent = result.columns[index];
      value.textContent = text(values[index]);
      if (values[index] === null) value.className = 'null';
      fields.append(name, value);
    }
    return fields;
  }

  function renderSnapshot(result, layout, columns) {
    const grid = $('grid');
    if (layout.mode === 'tree') {
      const fragment = document.createDocumentFragment();
      for (const [index, row] of result.rows.entries()) {
        const item = document.createElement('details'), label = document.createElement('summary');
        label.textContent = 'Row ' + rowNumber(result, index);
        item.className = 'result-tree-row';
        item.append(label);
        item.ontoggle = () => {
          if (item.open && item.childElementCount === 1) item.append(columnPairs(result, row, columns));
        };
        fragment.append(item);
      }
      grid.append(fragment);
    } else if (layout.mode === 'text') {
      const output = document.createElement('pre');
      output.className = 'result-plain-text';
      const line = row => columns.map(index => typeof row[index] === 'number' ? text(row[index]) : JSON.stringify(row[index])).join('\t');
      output.textContent = [line(result.columns), ...result.rows.map(line)].join('\n');
      grid.append(output);
    } else {
      const table = document.createElement('table'), head = table.createTHead().insertRow(), body = table.createTBody();
      table.className = 'result-transpose';
      const label = document.createElement('th');
      label.textContent = 'Column';
      head.append(label);
      for (const [index] of result.rows.entries()) {
        const number = document.createElement('th');
        number.scope = 'col';
        number.textContent = 'Row ' + rowNumber(result, index);
        head.append(number);
      }
      for (const index of columns) {
        const row = body.insertRow(), name = document.createElement('th');
        name.scope = 'row';
        name.textContent = result.columns[index];
        row.append(name);
        for (const values of result.rows) presentValue(row.insertCell(), values[index]);
      }
      grid.append(table);
    }
  }

  const chartPageSize = 24;
  const chartCountOps = new Set(['count', 'nonnull']);
  function chartFor(record) {
    const revision = record.chart.revision;
    let chart = charts.get(record.id);
    if (chart?.revision !== revision) {
      const signature = JSON.stringify(record.result.columns);
      const previous = chart?.signature === signature ? chartOptions(chart) : { category: null, operation: 'count', measure: null };
      chart = { revision, signature, shape: chart?.shape || 'bar', ...previous, page: 0 };
      charts.set(record.id, chart);
    }
    return chart;
  }
  const chartOptions = ({ category, operation, measure }) => ({ category, operation, measure });
  function useChart(record, chart, type) {
    const requestId = ++requestSequence;
    if (type === 'analyzeResult') {
      chart.pending = requestId;
      chart.analysis = chart.error = undefined;
      chart.page = 0;
    }
    vscode.postMessage({ type, id: record.id, revision: chart.revision, requestId, options: chartOptions(chart) });
  }
  const categoryText = group => group.category === null ? 'NULL' : group.category === '' ? '(empty text)' :
    group.negativeZero ? '-0' : typeof group.category === 'string' && /^(?:NULL|\(empty text\)|true|false|-?\d)/.test(group.category) ?
      JSON.stringify(group.category) : text(group.category);

  function drawResultChart(canvas, groups, axis, shape) {
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
    if (width < 25 || height < 25) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    const colors = getComputedStyle(document.body);
    const color = (name, fallback) => colors.getPropertyValue('--vscode-' + name).trim() || fallback;
    const left = Math.min(83, width / 5), right = width - 14, top = 16, bottom = height - 35;
    const step = (right - left) / Math.max(groups.length, 1);
    const x = index => left + (index + 0.5) * step;
    const y = position => bottom - position * (bottom - top);
    const origin = y(axis.zero);
    ctx.strokeStyle = color('panel-border', '#777');
    for (const position of [0, 0.25, 0.5, 0.75, 1]) {
      ctx.beginPath();
      ctx.moveTo(left, y(position));
      ctx.lineTo(right, y(position));
      ctx.stroke();
    }
    ctx.strokeStyle = color('foreground', '#bbb');
    ctx.beginPath();
    ctx.moveTo(left, origin);
    ctx.lineTo(right, origin);
    ctx.stroke();
    const positive = color('charts-blue', '#3794ff'), negative = color('charts-orange', '#d18616');
    if (shape === 'line') {
      ctx.strokeStyle = positive;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let connected = false;
      groups.forEach((group, index) => {
        if (group.position === null) { connected = false; return; }
        if (connected) ctx.lineTo(x(index), y(group.position));
        else ctx.moveTo(x(index), y(group.position));
        connected = true;
      });
      ctx.stroke();
    }
    groups.forEach((group, index) => {
      if (group.position === null) return;
      const pointX = x(index), pointY = y(group.position);
      ctx.fillStyle = pointY > origin ? negative : positive;
      if (shape === 'line') {
        ctx.beginPath();
        ctx.arc(pointX, pointY, 3, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const barWidth = Math.min(40, step * 0.72);
        ctx.fillRect(pointX - barWidth / 2, Math.min(origin, pointY), barWidth, Math.max(2, Math.abs(origin - pointY)));
      }
    });
    ctx.fillStyle = color('foreground', '#bbb');
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    if (axis.minimum === axis.maximum) ctx.fillText(axis.minimum, left - 5, origin, left - 10);
    else {
      ctx.fillText(axis.maximum, left - 5, top, left - 10);
      ctx.fillText(axis.minimum, left - 5, bottom, left - 10);
      if (axis.zero > 0 && axis.zero < 1) ctx.fillText('0', left - 5, origin, left - 10);
    }
    ctx.textAlign = 'center';
    const cadence = Math.max(1, Math.ceil(groups.length / Math.max(1, Math.floor(width / 95))));
    for (let index = 0; index < groups.length; index += cadence) {
      const label = categoryText(groups[index]).replace(/\s+/g, ' ');
      ctx.fillText(label.length > 14 ? label.slice(0, 13) + '…' : label, x(index), bottom + 20, Math.min(88, step * cadence));
    }
  }
  function renderChart(record, busy) {
    const chart = chartFor(record), all = record.result.columns;
    $('chart-tools').hidden = false;
    $('chart-shape').value = chart.shape;
    $('chart-operation').value = chart.operation;
    for (const option of $('chart-operation').options) option.disabled = !chartCountOps.has(option.value) && !record.chart.numeric.length;
    const choice = (name, index) => ({ value: String(index), label: (index + 1) + '. ' + name });
    options($('chart-category'), [{ value: '', label: chart.operation === 'values' ? 'Row numbers' : 'All rows' }, ...all.map(choice)],
      chart.category === null ? '' : String(chart.category));
    const measureIndexes = chart.operation === 'nonnull' ? all.map((_, index) => index) : record.chart.numeric;
    options($('chart-measure'), measureIndexes.map(index => choice(all[index], index)), String(chart.measure));
    $('chart-shape').disabled = $('chart-operation').disabled = $('chart-category').disabled = busy;
    $('chart-measure').disabled = busy || chart.operation === 'count';
    $('chart-export').disabled = busy || !chart.analysis;
    if (busy) { $('chart-status').textContent = 'Waiting for the current table action…'; return; }
    if (!chart.analysis && !chart.error && !chart.pending) useChart(record, chart, 'analyzeResult');
    if (!chart.analysis) {
      $('chart-status').textContent = chart.error || 'Calculating captured results…';
      return;
    }
    const analysis = chart.analysis, grid = $('grid');
    const coverage = analysis.page === undefined ? 'captured rows' : 'captured rows on table page ' + analysis.page;
    const partial = analysis.truncated || analysis.hasPrevious || (analysis.page !== undefined && analysis.hasNext !== false);
    $('chart-status').textContent = analysis.rows + ' ' + coverage + ' · ' + analysis.groups.length + ' plotted categories' +
      (partial ? ' · preview can omit other rows' : '') +
      (analysis.uncommitted ? ' · includes this session’s uncommitted values' : '');
    const groupStart = chart.page * chartPageSize, groups = analysis.groups.slice(groupStart, groupStart + chartPageSize);
    if (!groups.length) return;
    const panel = document.createElement('section'), extent = document.createElement('div'), canvas = document.createElement('canvas');
    panel.className = 'chart-panel';
    extent.className = 'chart-extent';
    extent.textContent = 'Vertical scale · minimum ' + analysis.axis.minimum + ' · maximum ' + analysis.axis.maximum;
    canvas.className = 'result-chart-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    panel.append(extent, canvas);
    if (analysis.groups.length > chartPageSize) {
      const controls = document.createElement('div'), range = document.createElement('span');
      controls.className = 'chart-navigation';
      range.textContent = `${groupStart + 1}–${groupStart + groups.length} of ${analysis.groups.length} categories`;
      for (const [delta, name] of [[-1, 'Previous Categories'], [1, 'Next Categories']]) {
        const button = document.createElement('button');
        button.textContent = name;
        button.disabled = delta < 0 ? chart.page === 0 : groupStart + groups.length >= analysis.groups.length;
        button.onclick = () => { chart.page += delta; render(); };
        controls.append(button);
      }
      controls.append(range);
      panel.append(controls);
    }
    const table = document.createElement('table');
    table.className = 'chart-data';
    const heading = table.createTHead().insertRow(), body = table.createTBody();
    for (const label of [analysis.category, 'Rows', ...(chart.operation !== 'count' ? ['Non-NULL'] : []), 'Exact value']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      heading.append(cell);
    }
    for (const group of groups) {
      const row = body.insertRow();
      for (const value of [categoryText(group), group.rows, ...(chart.operation !== 'count' ? [group.nonNull] : []), group.value]) {
        presentValue(row.insertCell(), value);
      }
    }
    panel.append(table);
    grid.append(panel);
    const draw = () => drawResultChart(canvas, groups, analysis.axis, chart.shape);
    draw();
    chartObserver = new ResizeObserver(draw);
    chartObserver.observe(canvas);
  }

  function renderResultLayout(record, layout, rows, { busy, needsDraftView }) {
    const result = record.result, order = columnOrder(layout);
    const visible = order.filter(index => !layout.hidden.has(index));
    if ((needsDraftView && !editableModes.has(layout.mode)) || !result.columns.length) layout.mode = 'grid';
    const selector = $('result-view');
    selector.value = layout.mode;
    selector.disabled = busy || !result.columns.length;
    for (const option of selector.options) option.disabled = needsDraftView && !editableModes.has(option.value);
    selector.title = needsDraftView ? 'Apply or discard drafts before using snapshot views.' : '';
    $('result-layout').hidden = !result.columns.length;
    $('result-row-navigation').hidden = layout.mode !== 'record' || !rows.length;
    layout.row = Math.max(0, Math.min(layout.row, rows.length - 1));
    const row = rows[layout.row];
    $('result-row-status').textContent = row ?
      `${row.inserted ? 'New row' : 'Row'} ${row.number} · ${layout.row + 1} of ${rows.length}${row.inserted ? ' · local draft' : ' captured'}${row.deleted ? ' · deletion staged' : ''}` : '';
    $('result-row-previous').disabled = busy || layout.row <= 0;
    $('result-row-next').disabled = busy || layout.row >= rows.length - 1;
    renderColumns(record, layout, order, visible);
    return visible;
  }

  function renderGrid(active, result, rows, enabled, layout, columns) {
    const table = document.createElement('table'), head = table.createTHead().insertRow();
    const corner = document.createElement('th');
    corner.textContent = '#';
    corner.className = 'row-number';
    head.append(corner);
    const pins = new Map();
    const numberWidth = enabled ? 104 : active.readOnly && result.edit ? 80 : 56;
    if (columns.some(index => layout.pinned.has(index) || layout.widths[index])) {
      let width = numberWidth;
      corner.style.width = numberWidth + 'px';
      for (const index of columns) {
        if (layout.pinned.has(index)) pins.set(index, width);
        width += columnWidth(layout, index);
      }
      table.classList.add('result-grid-sized');
      table.style.width = width + 'px';
    }
    const pin = (cell, index) => {
      if (pins.has(index)) {
        cell.classList.add('result-pinned');
        cell.style.left = pins.get(index) + 'px';
      }
    };
    for (const index of columns) {
      const th = document.createElement('th');
      th.textContent = result.columns[index];
      th.scope = 'col';
      const info = result.edit?.columns[index];
      if (info) th.title = `${info.type}${info.primaryKey ? ' · primary key (updates disabled)' : ''}${info.generated ? ' · generated (read only)' : ''}`;
      if (table.classList.contains('result-grid-sized')) th.style.width = columnWidth(layout, index) + 'px';
      pin(th, index);
      head.append(th);
    }
    const body = table.createTBody();
    for (const [rowIndex, row] of rows.entries()) {
      const tr = body.insertRow();
      tr.onpointerdown = tr.onfocusin = () => { layout.row = rowIndex; };
      if (row.deleted) tr.className = 'deleted';
      if (row.inserted) tr.classList.add('inserted');
      const number = tr.insertCell();
      number.className = 'row-number';
      number.textContent = row.inserted ? '+' : String(row.number);
      if (enabled) addRowEditActions(number, active, row);
      addRelatedRowAction(number, active, row, true);
      for (const index of columns) {
        const td = tr.insertCell();
        presentDataCell(td, active, row, index, enabled);
        pin(td, index);
      }
    }
    $('grid').append(table);
  }

  function renderExportAction(record) {
    const format = $('export-format').value;
    const labels = { csv: 'CSV', json: 'JSON', xlsx: 'XLSX', insert: 'INSERT' };
    $('export').textContent = 'Export ' + labels[format];
    const result = record?.result;
    const blocked = $('export').disabled || !result || insertExport?.id !== record.id ||
      insertExport?.modelId !== result.edit?.modelId || format !== 'insert';
    if (blocked) insertExport = undefined;
    $('insert-export').hidden = blocked;
  }

  function render() {
    const active = current();
    if (active) currentId = active.id;
    $('tabs').replaceChildren(...history.map(record => {
      const button = document.createElement('button'); button.textContent = `Result ${record.id}` + (record.state === 'running' ? ' …' : record.state === 'error' ? ' !' : '');
      button.className = record.id === currentId ? 'active' : ''; button.title = record.sql; button.setAttribute('aria-pressed', String(record.id === currentId));
      button.disabled = Boolean(editingCell && record.id !== editingCell.id);
      button.onclick = () => { currentId = record.id; render(); }; return button;
    }));
    chartObserver?.disconnect();
    chartObserver = undefined;
    $('grid').replaceChildren();
    $('chart-tools').hidden = true;
    const exportable = Boolean(active?.state === 'done' && active.result?.columns.length && !active.editBusy &&
      !active.hasDraft && !active.review && !active.sessionState?.outcomeUnknown && !draft(active).pendingRequestId);
    $('copy').disabled = $('export').disabled = $('export-format').disabled = !exportable;
    $('copy').title = $('export').title = 'Use all captured rows and columns, including hidden columns.';
    $('result-view').disabled = true;
    $('result-layout').hidden = $('result-column-panel').hidden = true;
    renderExportAction(active);
    $('close-result').disabled = !active || active.state === 'running' || active.editBusy || Boolean(editingCell || active && draft(active).pendingRequestId);
    $('edit-tools').hidden = $('edit-status').hidden = $('review-panel').hidden = $('browse-tools').hidden = $('bulk-panel').hidden = true;
    if (!active) { editingCell = null; $('cell-editor').hidden = true; $('source').textContent = 'No result selected'; $('message').textContent = 'Run SQL from the editor with Ctrl+Enter.'; $('status').textContent = 'Ready'; return; }
    $('source').textContent = active.source;
    $('message').textContent = active.state === 'running' ? 'Running query…' : active.error || '';
    $('message').className = active.state === 'error' ? 'error' : '';
    if (!active.result) {
      $('status').textContent = active.state === 'running' ? `${active.readOnly ? 'Read-only' : 'Read/write'} query · 5 second limit` : active.sessionState?.outcomeUnknown ? 'Write outcome unknown · inspect the database before retrying' : 'Query failed';
      if (active.sessionState?.needsReconnect) $('message').textContent += active.sessionState.outcomeUnknown ? ' The write may have completed. Inspect the database before retrying, then reconnect explicitly.' : ' Session lost. Reconnect explicitly before running another statement.';
      return;
    }
    const result = active.result, enabled = renderTools(active, result), layout = resultLayout(active);
    const item = draft(active), cellOpen = editingCell?.id === active.id;
    const busy = Boolean(cellOpen || item.pendingRequestId || active.editBusy || active.sessionState?.outcomeUnknown || bulkForms.get(active.id)?.open);
    const needsDraftView = Boolean(count(item) || active.hasDraft || active.review || active.sessionState?.outcomeUnknown);
    const rows = resultRows(active);
    const columns = renderResultLayout(active, layout, rows, { busy, needsDraftView });
    renderBrowse(active, result);
    renderBulk(active);
    if (layout.mode === 'grid') renderGrid(active, result, rows, enabled, layout, columns);
    else if (layout.mode === 'record') renderRecord(active, rows[layout.row], columns, enabled);
    else {
      $('edit-tools').hidden = $('edit-status').hidden = $('review-panel').hidden = $('bulk-panel').hidden = true;
      if (layout.mode === 'chart') renderChart(active, busy);
      else renderSnapshot(result, layout, columns);
    }
    $('export-format').options[3].disabled = !result.fields?.length;
    $('export-format').disabled = $('export').disabled;
    if ($('export-format').value === 'insert' && !result.fields?.length) $('export-format').value = 'csv';
    renderExportAction(active);
    const mode = active.readOnly ? 'read only' : result.state?.autocommit ? 'writes · auto commit' : 'writes · manual commit';
    const transaction = result.state?.inTransaction ? ' · transaction active when completed' : '';
    $('status').textContent = `${result.columns.length ? `${result.rowCount} rows` : `${result.affectedRows || 0} rows affected`}${result.truncated ? ' · limit reached, more rows available' : ''}   ·   ${Number(result.durationMs).toFixed(1)} ms   ·   ${mode}${transaction}${result.warningCount ? ` · ${result.warningCount} warnings` : ''}`;
    if (!rows.length) $('message').textContent = result.columns.length ? 'Query completed. No rows returned.' : `Statement completed. ${result.affectedRows || 0} rows affected.`;
    if (result.state?.needsReconnect) $('message').textContent += ' Session closed; reconnect explicitly before running another statement.';
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'resultAnalysis') {
      const { id, revision, requestId, analysis, error } = event.data, chart = charts.get(id);
      if (chart?.revision === revision && chart.pending === requestId) {
        chart.pending = undefined;
        chart.analysis = analysis;
        chart.error = error;
        if (current()?.id === id) render();
      }
      return;
    }
    if (event.data?.type !== 'results' || !Array.isArray(event.data.history)) return;
    const previous = history.at(-1)?.id, keepEditor = editingCell || current()?.result?.edit && !current().readOnly; history = event.data.history;
    if (editingCell && history.find(record => record.id === editingCell.id)?.result?.edit?.modelId !== editingCell.modelId) { editingCell = null; $('cell-editor').hidden = true; }
    if (history.at(-1)?.id !== previous && !keepEditor) currentId = history.at(-1)?.id;
    for (const id of drafts.keys()) if (!history.some(record => record.id === id)) drafts.delete(id);
    for (const id of browseForms.keys()) if (!history.some(record => record.id === id)) browseForms.delete(id);
    for(const id of bulkForms.keys())if(!history.some(record=>record.id===id))bulkForms.delete(id);
    for (const id of layouts.keys()) if (!history.some(record => record.id === id)) layouts.delete(id);
    for (const id of charts.keys()) if (!history.some(record => record.id === id)) charts.delete(id);
    for(const record of history){
      if(!record.result?.edit)continue;const model=record.result.edit,form=bulkForm(record),item=draft(record),source=record.bulkSource,bulk=record.bulkDraft;
      const workbook=record.xlsxWorkbook;if(workbook&&workbook.modelId===model.modelId&&workbook.id!==form.workbookId){form.workbookId=workbook.id;form.sheets=workbook.sheets;form.sheetId=workbook.sheets.find(s=>s.state==='visible')?.id||workbook.sheets[0]?.id;form.mode='import';form.format='xlsx';form.open=true;form.text='';form.sourceId=undefined;form.mapping=[];form.formulaPolicy='reject';form.blankPolicy='empty';form.hasHeader=true;}
      if(source&&source.modelId===model.modelId&&source.id!==form.lastSourceId){form.lastSourceId=source.id;form.sourceId=source.id;form.mode='import';form.format=source.format||'text';form.open=true;form.text=source.text;form.delimiter=source.delimiter;form.hasHeader=source.hasHeader;form.headers=source.headers;form.rowCount=source.rowCount;if(source.format==='xlsx')Object.assign(form,{sheetId:source.sheetId,sheetName:source.sheetName,dateSystem:source.dateSystem,formulaCount:source.formulaCount,formulaPolicy:source.formulaPolicy,blankPolicy:source.blankPolicy});form.mapping=Array.from({length:source.width},(_,index)=>({source:index,target:model.columns.find(c=>c.name===source.headers?.[index]&&c.insertable)?.name||null}));}
      if(bulk&&bulk.id!==item.lastBulk){item.lastBulk=bulk.id;if(bulk.modelId===model.modelId&&bulk.draftRevision===item.revision&&count(item)===0){item.updates=new Map(bulk.updates.map(update=>[update.rowId,update.values]));item.deletes=new Set();item.inserts=bulk.inserts.map(insert=>({id:`new-${++item.next}`,values:insert.values}));item.revision++;form.open=false;record.review=undefined;if(bulk.requiredColumns?.length)record.editMessage='Fill required new-row values before Review: '+bulk.requiredColumns.join(', ');vscode.postMessage({type:'draftChanged',id:record.id,modelId:model.modelId,count:count(item),draftRevision:item.revision});}else record.editError='The bulk draft no longer matches this page. Existing local changes were preserved.';}
    }
    render(); persist();
  });
  $('cell-null').onchange = () => { if (editingCell) showCellMode(editingCell.mode); cellError(); };
  $('cell-value').oninput = () => cellError();
  $('cell-format').onchange = () => {
    if (!editingCell) return;
    const mode = $('cell-format').value;
    try {
      const value = decodeCell($('cell-value').value, editingCell.mode);
      $('cell-value').value = encodeCell(value, mode);
      editingCell.mode = mode;
      cellError();
    } catch (error) {
      cellError(error.message);
    }
    showCellMode(editingCell.mode);
  };
  $('cancel-cell').onclick = () => { editingCell = null; $('cell-editor').hidden = true; render(); };
  $('cell-editor').onsubmit = event => {
    event.preventDefault();
    const record = current();
    if (!record || !editingCell || editingCell.id !== record.id || editingCell.modelId !== record.result?.edit?.modelId ||
        record.editBusy || record.readOnly || record.sessionState?.outcomeUnknown) return;
    const item = draft(record);
    if (item.pendingRequestId) return;
    let cell = { kind: 'null' };
    if (!$('cell-null').checked) {
      try {
        const value = decodeCell($('cell-value').value, editingCell.mode);
        if (/[\ud800-\udfff]/u.test(value)) throw Error('A cell requires valid Unicode text.');
        if (new TextEncoder().encode(value).length > cellLimit) throw Error('A staged cell must be at most 128 KiB in its database representation.');
        if (editingCell.column.kind === 'json') {
          try { JSON.parse(value); } catch { throw Error('Enter valid JSON, or select SQL NULL to clear a nullable cell.'); }
        }
        cell = { kind: 'value', text: value };
      } catch (error) {
        cellError(error.message);
        return;
      }
    }
    const candidate = { ...item, updates: new Map(item.updates), inserts: item.inserts.map(row => ({ ...row, values: { ...row.values } })) };
    if (editingCell.inserted) {
      const row = candidate.inserts.find(row => row.id === editingCell.rowId);
      if (!row) { cellError('This draft row is no longer available. Cancel the editor and select a row.'); return; }
      row.values = { ...row.values, [editingCell.column.name]: cell };
    } else candidate.updates.set(editingCell.rowId, { ...candidate.updates.get(editingCell.rowId), [editingCell.column.name]: cell });
    if (new TextEncoder().encode(JSON.stringify(changes(candidate))).length > 1024 * 1024) { cellError('The local change set must be at most 1 MiB. Apply the current batch first.'); return; }
    item.updates = candidate.updates; item.inserts = candidate.inserts;
    editingCell = null; $('cell-editor').hidden = true; changed(record);
  };
  $('cell-editor').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); $('cancel-cell').click(); } };
  $('add-row').onclick = () => {
    const record = current(), item = draft(record), layout = resultLayout(record);
    item.inserts.push({ id: `new-${++item.next}`, values: {} });
    if (layout.mode === 'record') layout.row = record.result.rows.length + item.inserts.length - 1;
    changed(record);
  };
  $('paste-cells').onclick=()=>{const form=bulkForm(current());form.mode='paste';form.format='text';form.open=true;form.sourceId=undefined;render();};
  $('import-text').onclick=()=>{const form=bulkForm(current());form.mode='import';form.format='text';form.open=true;form.sourceId=undefined;form.delimiter=',';render();};
  $('import-file').onclick=()=>send('chooseImportFile');
  $('import-xlsx').onclick=()=>send('chooseXlsxFile');
  const bulkInput=()=>{const form=bulkForm(current());if(form.format!=='xlsx'){form.text=$('bulk-text').value;form.delimiter=$('bulk-delimiter').value==='comma'?',':'\t';}form.hasHeader=$('bulk-header').checked;form.sourceId=undefined;$('bulk-stage').disabled=form.mode==='import'||!form.text;};
  $('bulk-text').oninput=bulkInput;$('bulk-delimiter').onchange=()=>{bulkInput();render();};$('bulk-header').onchange=()=>{bulkInput();render();};
  $('bulk-row').onchange=()=>{bulkForm(current()).anchorRowId=$('bulk-row').value;};$('bulk-column').onchange=()=>{bulkForm(current()).anchorColumn=$('bulk-column').value;};
  for(const [id,key]of [['xlsx-sheet','sheetId'],['xlsx-formulas','formulaPolicy'],['xlsx-blanks','blankPolicy']])$(id).onchange=()=>{const form=bulkForm(current());form[key]=$(id).value;form.sourceId=undefined;form.mapping=[];form.text='';render();};
  $('bulk-null-enabled').onchange=()=>{bulkForm(current()).nullEnabled=$('bulk-null-enabled').checked;render();};$('bulk-null-token').oninput=()=>{bulkForm(current()).nullToken=$('bulk-null-token').value;};
  $('bulk-inspect').onclick=()=>{const record=current(),form=bulkForm(record);send(form.format==='xlsx'?'inspectXlsxSheet':'inspectBulk',{modelId:record.result.edit.modelId,...(form.format==='xlsx'?{workbookId:form.workbookId,sheetId:form.sheetId,formulaPolicy:form.formulaPolicy,blankPolicy:form.blankPolicy}:{text:form.text,delimiter:form.delimiter}),hasHeader:form.hasHeader});};
  $('bulk-form').onsubmit=event=>{event.preventDefault();const record=current(),form=bulkForm(record);send('prepareBulk',{operation:form.mode,modelId:record.result.edit.modelId,text:form.text,delimiter:form.delimiter,sourceId:form.sourceId,mapping:form.mapping,anchorRowId:form.anchorRowId,anchorColumn:form.anchorColumn,...(form.format!=='xlsx'&&form.nullEnabled?{nullToken:form.nullToken}:{})});};
  $('bulk-cancel').onclick=()=>{bulkForm(current()).open=false;render();};
  $('discard').onclick = () => { const record = current(), item = draft(record); item.updates.clear(); item.deletes.clear(); item.inserts = []; changed(record); };
  $('review').onclick = () => send('reviewChanges', { changes: changes(draft(current())) });
  $('apply').onclick = () => send('applyChanges', { reviewId: current()?.review?.reviewId });
  for (const [id, type] of [['enable-edit', 'enableEdit'], ['restore-browsing', 'restoreBrowsing'], ['commit', 'commitChanges'], ['rollback', 'rollbackChanges'], ['reload', 'reloadTable']]) $(id).onclick = () => send(type);
  $('copy').onclick = () => send('copy');
  $('export-format').onchange = () => renderExportAction(current());
  $('export').onclick = () => {
    const format = $('export-format').value;
    if (format !== 'insert') { send('export', { format }); return; }
    const record = current(), fields = record.result.fields;
    insertExport = { id: record.id, modelId: record.result.edit?.modelId };
    const first = fields[0];
    const oneTable = first?.originalTable && fields.every(field => field.originalTable === first.originalTable && field.schema === first.schema);
    $('export-table').value = oneTable ? first.originalTable : '';
    $('export-schema').value = oneTable ? first.schema : '';
    $('export-columns').value = '';
    $('export-columns').setCustomValidity('');
    renderExportAction(record);
    $('export-table').focus();
  };
  $('export-cancel').onclick = () => { insertExport = undefined; renderExportAction(current()); };
  $('export-columns').oninput = () => $('export-columns').setCustomValidity('');
  $('insert-export').onsubmit = event => {
    event.preventDefault();
    if (!insertExport || $('insert-export').hidden) return;
    const target = { table: $('export-table').value, schema: $('export-schema').value };
    const columns = $('export-columns');
    if (columns.value.trim()) {
      try { target.columns = JSON.parse(columns.value); }
      catch { columns.setCustomValidity('Enter destination column names as a JSON array, for example ["id", "name"].'); columns.reportValidity(); return; }
    }
    send('export', { format: 'insert', destination: target });
    insertExport = undefined;
    renderExportAction(current());
  };
  function updateResultLayout(action) {
    const record = current();
    if (!record?.result) return;
    action(resultLayout(record), record);
    persist();
    render();
  }
  $('result-view').onchange = () => updateResultLayout(layout => { layout.mode = $('result-view').value; });
  $('chart-shape').onchange = () => {
    const record = current();
    if (!record?.chart) return;
    chartFor(record).shape = $('chart-shape').value;
    render();
  };
  function changeChartOptions() {
    const record = current();
    if (!record?.chart) return;
    const chart = chartFor(record);
    const category = $('chart-category').value;
    chart.category = category === '' ? null : Number(category);
    chart.operation = $('chart-operation').value;
    const selected = $('chart-measure').value;
    const choices = chart.operation === 'nonnull' ? record.result.columns.map((_, index) => index) : record.chart.numeric;
    chart.measure = chart.operation === 'count' ? null :
      selected !== '' && choices.includes(Number(selected)) ? Number(selected) : choices[0] ?? null;
    useChart(record, chart, 'analyzeResult');
    render();
  }
  for (const id of ['chart-category', 'chart-operation', 'chart-measure']) $(id).onchange = changeChartOptions;
  $('chart-export').onclick = () => {
    const record = current();
    if (!record?.chart) return;
    const chart = chartFor(record);
    if (chart.analysis) useChart(record, chart, 'exportAnalysis');
  };
  $('result-columns').onclick = () => updateResultLayout(layout => { layout.open = !layout.open; });
  $('result-row-previous').onclick = () => updateResultLayout(layout => { layout.row--; });
  $('result-row-next').onclick = () => updateResultLayout(layout => { layout.row++; });
  $('result-column-reset').onclick = () => updateResultLayout((layout, record) => {
    layout.order = record.result.columns.map((_, index) => index);
    layout.hidden.clear();
    layout.pinned.clear();
    layout.widths = {};
    saveColumnLayout(record, layout, true);
  });
  $('close-result').onclick = () => send('closeResult');
  function browse(page, size) { const record = current(), query = record?.result?.edit?.query; if (query) send('browseTable', { query: { ...query, page, pageSize: size ?? query.pageSize } }); }
  $('page-previous').onclick = () => browse(current().result.browse.page - 1);
  $('page-next').onclick = () => browse(current().result.browse.page + 1);
  $('page-size').onchange = () => browse(0, Number($('page-size').value));
  $('browse-options').onclick = () => { const form = browseForms.get(current()?.id); if (form) { form.expanded = !form.expanded; render(); } };
  $('browse-form').onsubmit = event => { event.preventDefault(); const record = current(), form = browseForms.get(record?.id); if (form) send('browseTable', { query: { page: 0, pageSize: record.result.browse.pageSize, sort: form.sort, filters: form.filters.map(rule => ({ column: rule.column, operator: rule.operator, ...(['isNull', 'isNotNull'].includes(rule.operator) ? {} : { value: rule.value || { kind: 'value', text: '' } }) })) } }); };
  $('clear-browse').onclick = () => send('browseTable', { query: { page: 0, pageSize: current().result.browse.pageSize, sort: [], filters: [] } });
  vscode.postMessage({ type: 'ready' });
})();
