'use strict';

const path = require('node:path');

const METHOD = 6, CONSTRUCTOR = 9;
const sameFile = (left,right) => left?.scheme === 'file' && right?.scheme === 'file' &&
  !path.relative(left.fsPath,right.fsPath);

function methodDeclarations(symbols) {
  if (!Array.isArray(symbols)) return [];
  return symbols.flatMap(symbol => [
    ...(symbol?.selectionRange && [METHOD,CONSTRUCTOR].includes(symbol.kind) ? [symbol] : []),
    ...methodDeclarations(symbol?.children)
  ]);
}

function hasPosition(range,at) {
  return range?.start && range?.end && (at.line > range.start.line || at.line === range.start.line && at.character >= range.start.character) &&
    (at.line < range.end.line || at.line === range.end.line && at.character < range.end.character);
}

function inlineLocations(items,line,lineLength) {
  if (!Array.isArray(items)) return [];
  const columns = new Map();
  for (const item of items) {
    if (item?.line !== line || !Number.isSafeInteger(item.column) || item.column < 2 || item.column > lineLength ||
        !Number.isSafeInteger(item.endColumn) || item.endLine !== line || item.endColumn <= item.column ||
        item.endColumn > lineLength+1) continue;
    columns.set(item.column,{column:item.column,endColumn:item.endColumn});
  }
  return [...columns.values()].sort((a,b) => a.column-b.column);
}

function createJavaBreakpointTools(vscode,{request,ensureTrusted,isSupported}) {
  const inlineReviews = new WeakMap();
  const localSource = uri => uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment &&
    /.java$/i.test(uri.fsPath) && Boolean(vscode.workspace.getWorkspaceFolder(uri));

  function version(document) {
    ensureTrusted();
    if (!document || !localSource(document.uri) || document.languageId !== 'java' || document.isClosed || document.isDirty) {
      throw Error('Open a saved Java source file in the workspace.');
    }
    return document.version;
  }

  function requireVersion(document,saved) {
    if (version(document) !== saved) throw Error('The Java source changed during breakpoint selection.');
  }

  const sameLocation = (breakpoint,uri,line,character) => sameFile(breakpoint.location?.uri,uri) &&
    breakpoint.location.range.start.line === line && breakpoint.location.range.start.character === character;

  function addAt(uri,line,character) {
    const known = vscode.debug.breakpoints.find(item => sameLocation(item,uri,line,character));
    if (known) return {breakpoint:known,added:false};
    const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri,new vscode.Position(line,character)),true);
    vscode.debug.addBreakpoints([breakpoint]);
    return {breakpoint,added:true};
  }

  async function addMethod({document,position,cancellation} = {}) {
    const sourceVersion = version(document);
    if (!position) throw Error('Place the cursor on a Java method name.');
    const textDocument = {uri:document.uri.toString()};
    const sourceSymbols = methodDeclarations(await request('textDocument/documentSymbol',{textDocument},cancellation));
    requireVersion(document,sourceVersion);
    let target = document, targetVersion = sourceVersion, symbols = sourceSymbols;
    let at = {line:position.line,character:position.character};
    if (!symbols.some(symbol => hasPosition(symbol.selectionRange,at))) {
      const result = await request('textDocument/definition',{textDocument,position:at},cancellation);
      requireVersion(document,sourceVersion);
      const definitions = Array.isArray(result) ? result : result ? [result] : [];
      if (definitions.length !== 1) throw Error('JDT must resolve one Java method declaration at the cursor.');
      const [definition] = definitions;
      const uri = vscode.Uri.parse(definition.targetUri || definition.uri || '');
      if (!localSource(uri)) throw Error('The Java method declaration must have workspace source.');
      at = (definition.targetSelectionRange || definition.range)?.start;
      if (!at) throw Error('JDT returned no Java method declaration position.');
      if (!sameFile(uri,document.uri)) {
        target = await vscode.workspace.openTextDocument(uri);
        targetVersion = version(target);
        symbols = methodDeclarations(await request('textDocument/documentSymbol',{textDocument:{uri:target.uri.toString()}},cancellation));
      }
    }
    requireVersion(document,sourceVersion);
    requireVersion(target,targetVersion);
    if (cancellation?.isCancellationRequested) throw Error('Java breakpoint selection cancelled.');
    const matches = symbols.filter(symbol => symbol.kind === METHOD && hasPosition(symbol.selectionRange,at));
    if (matches.length !== 1) throw Error('Place the cursor on a Java method declaration or a resolved method invocation.');
    const [method] = matches;
    const line = method.selectionRange.start.line;
    if (symbols.some(symbol => symbol !== method && symbol.selectionRange.start.line === line)) {
      throw Error('Put each Java method declaration on a separate line before selecting its exact breakpoint.');
    }
    return {method:method.name,uri:target.uri.toString(),line:line+1,...addAt(target.uri,line,0)};
  }

  async function inspectInline({document,position,session = vscode.debug.activeDebugSession} = {}) {
    const saved = version(document);
    const line = position?.line;
    if (!session || session !== vscode.debug.activeDebugSession || !isSupported(session)) {
      throw Error('Start a Rocketbrain Java debug session before choosing inline breakpoint locations.');
    }
    if (!Number.isSafeInteger(line) || line < 0 || line >= document.lineCount || !vscode.debug.breakpoints.some(item =>
      sameLocation(item,document.uri,line,0) && item.enabled)) {
      throw Error('Set a standard breakpoint on the Java line before choosing its inline locations.');
    }
    const source = {name:path.basename(document.uri.fsPath),path:document.uri.fsPath};
    const answer = await session.customRequest('breakpointLocations',{source,line:line+1,endLine:line+1});
    requireVersion(document,saved);
    if (session !== vscode.debug.activeDebugSession || !isSupported(session)) throw Error('The active Java debug session changed.');
    const text = document.lineAt(line).text;
    const choices = inlineLocations(answer?.breakpoints,line+1,text.length).map(location => ({
      ...location,label:text.slice(location.column-1,location.endColumn-1).trim()
    }));
    if (!choices.length) throw Error('The Java debug engine has no verified inline locations for this line. Wait for line breakpoint verification and try again.');
    const report = {uri:document.uri.toString(),line:line+1,choices};
    inlineReviews.set(report,{document,saved,session,line,allowed:new Set(choices.map(choice => choice.column))});
    return report;
  }

  function addInline(report,columns) {
    const reviewed = inlineReviews.get(report);
    if (!reviewed) throw Error('Inspect Java inline locations before adding a breakpoint.');
    const {document,saved,session,line,allowed} = reviewed;
    requireVersion(document,saved);
    if (session !== vscode.debug.activeDebugSession || !isSupported(session)) throw Error('The active Java debug session changed.');
    if (!Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length ||
        columns.some(column => !allowed.has(column))) throw Error('Choose columns returned by the Java debug engine.');
    return columns.map(column => ({column,...addAt(document.uri,line,column-1)}));
  }

  return {addMethod,inspectInline,addInline};
}

module.exports = { createJavaBreakpointTools,inlineLocations };
