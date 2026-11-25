'use strict';

const path = require('node:path');
const { createJvmDiagnostics } = require('./jvm-diagnostics');
const { showHeapAnalysis } = require('./hprof-vscode');
const { packageName } = require('./workbench-model');

const COMMANDS = {
  record: 'rocketbrain.java.recordJvmProfile',
  inspectRecording: 'rocketbrain.java.inspectJvmRecording',
  threads: 'rocketbrain.java.captureJvmThreads',
  inspectThreads: 'rocketbrain.java.inspectJvmThreads',
  heap: 'rocketbrain.java.inspectJvmHeapHistogram',
  heapDump: 'rocketbrain.java.inspectJvmHeapDump'
};
const EXCLUDE = '**/{.git,.gradle,node_modules,target,build,bin,dist}/**';

function local(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment;
}

async function openJavaFrame(vscode, frame) {
  const binary = frame?.type?.split('$')[0] || '';
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(binary) || !Number.isInteger(frame.line) || frame.line < 1) return false;
  const parts = binary.split('.'), simple = parts.pop();
  const sources = await vscode.workspace.findFiles('**/' + simple + '.java', EXCLUDE, 15);
  const matches = [];
  for (const uri of sources.filter(local)) {
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    if (source.length <= 512 * 1024 && packageName(source) === parts.join('.') && frame.line <= document.lineCount) matches.push(document);
  }
  if (matches.length !== 1) return false;
  const point = new vscode.Position(frame.line - 1, 0);
  await vscode.window.showTextDocument(matches[0], { preview: true, selection: new vscode.Range(point, point) });
  return true;
}

