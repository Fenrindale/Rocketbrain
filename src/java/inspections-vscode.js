'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { inspectionProfiles,inspectionProfile } = require('./inspection-profiles');
const { inspectSources } = require('./inspection-analysis');
const { inside } = require('./workbench-model');

const COMMANDS = Object.freeze({
  inspect:'rocketbrain.java.inspectProject',
  duplicates:'rocketbrain.java.findJavaDuplicates',
  clear:'rocketbrain.java.clearProjectInspections'
});
const LIMIT_FILES = 500;
const LIMIT_BYTES = 16 * 1024 * 1024;
const LIMIT_FILE = 512 * 1024;
const EXCLUDE = '**/{.git,.idea,.gradle,.metadata,build,target,out,bin,dist,node_modules}/**';
const standardLabel = 'Rocketbrain Java Inspections';
const hash = input => createHash('sha256').update(input).digest('hex');
const key = uri => process.platform === 'win32' ? uri.fsPath.toLowerCase() : uri.fsPath;

function local(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment && path.isAbsolute(uri.fsPath);
}

async function readSource(uri) {
  const file = uri.fsPath;
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || path.relative(file,await fs.realpath(file))) {
    throw Error('Linked or unavailable Java source');
  }
  if (stat.size > LIMIT_FILE) throw Error('Java source exceeds 512 KiB');
  const bytes = await fs.readFile(file);
  if (bytes.length > LIMIT_FILE) throw Error('Java source grew beyond 512 KiB');
  const text = new TextDecoder('utf-8',{ fatal:true }).decode(bytes);
  return { uri:uri.toString(),text,bytes:bytes.length,sha:hash(bytes) };
}

