'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { ACTIONS,conversionAt,reviewConversionEdit,verifyConversion } = require('../src/java/java-conversion');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { positionAt } = require('../src/spring/java');
const { StdioLsp,until } = require('./helpers/stdio-lsp');
const { conversionSource } = require('./helpers/java-conversion-fixture');

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const runtimeTest = {skip:!configuration && 'Independent JDK25 and JDT LS are not configured.',timeout:120000};

test('conversion selection rejects ambiguous source spans',() => {
  assert.throws(() => conversionAt([],10),/Select a nonescaping/);
  assert.throws(() => conversionAt([
    {kind:'lambda',cursorStart:1,end:12},{kind:'anonymous',cursorStart:1,end:12}
  ],10),/Select a nonescaping/);
});

test('conversion review accepts only an exact unannotated single edit to the reviewed source',() => {
  const text = 'prefix input -> input suffix';
  const uri = 'file:///fixture/Source.java';
  const site = {kind:'lambda',start:7,end:21};
  const replacement = {range:{start:{line:0,character:7},end:{line:0,character:21}},newText:'new Function() {}'};
  const action = edit => ({title:ACTIONS.lambda.title,kind:'refactor',edit});
  const review = value => reviewConversionEdit(value,{text,site,version:5,belongsToSource:value => value === uri});
  assert.equal(review(action({changes:{[uri]:[replacement]}})).text,'prefix new Function() {} suffix');
  assert.throws(() => review({...action({changes:{[uri]:[replacement]}}),command:{command:'unsafe'}}),/selected source conversion/);
  assert.throws(() => review(action({changes:{'file:///outside.java':[replacement]}})),/only the selected/);
  assert.throws(() => review(action({documentChanges:[{textDocument:{uri,version:4},edits:[replacement]}]})),/only the selected/);
  assert.throws(() => review(action({changes:{[uri]:[replacement,replacement]}})),/only the selected/);
  assert.throws(() => review(action({changes:{[uri]:[{...replacement,annotationId:'approval'}]}})),/exact selected syntax/);
  assert.throws(() => review(action({changes:{[uri]:[{...replacement,newText:'new Function() { /* omitted */ }'}]}})),/source comments/);
});

test('conversion verification rejects changed attributed bodies, bindings and array roles',() => {
  const before = {kind:'lambda',start:5,end:10,sam:'F#apply(int)',type:'F',parameters:['x:int'],body:'x + 1',bindings:['x'],
    captures:['outer'],callTargets:['Example#use(int)']};
  const after = {...before,kind:'anonymous',end:50};
  assert.equal(verifyConversion(before,[after],45).checkedBindings,1);
  for (const mutation of [{body:'x + 2'},{bindings:['y']},{parameters:['y:int']},{end:49},
    {captures:['other']},{callTargets:['Example#use(long)']}]) {
    assert.throws(() => verifyConversion(before,[{...after,...mutation}],45),/preserves its checked Java behavior/);
  }
  const loop = {kind:'indexed',start:5,end:10,array:'entries',arrayType:'int[]',accumulator:'total',accumulatorType:'long'};
  assert.throws(() => verifyConversion(loop,[{...loop,kind:'enhanced',array:'other'}],5),/preserves its checked Java behavior/);
});

