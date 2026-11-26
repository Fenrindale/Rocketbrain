'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { startGroovyConsole } = require('./groovy-console');
const { openSpecification, runSpockSpecification } = require('./spock-specification');
const { nativeTaskRunner } = require('./workbench-tasks');
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
  tests:'rocketbrain.groovy.runTests', specification:'rocketbrain.groovy.runSpecification', project:'rocketbrain.groovy.projectSelection',
  stopProject:'rocketbrain.groovy.stopProject', members:'rocketbrain.groovy.completeTypedMember',
  declaration:'rocketbrain.groovy.openTypedMemberDeclaration'
});

function registerGroovyWorkbench(vscode,java,{ specificationRunner } = {}) {
  const output = vscode.window.createOutputChannel('Rocketbrain Groovy Console');
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-groovy');
  const subscriptions = [output,diagnostics];
  const spockTasks = specificationRunner || nativeTaskRunner(vscode, { output });
  const jobs = new Set(), processes = new Set();
  let console, consoleKey, busy = false, disposed = false, epoch = 0, closing, spockRunning = false;

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
    if (spockRunning) throw fail('Wait for the selected Spock specification to finish.');
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

  async function runSpecification({ document, projectUri, allowProjectExecution, cancellation } = {}) {
    trusted();
    if (allowProjectExecution !== true) throw fail('Choose Run Selected Spock Specification before executing Gradle.');
    if (spockRunning) throw fail('Wait for the selected Spock specification to finish.');
    spockRunning = true;
    const ticket = epoch;
    try {
      const candidates = (await projects()).filter(project =>
        document?.uri?.scheme === 'file' && inside(project.root, document.uri.fsPath));
      candidates.sort((left, right) => right.root.length - left.root.length);
      const project = candidates[0];
      if (!project || projectUri && project.uri !== projectUri) throw fail('Select the saved Groovy source in its imported Gradle project.');
      const roots = workspaceRoots(vscode.workspace.workspaceFolders);
      const selection = await openSpecification(document, project, roots, readSavedScript);
      const verify = async () => {
        trusted();
        if (ticket !== epoch) throw fail('The Groovy workspace changed while preparing the Spock specification.');
        if (java.workbench.getSnapshot().taskRunning) throw fail('Wait for the current Java workbench build to finish.');
        if (vscode.workspace.textDocuments.some(source => source.isDirty && source.uri.scheme === 'file' &&
            /\.(?:groovy|java|gradle|kts|properties)$/u.test(source.uri.fsPath) && inside(project.root, source.uri.fsPath))) {
          throw fail('Save modified sources and Gradle build files before testing the specification.');
        }
        await selection.validate();
      };
      const tools = configuration(project.root);
      const receipt = await runSpockSpecification({ selection, project, tools, runner: spockTasks, verify, cancellation });
      if (receipt.state === 'cancelled') return receipt;
      await verify();
      const failures = receipt.cases.flatMap(result => {
        if (result.state !== 'FAILURE' || !result.line || !result.message) return [];
        const line = result.line - 1;
        const diagnostic = new vscode.Diagnostic(new vscode.Range(line, 0, line, document.lineAt(line).text.length),
          result.message, vscode.DiagnosticSeverity.Error);
        diagnostic.source = 'Spock';
        return [diagnostic];
      });
      diagnostics.set(document.uri, failures);
      return receipt;
    } finally { spockRunning = false; }
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
  register(COMMANDS.specification, async () => {
    const document = vscode.window.activeTextEditor?.document;
    const receipt = await progress('Run Selected Spock Specification', cancellation =>
      runSpecification({ document, allowProjectExecution: true, cancellation }));
    if (receipt.state === 'cancelled') return receipt;
    const counts = ['SUCCESS', 'FAILURE', 'SKIPPED'].map(state => receipt.cases.filter(item => item.state === state).length);
    output.appendLine(receipt.specification + ' · ' + counts[0] + ' passed, ' + counts[1] + ' failed, ' + counts[2] + ' skipped');
    for (const item of receipt.cases) {
      output.appendLine(item.state + ' · ' + item.displayName + ' (' + item.durationMs + ' ms)');
      if (item.message) output.appendLine(item.message);
    }
    output.show(true);
    return receipt;
  });
  async function chooseProject() {
    const projects = await progress('Find Imported Java Projects', cancellation => projectConsole.list({ cancellation }));
    if (!projects.length) throw fail('Import a local Maven or Gradle project before reviewing its Groovy classpath.');
    const selected = await vscode.window.showQuickPick(projects.map(project => ({
      label: project.name, description: project.tool, detail: project.root, project
    })), { title: 'Groovy Project Classpath' });
    if (!selected) return;
    const scope = await vscode.window.showQuickPick([
      { label: 'Runtime', value: 'runtime' }, { label: 'Test', value: 'test' }
    ], { title: 'Choose Groovy Project Classpath Scope' });
    return scope ? { selected, scope } : undefined;
  }

  register(COMMANDS.project,async () => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'groovy' || editor.selection.isEmpty) throw fail('Select saved Groovy code to review.');
    const { document, selection: range } = editor;
    const choiceOfProject = await chooseProject();
    if (!choiceOfProject) return;
    const { selected, scope } = choiceOfProject;
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
  async function typedMember(action) {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== 'groovy') throw fail('Open a Groovy source editor to inspect a typed member.');
    const { document, selection } = editor, position = selection.active;
    const chosen = await chooseProject();
    if (!chosen) return;
    const plan = await progress('Inspect Typed Groovy Members', cancellation => projectConsole.members.inspect({
      document, position, projectUri: chosen.selected.project.uri, scope: chosen.scope.value, cancellation
    }));
    if (!plan.members.length) throw fail('No attributable public Java methods match this Groovy member prefix.');
    const selected = await vscode.window.showQuickPick(plan.members.map(member => ({
      label: member.name, description: '(' + member.parameters.join(', ') + ')',
      detail: member.owner + ' → ' + member.returnType, member
    })), { title: action === 'apply' ? 'Complete Typed Groovy Member' : 'Open Typed Groovy Member Declaration' });
    if (selected) return progress('Verify Typed Groovy Member', cancellation =>
      projectConsole.members[action]({ id: plan.id, key: selected.member.key, editor, cancellation }));
  }
  register(COMMANDS.members,() => typedMember('apply'));
  register(COMMANDS.declaration,() => typedMember('openDeclaration'));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => diagnostics.delete(event.document.uri)));
  if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    void reset().catch(() => {});
    void projectConsole.invalidate().catch(() => {});
    void spockTasks.stop?.().catch(() => {});
    for (const child of processes) void child.dispose().catch(() => {});
  }));

  return {
    evaluate:options => track(() => evaluate(options)),runScript:options => track(() => runScript(options)),
    runTests:options => track(() => runTests(options)),
    runSpecification:options => track(() => runSpecification(options)),reset,
    project:{list:options => track(() => projectConsole.list(options)),review:options => track(() => projectConsole.review(options)),
      show:id => track(() => projectConsole.show(id)),run:options => track(() => projectConsole.run(options)),stop:projectConsole.stop,
      members: {
        inspect:options => track(() => projectConsole.members.inspect(options)),
        apply:options => track(() => projectConsole.members.apply(options)),
        openDeclaration:options => track(() => projectConsole.members.openDeclaration(options))
      }
    },
    dispose() {
      if (closing) return closing;
      disposed=true;
      epoch++;
      closing=(async () => {
        await Promise.allSettled([projectConsole.dispose(), spockTasks.dispose?.(), ...[...processes].map(child => child.dispose())]);
        await Promise.allSettled(jobs);
        for (const item of subscriptions) item.dispose();
      })();
      return closing;
    }
  };
}

module.exports = { registerGroovyWorkbench,COMMANDS };
