'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { startGroovyConsole } = require('./groovy-console');
const { createGroovyProjectConsole } = require('./groovy-project-console');
const { workspaceRoots,workspacePath,inside,cancelled,fail } = require('./workbench-model');

const maxScriptBytes = 64 * 1024;
const editorText = text => text.replace(/\r\n?/g,'\n');

async function readSavedScript(file) {
  const input = await fs.open(file,'r');
  try {
    const stat = await input.stat();
    if (!stat.isFile() || stat.size > maxScriptBytes) throw fail('Run a saved UTF-8 Groovy script no larger than 64 KiB.');
    const bytes = Buffer.alloc(maxScriptBytes + 1);
    const { bytesRead } = await input.read(bytes,0,bytes.length,0);
    if (bytesRead !== stat.size) throw fail('The Groovy script changed while it was being read.');
    return bytes.subarray(0,bytesRead);
  } finally { await input.close(); }
}

const COMMANDS = Object.freeze({
  console:'rocketbrain.groovy.console', reset:'rocketbrain.groovy.resetConsole',
  selection:'rocketbrain.groovy.evaluateSelection', script:'rocketbrain.groovy.runScript',
  tests:'rocketbrain.groovy.runTests', project:'rocketbrain.groovy.projectSelection',
  stopProject:'rocketbrain.groovy.stopProject'
});

