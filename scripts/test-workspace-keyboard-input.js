'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFileSync,spawn} = require('node:child_process');
const {downloadAndUnzipVSCode} = require('@vscode/test-electron');

const vscodeVersion = '1.100.3';

async function addProbeExtension(extensions,root) {
  const folder = path.join(extensions,'rocketbrain-fixture.keyboard-input-0.0.1');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({
    name:'keyboard-input',publisher:'rocketbrain-fixture',version:'0.0.1',private:true,
    engines:{vscode:'^1.100.0'},activationEvents:['onStartupFinished'],main:'./index.js'
  }),{flag:'wx'});
  await fs.copyFile(path.join(root,'test','keyboard-profile-key-input.js'),path.join(folder,'probe.js'));
  await fs.writeFile(path.join(folder,'index.js'),[
    "'use strict';",
    "const vscode=require('vscode');",
    "const fs=require('node:fs/promises');",
    "const path=require('node:path');",
    "exports.activate=()=>{",
    "  const phase=process.env.ROCKETBRAIN_KEYBOARD_INPUT_PHASE;",
    "  const root=process.env.ROCKETBRAIN_KEYBOARD_INPUT_RECEIPTS;",
    "  void require('./probe').run().catch(async error=>{",
    "    await fs.writeFile(path.join(root,phase+'-failure.txt'),String(error.stack||error).slice(0,6000),{flag:'wx'});",
    "  }).finally(()=>vscode.commands.executeCommand('workbench.action.quit'));",
    "};",
    ""
  ].join('\n'),{flag:'wx'});
}

async function launchOwnedWindow(executable,{root,folder,profile,extensions,phase,temp}) {
  // VS Code deliberately uses memory-only workspace state with --extensionTestsPath.
  // An independently installed probe in this private profile exercises ordinary persistence.
  const child=spawn(executable,[folder,'--new-window','--user-data-dir='+profile,'--extensions-dir='+extensions,
    '--extensionDevelopmentPath='+root,'--disable-workspace-trust','--skip-welcome','--skip-release-notes',
    '--disable-updates','--disable-telemetry','--disable-gpu','--no-sandbox'],{
    cwd:folder,detached:true,stdio:'inherit',
    env:{...process.env,ROCKETBRAIN_KEYBOARD_INPUT_PHASE:phase,ROCKETBRAIN_KEYBOARD_INPUT_RECEIPTS:temp}
  });
  let timedOut=false;
  const timer=setTimeout(()=>{
    timedOut=true;
    if(child.pid && child.exitCode===null) {
      try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}
    }
  },90000);
  try {
    const result=await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>resolve({code,signal}));
    });
    const diagnostic=await fs.readFile(path.join(temp,phase+'-failure.txt'),'utf8').catch(error=>{
      if(error.code!=='ENOENT')throw error;
    });
    if(diagnostic)throw Error('Owned VS Code '+phase+' phase failed: '+diagnostic);
    assert.equal(timedOut,false,'Owned VS Code timed out during '+phase);
    assert.deepEqual(result,{code:0,signal:null});
    await fs.stat(path.join(temp,phase+'.json'));
    console.log('Owned VS Code '+phase+' phase passed.');
  } finally {clearTimeout(timer);}
}

async function run() {
  assert.equal(process.platform,'linux','Use the disposable hosted Linux display.');
  assert.equal(process.env.ROCKETBRAIN_OWNED_KEYBOARD_DISPLAY,'1');
  assert.match(process.env.DISPLAY,/^:\d+(?:\.\d+)?$/u);
  const output = path.resolve(process.env.ROCKETBRAIN_KEYBOARD_INPUT_OUTPUT);
  const real = await fs.realpath(os.tmpdir()), temp = await fs.mkdtemp(path.join(real,'rb-owned-key-input-'));
  const profile = path.join(temp,'profile'), extensions = path.join(temp,'extensions');
  const workspace = [path.join(temp,'first'),path.join(temp,'second')];
  try {
    await fs.mkdir(path.join(profile,'User'),{recursive:true});
    await fs.mkdir(extensions);
    for (const folder of workspace) {
      await fs.mkdir(folder);
      await fs.writeFile(path.join(folder,'owned-shortcuts.sql'),'select id from ledger\nwhere id=1;\n',{flag:'wx'});
    }
    const settings = {
      'telemetry.telemetryLevel':'off','extensions.autoUpdate':false,'extensions.autoCheckUpdates':false,
      'workbench.startupEditor':'none','workbench.editor.enablePreview':false,'editor.quickSuggestions':{comments:'off',strings:'off',other:'off'},
      'editor.suggestOnTriggerCharacters':false,'workbench.localHistory.enabled':false,'files.eol':'\n'
    };
    const settingsFile = path.join(profile,'User','settings.json');
    const original = JSON.stringify(settings,null,2);
    await fs.writeFile(settingsFile,original,{flag:'wx'});
    const keys = path.join(profile,'User','keybindings.json');
    const baseline = '[\n  // Owned sentinel preserved by every phase.\n]\n';
    await fs.writeFile(keys,baseline,{flag:'wx'});
    const executable = await downloadAndUnzipVSCode(vscodeVersion);
    const root = path.resolve(__dirname,'..');
    const cases = [['enable',workspace[0]],['other',workspace[1]],['reload',workspace[0]]];
    await addProbeExtension(extensions,root);
    for (const [phase,folder] of cases) await launchOwnedWindow(executable,{root,folder,profile,extensions,phase,temp});
    assert.equal(await fs.readFile(keys,'utf8'),baseline);
    assert.equal(await fs.readFile(settingsFile,'utf8'),original);
    const phases = await Promise.all(cases.map(async([name])=>JSON.parse(await fs.readFile(path.join(temp,name+'.json'),'utf8'))));
    assert.deepEqual(phases.map(row=>[row.phase,row.initialEnabled]),[['enable',false],['other',false],['reload',true]]);
    const sourceCommit = execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    await fs.writeFile(output,JSON.stringify({sourceCommit,vscodeVersion,phases,keybindingsUnchanged:true,settingsUnchanged:true,stockWorkspaceStorage:true},null,2)+'\n',{flag:'wx'});
  } finally {
    assert.equal(path.dirname(await fs.realpath(temp)),real);
    await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  }
}

run().catch(error=>{console.error(error.stack);process.exitCode=1;});
