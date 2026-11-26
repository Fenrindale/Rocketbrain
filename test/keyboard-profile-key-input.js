'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const vscode = require('vscode');

const exec = promisify(execFile);
const original = 'select id from ledger\nwhere id=1;\n';
const phase = process.env.ROCKETBRAIN_KEYBOARD_INPUT_PHASE;
const sleep = delay => new Promise(resolve=>setTimeout(resolve,delay));

async function until(test,description) {
  const deadline = Date.now()+10000;
  while (Date.now()<deadline) {
    const value = await test();
    if (value) return value;
    await sleep(80);
  }
  throw Error('Timed out waiting for '+description);
}

async function run() {
  assert.equal(process.platform,'linux');
  assert.equal(process.env.ROCKETBRAIN_OWNED_KEYBOARD_DISPLAY,'1');
  assert.match(process.env.DISPLAY,/^:\d+(?:\.\d+)?$/u);
  assert.ok(['enable','reload','other'].includes(phase));
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain');
  await until(()=>extension?.isActive,'normal extension startup');
  const api = extension.exports;
  assert.ok(api?.keyboardProfile);
  const service = api.keyboardProfile;
  const root = vscode.workspace.workspaceFolders[0].uri;
  const expectedInitial = phase==='reload';
  assert.equal((await service.workspaceStatus()).enabled,expectedInitial);

  const windows = await exec('xdotool',['search','--onlyvisible','--class','^[Cc]ode$'],{timeout:5000});
  const visible = windows.stdout.trim().split(/\s+/u).filter(Boolean);
  assert.equal(visible.length,1,'Use one owned visible VS Code window on the dedicated display.');
  assert.match(visible[0],/^\d+$/u);
  await exec('xdotool',['windowfocus','--sync',visible[0]],{timeout:5000});
  const press = (...keys) => exec('xdotool',['key','--clearmodifiers','--delay','130',...keys],{timeout:5000});
  const record = {phase,initialEnabled:expectedInitial};

  const file = vscode.Uri.joinPath(root,'owned-shortcuts.sql');
  const document = await vscode.workspace.openTextDocument(file);
  const editor = await vscode.window.showTextDocument(document,{preview:false,preserveFocus:false});
  const value = () => document.getText();
  const focus = () => vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');

  async function reset() {
    if (value()!==original) {
      assert.ok(await editor.edit(edit=>edit.replace(new vscode.Range(
        document.positionAt(0),document.positionAt(value().length)),original)));
    }
    const end = document.positionAt(original.length);
    editor.selection = new vscode.Selection(end,end);
    await focus();
    await sleep(120);
  }

  try {
    assert.equal(value(),original);
    if (!expectedInitial) {
      await reset();
      await press('ctrl+shift+F10','f');
      await until(()=>value()===original+'f','ordinary typing while the profile is disabled');
      record.disabledLeavesLetter=true;
      if (phase==='other') return await complete(record);
      assert.equal((await service.setWorkspaceEnabled(true)).enabled,true);
    }

    // Obtain the formatter's exact text through the ordinary command before checking physical key dispatch.
    await reset();
    await vscode.commands.executeCommand('rocketbrain.sql.format');
    const formatted = await until(()=>value()!==original&&value(),'the ordinary SQL format command');
    await reset();
    await press('ctrl+shift+F10','f');
    await until(()=>value()===formatted,'physical SQL formatting chord');
    record.formatsSQL=true;

    await reset();
    const picker = vscode.window.createQuickPick();
    picker.items = [{label:'Owned shortcut focus probe'}];
    picker.title = 'Owned shortcut focus probe';
    try {
      picker.show();
      await sleep(250);
      await press('ctrl+shift+F10','f');
      await until(()=>picker.value==='f','normal typing into Quick Pick');
      assert.equal(value(),original);
      record.quickOpenFocusProtected=true;
    } finally {picker.dispose();}
    await reset();

    await press('ctrl+shift+F10','Escape','f');
    await until(()=>value()===original+'f','normal typing after the chord is cancelled');
    record.escapeCancelsChord=true;
    await reset();

    if (phase==='enable') {
      // Validate the Java-specific route with an actual VS Code provider and source positions.
      assert.equal(api.java.getState().state,'stopped','An SQL-only workspace must not automatically start JDT.');
      const javaUri = vscode.Uri.joinPath(root,'OwnedKeyboard.java');
      const source = 'final class OwnedKeyboard {\n    int marker;\n    int read() { return marker; }\n}\n';
      await vscode.workspace.fs.writeFile(javaUri,Buffer.from(source));
      const java = await vscode.workspace.openTextDocument(javaUri);
      const position = new vscode.Position(2,24), target = new vscode.Position(1,8);
      const language = vscode.languages.registerDefinitionProvider({language:'java',scheme:'file'},{
        provideDefinition:()=>new vscode.Location(javaUri,target)
      });
      try {
        const local = await vscode.window.showTextDocument(java,{preview:false,preserveFocus:false});
        local.selection = new vscode.Selection(position,position);
        await sleep(240);
        await press('ctrl+shift+F9','d');
        await until(()=>local.selection.active.line===1,'physical Java definition chord');
        assert.equal(local.selection.active.character,8);
        record.javaDefinition=true;
      } finally {language.dispose();}
      await until(()=>api.java.getState().state==='configuration-required','Java source admission');
      record.sqlOnlyStartupIdle=true;
      record.javaDocumentAdmitted=true;
    } else {
      assert.equal((await service.setWorkspaceEnabled(false)).enabled,false);
      await reset();
      await press('ctrl+shift+F10','f');
      await until(()=>value()===original+'f','ordinary typing after disabling the profile');
      record.disabledAfterReload=true;
    }
    return await complete(record);
  } finally {
    await vscode.window.showTextDocument(document,{preview:false,preserveFocus:false});
    await reset();
    await document.save();
  }
}

async function complete(record) {
  await fs.writeFile(path.join(process.env.ROCKETBRAIN_KEYBOARD_INPUT_RECEIPTS,phase+'.json'),
    JSON.stringify(record,null,2)+'\n',{flag:'wx'});
}
module.exports = {run};
