'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { independentJavaExecutable } = require('./debug-runtime');
const { streamPipeline, traceStream } = require('./stream-trace');

const scheme = 'rocketbrain-java-stream';
const traceCommand = 'rocketbrain.java.traceStream';
const navigateCommand = 'rocketbrain.java.navigateStreamStage';

function registerStreamTrace(vscode, java) {
  const reports = new Map();
  const running = new Set();
  let disposed = false;
  const trusted = () => {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted workspace before running a Java stream trace.');
  };
  const keyFor = uri => uri.path.split('/')[1];
  async function confirmJdkType(pipeline, document, offset) {
    if (pipeline.origin.startsWith('java.util.')) return;
    const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', document.uri, document.positionAt(offset+pipeline.stages[0].start));
    const expected = pipeline.list ? /(?:java\.util|java\/util)\/List\.class$/ : /(?:java\.util\.stream|java\/util\/stream)\/Stream\.class$/;
    if (!Array.isArray(definitions) || !definitions.length || definitions.some(location => {
      const uri = location.targetUri || location.uri;
      return uri?.scheme !== 'jdt' || !expected.test(uri.path);
    })) throw Error('Select a JDK Stream.of or List.of pipeline. A fully qualified JDK class name also identifies the source.');
  }

  function sourceFrame(document, range) {
    trusted();
    if (!document || document.isClosed || document.languageId !== 'java' || document.uri.scheme !== 'file' ||
        !vscode.workspace.getWorkspaceFolder(document.uri) || !range || range.isEmpty) {
      throw Error('Select a complete stream expression in a local Java editor.');
    }
    return { document,range,version:document.version,text:document.getText(range),offset:document.offsetAt(range.start) };
  }

  function current(frame) {
    trusted();
    const { document,version,range,text } = frame;
    if (document.isClosed || document.version !== version || document.getText(range) !== text) {
      throw Error('The Java source changed. Run a trace on the current selection.');
    }
  }

  async function trace(document, range, { signal } = {}) {
    const frame = sourceFrame(document,range);
    const pipeline = streamPipeline(frame.text);
    const javaHome = java.getState().javaHome;
    if (!javaHome) throw Error('Configure the independent JDK before running a Java stream trace.');
    const executable = independentJavaExecutable(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
    await confirmJdkType(pipeline,document,frame.offset);
    current(frame);
    const controller = new AbortController();
    running.add(controller);
    let receipt;
    try {
      receipt = await traceStream(frame.text,executable,{signal:signal ? AbortSignal.any([controller.signal,signal]) : controller.signal});
    } finally { running.delete(controller); }
    current(frame);
    const id = randomUUID();
    while (reports.size >= 4) reports.delete(reports.keys().next().value);
    reports.set(id,{ frame,receipt });
    return { ...structuredClone(receipt), uri:vscode.Uri.from({scheme,path:`/${id}/Java Stream.txt`}) };
  }

  function rendered(receipt) {
    const value = input => input === null ? 'null' : JSON.stringify(input);
    const lines = receipt.stages.flatMap((stage,index) => {
      const events = receipt.events.filter(event => event.stage === index);
      return [stage.name+' · '+events.length+' events',...events.map(event =>
        '  '+event.action+' '+value(event.input)+(event.action==='mapped'||event.action==='flat value'?' → '+value(event.output):'')), ''];
    });
    if (receipt.truncated) lines.push('The trace reached its 512-event limit.');
    return lines.join('\n');
  }

  async function reveal(uri, index) {
    const report = uri?.scheme === scheme && reports.get(keyFor(uri));
    const stage = report?.receipt.stages[index];
    if (!stage) throw Error('Open an available Java stream trace and select a stage.');
    current(report.frame);
    const { document,offset } = report.frame;
    const selection = new vscode.Range(document.positionAt(offset+stage.start),document.positionAt(offset+stage.end));
    await vscode.window.showTextDocument(document,{ selection,preview:false });
    return { document,selection };
  }

  const subscriptions = [vscode.workspace.registerTextDocumentContentProvider(scheme,{
    provideTextDocumentContent(uri) {
      const report = !disposed && vscode.workspace.isTrusted && reports.get(keyFor(uri));
      return report ? rendered(report.receipt) : '';
    }
  })];
  function command(name, action) {
    subscriptions.push(vscode.commands.registerCommand(name,async()=>{
      try { trusted();return await action(); }
      catch(error) { await vscode.window.showErrorMessage(error.message); }
    }));
  }
  command(traceCommand, async () => {
    const editor = vscode.window.activeTextEditor;
    const frame = sourceFrame(editor?.document,editor?.selection);
    if (await vscode.window.showInformationMessage('Run the selected Java stream with the configured JDK?',{modal:true},'Run Trace') !== 'Run Trace') return;
    current(frame);
    const receipt = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Running Java stream trace',cancellable:true},
      async(_,token)=>{
        const controller = new AbortController(), listener = token.onCancellationRequested(()=>controller.abort());
        if(token.isCancellationRequested)controller.abort();
        try {return await trace(frame.document,frame.range,{signal:controller.signal});}
        finally {listener.dispose();}
      });
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(receipt.uri),{preview:false});
  });
  command(navigateCommand, async () => {
    const uri = vscode.window.activeTextEditor?.document.uri;
    const report = uri?.scheme === scheme && reports.get(keyFor(uri));
    if (!report) throw Error('Open a Java stream trace.');
    const stage = await vscode.window.showQuickPick(report.receipt.stages.map((item,index)=>({label:item.name,index})),
      {title:'Go to Java Stream Stage'});
    if (stage) await reveal(uri,stage.index);
  });
  return { trace,reveal,dispose(){
    disposed = true;
    for(const controller of running)controller.abort();
    reports.clear();
    for(const disposable of subscriptions)disposable.dispose();
  } };
}

module.exports = { registerStreamTrace };
