'use strict';

const { randomUUID } = require('node:crypto');
const { bindProcedure, fail } = require('./routine-call');

const scheme = 'rocketbrain-procedure-review';
const reviewLifetime = 120000;
const routineLabel = object => [object.package, object.name].filter(Boolean).join('.');

function registerRoutineCalls(vscode, { database }) {
  const drafts = new Map(), reviews = new Map(), captures = new Map();
  let disposed = false;
  function requireTrusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('TRUST', 'Trust the workspace before reviewing or invoking a procedure.');
  }
  function remember(collection, value, limit = 8) {
    const id = randomUUID();
    while (collection.size >= limit) collection.delete(collection.keys().next().value);
    collection.set(id, { ...value, expires: Date.now() + reviewLifetime });
    return id;
  }
  function current(collection, id) {
    requireTrusted();
    const value = collection.get(id);
    if (!value || value.expires < Date.now() || !value.guard()) {
      collection.delete(id);
      throw fail('STALE', 'The procedure review expired or the connection changed. Review the procedure again.');
    }
    return value;
  }
  async function inspect(target) {
    requireTrusted();
    return database.withDatabaseAdmin(async ({ db, guard, epoch }) => {
      const procedure = await db.inspectProcedureCall(target, { guard });
      if (!guard()) throw fail('STALE', 'The connection changed while inspecting the procedure.');
      const id = remember(drafts, { procedure, guard, epoch });
      const callBlocked = Boolean(db.getSessionState().writeProtection);
      return { id, ...structuredClone(procedure), connectionEpoch: epoch, callBlocked };
    });
  }
  async function listPackages(options) {
    requireTrusted();
    return database.withDatabaseAdmin(async ({ db, guard, epoch }) => {
      const page = await db.listProcedurePackages(options);
      if (!guard()) throw fail('STALE', 'The database changed while listing packages.');
      return { ...page, connectionEpoch: epoch };
    });
  }
  async function inspectPackage(target) {
    requireTrusted();
    return database.withDatabaseAdmin(async ({ db, guard, epoch }) => {
      const loaded = await db.inspectProcedurePackage(target, { guard });
      if (!guard()) throw fail('STALE', 'The database changed while inspecting the package.');
      return { ...structuredClone(loaded), connectionEpoch: epoch };
    });
  }
  function prepare(id, inputs) {
    const draft = current(drafts, id);
    const { kinds } = bindProcedure(draft.procedure.parameters, inputs);
    const reviewId = remember(reviews, { ...draft, inputs: structuredClone(inputs), kinds });
    drafts.delete(id);
    const uri = vscode.Uri.parse(scheme + ':/' + reviewId + '/procedure.sql');
    return { id: reviewId, uri, object: structuredClone(draft.procedure.object), connectionEpoch: draft.epoch,
      ...Object.fromEntries(['sql', 'account', 'role', 'dialect', 'fingerprint'].map(key => [key, draft.procedure[key]])), parameterKinds: kinds };
  }
  function documentText(uri) {
    const id = uri.path.split('/')[1];
    let review;
    try { review = current(reviews, id); }
    catch { return '-- The procedure review is no longer available.'; }
    const { procedure, kinds } = review;
    let inputIndex = 0;
    const parameters = procedure.parameters.map(item => '-- ' + item.mode + ' ' + JSON.stringify(item.name) + ' ' +
      JSON.stringify(item.type) + (item.mode === 'OUT' ? ' · output only' : ' · ' + kinds[inputIndex++] + ' input kept private'));
    const definitions = procedure.packageSources ? procedure.packageSources.flatMap(({ kind, settings, source }) =>
      ['', '-- Package ' + kind.toLowerCase() + ' · ' + JSON.stringify(settings), source]) : ['', procedure.source];
    return ['-- Rocketbrain stored procedure review', '-- Account: ' + JSON.stringify(procedure.account),
      '-- Active role: ' + JSON.stringify(procedure.role), '-- Definition fingerprint: ' + procedure.fingerprint,
      '-- Database: ' + JSON.stringify(procedure.object.schema),
      '-- ' + procedure.sql, ...parameters,
      '-- This approved call can change persistent data and can commit work within its own connection.',
      '-- The server enforces EXECUTE and routine privileges, including its SQL SECURITY mode.',
      ...(procedure.dialect === 'mariadb' ? ['-- MariaDB compares the definition before and after the call. Concurrent DDL can still change the routine.'] : []),
      ...(procedure.packageSources ? ['-- The package may run initialization code on this connection before the member.'] : []),
      ...definitions].join('\n');
  }
  async function run(id, { approved, signal, maxRows, timeoutMs } = {}) {
    const review = current(reviews, id);
    if (approved !== true) throw fail('APPROVAL', 'Approve the exact stored procedure review before running it.');
    reviews.delete(id);
    const sql = review.procedure.sql, label = database.source() + ' · ' + routineLabel(review.procedure.object);
    const resultId = database.scriptResultBegin(sql, label, { readOnly: false });
    try {
      const report = await database.withDatabaseAdmin(({ db, epoch, guard }) => {
        if (epoch !== review.epoch || !guard() || !review.guard()) throw fail('STALE', 'The reviewed database connection changed.');
        return db.runProcedureCall(review.procedure, review.inputs, { guard, signal, maxRows, timeoutMs });
      }, { write: true });
      const rows = report.resultSets.map((set, index) => [index + 1, set.columns.length, set.rowCount]);
      const scriptStatements = report.resultSets.map((set, index) => ({ index, label: 'Result set ' + (index + 1) + ' · ' + set.rowCount + ' row(s)' }));
      const outputRows = report.outputParameters.map(({ name, mode, type, value }) => [name, mode, type, value]);
      const outputGrid = outputRows.length ? { columns: ['Parameter', 'Mode', 'SQL type', 'Value'], rows: outputRows,
        rowCount: outputRows.length, affectedRows: 0, durationMs: 0, truncated: false } : undefined;
      if (outputGrid) scriptStatements.push({ index: report.resultSets.length, label: 'Output parameters · ' + outputRows.length });
      for (const existing of captures.keys()) if (!database.scriptResultRetained(existing)) captures.delete(existing);
      if (captures.size >= 8) captures.delete(captures.keys().next().value);
      captures.set(resultId, { sql, label, resultSets: report.resultSets, outputGrid });
      const summary = { columns: ['Result set', 'Columns', 'Rows'], rows, rowCount: rows.length, affectedRows: report.affectedRows,
        durationMs: report.durationMs, truncated: false, warningCount: report.warningCount, captureKind: 'procedure',
        procedureOutputAvailable: Boolean(outputGrid), scriptStatements };
      if (!rows.length) summary.warning = outputGrid ? 'The procedure returned output parameters.' : 'The procedure completed without a result set.';
      database.scriptResultFinish(resultId, summary);
      return { resultId, ...structuredClone(report) };
    } catch (error) {
      database.scriptResultFinish(resultId, undefined, error.message, { outcomeUnknown: error.possibleEffects === true });
      throw error;
    }
  }
  async function openResult({ resultId, index } = {}) {
    requireTrusted();
    const capture = captures.get(resultId), isOutput = Boolean(capture && index === capture.resultSets.length);
    const set = isOutput ? capture.outputGrid : capture?.resultSets[index];
    if (!Number.isInteger(index) || index < 0 || !set || !database.scriptResultRetained(resultId)) {
      throw fail('RESULT', 'Choose a retained result set from the completed procedure.');
    }
    let id = database.scriptStatementResult(resultId, index);
    if (!id) {
      const suffix = isOutput ? 'Output parameters' : 'Result set ' + (index + 1);
      id = database.scriptResultBegin(capture.sql, capture.label + ' · ' + suffix,
        { readOnly: true, scriptCapture: { resultId, index } });
      database.scriptResultFinish(id, structuredClone(set));
    }
    await database.showResults();
    await database.activateResult(id);
    return { resultId: id, index, ...(isOutput && { outputParameters: true }), executedSql: false };
  }
  async function chooseCatalog(packageMode) {
    const title = packageMode ? 'MariaDB Package' : 'Stored Procedure';
    const prefix = await vscode.window.showInputBox({ title: 'Find a ' + title, prompt: 'Optional name prefix in the connected database' });
    if (prefix === undefined) return;
    let after, epoch;
    do {
      const page = await database.withDatabaseAdmin(async ({ db, guard, epoch: observed }) => {
        if (epoch !== undefined && epoch !== observed) throw fail('STALE', 'The connected database changed. Start the search again.');
        epoch = observed;
        const value = packageMode ? await db.listProcedurePackages({ prefix, after }) : await db.listProcedureCalls({ prefix, after });
        if (!guard()) throw fail('STALE', 'The connected database changed. Start the search again.');
        return value;
      });
      const items = page.items.map(item => ({ label: item.name, description: item.schema, item }));
      if (page.next) items.push({ label: 'Next page…', next: true });
      if (!items.length) { await vscode.window.showInformationMessage('No matching ' + title.toLowerCase() + ' is visible to this account.'); return; }
      const selected = await vscode.window.showQuickPick(items, { title: 'Choose a ' + title + ' to Review' });
      if (!selected?.next) return selected?.item && { item: selected.item, epoch };
      after = page.next;
    } while (after);
  }
  async function choosePackageProcedure() {
    const selected = await chooseCatalog(true);
    if (!selected) return;
    const details = await inspectPackage(selected.item);
    if (selected.epoch !== details.connectionEpoch) throw fail('STALE', 'The database changed during package selection.');
    const procedures = details.members.filter(member => member.supported).map(member => ({ label: member.name, member,
      description: member.parameters.map(parameter => parameter.mode + ' ' + parameter.type).join(', ') }));
    if (!procedures.length) { await vscode.window.showInformationMessage('This package has no public procedure with a supported, matching scalar signature.'); return; }
    const choice = await vscode.window.showQuickPick(procedures, { title: 'Choose a Public Package Procedure' });
    if (choice) return { epoch: details.connectionEpoch, item: { schema: details.object.schema, package: details.object.name,
      kind: 'package-procedure', name: choice.member.name } };
  }
  async function inputValues(parameters) {
    const values = [];
    for (const { name, kind, type, mode } of parameters) {
      if (mode === 'OUT') continue;
      const title = mode + ' ' + name + ' · ' + type;
      const choice = await vscode.window.showQuickPick(['Enter value', 'SQL NULL'], { title });
      if (!choice) return;
      if (choice === 'SQL NULL') { values.push({ kind: 'null' }); continue; }
      const value = await vscode.window.showInputBox({ title, password: /password|secret|token/i.test(name), ignoreFocusOut: true,
        ...(kind === 'binary' && { placeHolder: '0x0123ABCD' }),
        ...(kind === 'date' && { placeHolder: 'YYYY-MM-DD or YYYY-MM-DD HH:mm:ss' }),
        ...(kind === 'number' && { validateInput: text => !text.trim() || !Number.isFinite(Number(text)) ? 'Enter a finite number.' : undefined }) });
      if (value === undefined) return;
      values.push({ kind, value: kind === 'number' ? Number(value) : value });
    }
    return values;
  }
  async function command(target, packageMode = false) {
    requireTrusted();
    const kind = packageMode ? 'package-procedure' : 'procedure';
    const picked = target?.kind === kind ? { item: target } : packageMode ? await choosePackageProcedure() : await chooseCatalog(false);
    if (!picked) return;
    const draft = await inspect(picked.item);
    if (picked.epoch !== undefined && picked.epoch !== draft.connectionEpoch) { drafts.delete(draft.id); throw fail('STALE', 'The database changed during selection.'); }
    let review;
    try {
      if (draft.callBlocked) throw fail('PROTECTION', 'This connection profile protects writes. The procedure definition can still be opened from the database object source viewer.');
      const values = await inputValues(draft.parameters);
      if (!values) return;
      review = prepare(draft.id, values);
      const document = await vscode.workspace.openTextDocument(review.uri);
      await vscode.window.showTextDocument(document, { preview: false });
      const approved = await vscode.window.showWarningMessage('Run the reviewed stored procedure once?', { modal: true,
        detail: 'A procedure can change or commit data. Review its definition and account before running.' }, 'Run Procedure');
      if (approved !== 'Run Procedure') return;
      const normalize = text => text.replaceAll('\r\n', '\n');
      if (document.isClosed || normalize(document.getText()) !== normalize(documentText(review.uri))) {
        throw fail('STALE', 'The procedure review document changed. Open a new review before running.');
      }
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Calling ' + routineLabel(draft.object), cancellable: true }, async (_, token) => {
        const controller = new AbortController();
        if (token.isCancellationRequested) controller.abort();
        const listener = token.onCancellationRequested(() => controller.abort());
        try { return await run(review.id, { approved: true, signal: controller.signal }); }
        finally { listener.dispose(); }
      });
      await database.showResults();
      return { resultId: report.resultId, resultSets: report.resultSets.length, outputParameters: report.outputParameters.length };
    } finally {
      drafts.delete(draft.id);
      if (review) reviews.delete(review.id);
    }
  }
  function registerReviewCommand(id, packageMode) {
    return vscode.commands.registerCommand(id, async target => {
      try { return await command(target, packageMode); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage(error.message); }
    });
  }
  const subscriptions = [
    vscode.workspace.registerTextDocumentContentProvider(scheme, { provideTextDocumentContent: documentText }),
    vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === scheme) reviews.delete(document.uri.path.split('/')[1]); }),
    registerReviewCommand('rocketbrain.db.reviewProcedureCall', false),
    registerReviewCommand('rocketbrain.db.reviewPackageCall', true),
    vscode.commands.registerCommand('rocketbrain.db.openProcedureResult', openResult)
  ];
  return { inspect, listPackages, inspectPackage, prepare, run, openResult, dispose() {
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
    drafts.clear(); reviews.clear(); captures.clear();
  } };
}

module.exports = { registerRoutineCalls };
