'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath,pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { constantPlacement,constantChange,confirmConstant } = require('../src/java/extract-constant');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { execute } = require('../src/java/testing/provision');
const { rangeAt } = require('../src/spring/java');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { constantFixture,assertOnlySelectedConstant } = require('./helpers/java-constant-fixture');

const configFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('real JDT placement and javac bindings extract exactly one compile-time Java constant', {
  skip:!configFile && 'Configure the independent JDK and JDT LS.',timeout:240000
},async t => {
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  const settings = config.settings || config;
  const javaHome = config.javaHome || settings['rocketbrain.java.javaHome'];
  const serverPath = config.serverPath || settings['rocketbrain.java.serverPath'];
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent,'rb-extract-constant-'));
  t.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(real,owned);
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-extract-constant-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  const project = path.join(owned,'project'), root = pathToFileURL(project).href;
  const fixture = constantFixture('dev.rocketbrain','RefactorConstantFixture');
  const file = path.join(project,'src/main/java/dev/rocketbrain',fixture.className + '.java'), uri = pathToFileURL(file).href;
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,fixture.source,{flag:'wx'});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const jdtSettings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const lsp = new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(owned,'jdt')}));
  const clean = async (text,inspection) => {
    const result = await analyzeJavaSources({javaHome,storagePath:path.join(owned,'analysis'),sources:[{uri,text}],inspection});
    assert.deepEqual(result.errors,[]);
    return result.constant;
  };
  async function request(selection) {
    const context = {textDocument:{uri},range:rangeAt(fixture.source,selection.start,selection.end),context:{diagnostics:[]}};
    return lsp.request('java/getRefactorEdit',{command:'extractConstant',context,options:{tabSize:4,insertSpaces:true},commandArguments:[]});
  }
  const extract = async (expression,name) => {
    const selection = fixture.selection(expression);
    const proof = await clean(fixture.source,{kind:'constant',uri,...selection});
    assert.equal(proof.error,undefined);
    const response = await request(selection);
    const placement = constantPlacement(response,{text:fixture.source,selection,version:1,type:proof.type,
      belongsToSource:value => !path.relative(file,fileURLToPath(value))});
    const change = constantChange({text:fixture.source,selection,placement,proof,name});
    const result = await clean(change.after,{kind:'constant',uri,name,start:change.checkedStart,end:change.checkedEnd});
    confirmConstant(proof,result,placement,change);
    return {change,placement,proof,selection};
  };
  let transformed, stringChange;
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri:root,workspaceFolders:[{uri:root,name:'constant-fixture'}],
      capabilities:{workspace:{configuration:true,workspaceEdit:{documentChanges:true}},textDocument:{codeAction:{
        codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix','refactor','refactor.extract','refactor.extract.constant']}},
        resolveSupport:{properties:['edit']}}}},initializationOptions:{workspaceFolders:[root],settings:jdtSettings,
        extendedClientCapabilities:{advancedExtractRefactoringSupport:false}}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings:jdtSettings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text:fixture.source}});
    await until(async () => (await lsp.request('textDocument/documentSymbol',{textDocument:{uri}}))?.length,65000);
    transformed = await extract(fixture.common,'SELECTED_WEIGHT');
    assertOnlySelectedConstant(fixture,transformed.change.after,'SELECTED_WEIGHT');
    assert.deepEqual(transformed.proof.bindings,[`dev.rocketbrain.${fixture.className}#BASE:int`]);
    for (const rejected of ['TAKEN','INHERITED','SHADOW']) {
      assert.throws(() => constantChange({text:fixture.source,name:rejected,...transformed}),/conflicts with an existing symbol/);
    }
    stringChange = await extract(fixture.other,'LABEL');
    assert.equal(stringChange.proof.type,'java.lang.String');
    assert.match(stringChange.change.after,/private static final java\.lang\.String LABEL/);
    assert.match(stringChange.change.after,/String text\(\) \{ return LABEL; \}/);
    for (const expression of ['mutable + 1','Math.random() * 7','FIXED * 2']) {
      const selection = fixture.selection(expression);
      const proof = await clean(fixture.source,{kind:'constant',uri,...selection});
      assert.match(proof.error,/compile-time expression/);
    }
    assert.ok((await request(fixture.selection('Math.random() * 7')))?.edit,
      'The real JDT makes a broader offer. The compiler guard must enforce the selected workflow.');
  } finally { await lsp.close(); }
  const bin = name => path.join(javaHome,'bin',name + (process.platform==='win32'?'.exe':''));
  const run = async (state,text) => {
    const directory = path.join(owned,state);
    await fs.mkdir(directory);
    const javaFile = path.join(directory,fixture.className+'.java');
    await fs.writeFile(javaFile,text,{flag:'wx'});
    const build = await execute(bin('javac'),['-encoding','UTF-8','-d',directory,javaFile]);
    assert.equal(build.code,0,build.output);
    const studied = await execute(bin('java'),['-Dstdout.encoding=UTF-8','-cp',directory,fixture.packageName+'.'+fixture.className]);
    assert.equal(studied.code,0,studied.output);
    return studied.output.trim();
  };
  for (const [state,text] of [['before',fixture.source],['numeric',transformed.change.after],['string',stringChange.change.after]]) {
    assert.equal(await run(state,text),fixture.output);
  }
  if (process.env.ROCKETBRAIN_EXTRACT_CONSTANT_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_EXTRACT_CONSTANT_RECEIPT,JSON.stringify({jdk:25,jdt:'1.63.0',
      compilerBinding:true,selectedOccurrences:1,unselectedDuplicatePreserved:true,eligibleTypes:['int','java.lang.String'],
      sideEffectRefused:true,mutableFieldRefused:true,localBindingRefused:true,fieldInheritedAndLocalConflictsRefused:true,
      separateJavacBuildAndExecution:true,unchangedOutput:fixture.output},null,2)+'\n');
  }
});
