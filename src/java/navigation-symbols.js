'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { localUri } = require('./dependency-workspace');

const RELATIONS = Object.freeze({
  declaration:'Declaration', type:'Type Declaration', implementation:'Implementations', super:'Super Method'
});
const LIMIT = 80;
const hash = text => createHash('sha256').update(text).digest('hex');
const validPoint = point => Number.isSafeInteger(point?.line) && point.line >= 0 &&
  Number.isSafeInteger(point.character) && point.character >= 0;
const samePoint = (a,b) => a.line === b.line && a.character === b.character;
const sameFile = (a,b) => !path.relative(a,b);

function destination(vscode, item, allowClassFile) {
  const value = item?.targetUri || item?.uri;
  const range = item?.targetSelectionRange || item?.targetRange || item?.range;
  if (typeof value !== 'string' || value.length > 8192 || !validPoint(range?.start) || !validPoint(range?.end) ||
      range.start.line > range.end.line || range.start.line === range.end.line && range.start.character > range.end.character) return;
  const uri = vscode.Uri.parse(value);
  const local = localUri(uri) && vscode.workspace.getWorkspaceFolder(uri);
  if (!local && !(allowClassFile && uri.scheme === 'jdt' && uri.authority === 'contents' && !uri.fragment)) return;
  const point = ({line,character}) => Object.freeze({line,character});
  const displayName = typeof item.displayName === 'string' && item.displayName.length <= 300 ? item.displayName.replace(/\s+/g,' ').trim() : '';
  const label = displayName || path.posix.basename(uri.path);
  return {uri,local,range:Object.freeze({start:point(range.start),end:point(range.end)}),label};
}

async function localEvidence(vscode, uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || !localUri(uri)) throw Error('Source targets must remain inside an open local workspace.');
  const file = uri.fsPath;
  const real = await fs.realpath(file), root = await fs.realpath(folder.uri.fsPath), relative = path.relative(root,real);
  const stat = await fs.lstat(file,{bigint:true});
  if (!sameFile(file,real) || relative.startsWith('..'+path.sep) || relative === '..' || path.isAbsolute(relative) || !stat.isFile()) {
    throw Error('Navigation requires a physical workspace source file.');
  }
  const open = vscode.workspace.textDocuments.find(doc => !doc.isClosed && localUri(doc.uri) && sameFile(doc.uri.fsPath,file));
  return {disk:String(stat.dev)+':'+stat.ino+':'+stat.size+':'+stat.mtimeNs+':'+stat.ctimeNs,
    buffer:open?.isDirty ? hash(open.getText()) : undefined, relative};
}

async function requestLocations(vscode, request, cancellation) {
  if (cancellation?.isCancellationRequested) throw Error('Code navigation was cancelled.');
  const source = new vscode.CancellationTokenSource();
  let timer, subscription;
  try {
    const interrupt = new Promise((_,reject) => {
      const fail = message => { source.cancel(); reject(Error(message)); };
      timer = setTimeout(() => fail('The code navigation provider timed out. Try again after the project is imported.'),40000);
      subscription = cancellation?.onCancellationRequested?.(() => fail('Code navigation was cancelled.'));
      if (cancellation?.isCancellationRequested) fail('Code navigation was cancelled.');
    });
    return await Promise.race([interrupt,Promise.resolve().then(() => request(source.token))]);
  } finally { clearTimeout(timer); subscription?.dispose(); source.dispose(); }
}

