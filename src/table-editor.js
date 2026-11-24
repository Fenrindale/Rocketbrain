'use strict';
const {randomUUID}=require('node:crypto');
const {parseDelimited,planPaste,planImport,planDuplicate}=require('./db/grid-bulk');
const {inspectXlsx,sheetToImport}=require('./db/grid-xlsx');

/** Owns the server-side association between a result tab and a table snapshot. */
class TableEditor {
  constructor({ results, connection, withSession, trusted, onStatus = () => {} }) {
    Object.assign(this, { results, connection, withSession, trusted, onStatus });
    this.contexts = new Map();
  }
  _context(id) {
    const context = this.contexts.get(id), current = this.connection();
    if (!context || !current.mysql || current.disposed || current.epoch !== context.epoch || current.db !== context.db) throw new Error('This result belongs to an inactive connection. Open the table again.');
    if (!this.trusted()) throw new Error('Trust the workspace before editing a database.');
    return context;
  }
  _record(id) {
    const record = this.results.history.find(item => item.id === id);
    if (!record) throw new Error('This result tab is no longer available.');
    return record;
  }
  _retain(context, result) {
    const modelId = result.edit?.modelId;
    if (!modelId || modelId === context.modelId) return;
    context.db.retainTableSnapshot({ sessionId: context.sessionId, modelId });
    if (context.modelId) context.db.releaseTableSnapshot({ sessionId: context.sessionId, modelId: context.modelId });
    context.modelId = modelId;
  }
  forget(id) {
    const context = this.contexts.get(id); this.contexts.delete(id);
    if (context?.modelId) { try { context.db.releaseTableSnapshot({ sessionId: context.sessionId, modelId: context.modelId }); } catch { /* Disposed connection. */ } }
  }
  async open({ table, sessionId, sql, filters = [] }) {
    const current = this.connection();
    if (!current.mysql || !this.trusted()) throw new Error('Connect to MySQL or MariaDB in a trusted workspace first.');
    const session = current.db.getSessionState(sessionId);
    const id = this.results.begin(sql, `${current.label} · ${sessionId} · ${table}`, {
      sessionId, readOnly: session.readOnly, tableLayoutConnection: current.tableLayoutConnection, table
    });
    const context = { db: current.db, epoch: current.epoch, sessionId, table, query: { page: 0, pageSize: 200, sort: [], filters } };
    this.contexts.set(id, context);
    for (const key of this.contexts.keys()) if (!this.results.history.some(record => record.id === key)) this.forget(key);
    try {
      await this.withSession(sessionId, async () => {
        this._context(id);
        const result = await context.db.previewTable(table, { sessionId, ...context.query });
        context.query = result.edit?.query || context.query;
        this._retain(context, result); this.results.finish(id, result);
        if (filters.length && result.browse?.sql) this.results.editState(id, { sql: result.browse.sql });
      });
    } catch (error) { this.results.finish(id, undefined, error.message, error.state); }
    finally { this.onStatus(); }
    return id;
  }
  relatedSnapshot(id, { rowId, modelId } = {}) {
    const context = this._context(id);
    const record = this._record(id);
    const result = record.result;
    const index = result?.edit?.rowIds?.indexOf(rowId) ?? -1;
    const validate = () => {
      if (this._context(id) !== context || this._record(id) !== record || record.result !== result ||
          index < 0 || !modelId || context.modelId !== modelId || result?.edit?.modelId !== modelId ||
          record.state !== 'done' || record.closing || record.hasDraft || record.review || record.editBusy || !record.readOnly) {
        throw Error('Choose a current saved row from a read-only table preview without local drafts.');
      }
      const session = context.db.getSessionState(context.sessionId);
      if (!session.readOnly || !session.autocommit || session.inTransaction || !session.connected ||
          session.outcomeUnknown || session.needsReconnect || session.connectionId !== result.state?.connectionId) {
        throw Error('Resolve the console session state before following a relation.');
      }
    };
    validate();
    return { db:context.db, sessionId:context.sessionId, table:context.table,
      columns:[...result.columns], values:[...result.rows[index]], validate };
  }
  async _load(id, context, message, query = context.query) {
    const result = await context.db.previewTable(context.table, { sessionId: context.sessionId, ...query });
    context.query = result.edit?.query || query;
    this._retain(context, result);
    this.results.finish(id, result);
    context.bulkSource=undefined;
    context.xlsxWorkbook=undefined;
    this.results.editState(id, { readOnly: result.state.readOnly, review: undefined,hasDraft:false,draftRevision:0,bulkSource:undefined,xlsxWorkbook:undefined,bulkDraft:undefined,editMessage: message, editError: undefined, ...(result.browse?.sql ? { sql: result.browse.sql } : {}) });
  }
  async stageDatasetChanges(id, { changes, modelId, draftRevision, requestId, assertFresh }) {
    const context = this._context(id), record = this._record(id);
    const verify = () => {
      this._context(id);
      assertFresh();
      const session = context.db.getSessionState(context.sessionId);
      const pendingDraft = record.bulkDraft?.modelId === modelId && record.bulkDraft?.draftRevision === (record.draftRevision || 0);
      if (record.readOnly || session.readOnly || session.needsReconnect || session.outcomeUnknown || !record.result.edit?.canEdit ||
          record.hasDraft || record.review || pendingDraft || record.result.edit.modelId !== modelId ||
          !Number.isInteger(draftRevision) || draftRevision !== (record.draftRevision || 0)) {
        throw Error('Enable editing, clear pending drafts and compare the current table snapshot again.');
      }
    };
    if (record.editBusy) throw Error('Wait for the current table operation.');
    verify();
    this.results.editState(id, { editBusy: true, editError: undefined, editMessage: undefined });
    try {
      await this.withSession(context.sessionId, async () => {
        verify();
        this.results.editState(id, { bulkDraft: { id: randomUUID(), modelId, draftRevision, ...changes },
          editMessage: 'Compared rows are staged. Review SQL, Apply, then Commit or Roll Back.' });
      });
    } finally {
      this.results.editState(id, { editBusy: false, editResponseId: requestId });
      this.onStatus();
    }
  }
  async handle(id, message) {
    let context, locked = false, completed;
    try {
      context = this._context(id);
      const record = this._record(id);
      if (record.closing) throw new Error('This result is being closed.');
      if (!record.result?.edit) throw new Error('Only an explicit table preview can be edited.');
      if (message.type === 'draftChanged') {
        if(message.modelId!==undefined&&message.modelId!==record.result.edit.modelId)return;
        if (!Number.isInteger(message.count) || message.count < 0 || message.count > 500 || !Number.isInteger(message.draftRevision) || message.draftRevision < 0) throw new Error('Invalid local draft state.');
        this.results.editState(id, { hasDraft: message.count > 0, draftRevision: message.draftRevision, ...(!record.editBusy ? { review: undefined } : {}) }); return;
      }
      if (message.type === 'invalidateReview') { if (!record.editBusy) this.results.editState(id, { review: undefined }); return; }
      if (!['enableEdit', 'reviewChanges', 'applyChanges', 'commitChanges', 'rollbackChanges', 'reloadTable', 'browseTable', 'restoreBrowsing','inspectBulk','inspectXlsx','inspectXlsxSheet','prepareBulk'].includes(message.type)) return;
      if (record.editBusy) throw new Error('Wait for this table operation to finish.');
      locked = true;
      this.results.editState(id, { editBusy: true, editError: undefined, editMessage: undefined,bulkDraft:undefined });
      await this.withSession(context.sessionId, async () => {
        this._context(id);
        if(['inspectBulk','inspectXlsx','inspectXlsxSheet','prepareBulk'].includes(message.type)){
          const session=context.db.getSessionState(context.sessionId),model=record.result.edit;
          if(record.readOnly||session.readOnly||!model.canEdit||session.needsReconnect||session.outcomeUnknown)throw new Error('Enable editing on a connected writable table before staging bulk changes.');
          if(record.hasDraft||record.review)throw new Error('Apply or discard the current local draft before staging a bulk change.');
          if(message.modelId!==model.modelId||!Number.isInteger(message.draftRevision)||message.draftRevision!== (record.draftRevision||0))throw new Error('The table snapshot or local draft changed. Open the bulk review again.');
          if(message.nullToken!==undefined&&(typeof message.nullToken!=='string'||!message.nullToken||message.nullToken.length>100))throw new Error('Use an explicit nonempty NULL token of at most 100 characters.');
          if(message.type==='inspectXlsx'){
            const book=await inspectXlsx(message.buffer);this._context(id);if(record.closing||record.result.edit.modelId!==model.modelId||record.hasDraft||record.review||message.draftRevision!==(record.draftRevision||0))throw new Error('The table or local draft changed while reading the workbook. Choose it again.');
            const workbook={id:randomUUID(),modelId:model.modelId,book,label:typeof message.label==='string'?message.label.slice(0,200):'XLSX workbook'};context.xlsxWorkbook=workbook;context.bulkSource=undefined;
            this.results.editState(id,{xlsxWorkbook:{id:workbook.id,modelId:model.modelId,label:workbook.label,sheets:book.sheets.map(({id,name,state})=>({id,name,state})),dateSystem:book.date1904?'1904':'1900'},bulkSource:undefined,editMessage:'Choose a worksheet, header and blank-cell policies. Formulas are never evaluated.'});
          }else if(message.type==='inspectXlsxSheet'){
            const workbook=context.xlsxWorkbook;if(!workbook||workbook.id!==message.workbookId||workbook.modelId!==model.modelId)throw new Error('Choose the current XLSX workbook before inspecting a worksheet.');
            const parsed=sheetToImport(workbook.book,{sheetId:message.sheetId,hasHeader:message.hasHeader===true,formulaPolicy:message.formulaPolicy,blankPolicy:message.blankPolicy}),source={id:randomUUID(),modelId:model.modelId,format:'xlsx',parsed,label:workbook.label};context.bulkSource=source;
            const text=parsed.rows.slice(0,5).map(row=>row.map(value=>value.slice(0,128)).join('\t')).join('\n');
            this.results.editState(id,{bulkSource:{id:source.id,modelId:model.modelId,format:'xlsx',text,label:source.label,headers:parsed.headers,width:parsed.width,rowCount:parsed.rowCount,sheetId:parsed.sheetId,sheetName:parsed.sheetName,dateSystem:parsed.dateSystem,hasHeader:parsed.hasHeader,formulaPolicy:parsed.formulaPolicy,blankPolicy:parsed.blankPolicy,formulaCount:parsed.formulaCount,blankCells:parsed.blankCells},editMessage:'Map worksheet fields, then stage the import. No database changes have been submitted.'});
          }else if(message.type==='inspectBulk'){
            const parsed=parseDelimited(message.text,{delimiter:message.delimiter,hasHeader:message.hasHeader===true});
            const source={id:randomUUID(),modelId:model.modelId,text:message.text,delimiter:parsed.delimiter,hasHeader:parsed.hasHeader,headers:parsed.headers,width:parsed.width,rowCount:parsed.rowCount,label:typeof message.label==='string'?message.label.slice(0,200):'Pasted CSV/TSV'};
            context.bulkSource=source;context.xlsxWorkbook=undefined;this.results.editState(id,{bulkSource:source,xlsxWorkbook:undefined,editMessage:'Map source fields, then stage the import. No database changes have been submitted.'});
          }else{
            let changes;
            if(message.operation==='duplicate')changes=planDuplicate(model,record.result,message.rowId);
            else if(message.operation==='paste')changes=planPaste(model,parseDelimited(message.text,{delimiter:message.delimiter,hasHeader:false}),message);
            else if(message.operation==='import'){
              const source=context.bulkSource;if(!source||source.id!==message.sourceId||source.modelId!==model.modelId)throw new Error('Inspect the current import source before staging an import.');
              if(source.format==='xlsx'&&message.nullToken!==undefined)throw new Error('XLSX blank-cell policies are separate from CSV unquoted NULL tokens.');
              changes=planImport(model,source.format==='xlsx'?source.parsed:parseDelimited(source.text,{delimiter:source.delimiter,hasHeader:source.hasHeader}),message);
            }else throw new Error('Choose paste, duplicate or import.');
            this.results.editState(id,{bulkDraft:{id:randomUUID(),modelId:model.modelId,draftRevision:message.draftRevision,...changes},editMessage:changes.requiredColumns?.length?'Fill required new-row values before Review: '+changes.requiredColumns.join(', '):'Bulk changes validated. Review SQL, Apply, then Commit or Roll Back.'});
          }
        }else if (message.type === 'restoreBrowsing') {
          if (record.hasDraft || record.review) throw new Error('Apply or discard local drafts before switching to read-only browsing.');
          await context.db.rollback({ sessionId: context.sessionId });
          completed = 'Transaction rolled back.';
          await context.db.setAutocommit(true, { sessionId: context.sessionId });
          await context.db.setReadOnly(true, { sessionId: context.sessionId });
          await this._load(id, context, 'Transaction rolled back. Read-only server browsing enabled.');
        } else if (message.type === 'browseTable') {
          const session = context.db.getSessionState(context.sessionId);
          if (record.hasDraft || record.review || session.inTransaction || session.outcomeUnknown || session.needsReconnect || session.transactionState === 'unknown') throw new Error('Apply or discard local drafts, then commit or roll back the transaction before changing pages, sorting or filters.');
          if (!message.query || typeof message.query !== 'object' || Array.isArray(message.query) || Buffer.byteLength(JSON.stringify(message.query), 'utf8') > 70000 || Object.keys(message.query).some(key => !['page', 'pageSize', 'sort', 'filters'].includes(key))) throw new Error('Invalid table browsing options.');
          await this._load(id, context, 'Server page, sorting and filters refreshed. Concurrent database changes may move rows between pages.', message.query);
        } else if (message.type === 'enableEdit') {
          await context.db.setReadOnly(false, { sessionId: context.sessionId });
          await context.db.setAutocommit(false, { sessionId: context.sessionId });
          await this._load(id, context, 'Editing enabled. Stage changes, review SQL, apply, then commit or roll back.');
        } else if (message.type === 'reloadTable') {
          await this._load(id, context, 'Table reloaded in the current session.');
        } else if (message.type === 'reviewChanges') {
          const changes = message.changes;
          if (!changes || Buffer.byteLength(JSON.stringify(changes), 'utf8') > 1024 * 1024 || !Array.isArray(changes.updates) || !Array.isArray(changes.inserts) || !Array.isArray(changes.deletes)) throw new Error('The change set is invalid or exceeds 1 MiB.');
          if (changes.updates.length + changes.inserts.length + changes.deletes.length > 500) throw new Error('Review at most 500 changed rows at a time.');
          // No identifiers, source values or SQL supplied by the Webview are trusted.
          const review = await context.db.reviewChangeSet({ sessionId: context.sessionId, modelId: record.result.edit.modelId, updates: changes.updates, inserts: changes.inserts, deletes: changes.deletes });
          this.results.editState(id, { review: { ...review, draftRevision: message.draftRevision }, editMessage: 'Review the parameterized statements and values. Apply runs them; Commit persists the transaction.' });
        } else if (message.type === 'applyChanges') {
          if (!record.review || record.review.reviewId !== message.reviewId || record.review.draftRevision !== message.draftRevision) throw new Error('Review the current changes before applying them.');
          const reviewId = record.review.reviewId;
          this.results.editState(id, { review: undefined });
          const applied = await context.db.applyChangeSet({ sessionId: context.sessionId, reviewId });
          if (applied.result) { this._retain(context, applied.result); this.results.finish(id, applied.result); }
          else await this._load(id, context);
          const session = context.db.getSessionState(context.sessionId);
          context.bulkSource=undefined;
          this.results.editState(id, { readOnly: session.readOnly, sessionState: session, hasDraft: false,draftRevision:0,bulkSource:undefined,bulkDraft:undefined,lastAppliedReviewId: reviewId, editMessage: applied.committed ? 'Changes committed.' : 'Changes applied in this session. Commit or roll back the transaction.' });
        } else {
          if (message.type === 'commitChanges') await context.db.commit({ sessionId: context.sessionId });
          else await context.db.rollback({ sessionId: context.sessionId });
          completed = message.type === 'commitChanges' ? 'Transaction committed.' : 'Transaction rolled back.';
          await this._load(id, context, message.type === 'commitChanges' ? 'Transaction committed. Table reloaded.' : 'Transaction rolled back. Table reloaded.');
        }
      });
    } catch (error) {
      let session;
      try { session = error.state || (context && context.db.getSessionState(context.sessionId)); } catch { /* Closed connection. */ }
      const detail = (completed ? completed + ' Refresh failed: ' : '') + (error.message || String(error)) + (error.priorTransactionRolledBack ? ' The server rolled back the entire previous transaction, including changes outside this grid apply.' : '');
      this.results.editState(id, { editError: detail, review: undefined, ...(session ? { sessionState: session, readOnly: session.readOnly } : {}), editExpired: !context || this.connection().epoch !== context.epoch });
    } finally { if (locked) this.results.editState(id, { editBusy: false, editResponseId: message.requestId }); this.onStatus(); }
  }
  dispose() { for (const id of this.contexts.keys()) this.forget(id); }
}

module.exports = { TableEditor };
