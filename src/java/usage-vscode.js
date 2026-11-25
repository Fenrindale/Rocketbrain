'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { localUri } = require('./dependency-workspace');
const { destination,localEvidence,requestLocations,samePoint,validPoint } = require('./navigation-symbols');
const { parseJavaFile } = require('../spring/java');
const { CONFIG,xmlAnchors,configurationAnchors,javaValueAnchors } = require('./usage-spring');

const SCOPE = {file:'Current File',folder:'Containing Workspace Folder',workspace:'Open Workspace'};
const LABEL = {java:'Java reference',kotlin:'Kotlin reference','spring-class':'Spring XML bean class',
  'spring-property':'Spring property usage','spring-config':'Application configuration key'};
const EXCLUDE = '**/{.git,.idea,.gradle,.metadata,node_modules,target,build,out,bin,dist,test-output,.vscode-test}/**';
const LIMIT = 250;
const MAX_RESOURCE_BYTES = 1024*1024;
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const equalRange = (a,b) => samePoint(a.start,b.start) && samePoint(a.end,b.end);
const order = (a,b) => a.line-b.line || a.character-b.character;
const at = (range,point) => order(range.start,point) <= 0 && order(point,range.end) < 0;
const sameSource = (a,b) => a && b && a.disk === b.disk && a.buffer === b.buffer;
const insideName = ({start,end}) => ({line:start.line,character:start.character+(start.line===end.line && end.character-start.character>1 ? 1 : 0)});

