'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath,pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { createJavaBreakpointTools,inlineLocations } = require('../src/java/debug-breakpoints');
const { DapClient } = require('./java-debug-dap');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { breakpointSource,breakpointBase } = require('./helpers/java-breakpoint-fixture');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const runtime = {skip:!configuration && 'Independent JDT LS and Java debug runtime are not configured.',timeout:180000};

class Position {
  constructor(line,character) { this.line=line; this.character=character; }
}
class Location {
  constructor(uri,start) { this.uri=uri; this.range={start,end:start}; }
}
class SourceBreakpoint {
  constructor(location,enabled) { this.location=location; this.enabled=enabled; }
}
const uriFor = file => ({scheme:'file',fsPath:file,toString:() => pathToFileURL(file).href});
const sourceFor = uri => ({name:path.basename(uri.fsPath),path:uri.fsPath});

function documentFor(file,text) {
  const lines = text.split('\n');
  return {
    uri:uriFor(file),languageId:'java',version:1,lineCount:lines.length,lineAt:line => ({text:lines[line]}),
    position(snippet,relative=0) {
      const line = lines.findIndex(value => value.includes(snippet));
      assert.ok(line >= 0,snippet);
      return new Position(line,lines[line].indexOf(snippet)+relative);
    }
  };
}

function shell(documents) {
  const debug = {breakpoints:[],addBreakpoints(items) { this.breakpoints.push(...items); }};
  return {
    debug,Position,Location,SourceBreakpoint,Uri:{parse:value => /^file:/.test(value) ? uriFor(fileURLToPath(value)) : {}},
    workspace:{
      getWorkspaceFolder:uri => documents.some(document => document.uri.fsPath === uri.fsPath) ? {uri} : undefined,
      openTextDocument:async uri => documents.find(item => item.uri.fsPath === uri.fsPath)
    }
  };
}

test('inline breakpoint locations ignore line defaults, malformed coordinates and duplicate columns',() => {
  assert.deepEqual(inlineLocations([
    {line:5,column:10,endLine:5,endColumn:18},
    {line:5,column:10,endLine:5,endColumn:18},
    {line:5,column:4,endLine:5,endColumn:8},
    {line:5,column:1,endLine:0,endColumn:1},
    {line:5,column:11,endLine:6,endColumn:1},
    {line:5,column:12,endLine:5,endColumn:99},
    {line:6,column:3,endLine:6,endColumn:7}
  ],5,23),[{column:4,endColumn:8},{column:10,endColumn:18}]);
});

test('inline review rejects source edits, fabricated positions and another debug session',async () => {
  const document = documentFor(path.resolve('Small.java'),'int a = x -> x + 1;\n');
  const vscode = shell([document]);
  const session = {customRequest:async () => ({breakpoints:[{line:1,column:9,endLine:1,endColumn:19}]})};
  vscode.debug.activeDebugSession = session;
  vscode.debug.breakpoints.push(new SourceBreakpoint(new Location(document.uri,new Position(0,0)),true));
  const tools = createJavaBreakpointTools(vscode,{ensureTrusted(){},isSupported:value => value === session});
  const inspect = () => tools.inspectInline({document,position:new Position(0,0)});
  const report = await inspect();
  assert.throws(() => tools.addInline(report,[10]),/Choose columns/);
  assert.throws(() => tools.addInline({...report},[9]),/Inspect Java inline/);
  document.version++;
  assert.throws(() => tools.addInline(report,[9]),/source changed/);
  const fresh = await inspect();
  vscode.debug.activeDebugSession = {};
  assert.throws(() => tools.addInline(fresh,[9]),/session changed/);
});