test('real JDT LS conversions retain Javac bindings and identical Java runtime results',runtimeTest,async t => {
  const {javaHome,serverPath} = JSON.parse(await fs.readFile(configuration,'utf8'));
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-conversion-jdt-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const project = path.join(root,'project'), pkg = path.join(project,'src/main/java/fixture');
  await fs.mkdir(pkg,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/maven/pom.xml'),path.join(project,'pom.xml'));
  const file = path.join(pkg,'Conversion.java'), uri = pathToFileURL(file).href, rootUri = pathToFileURL(project).href;
  const text = conversionSource('fixture','Conversion',{custom:true});
  await fs.writeFile(file,text);

  const inspect = async source => {
    const report = await analyzeJavaSources({javaHome,storagePath:path.join(root,'inspections'),
      sources:[{uri,text:source}],inspection:{kind:'conversion',uri}});
    assert.deepEqual(report.errors,[]);
    return report.conversions;
  };
  const allSites = await inspect(text);
  const sites = allSites.filter(site => site.start < text.indexOf('static boolean escaped'));
  assert.deepEqual(sites.map(site => site.kind),['lambda','anonymous','indexed','lambda','anonymous']);
  for (const snippet of ['escaped = n ->','captured = n ->','new IntUnaryOperator() {\n            @Override public int applyAsInt(int input) { return this',
    'values[i] += 1','unsafe = x ->','risky = x ->']) {
    const offset = text.indexOf(snippet);
    assert.ok(offset > 0,snippet);
    assert.throws(() => conversionAt(allSites,offset),/Select a nonescaping/);
  }
  assert.deepEqual(sites.slice(3).map(site=>site.type),[
    'fixture.Conversion.Formatter<java.lang.String>','fixture.Conversion.Formatter<java.lang.Object>'
  ]);
  assert.ok(sites.slice(3).every(site=>site.sam==='fixture.Conversion.Contract#apply(T)'));
  assert.deepEqual(sites.slice(3).map(site=>site.captures),[['prefix','suffix'],['prefix','suffix']]);
  assert.deepEqual(sites.slice(3).flatMap(site=>site.callTargets),[
    'fixture.Conversion#render(java.lang.String,java.lang.String)','fixture.Conversion#render(java.lang.Object,java.lang.String)'
  ]);

  const lsp = new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')}));
  const replacements = [];
  try {
    const settings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
    await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'conversion-fixture'}],
      capabilities:{workspace:{configuration:true,applyEdit:false,workspaceEdit:{documentChanges:true}},
        textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true},codeAction:{
          codeActionLiteralSupport:{codeActionKind:{valueSet:['quickassist','refactor','refactor.rewrite']}},
          resolveSupport:{properties:['edit']}
        }}},initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings}
    },75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,text,languageId:'java',version:1}});
    await until(async () => (await lsp.request('textDocument/documentSymbol',{textDocument:{uri}},10000))?.length,65000);
    for (const site of sites) {
      const start = positionAt(text,site.actionOffset);
      const actions = await lsp.request('textDocument/codeAction',{
        textDocument:{uri},range:{start,end:start},context:{diagnostics:[],only:['refactor']}
      });
      let action = actions.find(action => action.title === ACTIONS[site.kind].title);
      assert.ok(action,ACTIONS[site.kind].title);
      if (!action.edit && action.data) action = await lsp.request('codeAction/resolve',action);
      const belongsToSource = value => typeof value === 'string' && !path.relative(file,fileURLToPath(value));
      let review;
      try { review = reviewConversionEdit(action,{text,site,version:1,belongsToSource}); }
      catch (error) { throw Error(action.title + ': ' + JSON.stringify(action.edit),{cause:error}); }
      const verified = verifyConversion(site,await inspect(review.text),review.replacement.newText.length);
      assert.equal(verified.to,ACTIONS[site.kind].result);
      replacements.push({site,text:review.replacement.newText});
    }
  } finally { await lsp.close(); }
  assert.match(replacements[3].text,/new Formatter<String>\(\) \{/);
  assert.match(replacements[4].text,/input -> .*\.render\(input, prefix\) \+ suffix/);

  const run = promisify(execFile), classes = path.join(root,'classes');
  const java = name => path.join(javaHome,'bin',name+(process.platform === 'win32' ? '.exe' : ''));
  const options = {cwd:root,windowsHide:true,timeout:20000};
  const execute = async source => {
    await fs.mkdir(classes,{recursive:true});
    await fs.writeFile(file,source);
    await run(java('javac'),['--release','25','-proc:none','-d',classes,file],options);
    return (await run(java('java'),['-cp',classes,'fixture.Conversion'],options)).stdout.trim();
  };
  const transformed = replacements.slice().reverse().reduce((source,replacement) =>
    source.slice(0,replacement.site.start) + replacement.text + source.slice(replacement.site.end),text);
  const before=await execute(text),after=await execute(transformed);
  assert.equal(before,'5:9:2:0|case-string:L!|case-object:A?');
  assert.equal(after,before);
  if (process.env.ROCKETBRAIN_CUSTOM_SAM_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_CUSTOM_SAM_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',jdt:'1.63.0',before,after,rewrites:replacements.length,
      custom:sites.slice(3).map(({sam,type,captures,callTargets})=>({sam,type,captures,callTargets})),
      statefulInterfaceRefused:true,identityRefused:true},null,2)+'\n');
});
