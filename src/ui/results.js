'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  let history = [], currentId = null, editingCell = null, requestSequence = 0;
  const drafts = new Map(), browseForms = new Map(),bulkForms=new Map();
  for (const [id, item] of vscode.getState?.()?.drafts || []) drafts.set(id, { ...item, updates: new Map(item.updates), deletes: new Set(item.deletes) });
  const $ = id => document.getElementById(id);
  const text = value => value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value);
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
  function persist() { vscode.setState?.({ drafts: [...drafts].map(([id, item]) => [id, { ...item, updates: [...item.updates], deletes: [...item.deletes] }]) }); }
  const count = item => [...item.updates.keys()].filter(id => !item.deletes.has(id)).length + item.deletes.size + item.inserts.length;
  function changes(item) {
    return { updates: [...item.updates].filter(([rowId]) => !item.deletes.has(rowId)).map(([rowId, values]) => ({ rowId, values })), deletes: [...item.deletes], inserts: item.inserts.map(row => ({ values: row.values })) };
  }
  function send(type, payload = {}) {
    const record = current(); if (!record) return;
    if (['copy', 'export', 'closeResult'].includes(type)) { vscode.postMessage({ type, id: record.id, ...payload }); return; }
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
  function openCell(record, rowId, column, value, inserted = false) {
    editingCell = { id: record.id, rowId, column, inserted, modelId: record.result.edit.modelId };
    $('cell-label').textContent = `${column.name} · ${column.type}`;
    $('cell-value').value = value === null || value === undefined ? '' : String(value);
    $('cell-null').checked = value === null;
    $('cell-null').disabled = !column.nullable;
    $('cell-value').disabled = value === null;
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
    const options=(control,values,value)=>{control.replaceChildren(...values.map(v=>{const option=document.createElement('option');option.value=v.value;option.textContent=v.label;return option;}));control.value=value||'';};
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
    const blocked = Boolean(record.editBusy || item.pendingRequestId || record.editExpired || session?.needsReconnect);
    const enabled = model.canEdit && !record.readOnly && !blocked;
    const dirty = count(item) > 0;
    $('enable-edit').hidden = !record.readOnly;
    $('enable-edit').disabled = blocked || !model.canEdit;
    $('restore-browsing').hidden = record.readOnly;
    $('restore-browsing').disabled = blocked || dirty || cellOpen;
    $('add-row').disabled = !enabled || model.insertable === false || count(item) >= 500;
    $('add-row').title = model.insertable === false ? 'A required column cannot be inserted safely.' : 'Stage a new row';
    for(const id of ['paste-cells','import-text','import-file','import-xlsx'])$(id).disabled=!enabled||dirty||cellOpen||(id!=='paste-cells'&&model.insertable===false);
    $('discard').disabled = !dirty || record.editBusy || Boolean(item.pendingRequestId);
    $('review').disabled = !enabled || !dirty || cellOpen;
    $('apply').disabled = !enabled || !record.review || cellOpen;
    $('commit').disabled = !enabled || dirty || !session?.inTransaction || cellOpen;
    $('rollback').disabled = !enabled || dirty || !session?.inTransaction || cellOpen;
    $('reload').disabled = blocked || dirty || cellOpen;
    if (dirty || cellOpen) {
      $('copy').disabled = $('export').disabled = true;
      $('copy').title = $('export').title = 'Apply or discard local drafts before copying the server result.';
    } else $('copy').title = $('export').title = '';
    $('draft-count').textContent = `${count(item)} staged row changes`;
    $('edit-status').className = record.editError || session?.outcomeUnknown ? 'error' : '';
    $('edit-status').textContent = record.editError || record.editMessage || model.reason || (record.readOnly ? 'Enable Editing to stage changes. Apply and Commit are separate actions.' : 'Double-click a cell or press Enter/F2. Values remain local until Review and Apply.');
    if (session?.outcomeUnknown) $('edit-status').textContent += ' Write outcome unknown. Inspect the server before retrying.';
    if (session?.needsReconnect) $('edit-status').textContent += ' Reconnect this console explicitly; then discard drafts and reload.';
    if (record.review) $('review-sql').textContent = record.review.statements.map((statement, index) => `${index + 1}. ${statement.sql}\nBound values: ${JSON.stringify(statement.parameters)}\n`).join('\n');
    return enabled;
  }
  function render() {
    const active = current();
    if (active) currentId = active.id;
    $('tabs').replaceChildren(...history.map(record => {
      const button = document.createElement('button'); button.textContent = `Result ${record.id}` + (record.state === 'running' ? ' …' : record.state === 'error' ? ' !' : '');
      button.className = record.id === currentId ? 'active' : ''; button.title = record.sql; button.setAttribute('aria-pressed', String(record.id === currentId));
      button.onclick = () => { currentId = record.id; editingCell = null; $('cell-editor').hidden = true; render(); }; return button;
    }));
    $('grid').replaceChildren();
    $('copy').disabled = $('export').disabled = !active?.result;
    $('close-result').disabled = !active || active.state === 'running' || active.editBusy || Boolean(active && draft(active).pendingRequestId);
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
    const result = active.result, enabled = renderTools(active, result), table = document.createElement('table');
    renderBrowse(active, result);
    renderBulk(active);
    const head = table.createTHead().insertRow();
    const corner = document.createElement('th'); corner.textContent = '#'; corner.className = 'row-number'; head.append(corner);
    result.columns.forEach((column, index) => {
      const th = document.createElement('th'); th.textContent = column; th.scope = 'col';
      const info = result.edit?.columns[index];
      if (info) th.title = `${info.type}${info.primaryKey ? ' · primary key (updates disabled)' : ''}${info.generated ? ' · generated (read only)' : ''}`;
      head.append(th);
    });
    const body = table.createTBody(), item = draft(active), model = result.edit;
    function row(values, rowId, rowNumber, inserted) {
      const tr = body.insertRow(), deleted = item.deletes.has(rowId);
      if (deleted) tr.className = 'deleted'; if (inserted) tr.classList.add('inserted');
      const number = tr.insertCell(); number.className = 'row-number'; number.textContent = String(rowNumber);
      if (enabled) {
        const remove = document.createElement('button'); remove.textContent = deleted ? 'Undo' : '−'; remove.title = deleted ? 'Undo row deletion' : 'Stage row deletion';
        remove.setAttribute('aria-label', `${deleted ? 'Restore' : 'Delete'} ${inserted ? 'new row' : 'row'} ${rowId}`);
        remove.onclick = () => {
          if (inserted) item.inserts = item.inserts.filter(row => row.id !== rowId);
          else if (deleted) item.deletes.delete(rowId); else item.deletes.add(rowId);
          changed(active);
        }; number.append(remove);
        if(!inserted){const duplicate=document.createElement('button');duplicate.textContent='⧉';duplicate.title='Stage a duplicate row without primary/generated keys';duplicate.setAttribute('aria-label','Duplicate row '+rowId);duplicate.disabled=count(item)>0||model.insertable===false||Boolean(editingCell);duplicate.onclick=()=>send('prepareBulk',{operation:'duplicate',modelId:model.modelId,rowId});number.append(duplicate);}
      }
      values.forEach((original, columnIndex) => {
        const column = model?.columns[columnIndex], values = inserted ? item.inserts.find(row => row.id === rowId)?.values : item.updates.get(rowId);
        const pending = values && Object.hasOwn(values, column?.name) ? values[column.name] : undefined;
        const value = pending ? pending.kind === 'null' ? null : pending.text : original;
        const td = tr.insertCell(); td.textContent = inserted && !pending ? 'DEFAULT' : text(value); td.title = td.textContent;
        if (value === null) td.classList.add('null'); else if (typeof value === 'number') td.classList.add('numeric');
        if (pending) td.classList.add('modified');
        if (enabled && column && (inserted ? column.insertable ?? column.editable : column.editable) && !deleted) editableCell(td, active, rowId, column, value, inserted);
      });
    }
    result.rows.forEach((values, index) => row(values, model?.rowIds[index], (result.browse?.page || 0) * (result.browse?.pageSize || 0) + index + 1, false));
    if (model) item.inserts.forEach(insert => row(result.columns.map(() => undefined), insert.id, '+', true));
    $('grid').append(table);
    const mode = active.readOnly ? 'read only' : result.state?.autocommit ? 'writes · auto commit' : 'writes · manual commit';
    const transaction = result.state?.inTransaction ? ' · transaction active when completed' : '';
    $('status').textContent = `${result.columns.length ? `${result.rowCount} rows` : `${result.affectedRows || 0} rows affected`}${result.truncated ? ' · limit reached, more rows available' : ''}   ·   ${Number(result.durationMs).toFixed(1)} ms   ·   ${mode}${transaction}${result.warningCount ? ` · ${result.warningCount} warnings` : ''}`;
    if (!result.rows.length) $('message').textContent = result.columns.length ? 'Query completed. No rows returned.' : `Statement completed. ${result.affectedRows || 0} rows affected.`;
    if (result.state?.needsReconnect) $('message').textContent += ' Session closed; reconnect explicitly before running another statement.';
  }
  window.addEventListener('message', event => {
    if (event.data?.type !== 'results' || !Array.isArray(event.data.history)) return;
    const previous = history.at(-1)?.id, keepEditor = editingCell || current()?.result?.edit && !current().readOnly; history = event.data.history;
    if (editingCell && history.find(record => record.id === editingCell.id)?.result?.edit?.modelId !== editingCell.modelId) { editingCell = null; $('cell-editor').hidden = true; }
    if (history.at(-1)?.id !== previous && !keepEditor) currentId = history.at(-1)?.id;
    for (const id of drafts.keys()) if (!history.some(record => record.id === id)) drafts.delete(id);
    for (const id of browseForms.keys()) if (!history.some(record => record.id === id)) browseForms.delete(id);
    for(const id of bulkForms.keys())if(!history.some(record=>record.id===id))bulkForms.delete(id);
    for(const record of history){
      if(!record.result?.edit)continue;const model=record.result.edit,form=bulkForm(record),item=draft(record),source=record.bulkSource,bulk=record.bulkDraft;
      const workbook=record.xlsxWorkbook;if(workbook&&workbook.modelId===model.modelId&&workbook.id!==form.workbookId){form.workbookId=workbook.id;form.sheets=workbook.sheets;form.sheetId=workbook.sheets.find(s=>s.state==='visible')?.id||workbook.sheets[0]?.id;form.mode='import';form.format='xlsx';form.open=true;form.text='';form.sourceId=undefined;form.mapping=[];form.formulaPolicy='reject';form.blankPolicy='empty';form.hasHeader=true;}
      if(source&&source.modelId===model.modelId&&source.id!==form.lastSourceId){form.lastSourceId=source.id;form.sourceId=source.id;form.mode='import';form.format=source.format||'text';form.open=true;form.text=source.text;form.delimiter=source.delimiter;form.hasHeader=source.hasHeader;form.headers=source.headers;form.rowCount=source.rowCount;if(source.format==='xlsx')Object.assign(form,{sheetId:source.sheetId,sheetName:source.sheetName,dateSystem:source.dateSystem,formulaCount:source.formulaCount,formulaPolicy:source.formulaPolicy,blankPolicy:source.blankPolicy});form.mapping=Array.from({length:source.width},(_,index)=>({source:index,target:model.columns.find(c=>c.name===source.headers?.[index]&&c.insertable)?.name||null}));}
      if(bulk&&bulk.id!==item.lastBulk){item.lastBulk=bulk.id;if(bulk.modelId===model.modelId&&bulk.draftRevision===item.revision&&count(item)===0){item.updates=new Map(bulk.updates.map(update=>[update.rowId,update.values]));item.deletes=new Set();item.inserts=bulk.inserts.map(insert=>({id:`new-${++item.next}`,values:insert.values}));item.revision++;form.open=false;record.review=undefined;if(bulk.requiredColumns?.length)record.editMessage='Fill required new-row values before Review: '+bulk.requiredColumns.join(', ');vscode.postMessage({type:'draftChanged',id:record.id,modelId:model.modelId,count:count(item),draftRevision:item.revision});}else record.editError='The bulk draft no longer matches this page. Existing local changes were preserved.';}
    }
    render(); persist();
  });
  $('cell-null').onchange = () => { $('cell-value').disabled = $('cell-null').checked; };
  $('cancel-cell').onclick = () => { editingCell = null; $('cell-editor').hidden = true; render(); };
  $('cell-editor').onsubmit = event => {
    event.preventDefault();
    const record = current();
    if (!record || !editingCell || editingCell.id !== record.id || record.editBusy || record.readOnly) return;
    const item = draft(record), cell = $('cell-null').checked ? { kind: 'null' } : { kind: 'value', text: $('cell-value').value };
    if (item.pendingRequestId) return;
    if (cell.kind === 'value' && new TextEncoder().encode(cell.text).length > 128 * 1024) { $('edit-status').textContent = 'A staged cell must be at most 128 KiB.'; $('edit-status').className = 'error'; return; }
    const candidate = { ...item, updates: new Map(item.updates), inserts: item.inserts.map(row => ({ ...row, values: { ...row.values } })) };
    if (editingCell.inserted) {
      const row = candidate.inserts.find(row => row.id === editingCell.rowId); row.values = { ...row.values, [editingCell.column.name]: cell };
    } else candidate.updates.set(editingCell.rowId, { ...candidate.updates.get(editingCell.rowId), [editingCell.column.name]: cell });
    if (new TextEncoder().encode(JSON.stringify(changes(candidate))).length > 1024 * 1024) { $('edit-status').textContent = 'The local change set must be at most 1 MiB. Apply the current batch first.'; $('edit-status').className = 'error'; return; }
    item.updates = candidate.updates; item.inserts = candidate.inserts;
    editingCell = null; $('cell-editor').hidden = true; changed(record);
  };
  $('cell-editor').onkeydown = event => { if (event.key === 'Escape') { event.preventDefault(); $('cancel-cell').click(); } };
  $('add-row').onclick = () => { const record = current(), item = draft(record); item.inserts.push({ id: `new-${++item.next}`, values: {} }); changed(record); };
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
  $('copy').onclick = () => send('copy'); $('export').onclick = () => send('export');
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
