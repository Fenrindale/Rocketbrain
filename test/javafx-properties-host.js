'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { jdbcReadback } = require('./java-source-analysis-host');
const fixture = require('./helpers/javafx-preview');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function frames(panel) {
  return [...panel.webview.html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)"/gu)]
    .map(match => Buffer.from(match[1], 'base64'));
}

function invokeLink(vscode, panel, suffix) {
  const command = 'rocketbrain.javafx.' + suffix;
  const current = [...panel.webview.html.matchAll(/href="command:([^"?]+)\?([^"]+)"/gu)]
    .find(match => match[1] === command);
  assert.ok(current, 'Expected a review command link for ' + command);
  return vscode.commands.executeCommand(command, ...JSON.parse(decodeURIComponent(current[2])));
}

async function exerciseJavaFxProperties(fx, vscode, workspace, { normalEditLink = false } = {}) {
  const owned = await fs.mkdtemp(path.join(workspace, 'rb-fxml-properties-'));
  const source = path.join(owned, fixture.source), sheet = path.join(owned, fixture.stylesheet);
  const include = path.join(path.dirname(path.dirname(source)), 'shared', 'inset.fxml');
  let panel, document;
  try {
    await fs.cp(fixture.fixture, owned, { recursive: true });
    const original = await fs.readFile(source, 'utf8'), css = await fs.readFile(sheet, 'utf8');
    const shared = await fs.readFile(include);
    document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    await vscode.window.showTextDocument(document, { preview: false });
    const first = await fx.preview({ document, width: 96, height: 72, allowPreview: true });
    panel = fx.showPreview(first);
    assert.equal(panel.viewType, 'rocketbrainFxmlPreview');
    assert.match(panel.webview.html, /class="hotspot"[^>]+aria-label="Edit Rectangle · indicator"/u);
    assert.match(panel.webview.html, /Editable elements/u);
    assert.match(panel.webview.html, /controller and event hookups omitted/u);
    assert.doesNotMatch(panel.webview.html, /<script(?:\s|>)/u);
    fixture.imageProof(frames(panel)[0], first);
    const review = (receipt, property, value, extra) => fx.reviewProperty({
      receipt, id: 'indicator', property, value, allowReview: true, ...extra
    });
    await assert.rejects(review(first, 'fill', '#44cc66', { allowReview: false }), /current FXML preview/u);
    await assert.rejects(review(first, 'onMouseClicked', '#somethingElse'), /supported existing static FXML property/u);
    await assert.rejects(review(first, 'fill', '${controller.fill}'), /supported existing static FXML property/u);
    const discarded = await review(first, 'fill', '#44cc66');
    assert.ok(panel.webview.html.includes('Discard'));
    await invokeLink(vscode, panel, 'discardPreviewProperty');
    await assert.rejects(fx.applyProperty({ review: discarded, allowApply: true }), /active FXML property review/u);
    const stale = normalEditLink ? await invokeLink(vscode, panel, 'editPreviewProperty') :
      await review(first, 'fill', '#44cc66');
    assert.deepEqual([stale.before, stale.after], ['#cc3344','#44cc66']);
    assert.match(panel.webview.html, /Review property change/u);
    const [originalPng, proposedPng] = frames(panel);
    assert.equal(digest(originalPng), first.imageSha256);
    assert.equal(digest(proposedPng), stale.proposed.imageSha256);
    const paint = fixture.pixels(proposedPng);
    assert.deepEqual([paint(10,10), paint(70,52), paint(51,18)],
      [[68,204,102,255], [17,34,51,255], [34,51,255,255]]);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert.equal(document.isDirty, false);
    await assert.rejects(fx.applyProperty({ review: stale, allowApply: false }), /active FXML property review/u);
    await fs.writeFile(sheet, css + '\n/* changed after review */\n');
    await assert.rejects(fx.applyProperty({ review: stale, allowApply: true }), /FXML or CSS changed since preview/u);
    await assert.rejects(fx.applyProperty({ review: stale, allowApply: true }), /active FXML property review/u);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    await fs.writeFile(sheet, css);
    const fill = await review(first, 'fill', '#44cc66');
    const result = await invokeLink(vscode, panel, 'applyPreviewProperty');
    assert.deepEqual(result, {id:'indicator', property:'fill', value:'#44cc66'});
    await assert.rejects(fx.applyProperty({ review: fill, allowApply: true }), /active FXML property review/u);
    const filled = original.replace('fill="#cc3344"', 'fill="#44cc66"');
    await waitForEdit(document, filled);
    assert.equal(await fs.readFile(source, 'utf8'), original);
    assert.ok(await document.save());
    assert.equal(await fs.readFile(source, 'utf8'), filled);
    const saved = await vscode.commands.executeCommand('rocketbrain.javafx.refreshPreview');
    assert.equal(saved.resourcesSha256, fill.proposed.resourcesSha256);
    assert.equal(saved.imageSha256, fill.proposed.imageSha256);

    const size = await review(saved, 'width', '8');
    const layout = fixture.pixels(frames(panel)[1]);
    assert.deepEqual([layout(10,10), layout(20,10)], [[68,204,102,255], [17,34,51,255]]);
    await invokeLink(vscode, panel, 'applyPreviewProperty');
    const sized = filled.replace('width="24"', 'width="8"');
    await waitForEdit(document, sized);
    assert.ok(await document.save());
    const final = await vscode.commands.executeCommand('rocketbrain.javafx.refreshPreview');
    assert.equal(final.resourcesSha256, size.proposed.resourcesSha256);
    assert.equal(final.imageSha256, size.proposed.imageSha256);
    assert.equal(await fs.readFile(source, 'utf8'), sized);
    assert.equal(await fs.readFile(sheet, 'utf8'), css);
    assert.deepEqual(await fs.readFile(include), shared);
    return { runtime:final.runtime,width:96,height:72,baselineImage:first.imageSha256,
      colorImage:fill.proposed.imageSha256,layoutImage:final.imageSha256,proposedMatchesSaved:true,
      interactiveElementBounds:true,sourceAttributeOnly:true,cssAndIncludePreserved:true,
      discardRefused:true,staleCssRefused:true,replayRefused:true,unsupportedRefused:true,
      workspaceWriteBeforeSave:false };
  } finally {
    panel?.dispose();
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => {
      const uri = tab.input?.uri;
      return uri?.scheme === 'file' && !path.relative(source, uri.fsPath);
    });
    if (tabs.length) {
      if(document?.isDirty) await vscode.commands.executeCommand('workbench.action.files.revert', document.uri);
      await vscode.window.tabGroups.close(tabs);
    }
    const ownedReal = await fs.realpath(owned);
    assert.ok(path.basename(ownedReal).startsWith('rb-fxml-properties-'));
    assert.equal(path.relative(workspace, path.dirname(ownedReal)), '');
    await fs.rm(ownedReal, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  }
}

async function waitForEdit(document, expected) {
  const until = Date.now() + 4500;
  while (Date.now() < until && (document.getText() !== expected || !document.isDirty)) await pause(30);
  assert.equal(document.getText(), expected);
  assert.equal(document.isDirty, true);
}

async function runJavaFxPropertyChecks(api, vscode, checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const receipt = await exerciseJavaFxProperties(api.java.fx, vscode, workspace);
  const jdbc = await jdbcReadback();
  assert.ok(jdbc);
  checks.push('JavaFX preview reviewed original and proposed OpenJFX pixels, applied exact color and geometry attributes in the FXML editor, and refused stale CSS or replay.');
  return {...receipt,jdbc};
}

module.exports = { exerciseJavaFxProperties, runJavaFxPropertyChecks };