function registerGroovyWorkbench(vscode,java) {
  const output = vscode.window.createOutputChannel('Rocketbrain Groovy Console');
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-groovy');
  const subscriptions = [output,diagnostics];
  const jobs = new Set(), processes = new Set();
  let console, consoleKey, busy = false, disposed = false, epoch = 0, closing;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw fail('Trust this local workspace before executing Groovy code.');
  }

  function directory(value) {
    trusted();
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    if (!roots.length) throw fail('Open a local workspace before evaluating Groovy.');
    return workspacePath(value || roots[0],roots);
  }

  function configuration(workingDirectory) {
    const config = vscode.workspace.getConfiguration('rocketbrain.java');
    return {workspacePath:directory(workingDirectory),
      javaHome:config.get('javaHome') || java.getState().javaHome,gradleHome:config.get('gradleHome'),
      groovyJar:config.get('groovyConsoleJar'),workspaceTrusted:vscode.workspace.isTrusted};
  }

  const projectConsole = createGroovyProjectConsole(vscode, java, { trusted, configuration, readSavedScript });

  async function openWorker(options,ticket) {
    const child = await startGroovyConsole(options);
    if (disposed || !vscode.workspace.isTrusted || ticket !== epoch) {
      await child.dispose();
      throw fail('The Groovy console context changed before execution.');
    }
    processes.add(child);
    void child.terminated.finally(() => processes.delete(child)).catch(() => {});
    return child;
  }

  function track(action) {
    const pending = Promise.resolve().then(action);
    jobs.add(pending);
    void pending.finally(() => jobs.delete(pending)).catch(() => {});
    return pending;
  }

  async function reset() {
    epoch++;
    const previous=console;
    console=null;
    consoleKey=null;
    if (previous) await previous.dispose();
  }

  async function evaluate({code,workingDirectory,name,cancellation} = {}) {
    trusted();
    if (busy) throw fail('Wait for the current Groovy evaluation to finish.');
    busy=true;
    try {
      if (cancelled(cancellation)) throw fail('Groovy evaluation cancelled.');
      const options=configuration(workingDirectory), key=JSON.stringify(options);
      if (!console || console.closed || consoleKey !== key) {
        await reset();
        trusted();
        console=await openWorker(options,epoch);
        consoleKey=key;
      }
      trusted();
      return await console.evaluate(code,name,{cancellation});
    } finally { busy=false; }
  }

  async function runScript({document,cancellation} = {}) {
    trusted();
    if (!document || document.isDirty || document.isClosed || document.uri?.scheme !== 'file' ||
        document.uri.authority || document.uri.query || document.uri.fragment || !document.uri.fsPath.endsWith('.groovy')) {
      throw fail('Open a saved local Groovy script before running it.');
    }
    const file = workspacePath(document.uri.fsPath,workspaceRoots(vscode.workspace.workspaceFolders),{directory:false});
    const version=document.version, text=document.getText();
    const expected=await readSavedScript(file);
    const code=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(expected);
    if (editorText(code) !== editorText(text)) {
      throw fail('Run an exact saved UTF-8 Groovy script no larger than 64 KiB.');
    }
    if (document.isClosed || document.isDirty || document.version !== version || cancelled(cancellation)) {
      throw fail('The Groovy script changed before execution.');
    }
    const worker=await openWorker(configuration(path.dirname(file)),epoch);
    try {
      const saved=await readSavedScript(file);
      trusted();
      if (document.isClosed || document.isDirty || document.version !== version ||
          !saved.equals(expected) || cancelled(cancellation)) {
        throw fail('The Groovy script changed before execution.');
      }
      const receipt=await worker.evaluate(code,path.basename(file),{cancellation});
      if (!disposed && !document.isClosed && !document.isDirty && document.version === version) {
        diagnostics.delete(document.uri);
        if (receipt.state === 'error' && receipt.line > 0 && receipt.line <= document.lineCount) {
          const line=receipt.line-1, length=document.lineAt(line).text.length;
          const start=Math.min(Math.max(0,receipt.column-1),length);
          const marker=new vscode.Diagnostic(new vscode.Range(line,start,line,Math.min(start+1,length)),
            receipt.error,vscode.DiagnosticSeverity.Error);
          marker.source='Groovy';
          diagnostics.set(document.uri,[marker]);
        }
      }
      return receipt;
    } finally { await worker.dispose(); }
  }

  async function projects() {
    trusted();
    let snapshot=java.workbench.getSnapshot();
    if (!snapshot.projects.length) snapshot=await java.workbench.refresh();
    trusted();
    return snapshot.projects.filter(project => project.tool === 'gradle' && project.languages?.includes('groovy'));
  }

  async function runTests({projectUri,allowProjectExecution,cancellation} = {}) {
    trusted();
    if (allowProjectExecution !== true) throw fail('Choose the Groovy and Spock test action before executing Gradle.');
    const project=(await projects()).find(item => item.uri === projectUri);
    if (!project) throw fail('Choose a currently imported Gradle project with Groovy sources.');
    const saved = () => {
      if (vscode.workspace.textDocuments.some(document => document.isDirty && document.uri.scheme === 'file' &&
          /\.(?:groovy|java)$/.test(document.uri.fsPath) && inside(project.root,document.uri.fsPath))) {
        throw fail('Save modified Java and Groovy sources before running tests.');
      }
    };
    saved();
    const options={projectUri,allowProjectExecution:true,cancellation};
    const tasks=await java.workbench.discoverTasks(options);
    const task=tasks.find(item => [':test','test'].includes(item.name));
    if (!task) throw fail('The Groovy Gradle project has no observed test task.');
    trusted();
    saved();
    return java.workbench.runTask({...options,taskId:task.id});
  }

  function show(label,receipt) {
    output.appendLine('> '+label);
    if (receipt.stdout) output.append(receipt.stdout);
    if (receipt.stderr) output.append(receipt.stderr);
    if (receipt.error) output.appendLine(receipt.error);
    if (receipt.value) output.appendLine('=> '+receipt.value);
    if (receipt.truncated) output.appendLine('Groovy output reached its display limit.');
    output.show(true);
    return receipt;
  }

  function register(command,action) {
    subscriptions.push(vscode.commands.registerCommand(command,() => track(async () => {
      try { trusted(); return await action(); }
      catch (error) {
        const message='Rocketbrain Groovy: '+error.message;
        output.appendLine(message);
        void vscode.window.showErrorMessage(message);
        return undefined;
      }
    })));
  }

  function progress(title,action) {
    return vscode.window.withProgress({title,location:vscode.ProgressLocation.Notification,cancellable:true},
      (_progress,cancellation) => action(cancellation));
  }

  register(COMMANDS.console,async () => {
    const code=await vscode.window.showInputBox({title:'Groovy Console',prompt:'Enter a Groovy expression or statement.'});
    if (!code?.trim()) return undefined;
    return show(code,await progress('Evaluate Groovy',cancellation => evaluate({code,cancellation})));
  });
  register(COMMANDS.reset,async () => { await reset(); output.clear(); });
  register(COMMANDS.selection,async () => {
    const editor=vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'groovy' || editor.selection.isEmpty) throw fail('Select Groovy code to evaluate.');
    const code=editor.document.getText(editor.selection);
    return show(code,await progress('Evaluate Groovy Selection',cancellation => evaluate({code,cancellation})));
  });
  register(COMMANDS.script,async () => {
    const document=vscode.window.activeTextEditor?.document;
    return show(document && path.basename(document.uri.fsPath),await progress('Run Groovy Script',
      cancellation => runScript({document,cancellation})));
  });
  register(COMMANDS.tests,async () => {
    const list=await projects(), active=vscode.window.activeTextEditor?.document?.uri;
    const local=active?.scheme === 'file' && list.find(project => inside(project.root,active.fsPath));
    const selected=local || (await vscode.window.showQuickPick(list.map(project => ({label:project.name,project})),
      {title:'Run Groovy and Spock Tests'}))?.project;
    if (selected) return progress('Run Groovy and Spock Tests',cancellation =>
      runTests({projectUri:selected.uri,allowProjectExecution:true,cancellation}));
  });
  register(COMMANDS.project,async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'groovy' || editor.selection.isEmpty) throw fail('Select saved Groovy code to review.');
    const { document, selection: range } = editor;
    const projects = await progress('Find Imported Java Projects', cancellation => projectConsole.list({ cancellation }));
    if (!projects.length) throw fail('Import a local Maven or Gradle project before reviewing its Groovy classpath.');
    const selected = await vscode.window.showQuickPick(projects.map(project => ({
      label: project.name, description: project.tool, detail: project.root, project
    })), { title: 'Groovy Project Classpath' });
    if (!selected) return;
    const scope = await vscode.window.showQuickPick([
      { label: 'Runtime', value: 'runtime' }, { label: 'Test', value: 'test' }
    ], { title: 'Choose Groovy Project Classpath Scope' });
    if (!scope) return;
    const plan = await progress('Review Groovy Project Selection', cancellation =>
      projectConsole.review({ document, range, projectUri: selected.project.uri, scope: scope.value, cancellation }));
    await projectConsole.show(plan.id);
    const choice = await vscode.window.showWarningMessage('Run the reviewed Groovy project selection?',
      { modal: true, detail: selected.project.root + ' · ' + scope.label + ' classpath' }, 'Run Reviewed Code');
    if (choice !== 'Run Reviewed Code') return;
    const receipt = await progress('Run Reviewed Groovy Project Code', cancellation =>
      projectConsole.run({ id: plan.id, allowExecution: true, cancellation }));
    return show('Groovy project · ' + selected.project.name, receipt);
  });
  register(COMMANDS.stopProject,() => projectConsole.stop());
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => diagnostics.delete(event.document.uri)));
  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void reset().catch(() => {});
    void projectConsole.invalidate().catch(() => {});
    for (const child of processes) void child.dispose().catch(() => {});
  }));

  return {
    evaluate:options => track(() => evaluate(options)),runScript:options => track(() => runScript(options)),
    runTests:options => track(() => runTests(options)),reset,
    project:{list:options => track(() => projectConsole.list(options)),review:options => track(() => projectConsole.review(options)),
      show:id => track(() => projectConsole.show(id)),run:options => track(() => projectConsole.run(options)),stop:projectConsole.stop},
    dispose() {
      if (closing) return closing;
      disposed=true;
      epoch++;
      closing=(async () => {
        await Promise.allSettled([projectConsole.dispose(), ...[...processes].map(child => child.dispose())]);
        await Promise.allSettled(jobs);
        for (const item of subscriptions) item.dispose();
      })();
      return closing;
    }
  };
}

module.exports = { registerGroovyWorkbench,COMMANDS };
