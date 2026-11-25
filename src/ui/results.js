'use strict';
(() => {
  const vscode = acquireVsCodeApi();
  let history = [], currentId = null, editingCell = null, requestSequence = 0;
  let renderedWindow, scrollTop = 0;
  const drafts = new Map(), browseForms = new Map(),bulkForms=new Map(), layouts = new Map();
  const charts = new Map();
  const maps = new Map();
  const comparisons = new Map();
  const statementChoices = new Map();
  const statementKey = entry => entry.resultSet===undefined?String(entry.index):entry.index+'|'+entry.resultSet;
  const viewModes = ['grid', 'record', 'tree', 'text', 'transpose', 'chart', 'compare', 'map'];
  const editableModes = new Set(['grid', 'record']);
  let insertExport;
  let chartObserver;
  let mapObserver;
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
    if (item.pendingRequestId && record.editResponseId === item.pendingRequestId) {
      item.pendingRequestId = undefined;
      item.pendingScrollMode = undefined;
    }
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
    if (['copy', 'export', 'closeResult', 'openRelatedRows', 'returnToRelatedSource', 'setResultPin', 'renameResult',
      'openScriptStatement', 'saveFilterPreset', 'removeFilterPreset', 'saveSortPreset', 'removeSortPreset'].includes(type)) {
      vscode.postMessage({ type, id: record.id, ...payload }); return;
    }
    const item = draft(record);
    if (item.pendingRequestId || record.editBusy) return;
    const requestId=`${record.id}:${Date.now()}:${++requestSequence}`,message={type,id:record.id,requestId,draftRevision:item.revision,...payload};
    if(new TextEncoder().encode(JSON.stringify(message)).length>1100000){record.editError='This request exceeds the table input limit. Use a smaller batch; no data was staged.';render();return;}
    item.pendingRequestId = requestId;
    if (type === 'setContinuousScroll') item.pendingScrollMode = payload.enabled;
    persist(); render();
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
      form = { modelId: model.modelId, expanded: form?.expanded || false, sort: structuredClone(browse.sort || []),
        filters: structuredClone(browse.filters || []), selectedSort: form?.selectedSort, selectedFilter: form?.selectedFilter, search: '' };
      browseForms.set(record.id, form);
    }
    const session = record.sessionState || result.state, item = draft(record);
    const pending = record.editBusy || item.pendingRequestId || record.editExpired || session?.needsReconnect || session?.outcomeUnknown;
    const localChanges = count(item) > 0 || record.review || editingCell?.id === record.id;
    const blocked = Boolean(pending || localChanges || (!browse.keyset && session?.inTransaction) || session?.transactionState === 'unknown');
    $('page-previous').disabled = blocked || !browse.pageable || !browse.hasPrevious;
    $('page-next').disabled = blocked || !browse.pageable || browse.hasNext !== true || (!browse.keyset && browse.page >= 2000);
    $('continuous-scroll-choice').hidden = !browse.keyset;
    $('continuous-scroll').checked = item.pendingScrollMode ?? Boolean(browse.window);
    $('continuous-scroll').disabled = blocked;
    $('page-size').disabled = blocked;
    $('page-size').value = String(browse.pageSize);
    if (!$('page-size').value) {
      const option = document.createElement('option'); option.value = option.textContent = String(browse.pageSize); $('page-size').append(option); $('page-size').value = option.value;
    }
    const range = browse.window;
    $('page-label').textContent = (range && range.firstPage !== range.lastPage ? `Pages ${range.firstPage + 1}–${range.lastPage + 1}` : `Page ${(range?.firstPage ?? browse.page) + 1}`) +
      ` · ${result.rowCount} rows` + (browse.keyset ? ' · Read snapshot' : '');
    $('browse-options').disabled = Boolean(pending); $('browse-options').setAttribute('aria-expanded', String(form.expanded));
    $('browse-form').hidden = !form.expanded;
    const scalar = model.columns.filter(column => !['binary', 'json', 'unsupported'].includes(column.kind));
    const select = (label, choices, value, change) => {
      const control = document.createElement('select'); control.setAttribute('aria-label', label); control.disabled = blocked;
      for (const choice of choices) { const option = document.createElement('option'); option.value = choice.value; option.textContent = choice.label; control.append(option); }
      control.value = value; control.onchange = () => change(control.value); return control;
    };
    const remove = (label, action) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Remove'; button.setAttribute('aria-label', label); button.disabled = blocked; button.onclick = action; return button; };
    renderSortRules(browse.sortOptions, scalar, form, blocked, select, remove);
    renderFilterRules(record, form, scalar, blocked, select, remove);
    renderSortPresets(record, form, blocked);
    renderFilterPresets(record, form, blocked);
    $('apply-browse').disabled = $('clear-browse').disabled = blocked;
    $('browse-status').textContent = localChanges ? 'Apply or discard staged changes before changing pages, sorting or filters.'
      : range ? 'Scroll to load the next or previous rows in this snapshot. Copy and export use the retained rows.'
      : browse.keyset ? 'Pages share a single read-only table snapshot.'
      : session?.inTransaction ? 'Commit or roll back the current transaction before changing pages, sorting or filters.'
      : !browse.pageable ? 'First page only: this table has no primary key.' : 'Server-side results. Concurrent data changes may move rows between pages.';
  }
  function renderSortRules(sortOptions, scalar, form, blocked, select, remove) {
    const columns = sortOptions?.columns || scalar;
    const used = new Set(form.sort.map(rule => rule.column));
    const chooseColumn = (rule, column) => {
      rule.column = column.name;
      delete rule.collation;
      delete rule.jsonPath;
      delete rule.jsonType;
      delete rule.expression;
      if (column.expression) rule.expression = column.expression;
      if (column.jsonScalar && sortOptions.snapshot) {
        rule.jsonType = 'text';
        rule.jsonPath = '$';
      }
    };
    const move = (index, delta) => {
      const button = document.createElement('button'), destination = index + delta;
      button.type = 'button';
      button.textContent = delta < 0 ? '↑' : '↓';
      button.setAttribute('aria-label', 'Move sort ' + (index + 1) + (delta < 0 ? ' up' : ' down'));
      button.disabled = blocked || destination < 0 || destination >= form.sort.length;
      button.onclick = () => { form.sort.splice(destination, 0, form.sort.splice(index, 1)[0]); render(); };
      return button;
    };
    const rowFor = (rule, index) => {
      const row = document.createElement('div'), position = index + 1;
      row.className = 'browse-rule';
      const choices = columns.filter(column => column.name === rule.column || !used.has(column.name));
      const column = columns.find(item => item.name === rule.column);
      row.append(select('Sort column ' + position, choices.map(item => ({ value: item.name, label: item.name })), rule.column, value => {
        chooseColumn(rule, columns.find(item => item.name === value));
        render();
      }), select('Sort direction ' + position, [{ value: 'asc', label: 'Ascending' }, { value: 'desc', label: 'Descending' }], rule.direction, value => { rule.direction = value; }));
      if (sortOptions) {
        row.append(select('Sort NULLs ' + position, [{ value: '', label: 'Server NULL order' }, { value: 'first', label: 'NULLs first' },
          { value: 'last', label: 'NULLs last' }], rule.nulls || '', value => { if (value) rule.nulls = value; else delete rule.nulls; }));
        const collations = Object.hasOwn(sortOptions.collations, column?.charset) ? sortOptions.collations[column.charset] : [];
        if (collations.length) row.append(select('Sort collation ' + position,
          [{ value: '', label: 'Column collation' }, ...collations.map(name => ({ value: name, label: name }))], rule.collation || '',
          value => { if (value) rule.collation = value; else delete rule.collation; }));
        if (column?.jsonScalar) {
          const types = [
            ...(!sortOptions.snapshot ? [{ value: '', label: 'Document expression' }] : []),
            { value: 'integer', label: 'JSON integer' }, { value: 'boolean', label: 'JSON boolean' },
            { value: 'text', label: 'JSON UTF-8 text (binary)' }
          ];
          row.append(select('JSON sort type ' + position, types, rule.jsonType || '', value => {
            if (value) {
              rule.jsonType = value;
              rule.jsonPath ??= '$';
              delete rule.expression;
            } else chooseColumn(rule, column);
            render();
          }));
        }
        if (rule.jsonType) {
          const path = document.createElement('input');
          path.type = 'text';
          path.maxLength = 128;
          path.disabled = blocked;
          path.spellcheck = false;
          path.setAttribute('aria-label', 'JSON sort path ' + position);
          path.placeholder = '$.items[0].name';
          path.title = 'Use a single path with member names and array indexes. Missing, NULL and mismatched values sort as NULL.';
          path.value = rule.jsonPath || '';
          path.oninput = () => { rule.jsonPath = path.value; };
          row.append(path);
        } else if (!sortOptions.snapshot) {
          const expression = document.createElement('input');
          expression.type = 'text';
          expression.maxLength = 256;
          expression.disabled = blocked;
          expression.spellcheck = false;
          expression.setAttribute('aria-label', 'Sort expression ' + position);
          expression.placeholder = 'Optional sort expression';
          expression.title = 'Exact column names, arithmetic, ABS, LOWER, UPPER, TRIM, CHAR_LENGTH, JSON_TEXT or BYTE_PREFIX';
          expression.value = rule.expression || '';
          expression.oninput = () => { if (expression.value.trim()) rule.expression = expression.value; else delete rule.expression; };
          row.append(expression);
        }
      }
      row.append(move(index, -1), move(index, 1), remove('Remove sort ' + position, () => { form.sort.splice(index, 1); render(); }));
      return row;
    };
    $('sort-rules').replaceChildren(...form.sort.map(rowFor));
    $('add-sort').disabled = blocked || form.sort.length >= Math.min(columns.length, 8);
    $('add-sort').onclick = () => {
      const column = columns.find(item => !used.has(item.name));
      if (!column) return;
      const rule = { direction: 'asc' };
      chooseColumn(rule, column);
      form.sort.push(rule);
      render();
    };
  }
  const filterLabels = { eq: 'Equals', ne: 'Does not equal', lt: 'Less than', lte: 'At most', gt: 'Greater than', gte: 'At least',
    contains: 'Contains text', startsWith: 'Starts with', endsWith: 'Ends with', isNull: 'Is NULL', isNotNull: 'Is not NULL' };
  function filterOperators(column) {
    return ['json', 'binary', 'unsupported'].includes(column?.kind) ? ['isNull', 'isNotNull'] :
      ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', ...(column?.kind === 'text' ? ['contains', 'startsWith', 'endsWith'] : []), 'isNull', 'isNotNull'];
  }
  function filterInput(filters) {
    return filters.map(rule => rule.logic ? { logic: rule.logic, filters: filterInput(rule.filters) } : {
      column: rule.column, operator: rule.operator,
      ...(['isNull', 'isNotNull'].includes(rule.operator) ? {} : { value: rule.value || { kind: 'value', text: '' } })
    });
  }
  function renderFilterRules(record, form, scalar, blocked, select, remove) {
    const columns = record.result.edit.columns;
    const columnChoices = columns.map(column => ({ value: column.name, label: column.name }));
    const first = scalar[0] || columns[0];
    let leaves = 0, groups = 0;
    const count = rules => rules.forEach(rule => {
      if (rule.logic) { groups++; count(rule.filters); }
      else leaves++;
    });
    count(form.filters);
    const disabledAdd = blocked || !first || leaves >= 20;
    const canAdd = rules => !disabledAdd && rules.length < 20;
    const blank = () => ({ column: first.name, operator: filterOperators(first)[0], value: { kind: 'value', text: '' } });
    const add = (rules, isGroup) => {
      rules.push(isGroup ? { logic: 'or', filters: [blank()] } : blank());
      render();
    };
    const addButton = (text, label, rules, isGroup, depth) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = text;
      button.setAttribute('aria-label', label);
      button.disabled = !canAdd(rules) || (isGroup && (depth >= 3 || groups >= 20));
      button.onclick = () => add(rules, isGroup);
      return button;
    };
    function renderRules(rules, depth, prefix = '') {
      return rules.map((rule, index) => {
        const position = prefix + (index + 1);
        const discard = remove(rule.logic ? 'Remove filter group ' + position : 'Remove filter ' + position,
          () => { rules.splice(index, 1); render(); });
        discard.disabled = blocked || (depth > 0 && rules.length === 1);
        if (rule.logic) {
          const section = document.createElement('fieldset'), title = document.createElement('legend');
          section.className = 'browse-group';
          title.textContent = 'Group ' + position;
          const header = document.createElement('div');
          header.className = 'browse-actions';
          header.append(select('Filter group ' + position + ' mode', [
            { value: 'and', label: 'All match (AND)' }, { value: 'or', label: 'Any match (OR)' }
          ], rule.logic, value => { rule.logic = value; }), discard);
          section.append(title, header, ...renderRules(rule.filters, depth + 1, position + '.'),
            addButton('Add Filter', 'Add filter in group ' + position, rule.filters, false, depth + 1),
            addButton('Add Group', 'Add group in group ' + position, rule.filters, true, depth + 1));
          return section;
        }
        const row = document.createElement('div');
        row.className = 'browse-rule';
        const column = columns.find(column => column.name === rule.column);
        row.append(select('Filter column ' + position, columnChoices, rule.column, value => {
          rule.column = value;
          const operators = filterOperators(columns.find(column => column.name === value));
          if (!operators.includes(rule.operator)) rule.operator = operators[0];
          render();
        }), select('Filter operator ' + position, filterOperators(column).map(value => ({ value, label: filterLabels[value] })),
          rule.operator, value => { rule.operator = value; render(); }));
        const input = document.createElement('input');
        input.type = 'text';
        input.autocomplete = 'off';
        input.spellcheck = false;
        input.setAttribute('aria-label', 'Filter value ' + position);
        input.placeholder = column?.type || 'Value';
        input.value = rule.value?.text || '';
        input.disabled = blocked || ['isNull', 'isNotNull'].includes(rule.operator);
        input.oninput = () => { rule.value = { kind: 'value', text: input.value }; };
        row.append(input, discard);
        return row;
      });
    }
    $('filter-rules').replaceChildren(...renderRules(form.filters, 0));
    $('add-filter').disabled = !canAdd(form.filters);
    $('add-filter-group').disabled = !canAdd(form.filters) || groups >= 20;
    $('add-filter').onclick = () => add(form.filters, false);
    $('add-filter-group').onclick = () => add(form.filters, true);
    const search = $('browse-search-column'), input = $('browse-search-text'), button = $('browse-search-add');
    $('column-search').hidden = !scalar.length;
    if (!scalar.length) return;
    const column = scalar.find(item => item.name === form.searchColumn) || scalar[0];
    options(search, scalar.map(item => ({ value: item.name, label: item.name })), column.name);
    search.disabled = input.disabled = !canAdd(form.filters);
    const operator = column.kind === 'text' ? 'contains' : 'eq';
    input.placeholder = filterLabels[operator] + ' · ' + column.type;
    input.value = form.search;
    button.disabled = !canAdd(form.filters) || !form.search;
    search.onchange = () => { form.searchColumn = search.value; render(); };
    input.oninput = () => { form.search = input.value; button.disabled = !canAdd(form.filters) || !form.search; };
    button.onclick = () => {
      form.filters.push({ column: column.name, operator, value: { kind: 'value', text: form.search } });
      form.search = '';
      render();
    };
  }
  function renderFilterPresets(record, form, blocked) {
    const presets = record.filterPresets;
    $('filter-presets').hidden = !presets;
    if (!presets) return;
    const select = $('saved-filter'), current = presets.find(item => item.name === form.selectedFilter);
    options(select, [{ value: '', label: 'Choose a saved filter' }, ...presets.map(item => ({
      value: item.name, label: item.name + (item.applicable ? '' : ' (columns changed)')
    }))], current?.name || '');
    select.disabled = blocked;
    select.onchange = () => { form.selectedFilter = select.value; render(); };
    $('load-filter').disabled = blocked || !current?.applicable;
    $('load-filter').onclick = () => { form.filters = structuredClone(current.filters); render(); };
    $('remove-filter').disabled = blocked || !current;
    $('remove-filter').onclick = () => send('removeFilterPreset', { name: current.name, modelId: form.modelId });
    const saved = record.result.browse.filters || [];
    $('save-filter').disabled = blocked || !saved.length;
    $('save-filter').onclick = () => send('saveFilterPreset', { name: current?.name, modelId: form.modelId });
  }
  function renderSortPresets(record, form, blocked) {
    const presets = record.sortPresets;
    $('sort-presets').hidden = !presets;
    if (!presets) return;
    const select = $('saved-sort'), preset = presets.find(item => item.name === form.selectedSort);
    options(select, [{ value: '', label: 'Choose a saved sort' }, ...presets.map(item => ({
      value: item.name, label: item.name + (item.applicable ? '' : ' (metadata changed)')
    }))], preset?.name || '');
    select.disabled = blocked;
    select.onchange = () => { form.selectedSort = select.value; render(); };
    $('load-sort').disabled = blocked || !preset?.applicable;
    $('load-sort').onclick = () => { form.sort = structuredClone(preset.sort); render(); };
    $('remove-sort').disabled = blocked || !preset;
    $('remove-sort').onclick = () => send('removeSortPreset', { name: preset.name, modelId: form.modelId });
    $('save-sort').disabled = blocked || !record.result.browse.sort?.length;
    $('save-sort').onclick = () => send('saveSortPreset', { name: preset?.name, modelId: form.modelId });
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

  const rowNumber = (result, index) => (result.browse?.window?.firstPage ?? result.browse?.page ?? 0) * (result.browse?.pageSize || 0) + index + 1;
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
      const id = (model || record.result.relatedRows)?.rowIds[index];
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
    const model = record.result.edit || record.result.relatedRows;
    const session = record.sessionState;
    if (!model || !row.id || row.inserted || !record.readOnly || session?.inTransaction || session?.needsReconnect ||
        session?.outcomeUnknown || record.closing || record.editBusy || record.hasDraft || record.review ||
        draft(record).pendingRequestId) return;
    const open = document.createElement('button');
    open.textContent = compact ? '↗' : 'Related Rows';
    open.title = 'Follow a foreign key or saved logical relationship from this row';
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
    const coverage = analysis.page === undefined ? 'captured rows' : analysis.lastPage > analysis.page
      ? `captured rows on table pages ${analysis.page}–${analysis.lastPage}` : 'captured rows on table page ' + analysis.page;
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

  function compareForm(target) {
    let form = comparisons.get(target.id);
    if (form?.revision !== target.chart.revision) {
      form = { revision: target.chart.revision, sourceId: null, mapping: [], selected: new Set(), page: 0 };
      comparisons.set(target.id, form);
    }
    return form;
  }
  function clearComparison(form) {
    form.report = form.pending = form.error = undefined;
    form.selected.clear();
    form.page = 0;
  }
  function comparisonSources(target) {
    return history.filter(record => record.id !== target.id && record.state === 'done' && record.chart &&
      !record.hasDraft && !record.editBusy && !record.review && !record.sessionState?.outcomeUnknown);
  }

  function renderMappings(target, source, form, busy) {
    const panel = $('compare-mappings');
    panel.replaceChildren();
    if (!source) return;
    for (const [index, pair] of form.mapping.entries()) {
      const line = document.createElement('div');
      line.className = 'compare-pair';
      for (const [side, record, title] of [['target', target, 'Destination column'], ['source', source, 'Source column']]) {
        const label = document.createElement('label'), control = document.createElement('select');
        control.setAttribute('aria-label', title + ' ' + (index + 1));
        control.disabled = busy;
        options(control, record.result.columns.flatMap((name, column) =>
          column === pair[side] || !form.mapping.some(other => other[side] === column) ?
            [{ value: String(column), label: (column + 1) + '. ' + name }] : []), String(pair[side]));
        control.onchange = () => { pair[side] = Number(control.value); clearComparison(form); render(); };
        label.append(title, control);
        line.append(label);
      }
      const keyLabel = document.createElement('label'), check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = pair.key;
      check.disabled = busy;
      check.setAttribute('aria-label', 'Match key ' + (index + 1));
      check.onchange = () => { pair.key = check.checked; clearComparison(form); render(); };
      keyLabel.append(check, 'Match key');
      const remove = document.createElement('button');
      remove.textContent = 'Remove Pair';
      remove.setAttribute('aria-label', 'Remove column pair ' + (index + 1));
      remove.disabled = busy;
      remove.onclick = () => { form.mapping.splice(index, 1); clearComparison(form); render(); };
      line.append(keyLabel, remove);
      panel.append(line);
    }
  }
  const comparisonPageSize = 24;
  function renderComparisonTable(form, allowStage) {
    const report = form.report, table = document.createElement('table');
    if (!report.oneSidedChanges && (report.summary.targetOnly || report.summary.sourceOnly)) {
      const scope = document.createElement('p');
      scope.textContent = 'Compare complete unfiltered tables with matching integer primary keys to stage inserts or deletes.';
      $('grid').append(scope);
    }
    table.className = 'comparison-data';
    const head = table.createTHead().insertRow(), body = table.createTBody();
    for (const label of ['Stage', 'Matched key', 'Change', 'Mapped differences']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      head.append(cell);
    }
    const start = form.page * comparisonPageSize, entries = report.rows.slice(start, start + comparisonPageSize);
    for (const item of entries) {
      const row = body.insertRow(), selected = row.insertCell(), key = row.insertCell(), change = row.insertCell();
      if (allowStage && item.canStage) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = form.selected.has(item.index);
        check.setAttribute('aria-label', 'Stage comparison row ' + (item.index + 1));
        check.onchange = () => {
          if (check.checked) form.selected.add(item.index); else form.selected.delete(item.index);
          $('compare-stage').disabled = !form.selected.size;
        };
        selected.append(check);
      }
      presentValue(key, JSON.stringify(item.key));
      const stateLabel = { changed: 'Different', 'target-only': 'Destination capture only', 'source-only': 'Source capture only' }[item.state];
      const operationLabel = { update: 'Update', insert: 'Insert', delete: 'Delete' }[item.operation];
      presentValue(change, operationLabel ? stateLabel + ' · ' + operationLabel : stateLabel);
      const detail = row.insertCell();
      if (item.reason) detail.title = item.reason;
      if (item.fields?.length) {
        const disclosure = document.createElement('details'), label = document.createElement('summary');
        label.textContent = item.fields.length + ' changed fields';
        disclosure.append(label);
        for (const field of item.fields) {
          const group = document.createElement('div'), title = document.createElement('strong');
          title.textContent = field.targetName + (field.targetName === field.sourceName ? '' : ' ← ' + field.sourceName);
          group.append(title);
          for (const [name, value] of [['Destination', field.target], ['Source', field.source]]) {
            const line = document.createElement('div'), key = document.createElement('span'), literal = document.createElement('pre');
            key.textContent = name;
            literal.textContent = value === null ? 'SQL NULL' : JSON.stringify(value);
            line.className = 'comparison-values';
            line.append(key, literal);
            group.append(line);
          }
          disclosure.append(group);
        }
        detail.append(disclosure);
      }
    }
    $('grid').append(table);
    if (report.rows.length <= comparisonPageSize) return;
    const controls = document.createElement('div');
    controls.className = 'compare-pages';
    for (const [step, label] of [[-1, 'Previous Differences'], [1, 'Next Differences']]) {
      const button = document.createElement('button');
      button.textContent = label;
      button.disabled = step < 0 ? !form.page : start + entries.length >= report.rows.length;
      button.onclick = () => { form.page += step; render(); };
      controls.append(button);
    }
    controls.append(`${start + 1}–${start + entries.length} of ${report.rows.length} differences`);
    $('grid').prepend(controls);
  }

  function renderCompare(target, busy) {
    const form = compareForm(target), candidates = comparisonSources(target);
    const source = candidates.find(record => record.id === form.sourceId);
    $('compare-tools').hidden = false;
    options($('compare-source'), [{ value: '', label: 'Choose a result tab' }, ...candidates.map(record =>
      ({ value: String(record.id), label: 'Result ' + record.id + ' · ' + record.source }))], source ? String(source.id) : '');
    $('compare-source').disabled = busy;
    if (source && form.sourceRevision !== source.chart.revision) {
      form.sourceRevision = source.chart.revision;
      form.mapping = [];
      clearComparison(form);
    }
    if (!source) clearComparison(form);
    const maxPairs = Math.min(64, target.result.columns.length, source?.result.columns.length || 0);
    $('compare-add').disabled = busy || form.mapping.length >= maxPairs;
    $('compare-run').disabled = busy || !source || !form.mapping.some(pair => pair.key);
    renderMappings(target, source, form, busy);
    const report = form.report;
    const pendingDraft = target.bulkDraft?.modelId === target.result.edit?.modelId &&
      target.bulkDraft?.draftRevision === (target.draftRevision || 0);
    const allowStage = !busy && !target.readOnly && !pendingDraft && !source?.sessionState?.inTransaction && Boolean(report?.stageableRows);
    $('compare-stage').textContent = report?.oneSidedChanges ? 'Stage Selected Changes' : 'Stage Selected Updates';
    $('compare-stage').disabled = !allowStage || !form.selected.size;
    if (form.error) { $('compare-status').textContent = form.error; return; }
    if (!report) {
      $('compare-status').textContent = form.pending ? 'Comparing captured rows…' : 'Pair columns and mark a unique key. The current result is the destination.';
      return;
    }
    const { equal, changed, targetOnly, sourceOnly } = report.summary;
    const partial = report.target.partial || report.source.partial ? ' · at least one capture is filtered or paged' : '';
    const destination = allowStage ? ' Select changed matched rows to stage updates.' : target.readOnly ?
      ' Enable editing in Grid or Record to stage updates.' : source?.sessionState?.inTransaction ?
        ' Finish the source transaction and capture fresh rows before staging.' : ' Staging requires the complete destination primary key and editable changed fields.';
    $('compare-status').textContent = `${equal} equal · ${changed} different · ${targetOnly} destination only · ${sourceOnly} source only${partial}.${destination}`;
    if (report.rows.length) renderComparisonTable(form, allowStage);
  }

  function mapView(record) {
    const revision = record.chart.revision;
    let view = maps.get(record.id);
    if (view?.revision !== revision) {
      const prior = view?.column;
      view = { revision, column: record.mapColumns.includes(prior) ? prior : record.mapColumns[0] };
      maps.set(record.id, view);
    }
    return view;
  }

  function requestMap(record, column) {
    const view = { revision: record.chart.revision, column, pending: ++requestSequence };
    maps.set(record.id, view);
    vscode.postMessage({ type: 'mapResult', id: record.id, revision: view.revision, column, requestId: view.pending });
  }

  function mapButton(label, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.onclick = action;
    return button;
  }

  function mapSelect(parent, name, values, selected, change) {
    const label = document.createElement('label'), select = document.createElement('select');
    label.append(name, select);
    options(select, values, selected);
    select.onchange = () => change(select.value);
    parent.append(label);
    return select;
  }

  function mapFit(extent, canvas, geographic) {
    const [west, south, east, north] = extent;
    const minimum = geographic ? 0.06 : 0.0001;
    const scale = Math.min((canvas.clientWidth - 52) / Math.max(east - west, minimum),
      (canvas.clientHeight - 46) / Math.max(north - south, minimum));
    return { x: (west + east) / 2, y: (south + north) / 2, scale: Math.max(1e-12, scale) };
  }

  function mapStep(span) {
    const power = 10 ** Math.floor(Math.log10(span));
    return power * ([1, 2, 5, 10].find(factor => factor * power >= span) || 10);
  }

  const mapLongitude = x => x - 360 * Math.floor((x + 180) / 360);

  function renderMapCanvas(canvas, features, land, frame, selected, geographic) {
    const width = canvas.clientWidth, height = canvas.clientHeight, ratio = window.devicePixelRatio || 1;
    if (width < 60 || height < 60) return [];
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return [];
    ctx.scale(ratio, ratio);
    const colors = getComputedStyle(document.body);
    const color = (name, fallback) => colors.getPropertyValue('--vscode-' + name).trim() || fallback;
    const x = value => width / 2 + (value - frame.x) * frame.scale;
    const y = value => height / 2 - (value - frame.y) * frame.scale;
    const centerOffset = center => 360 * Math.round((frame.x - center) / 360);
    const offsets = center => {
      const offset = centerOffset(center);
      return geographic ? [offset - 360, offset, offset + 360] : [0];
    };
    const left = geographic ? Math.max(0, x(frame.x - 180)) : 0;
    const right = geographic ? Math.min(width, x(frame.x + 180)) : width;
    const top = geographic ? Math.max(0, y(90)) : 0;
    const bottom = geographic ? Math.min(height, y(-90)) : height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    function path(rings, offset, closed) {
      const result = new Path2D();
      for (const points of rings) {
        for (const [index, [longitude, latitude]] of points.entries()) {
          const drawX = x(longitude + offset), drawY = y(latitude);
          if (index === 0) result.moveTo(drawX, drawY);
          else result.lineTo(drawX, drawY);
        }
        if (closed) result.closePath();
      }
      return result;
    }
    if (geographic) {
      ctx.fillStyle = color('editorWidget-background', '#eaf2f8');
      ctx.fillRect(left, top, right - left, bottom - top);
      ctx.fillStyle = color('descriptionForeground', '#708e9f');
      ctx.strokeStyle = color('descriptionForeground', '#84909b');
      ctx.lineWidth = 0.75;
      for (const offset of offsets(0)) for (const polygon of land) {
        const coastline = path(polygon, offset, true);
        ctx.globalAlpha = 0.43;
        ctx.fill(coastline, 'evenodd');
        ctx.globalAlpha = 0.78;
        ctx.stroke(coastline);
      }
      ctx.globalAlpha = 1;
    }
    const gridStep = mapStep(Math.max(width, height) / (frame.scale * 8));
    const dx = width / frame.scale / 2, dy = height / frame.scale / 2;
    ctx.strokeStyle = color('panel-border', '#57616a');
    ctx.fillStyle = color('descriptionForeground', '#aeb8c0');
    ctx.font = '10px sans-serif';
    function tick(value, horizontal) {
      if (!geographic) return Number(value.toPrecision(5)).toString();
      const coord = horizontal ? mapLongitude(value) : value;
      const number = Number(Math.abs(coord).toFixed(5));
      return number === 0 ? '0°' : number + '°' + (horizontal ? coord < 0 ? 'W' : 'E' : coord < 0 ? 'S' : 'N');
    }
    const grid = (center, halfSpan, horizontal) => {
      const first = Math.ceil((center - halfSpan) / gridStep) * gridStep;
      for (let index = 0; index < 16; index++) {
        const value = first + index * gridStep;
        if (value > center + halfSpan) break;
        if (geographic && !horizontal && Math.abs(value) > 90) continue;
        const pixel = horizontal ? x(value) : y(value);
        ctx.beginPath();
        ctx.moveTo(horizontal ? pixel : 0, horizontal ? 0 : pixel);
        ctx.lineTo(horizontal ? pixel : width, horizontal ? height : pixel);
        ctx.stroke();
        ctx.fillText(tick(value, horizontal), horizontal ? pixel + 5 : left + 6,
          horizontal ? top + 14 : Math.max(top + 10, pixel - 4));
      }
    };
    grid(frame.x, dx, true);
    grid(frame.y, dy, false);
    const hit = [];
    for (const feature of features) for (const part of feature.parts) {
      const first = part.rings?.[0][0] ?? part.points[0];
      const isSelected = feature.row === selected;
      ctx.strokeStyle = ctx.fillStyle = isSelected ? color('charts-orange', '#f59c42') : color('charts-blue', '#3794ff');
      ctx.lineWidth = isSelected ? 3 : 1.65;
      for (const offset of offsets(first[0])) {
        let shape;
        if (part.type === 'point') {
          shape = new Path2D();
          shape.arc(x(first[0] + offset), y(first[1]), isSelected ? 6 : 4, 0, Math.PI * 2);
          ctx.fill(shape);
        } else {
          shape = path(part.rings ?? [part.points], offset, part.type === 'polygon');
          if (part.type === 'polygon') {
            ctx.globalAlpha = 0.27;
            ctx.fill(shape, 'evenodd');
            ctx.globalAlpha = 1;
          }
          ctx.stroke(shape);
        }
        hit.push({ shape, row: feature.row, filled: part.type !== 'line' });
      }
    }
    const ratioAtCenter = geographic ? 111.32 * Math.cos(frame.y * Math.PI / 180) : 1;
    if (ratioAtCenter > 0.01) {
      const distance = mapStep(Math.min(95, (right - left) * 0.16) * ratioAtCenter / frame.scale / 2);
      const bar = distance * frame.scale / ratioAtCenter;
      ctx.strokeStyle = ctx.fillStyle = color('foreground', '#eee');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(right - 14 - bar, bottom - 14);
      ctx.lineTo(right - 14, bottom - 14);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText((geographic ? '≈ ' : '') + Number(distance.toPrecision(5)) + (geographic ? ' km' : ' units'),
        right - 14, bottom - 20);
    }
    ctx.restore();
    ctx.lineWidth = 10;
    return hit.map(item => ({ row: item.row, contains(px, py) {
      return px >= left && px <= right && py >= top && py <= bottom &&
        (item.filled && ctx.isPointInPath(item.shape, px * ratio, py * ratio, 'evenodd') ||
          ctx.isPointInStroke(item.shape, px * ratio, py * ratio));
    } }));
  }

  function renderMap(record, layout, busy) {
    const view = mapView(record);
    const panel = document.createElement('section'), controls = document.createElement('div'), status = document.createElement('div');
    panel.className = 'result-map-panel';
    panel.setAttribute('aria-label', 'Captured result map');
    controls.className = 'map-controls';
    status.className = 'map-status';
    status.setAttribute('role', 'status');
    panel.append(controls, status);
    $('grid').append(panel);
    mapSelect(controls, 'Geometry column', record.mapColumns.map(index => ({
      value: String(index), label: record.result.columns[index] + ' · column ' + (index + 1)
    })), String(view.column), value => { requestMap(record, Number(value)); render(); }).disabled = busy;
    if (busy) { status.textContent = 'Finish the current result action before viewing its map.'; return; }
    if (!view.map) {
      if (!view.pending && !view.error) requestMap(record, view.column);
      status.textContent = view.error || 'Reading captured geometries…';
      return;
    }
    const { groups, land, mappedRows, rows, outsideLimit, omitted, partial } = view.map;
    status.textContent = [mappedRows + ' of ' + rows + ' captured rows mapped', ...(partial ? ['partial result'] : []),
      ...omitted.map(({ reason, count }) => count + ' ' + reason), ...(outsideLimit ? [outsideLimit + ' beyond map row limit'] : [])].join(' · ');
    if (!groups.length) return;
    const group = groups.find(item => item.kind === view.kind) || groups[0], geographic = group.kind === 'geographic';
    view.kind = group.kind;
    if (groups.length > 1) mapSelect(controls, 'Coordinates', groups.map(({ kind }) => ({
      value: kind, label: kind === 'geographic' ? 'Geographic' : 'Cartesian SRID 0'
    })), view.kind, value => { view.kind = value; view.frame = undefined; view.selected = undefined; render(); });
    const featureLabel = feature => 'Row ' + rowNumber(record.result, feature.row) + ' · ' + feature.family + ' · SRID ' + feature.srid;
    const selected = () => group.features.find(item => item.row === view.selected);
    if (!selected()) view.selected = group.features[0].row;
    const rowPicker = mapSelect(controls, 'Feature', group.features.map(item => ({ value: String(item.row), label: featureLabel(item) })),
      String(view.selected), value => { view.selected = Number(value); draw(); });
    const canvas = document.createElement('canvas'), note = document.createElement('div');
    canvas.className = 'result-map-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('aria-label', 'Geometry map. Use arrow keys to pan, plus and minus to zoom, or Home to fit captured rows.');
    note.className = 'map-status';
    note.textContent = geographic ? 'Longitude/latitude · EPSG:4326 and reprojected 3857 · Made with Natural Earth' : 'Cartesian XY · SRID 0';
    panel.append(canvas, note);
    let hits = [], drag;
    function draw() {
      if (canvas.clientWidth < 60 || canvas.clientHeight < 60) return;
      view.frame ||= mapFit(group.extent, canvas, geographic);
      hits = renderMapCanvas(canvas, group.features, land, view.frame, view.selected, geographic);
    }
    function fit(extent = group.extent) { view.frame = mapFit(extent, canvas, geographic); draw(); }
    function zoom(multiplier) {
      if (!view.frame) return;
      const minimum = geographic ? Math.min(0.5, mapFit([-180, -90, 180, 90], canvas, true).scale) : 1e-12;
      view.frame.scale = Math.max(minimum, Math.min(1e7, view.frame.scale * multiplier));
      draw();
    }
    function pan(dx, dy) {
      if (!view.frame) return;
      const limit = geographic ? 90 : 2e12;
      view.frame.x += dx / view.frame.scale;
      view.frame.y = Math.max(-limit, Math.min(limit, view.frame.y + dy / view.frame.scale));
      if (geographic) view.frame.x = mapLongitude(view.frame.x);
      else view.frame.x = Math.max(-limit, Math.min(limit, view.frame.x));
      draw();
    }
    controls.append(mapButton('Fit Rows', () => fit()), mapButton('Zoom In', () => zoom(1.5)),
      mapButton('Zoom Out', () => zoom(1 / 1.5)), mapButton('Open Record', () => {
        layout.row = view.selected;
        layout.mode = 'record';
        persist();
        render();
      }));
    if (geographic) controls.append(mapButton('World', () => fit([-180, -90, 180, 90])));
    canvas.addEventListener('keydown', event => {
      const actions = { ArrowLeft: () => pan(-42, 0), ArrowRight: () => pan(42, 0), ArrowUp: () => pan(0, 42),
        ArrowDown: () => pan(0, -42), Home: () => fit(), '+': () => zoom(1.5), '=': () => zoom(1.5),
        '-': () => zoom(1 / 1.5) };
      if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
    });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      zoom(event.deltaY < 0 ? 1.25 : 0.8);
    }, { passive: false });
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      canvas.setPointerCapture(event.pointerId);
      drag = { x: event.clientX, y: event.clientY, moved: false };
    });
    canvas.addEventListener('pointermove', event => {
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag = { x: event.clientX, y: event.clientY, moved: true };
      pan(-dx, dy);
    });
    canvas.addEventListener('pointercancel', () => { drag = undefined; });
    canvas.addEventListener('pointerup', event => {
      if (drag && !drag.moved) {
        const { left, top } = canvas.getBoundingClientRect();
        const feature = hits.findLast(item => item.contains(event.clientX - left, event.clientY - top));
        if (feature) { view.selected = feature.row; rowPicker.value = String(feature.row); draw(); }
      }
      drag = undefined;
    });
    draw();
    mapObserver = new ResizeObserver(draw);
    mapObserver.observe(canvas);
  }

  function renderResultLayout(record, layout, rows, { busy, needsDraftView }) {
    const result = record.result, order = columnOrder(layout);
    const visible = order.filter(index => !layout.hidden.has(index));
    if ((needsDraftView && !editableModes.has(layout.mode)) || !result.columns.length ||
        layout.mode === 'map' && !record.mapColumns?.length) layout.mode = 'grid';
    const selector = $('result-view');
    selector.value = layout.mode;
    selector.disabled = busy || !result.columns.length;
    for (const option of selector.options) option.disabled = needsDraftView && !editableModes.has(option.value) ||
      option.value === 'map' && !record.mapColumns?.length;
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
    const numberWidth = enabled ? 104 : active.readOnly && (result.edit || result.relatedRows) ? 80 : 56;
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
      tr.dataset.resultRowIndex = rowIndex;
      if (result.browse?.window) tr.dataset.snapshotRow = row.number;
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
    $('export').textContent = format === 'extractor' ? 'Export with Extractor' : 'Export ' + labels[format];
    const result = record?.result;
    const blocked = $('export').disabled || !result || insertExport?.id !== record.id ||
      insertExport?.modelId !== result.edit?.modelId || format !== 'insert';
    if (blocked) insertExport = undefined;
    $('insert-export').hidden = blocked;
  }

  function resultTabs() {
    return [...$('tabs').querySelectorAll('button[role="tab"]:not(:disabled)')];
  }
  function focusResultTab(button) {
    for (const tab of resultTabs()) tab.tabIndex = tab === button ? 0 : -1;
    (button || $('tabs')).focus();
  }
  function renderResultTabs(active) {
    const list = $('tabs'), panel = $('result-content'), previous = document.activeElement;
    const restore = list.contains(previous) && previous !== list;
    const focused = restore ? previous.id : undefined;
    list.replaceChildren(...history.map(record => {
      const button = document.createElement('button'), label = record.tabName || 'Result ' + record.id;
      const selected = record.id === currentId;
      button.id = 'query-result-' + record.id;
      button.textContent = label + (record.state === 'running' ? ' …' : record.state === 'error' ? ' !' : '');
      button.className = selected ? 'active' : '';
      button.title = record.sql;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(selected));
      button.setAttribute('aria-controls', panel.id);
      button.tabIndex = selected ? 0 : -1;
      if (record.tabPinned) { button.classList.add('retained'); button.setAttribute('aria-label', label + ' (pinned)'); }
      button.disabled = Boolean(editingCell && record.id !== editingCell.id);
      button.onclick = () => {
        currentId = record.id;
        render();
        focusResultTab($(button.id));
      };
      return button;
    }));
    if (active) {
      panel.setAttribute('aria-labelledby', 'query-result-' + active.id);
      panel.removeAttribute('aria-label');
    } else {
      panel.removeAttribute('aria-labelledby');
      panel.setAttribute('aria-label', 'Query result');
    }
    $('focus-query-editor').hidden = !active?.hasQueryEditor;
    if (restore) {
      const tabs = resultTabs();
      focusResultTab(tabs.find(button => button.id === focused) || tabs.find(button => button.tabIndex === 0));
    }
  }
  function returnToQuery() {
    const record = current();
    if (record?.hasQueryEditor) vscode.postMessage({ type: 'focusQueryEditor', id: record.id });
  }

  function render() {
    const active = current();
    const grid = $('grid'), windowId = active?.result?.browse?.window?.id;
    const anchor = renderedWindow === windowId && windowId ? visibleScrollAnchor(grid) : null;
    renderedWindow = undefined;
    grid.removeAttribute('tabindex');
    if (active) currentId = active.id;
    const origin = active?.relatedOrigin;
    const source = origin && history.find(record => {
      const model = record.result?.edit || record.result?.relatedRows;
      return record.id === origin.id && model?.modelId === origin.modelId && model.rowIds.includes(origin.rowId);
    });
    $('return-source-row').hidden = !source;
    $('return-source-row').disabled = Boolean(editingCell || active?.editBusy || source?.editBusy);
    renderResultTabs(active);
    chartObserver?.disconnect();
    chartObserver = undefined;
    mapObserver?.disconnect();
    mapObserver = undefined;
    grid.replaceChildren();
    $('chart-tools').hidden = true;
    $('compare-tools').hidden = true;
    const exportable = Boolean(active?.state === 'done' && active.result?.columns.length && !active.editBusy &&
      !active.hasDraft && !active.review && !active.sessionState?.outcomeUnknown && !draft(active).pendingRequestId);
    $('copy').disabled = $('export').disabled = $('export-format').disabled = !exportable;
    $('copy').title = $('export').title = 'Use all captured rows and columns, including hidden columns.';
    if (windowId) $('copy').title = $('export').title = 'Use all rows and columns in the retained scroll window.';
    $('result-view').disabled = true;
    $('result-layout').hidden = $('result-column-panel').hidden = true;
    renderExportAction(active);
    $('close-result').disabled = !active || active.state === 'running' || active.editBusy || Boolean(editingCell || active && draft(active).pendingRequestId);
    const pin = $('pin-result'), statement = $('script-result-selection'), captured = active?.result?.scriptStatements;
    pin.disabled = $('rename-result').disabled = $('close-result').disabled;
    pin.textContent = active?.tabPinned ? 'Unpin Result' : 'Pin Result';
    pin.setAttribute('aria-pressed', String(active?.tabPinned === true));
    $('script-result-sets').hidden = !captured?.length;
    if (captured?.length) {
      const procedure = active.result.captureKind === 'procedure';
      const outputs = procedure && active.result.procedureOutputAvailable;
      $('script-result-label').textContent = outputs ? 'Procedure results' : procedure ? 'Procedure result set' : 'Statement result';
      $('open-script-statement').textContent = outputs ? 'Open Result' : procedure ? 'Open Result Set' : 'Open Captured Statement';
      const prior = statementChoices.get(active.id);
      const selected = captured.some(item=>statementKey(item)===prior)?prior:statementKey(captured[0]);
      options(statement,captured.map(item=>({value:statementKey(item),label:item.label})),selected);
    }
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
    if (layout.mode === 'grid') {
      renderGrid(active, result, rows, enabled, layout, columns);
      if (windowId) {
        grid.tabIndex = 0;
        renderedWindow = windowId;
        restoreScrollAnchor(grid, anchor);
        scrollTop = grid.scrollTop;
      }
    }
    else if (layout.mode === 'record') renderRecord(active, rows[layout.row], columns, enabled);
    else {
      $('edit-tools').hidden = $('edit-status').hidden = $('review-panel').hidden = $('bulk-panel').hidden = true;
      if (layout.mode === 'chart') renderChart(active, busy);
      else if (layout.mode === 'compare') renderCompare(active, busy);
      else if (layout.mode === 'map') renderMap(active, layout, busy);
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

  function visibleScrollAnchor(grid) {
    const top = grid.getBoundingClientRect().top;
    const edge = top + (grid.querySelector('thead')?.getBoundingClientRect().height || 0);
    const row = [...grid.querySelectorAll('[data-snapshot-row]')].find(item => item.getBoundingClientRect().bottom > edge);
    return row ? { row: row.dataset.snapshotRow, offset: row.getBoundingClientRect().top - top, left: grid.scrollLeft } : null;
  }

  function restoreScrollAnchor(grid, anchor) {
    if (!anchor) return;
    const row = grid.querySelector('[data-snapshot-row="' + anchor.row + '"]');
    if (row) grid.scrollTop += row.getBoundingClientRect().top - grid.getBoundingClientRect().top - anchor.offset;
    grid.scrollLeft = anchor.left;
  }

  function moveScroll(direction, nearEdge = false) {
    const record = current();
    if (!record?.result?.browse?.window || renderedWindow !== record.result.browse.window.id) return;
    const forward = direction === 'next', grid = $('grid');
    const edge = forward ? grid.scrollHeight - grid.clientHeight - grid.scrollTop : grid.scrollTop;
    if ($('page-' + direction).disabled || (nearEdge && edge > 112)) return;
    send('scrollTable', { direction, modelId: record.result.edit.modelId });
  }
  window.addEventListener('message', event => {
    if (event.data?.type === 'focusResults') {
      if (editingCell && !$('cell-editor').hidden) $('cell-value').focus();
      else focusResultTab(resultTabs().find(button => button.getAttribute('aria-selected') === 'true'));
      return;
    }
    if (event.data?.type === 'returnToQuery') {
      returnToQuery();
      return;
    }
    if (event.data?.type === 'activateResult') {
      const { id, rowId, modelId } = event.data;
      const record = history.find(item => item.id === id);
      if ((!editingCell || editingCell.id === id) && record) {
        let row;
        const model = record.result?.edit || record.result?.relatedRows;
        if (rowId && model?.modelId === modelId) {
          row = model.rowIds.indexOf(rowId);
          if (row >= 0) resultLayout(record).row = row;
        }
        currentId = id;
        render();
        if (row >= 0) $('grid').querySelector('[data-result-row-index="' + row + '"]')?.scrollIntoView?.({ block: 'nearest' });
      }
      return;
    }
    if (event.data?.type === 'datasetComparison' || event.data?.type === 'datasetStageError') {
      const { id, comparison, error, requestId, type } = event.data, form = comparisons.get(id);
      if (form && (type === 'datasetStageError' || form.pending === requestId)) {
        form.pending = undefined;
        form.report = comparison;
        form.error = error;
        if (current()?.id === id) render();
      }
      return;
    }
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
    if (event.data?.type === 'resultMap') {
      const { id, revision, requestId, map, error } = event.data, view = maps.get(id);
      if (view?.revision === revision && view.pending === requestId) {
        view.pending = undefined;
        view.map = map;
        view.error = error;
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
    for (const id of maps.keys()) if (!history.some(record => record.id === id)) maps.delete(id);
    for (const id of comparisons.keys()) if (!history.some(record => record.id === id)) comparisons.delete(id);
    for (const id of statementChoices.keys()) if (!history.some(record => record.id === id)) statementChoices.delete(id);
    for(const record of history){
      if(!record.result?.edit)continue;const model=record.result.edit,form=bulkForm(record),item=draft(record),source=record.bulkSource,bulk=record.bulkDraft;
      const workbook=record.xlsxWorkbook;if(workbook&&workbook.modelId===model.modelId&&workbook.id!==form.workbookId){form.workbookId=workbook.id;form.sheets=workbook.sheets;form.sheetId=workbook.sheets.find(s=>s.state==='visible')?.id||workbook.sheets[0]?.id;form.mode='import';form.format='xlsx';form.open=true;form.text='';form.sourceId=undefined;form.mapping=[];form.formulaPolicy='reject';form.blankPolicy='empty';form.hasHeader=true;}
      if(source&&source.modelId===model.modelId&&source.id!==form.lastSourceId){form.lastSourceId=source.id;form.sourceId=source.id;form.mode='import';form.format=source.format||'text';form.open=true;form.text=source.text;form.delimiter=source.delimiter;form.hasHeader=source.hasHeader;form.headers=source.headers;form.rowCount=source.rowCount;if(source.format==='xlsx')Object.assign(form,{sheetId:source.sheetId,sheetName:source.sheetName,dateSystem:source.dateSystem,formulaCount:source.formulaCount,formulaPolicy:source.formulaPolicy,blankPolicy:source.blankPolicy});form.mapping=Array.from({length:source.width},(_,index)=>({source:index,target:model.columns.find(c=>c.name===source.headers?.[index]&&c.insertable)?.name||null}));}
      if(bulk&&bulk.id!==item.lastBulk){item.lastBulk=bulk.id;if(bulk.modelId===model.modelId&&bulk.draftRevision===item.revision&&count(item)===0){item.updates=new Map(bulk.updates.map(update=>[update.rowId,update.values]));item.deletes=new Set(bulk.deletes);item.inserts=bulk.inserts.map(insert=>({id:`new-${++item.next}`,values:insert.values}));item.revision++;form.open=false;record.review=undefined;if(bulk.requiredColumns?.length)record.editMessage='Fill required new-row values before Review: '+bulk.requiredColumns.join(', ');vscode.postMessage({type:'draftChanged',id:record.id,modelId:model.modelId,count:count(item),draftRevision:item.revision});}else record.editError='The bulk draft no longer matches this page. Existing local changes were preserved.';}
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
  $('compare-source').onchange = () => {
    const target = current();
    if (!target?.chart) return;
    const form = compareForm(target);
    form.sourceId = Number($('compare-source').value) || null;
    form.mapping = [];
    clearComparison(form);
    render();
  };
  $('compare-add').onclick = () => {
    const target = current();
    if (!target?.chart) return;
    const form = compareForm(target), source = comparisonSources(target).find(record => record.id === form.sourceId);
    if (!source) return;
    const unused = (side, index) => !form.mapping.some(pair => pair[side] === index);
    const left = target.result.columns.findIndex((_, index) => unused('target', index));
    const sameName = source.result.columns.findIndex((name, index) => name === target.result.columns[left] && unused('source', index));
    const right = sameName < 0 ? source.result.columns.findIndex((_, index) => unused('source', index)) : sameName;
    if (left < 0 || right < 0) return;
    form.mapping.push({ target: left, source: right, key: false });
    clearComparison(form);
    render();
  };
  $('compare-run').onclick = () => {
    const target = current();
    if (!target?.chart) return;
    const form = compareForm(target), source = comparisonSources(target).find(record => record.id === form.sourceId);
    if (!source) return;
    clearComparison(form);
    form.pending = ++requestSequence;
    vscode.postMessage({ type: 'compareDatasets', id: target.id, sourceId: source.id, requestId: form.pending,
      targetRevision: target.chart.revision, sourceRevision: source.chart.revision, mapping: form.mapping });
    render();
  };
  $('compare-stage').onclick = () => {
    const target = current();
    if (!target?.chart || !target.result.edit) return;
    const form = compareForm(target);
    if (!form.report || !form.selected.size) return;
    const input = { reviewId: form.report.reviewId, rows: [...form.selected], modelId: target.result.edit.modelId };
    clearComparison(form);
    send('stageDatasetComparison', input);
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
  $('focus-query-editor').onclick = returnToQuery;
  $('tabs').addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const tabs = resultTabs(), index = tabs.indexOf(event.target);
    if (index < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      event.key === 'ArrowRight' ? (index + 1) % tabs.length :
      event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    focusResultTab(tabs[next]);
  });
  $('tabs').addEventListener('focusout', event => {
    if ($('tabs').contains(event.relatedTarget)) return;
    for (const button of resultTabs()) {
      button.tabIndex = button.getAttribute('aria-selected') === 'true' ? 0 : -1;
    }
  });
  $('return-source-row').onclick = () => send('returnToRelatedSource');
  $('pin-result').onclick = () => send('setResultPin', { pinned: !current()?.tabPinned });
  $('rename-result').onclick = () => send('renameResult');
  $('script-result-selection').onchange = () => {
    if (current()) statementChoices.set(current().id,$('script-result-selection').value);
  };
  $('open-script-statement').onclick = () => {
    const [index,resultSet]=$('script-result-selection').value.split('|').map(Number);
    send('openScriptStatement',{index,...(resultSet!==undefined&&{resultSet})});
  };
  function browse(page, size) { const record = current(), query = record?.result?.edit?.query; if (query) send('browseTable', { query: { ...query, page, pageSize: size ?? query.pageSize } }); }
  const movePage = direction => {
    const view = current().result.browse;
    if (view.window) {
      if (renderedWindow === view.window.id) moveScroll(direction);
      else send('scrollTable', { direction, modelId: current().result.edit.modelId });
    } else browse(view.page + (direction === 'next' ? 1 : -1));
  };
  $('page-previous').onclick = () => movePage('previous');
  $('page-next').onclick = () => movePage('next');
  $('continuous-scroll').onchange = () => send('setContinuousScroll', {
    enabled: $('continuous-scroll').checked, modelId: current().result.edit.modelId
  });
  $('grid').addEventListener('scroll', () => {
    const top = $('grid').scrollTop, direction = top > scrollTop ? 'next' : 'previous';
    const moved = top !== scrollTop;
    scrollTop = top;
    if (moved) moveScroll(direction, true);
  }, { passive: true });
  $('grid').addEventListener('wheel', event => {
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && !event.ctrlKey && !event.shiftKey) {
      moveScroll(event.deltaY > 0 ? 'next' : 'previous', true);
    }
  }, { passive: true });
  $('grid').addEventListener('keydown', event => {
    if (event.target !== $('grid')) return;
    if (['PageDown', 'ArrowDown', 'End'].includes(event.key)) moveScroll('next', true);
    else if (['PageUp', 'ArrowUp', 'Home'].includes(event.key)) moveScroll('previous', true);
  });
  $('page-size').onchange = () => browse(0, Number($('page-size').value));
  $('browse-options').onclick = () => { const form = browseForms.get(current()?.id); if (form) { form.expanded = !form.expanded; render(); } };
  $('browse-form').onsubmit = event => { event.preventDefault(); const record = current(), form = browseForms.get(record?.id); if (form) send('browseTable', { query: { page: 0, pageSize: record.result.browse.pageSize, sort: form.sort, filters: filterInput(form.filters) } }); };
  $('clear-browse').onclick = () => send('browseTable', { query: { page: 0, pageSize: current().result.browse.pageSize, sort: [], filters: [] } });
  vscode.postMessage({ type: 'ready' });
})();