test('real independent Java debugger stops on exact overload, inherited method, field access modes and same-line lambdas',runtime,async t => {
  const config = JSON.parse(await fs.readFile(configuration,'utf8'));
  const {javaHome,serverPath,debugBundlePath} = config;
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-breakpoint-jdt-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const project = path.join(root,'project'), pkg = path.join(project,'src/main/java/fixture');
  await fs.mkdir(pkg,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/maven/pom.xml'),path.join(project,'pom.xml'));
  const className = 'BreakpointFixture', packageName = 'fixture', mainClass = packageName+'.'+className;
  const text = breakpointSource(packageName,className), baseText = breakpointBase(packageName,className);
  const document = documentFor(path.join(pkg,className+'.java'),text);
  const base = documentFor(path.join(pkg,className+'Base.java'),baseText);
  await Promise.all([[document,text],[base,baseText]].map(([source,contents]) => fs.writeFile(source.uri.fsPath,contents)));
  const vscode = shell([document,base]);
  const settings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const lsp = new StdioLsp(resolveLaunch({javaHome,serverPath,debugBundlePath,storagePath:path.join(root,'jdt')}));
  let dap;
  try {
    const rootUri = pathToFileURL(project).href;
    await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'breakpoints-fixture'}],
      capabilities:{workspace:{configuration:true},textDocument:{
        documentSymbol:{hierarchicalDocumentSymbolSupport:true},definition:{linkSupport:true}
      }},initializationOptions:{bundles:[debugBundlePath],workspaceFolders:[rootUri],settings}
    },75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri:document.uri.toString(),text,languageId:'java',version:1}});
    const command = (name,...args) => lsp.request('workspace/executeCommand',{command:name,arguments:args});
    const main = await until(async () => (await command('vscode.java.resolveMainClass',rootUri))?.find(item => item.mainClass === mainClass),85000);
    const build = await command('vscode.java.buildWorkspace',JSON.stringify({mainClass,projectName:main.projectName,isFullBuild:false}));
    assert.ok(build === 1 || build === 'SUCCEED');
    const [modulePaths,classPaths] = await command('vscode.java.resolveClasspath',mainClass,main.projectName);
    const javaExec = await command('vscode.java.resolveJavaExecutable',mainClass,main.projectName);
    dap = new DapClient(await command('vscode.java.startDebugSession'));
    const caps = await dap.request('initialize',{adapterID:'rocketbrain-java',clientID:'rocketbrain-breakpoint-tests',
      linesStartAt1:true,columnsStartAt1:true,pathFormat:'path',supportsRunInTerminalRequest:false,supportsVariableType:true});
    for (const capability of ['supportsFunctionBreakpoints','supportsDataBreakpoints','supportsBreakpointLocationsRequest']) assert.equal(caps[capability],true);
    const session = {customRequest:(...args) => dap.request(...args)};
    vscode.debug.activeDebugSession = session;
    const tools = createJavaBreakpointTools(vscode,{
      request:(...args) => lsp.request(...args),ensureTrusted(){},isSupported:value => value === session
    });
    const overload = await tools.addMethod({document,position:document.position('pick("b")',1)});
    assert.equal(overload.line,document.position('pick(String item)').line+1);
    assert.match(overload.method,/pick/);
    assert.equal(overload.added,true);
    const inherited = await tools.addMethod({document,position:document.position('inherited()',1)});
    assert.equal(inherited.line,base.position('inherited()').line+1);
    assert.equal(inherited.uri,base.uri.toString());
    assert.equal((await tools.addMethod({document,position:document.position('pick(String item)',1)})).added,false);

    const starting = dap.request('launch',{name:'Rocketbrain breakpoint fixture',type:'rocketbrain-java',mainClass,
      projectName:main.projectName,modulePaths,classPaths,javaExec,cwd:project,console:'internalConsole',sourcePaths:[]});
    starting.catch(() => {});
    await dap.event('initialized');

    const gateLine = document.position('FIELD_GATE').line;
    const lambdaPosition = document.position('TWO_LAMBDAS');
    const lineBreakpoint = line => new SourceBreakpoint(new Location(document.uri,new Position(line,0)),true);
    const standard = lineBreakpoint(lambdaPosition.line);
    vscode.debug.addBreakpoints([lineBreakpoint(gateLine),standard]);
    const sync = source => dap.request('setBreakpoints',{source:sourceFor(source.uri),breakpoints:
      vscode.debug.breakpoints.filter(item => item.location.uri.fsPath === source.uri.fsPath).map(item => {
        const at=item.location.range.start;
        return {line:at.line+1,...(at.character ? {column:at.character+1} : {})};
      })
    });
    assert.ok((await sync(document)).breakpoints.every(item => item.verified));
    assert.ok((await sync(base)).breakpoints.every(item => item.verified));
    const inline = await tools.inspectInline({document,position:lambdaPosition});
    assert.deepEqual(inline.choices.map(item => item.column),['n -> n + 10','n -> n + 20'].map(marker => document.position(marker).character+1));
    assert.equal(tools.addInline(inline,inline.choices.map(item => item.column)).length,2);
    vscode.debug.breakpoints = vscode.debug.breakpoints.filter(item => item !== standard);
    assert.ok((await sync(document)).breakpoints.every(item => item.verified));

    await dap.request('configurationDone');
    await starting;
    let stopped = await dap.event('stopped',0,18000);
    const frame = async stop => (await dap.request('stackTrace',{threadId:stop.threadId,startFrame:0,levels:2})).stackFrames[0];
    const gate = await frame(stopped);
    assert.equal(gate.line,gateLine+1);
    const {scopes} = await dap.request('scopes',{frameId:gate.id});
    const containers = await Promise.all(scopes.filter(scope => scope.variablesReference).map(scope =>
      dap.request('variables',{variablesReference:scope.variablesReference})));
    const box = containers.flatMap(item => item.variables).find(item => item.name === 'box');
    assert.ok(box?.variablesReference);
    const field = await dap.request('dataBreakpointInfo',{variablesReference:box.variablesReference,name:'value'});
    assert.deepEqual(new Set(field.accessTypes),new Set(['read','write','readWrite']));
    const watch = async accessType => {
      const result = await dap.request('setDataBreakpoints',{breakpoints:[{dataId:field.dataId,accessType}]});
      assert.equal(result.breakpoints[0].verified,true);
    };
    const proceed = async () => {
      const after = dap.events.length;
      await dap.request('continue',{threadId:stopped.threadId});
      stopped = await dap.event('stopped',after,18000);
      return frame(stopped);
    };
    await watch('read');
    assert.equal((await proceed()).line,document.position('FIELD_READ').line+1);
    assert.equal(stopped.reason,'data breakpoint');
    await watch('write');
    assert.equal((await proceed()).line,document.position('FIELD_WRITE').line+1);
    assert.equal(stopped.reason,'data breakpoint');
    await dap.request('setDataBreakpoints',{breakpoints:[]});
    assert.match((await proceed()).name,/Base\.inherited\(\)$/);
    assert.equal(stopped.reason,'function breakpoint');
    assert.match((await proceed()).name,/pick\(String\)$/);
    assert.equal(stopped.reason,'function breakpoint');
    for (const choice of inline.choices) {
      const lambda = await proceed();
      assert.equal(stopped.reason,'lambda breakpoint');
      assert.equal(lambda.line,inline.line);
      assert.equal(lambda.column,choice.column);
    }
    const after = dap.events.length;
    await dap.request('continue',{threadId:stopped.threadId});
    await dap.event('terminated',after,18000);
    assert.ok(dap.events.some(event => event.event === 'output' && /\b44\b/.test(event.body.output)));
  } finally {
    await dap?.close();
    await lsp.close();
  }
});
