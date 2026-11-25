'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { linkedExtraction } = require('../src/java/extract-constant');
const { NamedSelectionError,alignDraftLineEndings,reviewDraft,namedDraft,verifyNamedDraft,singleEdit } = require('../src/java/extract-value');
const { editedText } = require('../src/java/refactoring');
const { ACTIONS } = require('../src/java/extraction-actions');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { execute } = require('../src/java/testing/provision');
const { rangeAt } = require('../src/spring/java');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { namedExtractionFixture,assertNamedBody } = require('./helpers/java-named-extraction-fixture');

const configFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('linked Java extraction keeps the editor line endings and the exact UTF-16 marker',() => {
  const before = 'class Example {\r\n}\r\n';
  const proposed = 'class Example {\r\n    // 😀\n    private int value;\n}\r\n';
  const adapted = alignDraftLineEndings({proposed,name:'value',offset:proposed.indexOf('value')},before);
  assert.equal(adapted.proposed,proposed.replace(/\r?\n/g,'\r\n'));
  assert.equal(adapted.proposed.slice(adapted.offset,adapted.offset+5),'value');
  assert.equal(editedText(before,[singleEdit(before,adapted.proposed)]),adapted.proposed);
});

test('real JDT variable and field extraction give one exact named change with verified Javac bindings',{
  skip:!configFile,timeout:220000
},async t => {
  const runtime = JSON.parse(await fs.readFile(configFile,'utf8'));
  const settings = runtime.settings || runtime;
  const javaHome = runtime.javaHome || settings['rocketbrain.java.javaHome'];
  const serverPath = runtime.serverPath || settings['rocketbrain.java.serverPath'];
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent,'rb-extracted-value-'));
  t.after(async () => {
    const real = await fs.realpath(owned);
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-extracted-value-/);
    assert.equal(real,owned);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  const project = path.join(owned,'project'),rootUri=pathToFileURL(project).href;
  const fixture=namedExtractionFixture('fixtures.naming','NamedExtractionFixture');
  const file=path.join(project,'src/main/java/fixtures/naming',fixture.className+'.java'),uri=pathToFileURL(file).href;
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,fixture.source,{flag:'wx'});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const jdtSettings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(owned,'jdt')}));
  const check = async (text,kind,offset,name) => {
    const report=await analyzeJavaSources({javaHome,sources:[{uri,text}],storagePath:path.join(owned,'compiler'),
      inspection:{kind:'extraction',uri,extractionKind:kind,offset,name}});
    assert.deepEqual(report.errors,[]);
    return report.extraction;
  };
  async function draft(kind,expression,after=0) {
    const start=fixture.source.indexOf(expression,after),selection={start,end:start+expression.length};
    assert.ok(start>=0);
    const context={textDocument:{uri},range:rangeAt(fixture.source,selection.start,selection.end),context:{diagnostics:[]}};
    const result=await lsp.request('java/getRefactorEdit',{command:ACTIONS[kind].jdt,context,options:{tabSize:4,insertSpaces:true},commandArguments:[]});
    const linked=linkedExtraction(result,{text:fixture.source,version:1,belongsToSource:value=>!path.relative(file,fileURLToPath(value))});
    const proof=await check(linked.proposed,kind,linked.offset,linked.name);
    reviewDraft({before:fixture.source,selection,linked,proof,kind});
    return {linked,proof,selection,result};
  }
  const transformed=[];
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'named-extraction'}],
      capabilities:{workspace:{configuration:true,workspaceEdit:{documentChanges:true}},textDocument:{codeAction:{
        codeActionLiteralSupport:{codeActionKind:{valueSet:['','refactor','refactor.extract','refactor.extract.variable','refactor.extract.field']}},
        dataSupport:true,resolveSupport:{properties:['edit']}
      }}},
      initializationOptions:{workspaceFolders:[rootUri],settings:jdtSettings,extendedClientCapabilities:{advancedExtractRefactoringSupport:false}}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings:jdtSettings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text:fixture.source}});
    await until(async()=>(await lsp.request('textDocument/documentSymbol',{textDocument:{uri}}))?.length,65000);
    const at=fixture.source.indexOf(fixture.expression);
    const offered=await lsp.request('textDocument/codeAction',{textDocument:{uri},range:rangeAt(fixture.source,at,at+fixture.expression.length),
      context:{diagnostics:[],only:['refactor']}});
    for(const kind of ['local','field'])assert.ok(offered.some(action=>action.kind===ACTIONS[kind].kind&&action.title===ACTIONS[kind].defaultTitle),
      JSON.stringify(offered.map(({title,kind})=>({title,kind}))));
    for(const [kind,name,count] of [['local','calculatedValue',2],['field','cachedValue',3]]){
      const {linked,proof,selection,result}=await draft(kind,fixture.expression);
      for(const conflict of ['input','otherField','inheritedValue'])assert.throws(()=>namedDraft(linked,proof,conflict),/conflicts/);
      const renamed=namedDraft(linked,proof,name),verified=await check(renamed.text,kind,renamed.offset,name);
      verifyNamedDraft(proof,verified,renamed,name);
      assert.equal(renamed.names.length,count);
      assertNamedBody(fixture,renamed.text,kind,name);
      assert.equal(editedText(fixture.source,[singleEdit(fixture.source,renamed.text)]),renamed.text);
      const unrelated='class Other { int arithmetic(int x,int y) { return x++ + y; } }\n';
      assert.throws(()=>reviewDraft({before:fixture.source+unrelated,selection,proof,kind,
        linked:{...linked,proposed:linked.proposed+unrelated.replace('x++ + y','x+ ++y')}}),/changed unrelated source/);
      const wrong=fixture.source.indexOf(fixture.expression,selection.end);
      assert.throws(()=>reviewDraft({before:fixture.source,selection:{start:wrong,end:wrong+fixture.expression.length},linked,proof,kind}),/outside the selected occurrence/);
      const multi=structuredClone(result);multi.edit.changes['file:///unrelated.java']=[];
      assert.throws(()=>linkedExtraction(multi,{text:fixture.source,version:1,belongsToSource:()=>true}),/one bounded Java source edit/);
      transformed.push({kind,text:renamed.text,checkedNames:count});
    }
    await assert.rejects(draft('local','bump(input)',fixture.source.indexOf('public int compute')),NamedSelectionError);
    const initialized=await draft('local',fixture.expression,fixture.source.indexOf('public int assigned'));
    const named=namedDraft(initialized.linked,initialized.proof,'assignedValue');
    verifyNamedDraft(initialized.proof,await check(named.text,'local',named.offset,'assignedValue'),named,'assignedValue');
    assert.match(named.text,/int result = assignedValue;/);
  } finally { await lsp.close(); }
  const bin=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  for(const {kind,text} of [{kind:'original',text:fixture.source},...transformed]){
    const dir=path.join(owned,kind),source=path.join(dir,fixture.className+'.java');
    await fs.mkdir(dir);
    await fs.writeFile(source,text,{flag:'wx'});
    const compiled=await execute(bin('javac'),['-encoding','UTF-8','-d',dir,source]);
    assert.equal(compiled.code,0,compiled.output);
    const run=await execute(bin('java'),['-cp',dir,fixture.packageName+'.'+fixture.className]);
    assert.equal(run.code,0,run.output);
    assert.equal(run.output,fixture.expectedOutput);
  }
  if(process.env.ROCKETBRAIN_NAMED_EXTRACTION_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_NAMED_EXTRACTION_RECEIPT,
    JSON.stringify({jdt:'1.63.0',jdk:25,variants:transformed.map(({kind,checkedNames})=>({kind,checkedNames})),
      wholeLocalInitializer:true,unselectedIdenticalOccurrencePreserved:true,unrelatedDocumentRefused:true,
      nameCollisionsRefused:true,subexpressionRelocationRefused:true,sideEffectsPreserved:true,runtimeOutput:fixture.expectedOutput},null,2)+'\n');
});
