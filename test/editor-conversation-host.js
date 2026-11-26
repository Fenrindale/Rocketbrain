'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { digest } = require('../src/ai/editor-conversation');
const { conversationHost } = require('./helpers/editor-conversation-host');
const { startLocalModel } = require('./helpers/local-sql-model-fixture');

const marker = 'RB-WORKSPACE-837';
const historyMarker = 'RB-USER-510';
const question = 'Remember my conversation label RB-USER-510 for later. Right now, answer only this: Which exact string literal does the Spring GET endpoint return? Follow the constant across the two source files.';
const followup = 'What exact conversation label did I ask you to remember in my previous question? Return only the label.';

function selectedSources(root, Uri) {
  const java = path.join(root, 'src', 'main', 'java', 'fixture', 'boot');
  return ['LocalConversationEndpoint.java', 'LocalConversationFacts.java'].map(name => Uri.file(path.join(java, name)));
}

async function beforeOrAfter(fixture) {
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.ok(['mysql', 'mariadb'].includes(fixture.dbEngine));
  const [endpoint, jdbc] = await Promise.all(['/probe/workspace-conversation', '/probe/testing-state'].map(relative =>
    fetch(fixture.baseUrl + relative, { signal: AbortSignal.timeout(6000), redirect: 'error' })));
  assert.equal(endpoint.ok, true);
  assert.equal(await endpoint.text(), marker);
  assert.equal(jdbc.ok, true);
  const result = await jdbc.json();
  assert.deepEqual(result, { people: 2, departments: 1, rolledBackNames: 0 });
  return result;
}

function verifyHistory(first, second, review) {
  assert.equal(first.turn, 1);
  assert.ok(first.answer.includes(marker), first.answer);
  assert.equal(second.turn, 2);
  assert.ok(second.answer.includes(historyMarker), second.answer);
  assert.notEqual(first.payloadSha256, second.payloadSha256);
  assert.equal(review.payloadSha256, second.payloadSha256);
  assert.deepEqual(review.request.messages.slice(-3), [
    { role: 'user', content: question },
    { role: 'assistant', content: first.answer },
    { role: 'user', content: followup }
  ]);
}

async function verifyHeadless(fixture, target) {
  const host = conversationHost(fixture.projectPath, target);
  const files = selectedSources(fixture.projectPath, host.vscode.Uri);
  try {
    const jdbc = await beforeOrAfter(fixture);
    host.openFile(files[0]);
    host.inputs.files = files;
    host.inputs.question = question;
    const review = await host.invoke('startConversation');
    const outbound = host.review(review.uri);
    assert.deepEqual(outbound.context.map(file => file.sha256),
      await Promise.all(files.map(async file => digest(await fs.readFile(file.fsPath)))));
    host.inputs.approve = false;
    assert.equal(await host.invoke('sendConversation'), undefined);
    host.inputs.approve = true;
    const first = await host.invoke('sendConversation');

    host.openFile(files[1]);
    host.inputs.question = followup;
    const next = await host.invoke('continueConversation');
    const continuation = host.review(next.uri);
    assert.deepEqual(continuation.context, outbound.context);
    const second = await host.invoke('sendConversation');
    verifyHistory(first, second, continuation);
    assert.match(host.transcript(second.uri), /Turn 1[\s\S]*Turn 2/);
    assert.deepEqual(await beforeOrAfter(fixture), jdbc);
    await host.invoke('closeConversation');
    assert.match(host.transcript(second.uri), /closed/);
    return { engine: fixture.dbEngine, model: 'Qwen2.5-Coder-1.5B-Instruct Q4_K_M', jdbc,
      endpointMarker: marker, conversationMarker: historyMarker, files: outbound.context,
      reviewSha256: [first.payloadSha256, second.payloadSha256], answers: [first.answer, second.answer],
      registeredCommands: true, continuedAfterSwitchingEditor: true, approvalRequired: true, conversationClosed: true };
  } finally { host.conversation.dispose(); }
}

async function runEditorConversationChecks(api, vscode, checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const folder = await fs.realpath(process.env.ROCKETBRAIN_JAVA_TEST_WORKSPACE);
  assert.ok(folder.split(path.sep).includes('test-output'));
  const files = selectedSources(folder, vscode.Uri);
  const source = await vscode.workspace.openTextDocument(files[0]);
  assert.equal(await fs.realpath(vscode.workspace.getWorkspaceFolder(source.uri).uri.fsPath), folder);
  const conversation = api.codeModel.conversation;
  assert.ok(conversation);
  const preferences = vscode.workspace.getConfiguration('rocketbrain.localCodeModel', files[0]);
  const keys = ['endpoint', 'model'];
  const saved = Object.fromEntries(keys.map(key => [key, preferences.inspect(key)?.workspaceValue]));
  const supplied = { endpoint: process.env.ROCKETBRAIN_LOCAL_MODEL_ENDPOINT, model: process.env.ROCKETBRAIN_LOCAL_MODEL_ID };
  let owned, session;
  try {
    const jdbc = await beforeOrAfter(config);
    if (!supplied.endpoint || !supplied.model) owned = await startLocalModel();
    const target = owned ?? supplied;
    for (const key of keys) await preferences.update(key, target[key], vscode.ConfigurationTarget.Workspace);
    const review = conversation.start(source.uri, files, question);
    session = review.sessionId;
    const reviewDocument = await vscode.workspace.openTextDocument(review.uri);
    await vscode.window.showTextDocument(reviewDocument, { preview: false });
    const exact = JSON.parse(reviewDocument.getText());
    assert.equal(exact.payloadSha256, digest(JSON.stringify(exact.request)));
    await assert.rejects(conversation.send(session, review.reviewId, { confirmed: false }), /Confirm/);
    const first = await conversation.send(session, review.reviewId, { confirmed: true });
    await vscode.window.showTextDocument(source, { preview: false });
    const next = conversation.continueTurn(session, followup);
    const continuation = JSON.parse((await vscode.workspace.openTextDocument(next.uri)).getText());
    assert.deepEqual(continuation.context, exact.context);
    const second = await conversation.send(session, next.reviewId, { confirmed: true });
    verifyHistory(first, second, continuation);
    const transcript = await vscode.workspace.openTextDocument(second.uri);
    await vscode.window.showTextDocument(transcript, { preview: false });
    assert.match(transcript.getText(), /Turn 1[\s\S]*Turn 2/);
    assert.deepEqual(await beforeOrAfter(config), jdbc);
    checks.push('The local model answered from two pinned Spring Java source files and continued with the exact approved prior turn.');
    return { engine: config.dbEngine, reviewedFiles: 2, turns: 2, transcriptOpened: true, jdbc };
  } finally {
    try {
      if (session) conversation.close(session);
      for (const key of keys) await preferences.update(key, saved[key], vscode.ConfigurationTarget.Workspace);
    } finally { await owned?.close(); }
  }
}

async function main() {
  const { startSpringProject } = require('../scripts/spring-project');
  const fixtures = [];
  let model;
  try {
    for (const engine of ['mysql', 'mariadb']) {
      fixtures.push(await startSpringProject({ engine, observer: false }));
      console.error('Owned Spring runtime ready on ' + engine);
    }
    model = await startLocalModel();
    const receipts = [];
    for (const fixture of fixtures) receipts.push(await verifyHeadless(fixture, model));
    console.log(JSON.stringify(receipts, null, 2));
  } finally {
    try { await model?.close(); }
    finally {
      const closed = await Promise.allSettled(fixtures.map(fixture => fixture.close()));
      const failure = closed.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });

module.exports = { runEditorConversationChecks };