function createUsageSearch(vscode,java,progress) {
  const reports = new WeakMap();
  let disposed = false;

  function check(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before finding usages.');
    if (cancellation?.isCancellationRequested) throw Error('Usage search was cancelled.');
  }

  async function localSource(uri,cancellation) {
    check(cancellation);
    const source = await localEvidence(vscode,uri);
    const open = vscode.workspace.textDocuments.find(doc => !doc.isClosed && localUri(doc.uri) && key(doc.uri.fsPath) === key(uri.fsPath));
    if (open && Buffer.byteLength(open.getText()) <= MAX_RESOURCE_BYTES) return {uri:uri.toString(),text:open.getText()};
    const info = await fs.stat(uri.fsPath);
    if (open || info.size > MAX_RESOURCE_BYTES) throw Error('A usage source exceeds the file size limit.');
    const bytes = await fs.readFile(uri.fsPath);
    if (bytes.length > MAX_RESOURCE_BYTES || !sameSource(source,await localEvidence(vscode,uri))) throw Error('A usage source changed during reading.');
    return {uri:uri.toString(),text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
  }

  function collect(scope,origin,includeDeclaration,cancellation) {
    const folder = vscode.workspace.getWorkspaceFolder(origin);
    const originFolder = key(folder.uri.fsPath);
    const belongs = uri => {
      const candidate = localUri(uri) && vscode.workspace.getWorkspaceFolder(uri);
      return candidate && key(candidate.uri.fsPath) === originFolder;
    };
    const allowed = uri => localUri(uri) && vscode.workspace.getWorkspaceFolder(uri) && (scope === 'workspace' ||
      (scope === 'file' ? key(uri.fsPath) === key(origin.fsPath) : belongs(uri)));
    const lanes = new Set(), results = [], notes = new Set();
    const find = async (pattern,maximum,folderOnly = false) => {
      const glob = scope === 'folder' || folderOnly ? new vscode.RelativePattern(folder,pattern) : pattern;
      const files = await vscode.workspace.findFiles(glob,EXCLUDE,maximum+1,cancellation);
      check(cancellation);
      if (files.length > maximum) notes.add('A workspace source scan reached its file limit.');
      return files.slice(0,maximum).filter(folderOnly ? belongs : allowed);
    };
    const scan = async (pattern,scanFile,maximum) => {
      const files = scope === 'file' ? [origin] : await find(pattern,maximum);
      for (const uri of files) {
        check(cancellation);
        let next;
        try { next = await scanFile(uri); }
        catch { check(cancellation); notes.add('Some matching files could not be inspected.'); continue; }
        if (next?.unsupported) notes.add('Some configuration uses unsupported XML or YAML syntax.');
        if (next) results.push(...next.anchors);
        if (results.length > 4000) { notes.add('The reference scan reached its result limit.'); break; }
      }
    };
    const add = (items,provider) => {
      lanes.add(provider);
      if (!Array.isArray(items)) throw Error('A usage provider returned an invalid reference set.');
      if (items.length > 5000) notes.add('A language server reference set exceeded the processing limit.');
      for (const item of items.slice(0,5000)) results.push({...item,provider});
    };
    return {allowed,find,scan,add,lanes,results,notes,includeDeclaration};
  }

  function parameters(uri,position) {
    return {textDocument:{uri:uri.toString()},position:{line:position.line,character:position.character}};
  }

  async function openClass(uri,range,cancellation) {
    const source = await localSource(uri,cancellation);
    return parseJavaFile(source).types.find(type => range && equalRange(type.range,range));
  }

  async function classAnchor(document,point,cancellation) {
    const {uri} = document;
    const self = parseJavaFile({uri:uri.toString(),text:document.getText()}).types.find(type => at(type.range,point));
    if (self) return self;
    const found = await requestLocations(vscode,token => java.navigationLocations('declaration',parameters(uri,point),token),cancellation);
    if (!Array.isArray(found) || found.length !== 1) return;
    const other = destination(vscode,found[0],false);
    if (other && /\.java$/i.test(other.uri.path)) return openClass(other.uri,other.range,cancellation);
  }

  async function findClassFromXml(source,collection,cancellation) {
    const simple = source.key.split('.').at(-1);
    const candidates = await collection.find('**/'+simple+'.java',80,true);
    const matches = [];
    for (const uri of candidates) {
      const file = await localSource(uri,cancellation);
      const type = parseJavaFile(file).types.find(type => type.fqn === source.key);
      if (type) matches.push(type);
    }
    if (matches.length !== 1) collection.notes.add('The XML class has no unique Java declaration in its workspace folder.');
    return matches.length === 1 ? matches[0] : undefined;
  }

  async function springClasses(fqn,collection,cancellation) {
    collection.lanes.add('spring-class');
    await collection.scan('**/src/{main,test}/resources/**/*.xml',async uri => {
      if (!/\.xml$/i.test(uri.path)) return;
      const value = xmlAnchors(await localSource(uri,cancellation));
      return {...value,anchors:value.anchors.filter(item => item.provider === 'spring-class' && item.key === fqn)};
    },250);
  }

  async function valueSites(model,uri,cancellation) {
    const file = await localSource(uri,cancellation), text = file.text.replace(/\r\n/g,'\n');
    const starts = [0];
    for (const match of text.matchAll(/\n/g)) starts.push(match.index+1);
    return javaValueAnchors(model,{...file,text},point => (starts[point.line] ?? text.length)+point.character);
  }

  async function springProperty(property,collection,model,cancellation) {
    collection.lanes.add('spring-property');
    if (model.truncated) collection.notes.add('Spring model source indexing reached its file or byte limit.');
    const javaSources = new Set(model.injections.filter(item => item.valueRange && typeof item.expression === 'string').map(item => item.uri));
    for (const value of javaSources) {
      const uri = vscode.Uri.parse(value);
      if (collection.allowed(uri)) {
        try { collection.results.push(...(await valueSites(model,uri,cancellation)).filter(site => site.key === property)); }
        catch { check(cancellation); collection.notes.add('Some matching files could not be inspected.'); }
      }
    }
    await collection.scan('**/src/{main,test}/resources/**/*.xml',async uri => {
      if (!/\.xml$/i.test(uri.path)) return;
      const result = xmlAnchors(await localSource(uri,cancellation));
      return {...result,anchors:result.anchors.filter(item => item.provider === 'spring-property' && item.key === property)};
    },250);
    if (!collection.includeDeclaration) return;
    collection.lanes.add('spring-config');
    await collection.scan('**/application*.{properties,yml,yaml}',async uri => {
      if (!CONFIG.test(uri.path)) return;
      const result = configurationAnchors(await localSource(uri,cancellation));
      return {...result,anchors:result.anchors.filter(item => item.key === property)};
    },150);
  }

  async function inspect({uri,position,scope='folder',includeDeclaration=false,cancellation} = {}) {
    check(cancellation);
    if (!Object.hasOwn(SCOPE,scope) || !localUri(uri) || !vscode.workspace.getWorkspaceFolder(uri) || !validPoint(position)) {
      throw Error('Choose a source symbol and usage scope in an open local workspace.');
    }
    const origin = await localEvidence(vscode,uri), document = await vscode.workspace.openTextDocument(uri);
    const point = new vscode.Position(position.line,position.character), {version,languageId} = document;
    if (!samePoint(point,document.validatePosition(point))) throw Error('The usage search position is outside the source.');
    const collection = collect(scope,uri,includeDeclaration,cancellation);
    let identity, model, symbol;
    const addJava = async (source,position) => {
      const active = await java.start();
      if (active.state !== 'running') throw Error(active.message || 'Start the independent Java language server.');
      identity = {kind:'java',key:active.runtimeIdentity};
      const params = {...parameters(source,position),context:{includeDeclaration}};
      const references = await requestLocations(vscode,token => java.navigationLocations('references',params,token),cancellation);
      collection.add(references ?? [],'java');
    };
    if (languageId === 'kotlin') {
      const active = await java.kotlinEditor.start({document});
      if (active.state !== 'running' || !active.projectUri) throw Error('Start the independent Kotlin language server for this project.');
      identity = {kind:'kotlin',key:active.projectUri};
      const definitions = await requestLocations(vscode,token => java.kotlinEditor.definition(document,point,token),cancellation);
      const declaration = Array.isArray(definitions) && definitions.length === 1 && destination(vscode,definitions[0],false);
      const project = vscode.Uri.parse(active.projectUri).fsPath;
      const relative = declaration && path.relative(project,declaration.uri.fsPath);
      const inProject = declaration && relative !== '..' && !relative.startsWith('..'+path.sep) && !path.isAbsolute(relative) && /\.kt$/i.test(declaration.uri.path);
      if (inProject) await localEvidence(vscode,declaration.uri);
      const anchor = inProject ? await vscode.workspace.openTextDocument(declaration.uri) : document;
      const selection = inProject ? insideName(declaration.range) : point;
      const references = await requestLocations(vscode,token => java.kotlinEditor.references(anchor,selection,includeDeclaration,token),cancellation);
      collection.add(references ?? [],'kotlin');
    } else if (languageId === 'java') {
      if (document.getText().split(/\r?\n/)[point.line]?.includes('${')) {
        model = await java.spring.analyze();
        symbol = (await valueSites(model,uri,cancellation)).find(item => at(item.range,point));
      }
      if (!symbol) {
        await addJava(uri,point);
        const type = scope !== 'file' && await classAnchor(document,point,cancellation);
        if (type) {
          symbol = {key:type.fqn};
          await springClasses(type.fqn,collection,cancellation);
        }
      }
    } else {
      const file = await localSource(uri,cancellation);
      const isXml = /\.xml$/i.test(uri.path);
      const {anchors} = isXml ? xmlAnchors(file) : configurationAnchors(file);
      symbol = anchors.find(item => at(item.range,point));
      if (!symbol) throw Error('Select a Spring XML bean class, a literal Spring placeholder, or an application configuration key.');
      if (symbol.provider === 'spring-class') {
        const type = await findClassFromXml(symbol,collection,cancellation);
        if (type) {
          const javaUri = vscode.Uri.parse(type.uri);
          await vscode.workspace.openTextDocument(javaUri);
          await addJava(javaUri,insideName(type.range));
        }
        await springClasses(symbol.key,collection,cancellation);
      }
    }
    if (symbol && (symbol.provider === 'spring-config' || symbol.provider === 'spring-property')) {
      await springProperty(symbol.key,collection,model || await java.spring.analyze(),cancellation);
    }
    check(cancellation);
    const observed = [], seen = new Set(), evidence = new Map();
    for (const item of collection.results) {
      check(cancellation);
      const target = destination(vscode,item,false);
      if (!target || !collection.allowed(target.uri)) continue;
      const file = key(target.uri.fsPath), range = JSON.stringify(target.range), id = file+'|'+range;
      if (seen.has(id)) continue;
      seen.add(id);
      if (observed.length === LIMIT) { collection.notes.add('Only the first '+LIMIT+' unique locations are shown.'); break; }
      if (!evidence.has(file)) evidence.set(file,await localEvidence(vscode,target.uri).catch(() => null));
      const source = evidence.get(file);
      if (!source) continue;
      observed.push({...target,source,provider:item.provider});
    }
    if (document.isClosed || document.version !== version || !sameSource(origin,await localEvidence(vscode,uri))) {
      throw Error('The source changed during usage search. Search the symbol again.');
    }
    observed.sort((a,b) => a.source.relative.localeCompare(b.source.relative) || order(a.range.start,b.range.start));
    const targets = observed.map((item,id) => {
      const displayPath = scope === 'workspace' && vscode.workspace.workspaceFolders?.length > 1 ?
        path.join(vscode.workspace.getWorkspaceFolder(item.uri).name,item.source.relative) : item.source.relative;
      return Object.freeze({id,uri:item.uri.toString(),range:item.range,displayPath,provider:item.provider,label:LABEL[item.provider]});
    });
    const report = Object.freeze({scope,symbol:symbol?.key,providers:Object.freeze([...collection.lanes]),
      notes:Object.freeze([...collection.notes]),targets:Object.freeze(targets)});
    reports.set(report,{document,version,origin,observed,identity});
    return report;
  }

  async function reveal(report,id) {
    check();
    const review = reports.get(report), target = review?.observed[id];
    if (!Number.isSafeInteger(id) || !target) throw Error('Select an observed location from the current usage search.');
    const {document,version,origin,identity} = review;
    const runtime = identity?.kind === 'java' ? java.getState() : identity && java.kotlinEditor.getState();
    if (document.isClosed || document.version !== version || identity &&
        (runtime.state !== 'running' || (runtime.runtimeIdentity || runtime.projectUri) !== identity.key) ||
        !sameSource(origin,await localEvidence(vscode,document.uri).catch(() => null))) throw Error('The source or provider changed. Search the symbol again.');
    const opened = await vscode.workspace.openTextDocument(target.uri);
    if (!sameSource(target.source,await localEvidence(vscode,target.uri).catch(() => null))) throw Error('The usage location changed. Search the symbol again.');
    const {start,end} = target.range;
    const selection = new vscode.Range(start.line,start.character,end.line,end.character);
    if (!samePoint(start,opened.validatePosition(selection.start)) || !samePoint(end,opened.validatePosition(selection.end))) {
      throw Error('The usage range is no longer available. Search the symbol again.');
    }
    check();
    if (document.isClosed || document.version !== version) throw Error('The source changed during navigation. Search the symbol again.');
    await vscode.window.showTextDocument(opened,{selection,preview:true,preserveFocus:false});
    return report.targets[id];
  }

  async function choose() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw Error('Open a Java, Kotlin, or Spring source file to find usages.');
    const {document} = editor, {active:position} = editor.selection, {version} = document;
    const choice = await vscode.window.showQuickPick(Object.entries(SCOPE).map(([scope,label]) => ({scope,label})),{title:'Find JVM & Spring Usages · Scope'});
    if (!choice) return;
    if (document.isClosed || document.version !== version) throw Error('The source changed after scope selection. Search the symbol again.');
    const report = await progress('Find JVM & Spring Usages',cancellation => inspect({uri:document.uri,position,scope:choice.scope,cancellation}));
    if (!report.targets.length) {
      void vscode.window.showInformationMessage(['No usages found in '+SCOPE[report.scope]+'.',...report.notes].join(' '));
      return report;
    }
    const selected = await vscode.window.showQuickPick(report.targets.map(target => ({target,label:target.displayPath,
      description:'Line '+(target.range.start.line+1)+':'+(target.range.start.character+1),detail:target.label})),{
      title:[report.symbol || 'Usages',report.targets.length+ ' results',SCOPE[report.scope]].join(' · '),
      placeHolder:report.notes.join(' ') || 'Select a usage to open its source',matchOnDescription:true,matchOnDetail:true});
    if (selected) await reveal(report,selected.target.id);
    return report;
  }

  return {inspect,reveal,choose,dispose(){disposed=true;}};
}

module.exports = { createUsageSearch };
