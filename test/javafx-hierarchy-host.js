'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pixels } = require('./helpers/javafx-preview');
const { jdbcReadback } = require('./java-source-analysis-host');
const { hierarchyReplacement, hierarchyTargets } = require('../src/java/javafx-preview-hierarchy');
const { renderFxmlPreview } = require('../src/java/javafx-preview-runtime');

const green = [34, 204, 102, 255];
const red = [204, 51, 68, 255];
const blue = [68, 136, 204, 255];
const initial = `<?xml version="1.0" encoding="UTF-8"?>
<?import javafx.scene.layout.*?>
<?import javafx.scene.shape.Rectangle?>
<Pane xmlns:fx="http://javafx.com/fxml/1" fx:id="scene" prefWidth="96" prefHeight="72" stylesheets="@theme.css">
  <children>
    <Rectangle fx:id="red" x="30" y="20" width="20" height="20" fill="#cc3344"/>
    <Rectangle fx:id="green" x="30" y="20" width="20" height="20" fill="#22cc66"/>
  </children>
</Pane>
`;

function pngColors(png) {
  const pixel = pixels(png);
  return { overlap: pixel(35, 25), newNode: pixel(4, 4) };
}

async function withHierarchyFixture(parent, action) {
  const base = await fs.realpath(parent);
  const fixture = await fs.mkdtemp(path.join(base, 'rb-fxml-hierarchy-'));
  const owner = await fs.lstat(fixture, { bigint: true });
  try {
    const declared = path.join(fixture, 'src/main/resources/scene.fxml');
    const sheet = path.join(path.dirname(declared), 'theme.css');
    await fs.mkdir(path.dirname(declared), { recursive: true });
    await fs.writeFile(declared, initial, { flag: 'wx' });
    await fs.writeFile(sheet, '.root { -fx-background-color: #111111; }\n', { flag: 'wx' });
    return await action({ fixture, file: await fs.realpath(declared), sheet });
  } finally {
    const real = await fs.realpath(fixture), current = await fs.lstat(real, { bigint: true });
    assert.equal(path.relative(fixture, real), '');
    assert.equal(path.relative(base, path.dirname(real)), '');
    assert.match(path.basename(real), /^rb-fxml-hierarchy-[a-z0-9]{6}$/iu);
    assert.deepEqual([current.dev, current.ino], [owner.dev, owner.ino]);
    await fs.rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

async function headless({fixture,file,sheet}) {
  const [parent] = hierarchyTargets(initial);
  const move = { parent:parent.key, operation:'later', child:parent.children[0].key };
  const insert = { parent:parent.key, operation:'insert', type:'Rectangle' };
  const render = extra => renderFxmlPreview({ file, workspace:fixture, javaHome:process.env.ROCKETBRAIN_SPRING_JAVA_HOME,
    storage:process.env.ROCKETBRAIN_FXML_HIERARCHY_STORAGE, width:96, height:72, workspaceTrusted:true, allowPreview:true, ...extra });
  const baseline = await render();
  assert.deepEqual(pngColors(baseline.png).overlap, green);
  const moved = await render({ hierarchyEdit:move, expectedFingerprint:baseline.report.resourcesSha256 });
  assert.deepEqual(pngColors(moved.png).overlap, red);
  assert.equal(await fs.readFile(file,'utf8'), initial);
  const first = hierarchyReplacement(initial,move);
  assert.equal(first.before,'Rectangle · red → Rectangle · green');
  assert.equal(first.after,'Rectangle · green → Rectangle · red');
  await fs.writeFile(file, first.text);
  const afterMove = await render();
  assert.equal(afterMove.report.imageSha256, moved.report.imageSha256);
  assert.equal(afterMove.report.resourcesSha256, moved.report.resourcesSha256);
  const added = await render({ hierarchyEdit:insert, expectedFingerprint:afterMove.report.resourcesSha256 });
  assert.deepEqual(pngColors(added.png), { overlap:red, newNode:blue });
  assert.equal(await fs.readFile(file,'utf8'), first.text);
  const css = await fs.readFile(sheet,'utf8');
  await fs.writeFile(sheet, css.replace('#111111','#333333'));
  await assert.rejects(render({ hierarchyEdit:insert, expectedFingerprint:afterMove.report.resourcesSha256 }), /changed/u);
  await fs.writeFile(sheet, css);
  await fs.writeFile(file, added.design.edit.text);
  const saved = await render();
  assert.equal(saved.report.imageSha256, added.report.imageSha256);
  assert.equal(saved.report.resourcesSha256, added.report.resourcesSha256);
  const [edited]=saved.design.hierarchy;
  await assert.rejects(render({hierarchyEdit:{parent:edited.key,operation:'remove',child:edited.children[0].key}}),/controller or event wiring/u);
  const removed=await render({hierarchyEdit:{parent:edited.key,operation:'remove',child:edited.children.at(-1).key},
    expectedFingerprint:saved.report.resourcesSha256});
  assert.equal(removed.design.edit.text,first.text);
  assert.equal(removed.report.imageSha256,afterMove.report.imageSha256);
  return {runtime:saved.report.runtime, initial:green, reordered:red, inserted:blue,
    previewMatchesSaved:true, safeLeafRemoval:true, protectedLeafRefused:true, staleResourceRejected:true, jdbc:await jdbcReadback()};
}

function panelPng(panel, index) {
  const encoded = [...panel.webview.html.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)"/gu)][index]?.[1];
  assert.ok(encoded);
  return Buffer.from(encoded,'base64');
}

async function runJavaFxHierarchyChecks(api, vscode, checks) {
  return withHierarchyFixture(vscode.workspace.workspaceFolders[0].uri.fsPath, async ({file})=> {
    const fx=api.java.fx, document=await vscode.workspace.openTextDocument(file);
    let panel;
    try {
      await vscode.window.showTextDocument(document,{preview:false});
      const preview=async()=>{
        const receipt=await fx.preview({document,width:96,height:72,allowPreview:true});
        panel=fx.showPreview(receipt);
        return receipt;
      };
      const baseline=await preview();
      assert.match(panel.webview.html,/Scene containers/u);
      assert.match(panel.webview.html,/command:rocketbrain\.javafx\.editPreviewHierarchy/u);
      assert.deepEqual(pngColors(panelPng(panel,0)).overlap,green);
      const [parent]=fx.listHierarchy(baseline);
      const review=await fx.reviewHierarchy({receipt:baseline,parent:parent.key,operation:'later',
        child:parent.children[0].key,allowReview:true});
      assert.deepEqual(pngColors(panelPng(panel,1)).overlap,red);
      assert.equal(await fs.readFile(file,'utf8'),initial);
      await fx.applyHierarchy({review,allowApply:true});
      assert.ok(document.isDirty);
      assert.ok(await document.save());
      const afterMove=await preview();
      assert.equal(afterMove.imageSha256,review.proposed.imageSha256);
      const insertion=await fx.reviewHierarchy({receipt:afterMove,parent:fx.listHierarchy(afterMove)[0].key,
        operation:'insert',type:'Rectangle',allowReview:true});
      assert.deepEqual(pngColors(panelPng(panel,1)),{overlap:red,newNode:blue});
      await fx.applyHierarchy({review:insertion,allowApply:true});
      assert.ok(await document.save());
      const final=await preview();
      assert.equal(final.imageSha256,insertion.proposed.imageSha256);
      await assert.rejects(fx.applyHierarchy({review:insertion,allowApply:true}),/active FXML hierarchy review/u);
      const [edited]=fx.listHierarchy(final);
      const removal=await fx.reviewHierarchy({receipt:final,parent:edited.key,child:edited.children.at(-1).key,
        operation:'remove',allowReview:true});
      assert.equal(removal.proposed.imageSha256,afterMove.imageSha256);
      await fx.applyHierarchy({review:removal,allowApply:true});
      assert.ok(await document.save());
      assert.equal((await preview()).imageSha256,afterMove.imageSha256);
      checks.push('The installed JavaFX preview reordered overlapping nodes, added a palette node and removed it. Saved FXML produced the reviewed OpenJFX pixels.');
      return {runtime:final.runtime, initial:green, reordered:red, inserted:blue,
        previewMatchesSaved:true, safeLeafRemoval:true, replayRejected:true, jdbc:await jdbcReadback()};
    } finally {
      panel?.dispose();
      if (document.isDirty) await document.save();
      const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>
        tab.input?.uri?.scheme==='file'&&!path.relative(file,tab.input.uri.fsPath));
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
    }
  });
}

module.exports = { runJavaFxHierarchyChecks };
if (require.main===module) withHierarchyFixture(path.resolve(__dirname,'../test-output'),headless)
  .then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