function registerJvmDiagnostics(context,vscode,{java}) {
  const base = (context.storageUri || context.globalStorageUri).fsPath;
  const storagePath = path.join(base,'jvm-diagnostics');
  const output = vscode.window.createOutputChannel('Rocketbrain JVM Diagnostics');
  let disposed = false, activeEngine, activeHome, disposal;
  const pending = new Map();

  function trusted() {
    if (!vscode.workspace.isTrusted || disposed) throw Error('Use JVM diagnostics in a trusted workspace.');
  }

  function engine() {
    trusted();
    const javaHome = java.getState().javaHome || vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');
    if (!activeEngine || javaHome !== activeHome) {
      activeHome = javaHome;
      activeEngine = createJvmDiagnostics({ javaHome,storagePath,trusted });
    }
    return activeEngine;
  }

  function progress(title, work) {
    return vscode.window.withProgress({ title,cancellable:true,location:vscode.ProgressLocation.Notification }, async (_p,token) => {
      const controller = new AbortController();
      const sub = token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) controller.abort();
      const operation = Promise.resolve().then(() => work(controller.signal));
      pending.set(controller,operation);
      try { return await operation; }
      finally { pending.delete(controller); sub.dispose(); }
    });
  }

  async function chooseProcess() {
    const jvm = await progress('Find Local Java Processes',signal => engine().list({signal}));
    const item = await vscode.window.showQuickPick([
      ...jvm.map(process => ({ label:'PID ' + process.pid,description:process.label,pid:process.pid })),
      { label:'Enter a Java Process ID',manual:true }
    ], { title:'Select Local JVM' });
    if (!item) return;
    if (!item.manual) return item.pid;
    const typed = await vscode.window.showInputBox({ title:'Local Java Process ID',
      validateInput:value => /^\d{1,10}$/.test(value) && Number(value) > 0 ? undefined : 'Enter a positive process ID.' });
    return typed === undefined ? undefined : Number(typed);
  }

  async function chooseSave(extension, label, defaultName) {
    const workspace = vscode.workspace.workspaceFolders?.find(folder => local(folder.uri));
    const uri = await vscode.window.showSaveDialog({ title:label, filters:{ [label]:[extension] },
      defaultUri:workspace ? vscode.Uri.joinPath(workspace.uri,defaultName + '.' + extension) : undefined });
    if (uri && !local(uri)) throw Error('Choose a local diagnostic output.');
    return uri?.fsPath;
  }

  async function chooseInput(extension, label) {
    const uris = await vscode.window.showOpenDialog({ title:label,canSelectMany:false,canSelectFolders:false,
      filters:{ [label]:extension } });
    if (!uris?.length) return;
    if (!local(uris[0])) throw Error('Choose a local diagnostic file.');
    return uris[0].fsPath;
  }

  function show(title, detail) {
    output.appendLine(title);
    for (const line of detail) output.appendLine(line);
    output.appendLine('');
    output.show(true);
  }

  const openFrame = frame => openJavaFrame(vscode, frame);

  const labelFrame = frame => frame.type + '.' + frame.method + (frame.line ? ':' + frame.line : '');

  async function showProfile(profile) {
    const groups = [
      { label:'CPU Methods',detail:profile.cpuSamples + ' samples', rows:profile.cpuMethods },
      { label:'Allocation Methods',detail:profile.allocationSamples + ' samples', rows:profile.allocationMethods },
      { label:'Allocation Types',detail:profile.estimatedAllocationBytes.toLocaleString() + ' sampled bytes', rows:profile.allocationTypes },
      { label:'CPU Stack Paths', stacks:profile.cpuStacks },
      { label:'Allocation Stack Paths', stacks:profile.allocationStacks }
    ];
    const chosen = await vscode.window.showQuickPick(groups,{ title:'JVM Profile · CPU and Allocation Samples' });
    if (!chosen) return;
    if (chosen.stacks) {
      const stack = (await vscode.window.showQuickPick(chosen.stacks.map(stack => ({
        label:labelFrame(stack.frames[0]),description: stack.cpu ? stack.cpu + ' samples' : stack.allocated.toLocaleString() + ' sampled bytes',stack
      })), { title:chosen.label }))?.stack;
      if (!stack) return;
      const frame = (await vscode.window.showQuickPick(stack.frames.map(frame => ({ label:labelFrame(frame),frame })),
        { title:'Sample Stack · Leaf to Root' }))?.frame;
      if (frame && !await openFrame(frame)) show(chosen.label,stack.frames.map(labelFrame));
    } else {
      const row = (await vscode.window.showQuickPick(chosen.rows.map(row => ({
        label:row.method ? labelFrame(row) : row.type,
        description:chosen.label === 'CPU Methods' ? row.selfCpu + ' self / ' + row.cpu + ' inclusive samples' :
          (row.method ? row.allocated : row.bytes).toLocaleString() + ' sampled bytes', row
      })), { title:chosen.label }))?.row;
      if (row && (!row.method || !await openFrame(row))) show(chosen.label,[row.method ? labelFrame(row) : row.type]);
    }
  }

  async function showThreads(record) {
    const items = [
      ...(record.snapshot ? [
        ...record.snapshot.monitorCycles.map(cycle => ({ label:'Monitor cycle', description:cycle.join(' → '),cycle })),
        ...record.snapshot.threads.map(thread => ({
          label:thread.name || '#' + thread.id, description:[thread.virtual ? 'Virtual' : 'Platform',thread.state].filter(Boolean).join(' · '),
          thread
        }))
      ] : []),
      ...(record.locks ? [
        { label:'JVM Deadlock Report',description:record.locks.jvmDeadlocks + ' reported',locks:record.locks },
        ...(record.snapshot ? [] : record.locks.threads.map(thread => ({
          label:thread.name,description:thread.state,thread
        })))
      ] : [])
    ];
    const counts = record.snapshot ? ' · ' + record.snapshot.platformThreads + ' platform / ' + record.snapshot.virtualThreads + ' virtual' : '';
    const choice = await vscode.window.showQuickPick(items,{ title:'JVM Threads' + counts });
    if (choice?.locks) {
      show('JVM Deadlock Report',choice.locks.waitEdges.length ? choice.locks.waitEdges.map(edge => edge.thread + ' waits for ' + edge.heldBy) :
        [choice.locks.jvmDeadlocks + ' deadlocks reported by the JVM']);
    } else if (choice?.cycle) {
      const byId = new Map(record.snapshot.threads.map(thread => [thread.id,thread]));
      show('Monitor cycle in thread snapshot',choice.cycle.map(id => {
        const item = byId.get(id);
        return item.name + ' waits on ' + item.blockedOn;
      }));
    } else if (choice?.thread) {
      const thread = choice.thread;
      const monitors = thread.monitors || thread.locks || [];
      const other = thread.synchronizers || [];
      show(thread.name || '#' + thread.id,[
        thread.state,
        ...(thread.blockedOn ? ['Waiting on ' + thread.blockedOn] : []),
        ...(thread.awaiting || []).map(lock => 'Waiting on ' + lock),
        ...monitors.map(lock => 'Owns monitor ' + lock),
        ...other.map(lock => 'Owns synchronizer ' + lock),
        ...(thread.stack || [])
      ]);
    }
  }

  async function record() {
    const pid = await chooseProcess();
    if (!pid) return;
    const time = await vscode.window.showQuickPick([3,5,10,20,30].map(seconds => ({ label:seconds + ' seconds',seconds })),
      { title:'Record CPU and Allocation Samples' });
    if (!time) return;
    const output = await chooseSave('jfr','Flight Recording','java-' + pid);
    if (!output) return;
    const result = await progress('Record JVM Flight',async signal => {
      const service = engine();
      const target = await service.select(pid,{signal});
      return service.profile(target,{seconds:time.seconds,output,signal});
    });
    await showProfile(result.summary);
    return result;
  }

  async function inspectRecording() {
    const input = await chooseInput(['jfr'],'Flight Recording');
    if (!input) return;
    const report = await progress('Inspect Flight Recording',signal => engine().inspectJfr(input,{signal}));
    await showProfile(report);
    return report;
  }

  async function threads() {
    const pid = await chooseProcess();
    if (!pid) return;
    const type = await vscode.window.showQuickPick([
      { label:'Inspect in VS Code',format:'json' },
      { label:'Save Structured Thread Dump',extension:'json',format:'json' },
      { label:'Save Platform Thread and Lock Dump',extension:'txt',format:'locks' }
    ],{ title:'Capture JVM Threads' });
    if (!type) return;
    const output = type.extension ? await chooseSave(type.extension,type.label,'java-threads-' + pid) : undefined;
    if (type.extension && !output) return;
    const result = await progress('Capture JVM Threads',async signal => {
      const service = engine();
      return service.captureThreads(await service.select(pid,{signal}),{output,format:type.format,signal});
    });
    await showThreads(result);
    return result;
  }

  async function inspectThreads() {
    const input = await chooseInput(['json','txt'],'JVM Thread Dump');
    if (!input) return;
    const report = await progress('Inspect JVM Thread Dump',signal => engine().inspectThreads(input,{signal}));
    await showThreads(report);
    return report;
  }

  async function heap() {
    const pid = await chooseProcess();
    if (!pid) return;
    const confirmed = await vscode.window.showQuickPick([
      { label:'Capture Class Histogram',description:'Inspect the heap by class, including unreachable objects.' }
    ],{ title:'Local JVM Heap Histogram' });
    if (!confirmed) return;
    const report = await progress('Inspect JVM Heap Histogram',async signal => {
      const service = engine();
      return service.histogram(await service.select(pid,{signal}),{signal});
    });
    const choice = (await vscode.window.showQuickPick(report.rows.map(row => ({
      label:row.type, description:row.instances.toLocaleString() + ' instances · ' + row.bytes.toLocaleString() + ' bytes',
      detail:row.module,row
    })), { title:'JVM Heap Histogram · ' + report.total.bytes.toLocaleString() + ' bytes' }))?.row;
    if (choice) show('Class ' + choice.type,[choice.instances + ' instances',choice.bytes + ' bytes']);
    return report;
  }

  async function heapDump() {
    const input=await chooseInput(['hprof'],'HotSpot Heap Dump');
    if(!input)return;
    const analysis=await progress('Analyze JVM Heap Dump',signal=>engine().inspectHeapDump(input,{signal}));
    await showHeapAnalysis(vscode,analysis,show);
    return analysis.metrics;
  }

  const handlers = { record,inspectRecording,threads,inspectThreads,heap,heapDump };
  const commands = Object.entries(handlers).map(([key,handler]) => vscode.commands.registerCommand(COMMANDS[key],async () => {
    try { trusted(); return await handler(); }
    catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain JVM: ' + error.message); return null; }
  }));
  return {
    list:options => engine().list(options),
    select:(pid,options) => engine().select(pid,options),
    profile:(target,options) => engine().profile(target,options),
    inspectJfr:(input,options) => engine().inspectJfr(input,options),
    captureThreads:(target,options) => engine().captureThreads(target,options),
    inspectThreads:(input,options) => engine().inspectThreads(input,options),
    histogram:(target,options) => engine().histogram(target,options),
    inspectHeapDump:(input,options) => engine().inspectHeapDump(input,options),
    dispose() {
      if (disposal) return disposal;
      for (const controller of pending.keys()) controller.abort();
      disposed = true;
      for (const command of commands) command.dispose();
      disposal = Promise.allSettled(pending.values()).then(() => output.dispose());
      return disposal;
    }
  };
}

module.exports = { registerJvmDiagnostics, openJavaFrame, COMMANDS };