function registerJavaInspections(_context,vscode) {
  const diagnostics = vscode.languages.createDiagnosticCollection('rocketbrain-java-inspections');
  const active = new Set();
  const compiledReports = new WeakMap();
  let serial = 0, disposed = false, disposal;
  const severity = name => vscode.DiagnosticSeverity[
    { error:'Error',warning:'Warning',information:'Information',hint:'Hint' }[name]];

  function assertReady(cancellation) {
    if (!vscode.workspace.isTrusted || disposed) throw Error('Trust the workspace before inspecting its Java sources.');
    if (cancellation?.isCancellationRequested) throw Error('Java inspection cancelled.');
  }

  function profiles(uri) {
    return inspectionProfiles(vscode.workspace.getConfiguration('rocketbrain.java',uri).get('inspectionProfiles',[]));
  }

  function foldersFor(uri) {
    const folders = (vscode.workspace.workspaceFolders || []).filter(folder => local(folder.uri));
    const selected = uri ? folders.filter(folder => !path.relative(folder.uri.fsPath,uri.fsPath)) : folders;
    if (!selected.length) throw Error('Open a local workspace folder to inspect saved Java source.');
    return selected;
  }

  function dirty(uri) {
    return (vscode.workspace.textDocuments || []).some(document => local(document.uri) &&
      key(document.uri) === key(uri) && document.isDirty);
  }

  async function collect(folders,profile,cancellation) {
    const uris = new Map();
    for (const folder of folders) {
      for (const pattern of profile.include) {
        assertReady(cancellation);
        const matches = await vscode.workspace.findFiles(new vscode.RelativePattern(folder,pattern),EXCLUDE,LIMIT_FILES + 1,cancellation);
        if (matches.length > LIMIT_FILES) throw Error('This Java include scope has more than 500 files. Choose a narrower profile.');
        for (const uri of matches) {
          if (!local(uri) || !uri.fsPath.toLowerCase().endsWith('.java') ||
              !inside(folder.uri.fsPath,uri.fsPath) || !profile.matches(path.relative(folder.uri.fsPath,uri.fsPath))) continue;
          uris.set(key(uri),uri);
        }
        if (uris.size > LIMIT_FILES) throw Error('Inspect at most 500 saved Java files in one scope.');
      }
    }
    let total = 0;
    const files = [], skipped = [];
    for (const uri of [...uris.values()].sort((a,b) => a.fsPath.localeCompare(b.fsPath))) {
      assertReady(cancellation);
      if (dirty(uri)) {
        skipped.push({ uri:uri.toString(),reason:'Save this Java editor to inspect it.' });
        continue;
      }
      let file;
      try { file = await readSource(uri); }
      catch (error) {
        const reason = error.message.startsWith('Java source') ? error.message : 'Unavailable or non-UTF-8 Java source';
        skipped.push({ uri:uri.toString(),reason });
        continue;
      }
      total += file.bytes;
      if (total > LIMIT_BYTES) throw Error('This Java scope exceeds 16 MiB. Choose a narrower profile.');
      files.push(file);
    }
    return { files,skipped };
  }

  async function validateReadback(files,cancellation) {
    for (const file of files) {
      assertReady(cancellation);
      const uri = vscode.Uri.parse(file.uri);
      const latest = await readSource(uri).catch(() => null);
      if (!latest || latest.sha !== file.sha || dirty(uri) || !vscode.workspace.getWorkspaceFolder(uri)) {
        throw Error('A selected Java source changed during inspection. Run the profile again.');
      }
    }
  }

  function toRange(value) {
    return new vscode.Range(value.start.line,value.start.character,value.end.line,value.end.character);
  }

  function publish(result) {
    const byUri = new Map();
    for (const finding of result.findings) {
      const item = new vscode.Diagnostic(toRange(finding.range),finding.message,severity(finding.severity));
      item.source = standardLabel;
      item.code = finding.id;
      if (!byUri.has(finding.uri)) byUri.set(finding.uri,[]);
      byUri.get(finding.uri).push(item);
    }
    diagnostics.clear();
    diagnostics.set([...byUri].map(([uri,items]) => [vscode.Uri.parse(uri),items]));
  }

  async function scan({ profileName = 'Java workspace',folderUri,duplicates = true,publishDiagnostics = true,
    mode,cancellation } = {}) {
    assertReady(cancellation);
    if (folderUri && !local(folderUri)) throw Error('Choose an open local Java workspace folder.');
    const folders = foldersFor(folderUri);
    const chosen = profiles(folderUri).find(profile => profile.name === profileName);
    if (!chosen) throw Error('The selected Java inspection profile no longer exists.');
    const profile = mode ? inspectionProfile({ ...chosen,duplicateMode:mode }) : chosen;
    const ticket = ++serial;
    const { files,skipped } = await collect(folders,profile,cancellation);
    assertReady(cancellation);
    const inspected = inspectSources(files,profile,{ duplicates });
    await validateReadback(files,cancellation);
    assertReady(cancellation);
    if (ticket !== serial) throw Error('Java inspection results were superseded. Run the profile again.');
    const result = { ...inspected,profile:profile.name,scope:folders.map(folder => folder.name),
      skipped:[...skipped,...inspected.skipped] };
    compiledReports.set(result,new Map(files.map(file => [file.uri,file.sha])));
    if (publishDiagnostics) publish(result);
    return result;
  }

  async function reveal(report,item) {
    assertReady();
    const snapshots = compiledReports.get(report);
    const uri = vscode.Uri.parse(item.uri);
    if (!snapshots?.has(item.uri) || !local(uri) || !vscode.workspace.getWorkspaceFolder(uri)) {
      throw Error('Run Java inspection again to reveal this location.');
    }
    const current = await readSource(uri).catch(() => null);
    if (!current || current.sha !== snapshots.get(item.uri) || dirty(uri)) {
      throw Error('The Java source changed after inspection. Run the profile again.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const normalized = text => text.replace(/\r\n/g,'\n');
    if (document.isDirty || hash(normalized(document.getText())) !== hash(normalized(current.text))) {
      throw Error('The Java editor changed after inspection.');
    }
    return vscode.window.showTextDocument(document,{ preview:true,selection:toRange(item.range) });
  }

  function clear() {
    serial++;
    diagnostics.clear();
  }

  function schedule(options) {
    const operation = scan(options);
    active.add(operation);
    void operation.finally(() => active.delete(operation)).catch(() => {});
    return operation;
  }

  async function chooseScope() {
    const folders = foldersFor();
    if (folders.length === 1) return { uri:folders[0].uri };
    return vscode.window.showQuickPick([
      { label:'All Workspace Folders' },
      ...folders.map(folder => ({ label:folder.name,uri:folder.uri }))
    ],{ title:'Java Inspection Scope' });
  }

  async function chooseProfile() {
    const scope = await chooseScope();
    if (!scope) return;
    const profilesInScope = profiles(scope.uri);
    const choice = await vscode.window.showQuickPick([
      ...profilesInScope.map(profile => ({ label:profile.name,description:profile.include.join(', '),profile })),
      { label:'Edit Inspection Profiles',settings:true }
    ],{ title:'Java Inspection Profile' });
    if (choice?.settings) {
      await vscode.commands.executeCommand('workbench.action.openSettings','@id:rocketbrain.java.inspectionProfiles');
      return;
    }
    if (choice?.profile) return { folderUri:scope.uri,profileName:choice.profile.name,defaultMode:choice.profile.duplicateMode };
  }

  function runProgress(options,title) {
    return vscode.window.withProgress({ title,cancellable:true,location:vscode.ProgressLocation.Notification },
      (_progress,cancellation) => schedule({ ...options,cancellation }));
  }

  async function showFindings(report) {
    const detail = report.findings.length + ' findings in ' + report.scannedFiles + ' saved Java files' +
      (report.skipped.length ? ' · ' + report.skipped.length + ' skipped' : '');
    const selected = await vscode.window.showQuickPick([
      { label:'Open VS Code Problems',detail,problems:true },
      ...report.findings.map(finding => ({
        label:finding.message,description:finding.severity,
        detail:path.basename(vscode.Uri.parse(finding.uri).fsPath) + ':' + (finding.range.start.line + 1),finding
      })),
      ...report.skipped.map(item => ({ label:item.reason,detail:path.basename(vscode.Uri.parse(item.uri).fsPath) }))
    ],{ title:report.profile + ' · ' + detail });
    if (selected?.problems) await vscode.commands.executeCommand('workbench.actions.view.problems');
    if (selected?.finding) await reveal(report,selected.finding);
  }

  async function inspect() {
    const selected = await chooseProfile();
    if (!selected) return;
    const report = await runProgress({ ...selected,duplicates:false },'Inspect Saved Java Source');
    await showFindings(report);
    return report;
  }

  async function findDuplicates() {
    const selected = await chooseProfile();
    if (!selected) return;
    const modes = [
      { label:'Exact Tokens',description:'Ignore whitespace and comments',mode:'exact' },
      { label:'Ignore Literal Values',description:'Keep identifiers, operators and literal kinds',mode:'ignore-literals' }
    ].sort((left,right) => Number(right.mode === selected.defaultMode) - Number(left.mode === selected.defaultMode));
    const policy = await vscode.window.showQuickPick(modes,{ title:'Java Duplicate Matching Policy' });
    if (!policy) return;
    const report = await runProgress({ ...selected,duplicates:true,publishDiagnostics:false,mode:policy.mode },'Find Java Duplicate Code');
    const limited = report.duplicateSearchTruncated || report.oversizedMethods > 0 ? ' · Some candidates exceeded the search limits' : '';
    if (!report.duplicateGroups.length) {
      await vscode.window.showInformationMessage('No duplicate Java spans found in ' + report.scannedFiles + ' saved files' + limited + '.');
      return report;
    }
    const match = (await vscode.window.showQuickPick(report.duplicateGroups.map(group => ({
      label:group.occurrences[0].method,description:group.occurrences.length + ' occurrences · ' + group.tokens + ' tokens',group
    })),{ title:policy.label + ' · Java Duplicate Groups' + limited }))?.group;
    if (!match) return report;
    const location = (await vscode.window.showQuickPick(match.occurrences.map(place => ({
      label:place.method,detail:path.basename(vscode.Uri.parse(place.uri).fsPath) + ':' + (place.range.start.line + 1),place
    })),{ title:'Open Duplicate Java Source' }))?.place;
    if (location) await reveal(report,location);
    return report;
  }

  const commands = Object.entries({ inspect,duplicates:findDuplicates,clear }).map(([name,handler]) =>
    vscode.commands.registerCommand(COMMANDS[name],async () => {
      try { assertReady(); return await handler(); }
      catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return null; }
    }));
  function invalidate(uri) {
    if (local(uri) && uri.fsPath.toLowerCase().endsWith('.java')) diagnostics.delete(uri);
  }
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.java',true,false,false);
  const listeners = [
    watcher,watcher.onDidChange(invalidate),watcher.onDidDelete(invalidate),
    vscode.workspace.onDidChangeTextDocument(event => invalidate(event.document.uri)),
    vscode.workspace.onDidChangeWorkspaceFolders(clear),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('rocketbrain.java.inspectionProfiles')) clear();
    })
  ];
  return {
    scan:schedule,reveal,clear,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      for (const item of [...commands,...listeners]) item.dispose();
      diagnostics.dispose();
      disposal = Promise.allSettled(active).then(() => {});
      return disposal;
    }
  };
}

module.exports = { registerJavaInspections, COMMANDS };