function createSymbolNavigation(vscode, java, progress) {
  const reports = new WeakMap();
  let disposed = false;

  function check(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before navigating code.');
    if (cancellation?.isCancellationRequested) throw Error('Code navigation was cancelled.');
  }

  async function inspect({kind,uri,position,cancellation} = {}) {
    check(cancellation);
    if (!Object.hasOwn(RELATIONS,kind) || !localUri(uri) || !vscode.workspace.getWorkspaceFolder(uri) || !validPoint(position)) {
      throw Error('Place the cursor on a Java or Kotlin symbol in an open workspace.');
    }
    const origin = await localEvidence(vscode,uri);
    const document = await vscode.workspace.openTextDocument(uri);
    const point = new vscode.Position(position.line,position.character);
    if (!samePoint(point,document.validatePosition(point))) throw Error('The navigation position is outside the source.');
    const {languageId,version} = document;
    const params = {textDocument:{uri:uri.toString()},position:{line:point.line,character:point.character}};
    let response, identity;
    if (languageId === 'java') {
      const active = await java.start();
      if (active.state !== 'running') throw Error(active.message || 'Start the independent Java language server.');
      identity = active.runtimeIdentity;
      response = await requestLocations(vscode,token => java.navigationLocations(kind,params,token),cancellation);
    } else if (languageId === 'kotlin' && kind === 'declaration') {
      const active = await java.kotlinEditor.start({document});
      identity = active.projectUri;
      check(cancellation);
      response = await requestLocations(vscode,token => java.kotlinEditor.definition(document,params.position,token),cancellation);
    } else throw Error('Use Java for this relation or Kotlin for declaration navigation.');
    check(cancellation);
    if (document.isClosed || document.version !== version) throw Error('The source changed during navigation. Inspect the symbol again.');
    const values = response == null ? [] : Array.isArray(response) ? response : [response];
    const observed = [], seen = new Set();
    for (const item of values.slice(0,LIMIT)) {
      const candidate = destination(vscode,item,languageId === 'java');
      if (!candidate) continue;
      const {uri:targetUri,local,range,label} = candidate;
      const sourceKey = local && process.platform === 'win32' ? targetUri.fsPath.toLowerCase() : targetUri.toString();
      const key = sourceKey+'|'+JSON.stringify(range);
      if (seen.has(key)) continue;
      seen.add(key);
      const source = local ? await localEvidence(vscode,targetUri).catch(() => null) : null;
      if (local && !source) continue;
      check(cancellation);
      observed.push({uri:targetUri,range,label,source});
    }
    if (document.isClosed || document.version !== version) throw Error('The source changed during navigation. Inspect the symbol again.');
    const targets = observed.map((target,id) => Object.freeze({id,label:target.label,uri:target.uri.toString(),range:target.range,
      displayPath:target.source?.relative || target.uri.path}));
    const report = Object.freeze({kind,language:languageId,total:values.length,limited:values.length > LIMIT,targets:Object.freeze(targets)});
    reports.set(report,{document,version,identity,origin,observed});
    return report;
  }

  async function reveal(report,id) {
    check();
    const review = reports.get(report);
    if (!Number.isSafeInteger(id) || !review?.observed[id]) throw Error('Choose a source location from the current navigation result.');
    const target = review.observed[id];
    const current = report.language === 'java' ? java.getState() : java.kotlinEditor.getState();
    if (review.document.isClosed || review.document.version !== review.version || current.state !== 'running' ||
        (current.runtimeIdentity || current.projectUri) !== review.identity) {
      throw Error('The source or its language server changed. Inspect the symbol again.');
    }
    async function validateTarget() {
      if (!target.source) return;
      const live = await localEvidence(vscode,target.uri).catch(() => null);
      if (!live || live.disk !== target.source.disk || live.buffer !== target.source.buffer) {
        throw Error('The destination changed after navigation. Inspect the symbol again.');
      }
    }
    const liveOrigin = await localEvidence(vscode,review.document.uri).catch(() => null);
    if (liveOrigin?.disk !== review.origin.disk || liveOrigin.buffer !== review.origin.buffer) {
      throw Error('The source changed on disk. Inspect the symbol again.');
    }
    await validateTarget();
    const document = await vscode.workspace.openTextDocument(target.uri);
    await validateTarget();
    const {start,end} = target.range;
    const selection = new vscode.Range(start.line,start.character,end.line,end.character);
    if (!samePoint(selection.start,document.validatePosition(selection.start)) || !samePoint(selection.end,document.validatePosition(selection.end))) {
      throw Error('The destination source range is no longer available. Inspect the symbol again.');
    }
    check();
    if (review.document.isClosed || review.document.version !== review.version) throw Error('The source changed during navigation. Inspect the symbol again.');
    await vscode.window.showTextDocument(document,{selection,preview:true,preserveFocus:false});
    return report.targets[id];
  }

  async function choose(kind) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['java','kotlin'].includes(editor.document.languageId)) throw Error('Open a Java or Kotlin source file.');
    const {document} = editor, {active:position} = editor.selection, version = document.version;
    if (!kind) {
      const available = document.languageId === 'java' ? Object.entries(RELATIONS) : [['declaration',RELATIONS.declaration]];
      const chosen = available.length === 1 ? {kind:available[0][0]} : await vscode.window.showQuickPick(available.map(([key,label]) => ({kind:key,label})),
        {title:'Go to Code Target'});
      if (!chosen) return;
      kind = chosen.kind;
    }
    if (document.isClosed || document.version !== version) throw Error('The source changed. Select the symbol again.');
    const report = await progress('Go to '+RELATIONS[kind],cancellation => inspect({kind,uri:document.uri,position,cancellation}));
    if (!report.targets.length) {
      await vscode.window.showInformationMessage('The language server returned no available source targets.');
      return report;
    }
    const selected = report.targets.length === 1 ? {target:report.targets[0]} : await vscode.window.showQuickPick(report.targets.map(target => ({
      label:target.label,description:'Line '+(target.range.start.line+1),detail:target.displayPath,target
    })),{title:RELATIONS[kind]+(report.limited?' · First '+LIMIT+' results':''),matchOnDescription:true,matchOnDetail:true});
    if (selected) await reveal(report,selected.target.id);
    return report;
  }

  return {inspect,reveal,choose,dispose(){disposed=true;}};
}

module.exports = { createSymbolNavigation,destination,localEvidence,requestLocations,samePoint,validPoint };
