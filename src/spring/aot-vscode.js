'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inspectAotBeans, compareAotBeans, snapshot } = require('./aot-beans');

const scheme = 'rocketbrain-spring-aot';
const maxReports = 8;

function projectFor(file) {
  const parts = file.split(path.sep);
  for (let index = parts.length - 4; index > 0; index--) {
    const gradle = parts.slice(index,index + 3).join('/') === 'build/generated/aotSources';
    const maven = parts.slice(index,index + 4).join('/') === 'target/spring-aot/main/sources';
    if (gradle || maven) return parts.slice(0,index).join(path.sep) + path.sep;
  }
  throw Error('Choose a generated Spring AOT Java registration file.');
}

function registerSpringAot(vscode) {
  const reports = new Map(), subscriptions = [];
  let latest, disposed = false;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the local workspace before inspecting Spring AOT output.');
  }
  function local(value) {
    const uri = typeof value === 'string' ? vscode.Uri.parse(value) : value;
    if (uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
        !vscode.workspace.getWorkspaceFolder(uri)) {
      throw Error('Open the selected local Spring project as a workspace folder.');
    }
    return uri;
  }
  function store(value) {
    const id = randomUUID();
    while (reports.size >= maxReports) reports.delete(reports.keys().next().value);
    reports.set(id,value);
    return { id,...value };
  }
  function capture({artifactUri, projectUri} = {}) {
    trusted();
    const artifact = local(artifactUri);
    const project = projectUri ? local(projectUri).fsPath : projectFor(artifact.fsPath);
    const prior = latest;
    const recorded = store(inspectAotBeans(path.resolve(project),artifact.fsPath));
    latest = recorded.id;
    return { ...recorded, previousId:reports.get(prior)?.artifact === recorded.artifact ? prior : undefined };
  }
  async function show(report) {
    const uri = vscode.Uri.parse(scheme + ':/' + report.id + '.json');
    const document = await vscode.workspace.openTextDocument(uri);
    return vscode.window.showTextDocument(document,{preview:false});
  }
  function compare({beforeId,afterId} = {}) {
    trusted();
    const before = reports.get(beforeId), after = reports.get(afterId);
    if (!before?.artifact || !after?.artifact) throw Error('Capture the two Spring AOT registration snapshots first.');
    return store(compareAotBeans(before,after));
  }
  async function open({id,name,which = 'registration'} = {}) {
    trusted();
    const report = reports.get(id);
    const entry = report?.entries?.find(row => row.name === name);
    const selected = which === 'factory' ? entry?.factory?.source : entry?.generated;
    if (!selected) throw Error('This Spring AOT entry has no exact source location.');
    const uri = local(vscode.Uri.file(selected.file));
    if (snapshot(report.project,selected.file).sha256 !== selected.sha256) {
      throw Error('The Spring AOT source changed. Capture a new snapshot before navigating.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    trusted();
    const current = snapshot(report.project,selected.file);
    if (current.sha256 !== selected.sha256 || document.isDirty || document.getText() !== current.text) {
      throw Error('The Spring AOT source or editor changed. Capture a new snapshot before navigating.');
    }
    const { start,end } = selected.range;
    const selection = new vscode.Range(start.line,start.character,end.line,end.character);
    return vscode.window.showTextDocument(document,{selection,preview:false});
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(scheme,{
    provideTextDocumentContent(uri) {
      const id = uri.path.slice(1).replace(/\.json$/u,'');
      const report = reports.get(id);
      return report ? JSON.stringify(report,null,2) : 'This Spring AOT snapshot has expired.';
    }
  }));
  const command = (id,action) => subscriptions.push(vscode.commands.registerCommand(id,async () => {
    try { trusted(); return await action(); }
    catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Spring AOT: ' + error.message); }
  }));
  command('rocketbrain.spring.inspectAotBeans',async () => {
    const [artifact] = await vscode.window.showOpenDialog({
      title:'Choose a generated Spring AOT bean registrations Java file',
      canSelectFiles:true, canSelectFolders:false, canSelectMany:false, filters:{Java:['java']}
    }) || [];
    if (!artifact) return;
    const report = capture({artifactUri:artifact});
    await show(report);
    if (report.previousId) {
      const choice = await vscode.window.showInformationMessage('Compare with the previous snapshot of this Spring AOT artifact?', 'Compare Beans');
      if (choice === 'Compare Beans') await show(compare({beforeId:report.previousId,afterId:report.id}));
    }
    return report;
  });
  command('rocketbrain.spring.openAotBeanSource',async () => {
    const id = latest;
    const report = reports.get(id);
    if (!report) throw Error('Inspect a Spring AOT bean registration file first.');
    const items = report.entries.flatMap(entry => [
      { label:entry.name,description:'Generated registration',name:entry.name,which:'registration' },
      ...(entry.factory?.source ? [{
        label:entry.name,description:entry.factory.owner + '#' + entry.factory.method,name:entry.name,which:'factory'
      }] : [])
    ]);
    const item = await vscode.window.showQuickPick(items,{title:'Open Spring AOT bean source'});
    if (item) return open({id,name:item.name,which:item.which});
  });

  return { capture,compare,open,dispose(){
    disposed = true;
    reports.clear();
    for (const subscription of subscriptions) subscription.dispose();
  }};
}

module.exports = { registerSpringAot };
