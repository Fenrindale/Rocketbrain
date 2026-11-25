'use strict';

const { randomBytes } = require('node:crypto');
const { normalizeLocalChatTarget } = require('../ai/local-chat');
const { offeredTables } = require('./local-sql-assistant');
const { pickLocalSqlSchema } = require('./local-sql-assistant-vscode');
const { createSqlProposalReview, prepareSqlProposalBatch } = require('./sql-proposal-review');
const { proposalReviewHtml } = require('./sql-proposal-review-view');

const section = 'rocketbrain.localSqlAssistant';
const command = 'rocketbrain.localSqlAssistant.compareProposals';
const panelType = 'rocketbrain.sqlProposalReview';

function registerSqlProposalReview(context, vscode, database) {
  let current;
  let epoch = 0;

  function invalidate() {
    epoch++;
    current?.review?.invalidate();
  }

  function capture() {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before opening a local SQL proposal review.');
    const settings = vscode.workspace.getConfiguration(section);
    const target = normalizeLocalChatTarget(settings.get('endpoint'), settings.get('model'));
    const catalog = database.liveCatalogSnapshot();
    return { ...target, catalog, epoch, options: offeredTables(catalog) };
  }

  function check(record, observed) {
    if (record !== current || !vscode.workspace.isTrusted || observed !== epoch) {
      throw Error('The proposal review or its database/model scope changed. Prepare a new review.');
    }
  }

  function publish(record, state = record.review?.snapshot()) {
    if (record === current) {
      void Promise.resolve(record.panel.webview.postMessage({ type: 'state', preparing: record.preparing,
        state })).catch(() => {});
    }
  }

  async function start(record) {
    if (record.preparing || record.running) return;
    record.preparing = true;
    publish(record);
    try {
      const started = capture();
      const requests = [];
      for (let slot = 1; slot <= 3; slot++) {
        const value = await vscode.window.showInputBox({ title: 'SQL Proposal ' + slot,
          prompt: slot === 3 ? 'Add another request or leave this blank for two proposals' : 'Describe a read-only query or an alternative approach',
          ignoreFocusOut: true, validateInput: text => Buffer.byteLength(text) > 1024 || (slot < 3 && !text.trim()) ?
            'Enter a request of at most 1 KiB.' : undefined });
        check(record, started.epoch);
        if (value === undefined) return;
        if (value.trim()) requests.push(value);
      }
      const selections = await pickLocalSqlSchema(vscode, started.options);
      if (!selections) return;
      check(record, started.epoch);
      const prepared = prepareSqlProposalBatch({ ...started, selections, requests });
      const choice = await vscode.window.showInformationMessage('Send these isolated requests to the configured local SQL model?',
        { modal: true, detail: JSON.stringify(prepared.preview, null, 2) }, 'Start Proposals');
      if (choice !== 'Start Proposals') return;
      check(record, started.epoch);
      record.review?.invalidate();
      const review = createSqlProposalReview(prepared, { onChange: state => publish(record, state) });
      record.review = review;
      record.epoch = started.epoch;
      record.preparing = false;
      record.running = true;
      try { await review.start(); }
      finally { record.running = false; }
    } finally {
      record.preparing = false;
      publish(record);
    }
  }

  async function handle(record, message) {
    if (record !== current) return;
    if (message?.type === 'ready') return publish(record);
    if (message?.type === 'start') return start(record);
    const { reviewId, jobId, fingerprint, type } = message ?? {};
    const review = record.review;
    if (!review || ![reviewId, jobId].every(value => typeof value === 'string' && value.length === 36)) return;
    check(record, record.epoch);
    if (type === 'cancel') return review.cancel(reviewId, jobId);
    if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) return;
    if (type === 'reject') return review.reject(reviewId, jobId, fingerprint);
    if (type === 'accept') {
      const proposal = review.read(reviewId, jobId, fingerprint);
      const choice = await vscode.window.showInformationMessage('Mark this exact SQL proposal as reviewed?',
        { modal: true, detail: proposal.sql }, 'Mark Reviewed');
      if (choice === 'Mark Reviewed') {
        check(record, record.epoch);
        review.accept(reviewId, jobId, fingerprint);
      }
      return publish(record);
    }
    if (type === 'open') {
      const proposal = review.read(reviewId, jobId, fingerprint, { reviewedOnly: true });
      const { dialect, schema } = review.snapshot();
      const document = await vscode.workspace.openTextDocument({ language: 'sql',
        content: `-- Reviewed local proposal for ${dialect} schema ${schema}.\n${proposal.sql}\n` });
      check(record, record.epoch);
      review.read(reviewId, jobId, fingerprint, { reviewedOnly: true });
      await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      publish(record);
    }
  }

  function close(record) {
    if (current === record) current = undefined;
    record.listener.dispose();
    record.closed.dispose();
    record.review?.invalidate();
  }

  function open() {
    capture();
    if (current) {
      current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(panelType, 'SQL Proposal Review', vscode.ViewColumn.Active,
      { enableScripts: true, enableCommandUris: false, localResourceRoots: [] });
    const record = { panel };
    current = record;
    record.listener = panel.webview.onDidReceiveMessage(message => {
      void handle(record, message).catch(error => {
        if (record === current) {
          void vscode.window.showErrorMessage('Rocketbrain SQL Proposal Review: ' + error.message);
          publish(record);
        }
      });
    });
    record.closed = panel.onDidDispose(() => close(record));
    panel.webview.html = proposalReviewHtml(randomBytes(24).toString('base64'));
  }

  context.subscriptions.push(vscode.commands.registerCommand(command, () => {
    try { open(); }
    catch (error) { void vscode.window.showErrorMessage('Rocketbrain SQL Proposal Review: ' + error.message); }
  }), database.onDidChangeDatabase(invalidate),
  vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(section)) invalidate(); }),
  { dispose() { current?.panel.dispose(); } });

  return { preview({ selections, requests }) {
    return prepareSqlProposalBatch({ ...capture(), selections, requests }).preview;
  } };
}

module.exports = { registerSqlProposalReview, panelType };
