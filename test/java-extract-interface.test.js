'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL,fileURLToPath } = require('node:url');
const { test } = require('node:test');
const { interfaceMembers,interfaceEdit,EXTRACT_INTERFACE_KIND } = require('../src/java/extract-interface');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch,serverSettings } = require('../src/java/runtime');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { StdioLsp,positionOf,until } = require('./helpers/stdio-lsp');

const file = fsPath => ({scheme:'file',fsPath,toString:() => pathToFileURL(fsPath).href});
const parse = value => file(fileURLToPath(value));
const change = (from,to,newText) => ({
  range:{start:{line:0,character:from},end:{line:0,character:to}},newText
});
const create = uri => ({kind:'create',uri:uri.toString(),options:{overwrite:false,ignoreIfExists:true}});
const text = (uri,...edits) => ({textDocument:{uri:uri.toString(),version:null},edits});

test('interface extraction uses explicit engine member handles and opt-in usage retyping', () => {
  const member = {name:'read',typeName:'T',parameters:['T'],handleIdentifier:'generic-method-handle'};
  assert.deepEqual(interfaceMembers({subTypeName:'Reader',members:[member]}),[
    {id:member.handleIdentifier,name:'read',type:'T',parameters:['T']}
  ]);
  assert.throws(() => interfaceMembers({subTypeName:'Reader',members:[member,member]}), /unsupported extractable member/);
  assert.equal(serverSettings().java.refactoring.extract.interface.replace,false);
  assert.equal(serverSettings([],{extractInterfaceReplaceUsages:true}).java.refactoring.extract.interface.replace,true);
});

test('interface edit requires one new file and limits caller edits to reviewed sources', () => {
  const base = path.resolve('reviewed-fixture'),
    owner = file(path.join(base,'Reader.java')), target = file(path.join(base,'Reading.java')),
    caller = file(path.join(base,'Consumer.java')), outside = file(path.join(base,'outside','External.java'));
  const source = [{uri:owner.toString(),text:'class Reader<T> {}',sha:'old'},
    {uri:caller.toString(),text:'class Consumer { Reader<String> r; }'}];
  const edits = [create(target),text(target,change(0,0,'interface Reading<T> {}\n')),
    text(owner,change(15,15,' implements Reading<T>')),text(caller,change(17,23,'Reading'))];
  const response = {edit:{documentChanges:edits}};
  const options = {owner,created:target,sources:source,replaceUsages:true,parseUri:parse};
  const plan = interfaceEdit(response,options);
  assert.equal(plan.callerFiles,1);
  assert.equal(plan.createJavaFile.text,'interface Reading<T> {}\n');
  assert.equal(plan.updated[0].text,'class Reader<T> implements Reading<T> {}');
  assert.equal(plan.updated[0].sha,'old');
  assert.equal(plan.updated[1].text,'class Consumer { Reading<String> r; }');
  assert.throws(() => interfaceEdit(response,{...options,replaceUsages:false}), /outside the reviewed Java usage scope/);
  assert.throws(() => interfaceEdit({edit:{documentChanges:[...edits,text(outside,change(0,0,'unsafe'))]}},options), /outside/);
  assert.throws(() => interfaceEdit({edit:{documentChanges:[...edits,create(target)]}},options), /unexpected interface file/);
  assert.throws(() => interfaceEdit({edit:{documentChanges:[...edits,{kind:'delete',uri:owner.toString()}]}},options), /just the approved/);
  assert.throws(() => interfaceEdit({edit:{documentChanges:[edits[1],edits[0],...edits.slice(2)]}},options), /single initial text/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rb-interface-review-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const owner = file(path.join(root,'Reader.java')), target = file(path.join(root,'Reading.java'));
  const source = 'class Reader {}';
  const document = {uri:owner,version:2,getText:() => source};
  fs.writeFileSync(owner.fsPath,source);
  const completed = [];
  const vscode = {
    Uri:{parse},TextEdit:class{constructor(range,value){this.range=range;this.value=value;}},
    Range:class{constructor(...parts){this.parts=parts;}},
    WorkspaceEdit:class{
      constructor(){this.items=[];}
      set(uri,edits){this.items.push({uri,edits});}
      createFile(uri,options){this.items.push({uri,options});}
    },
    workspace:{
      isTrusted:true,
      getWorkspaceFolder:uri => {
        const relative = path.relative(root,uri.fsPath);
        return !relative.startsWith('..') && !path.isAbsolute(relative) ? {uri:file(root)} : undefined;
      },
      openTextDocument:async uri => {
        assert.equal(uri.fsPath,owner.fsPath);
        return document;
      },
      applyEdit:async edit => {completed.push(edit); return true;},
      registerTextDocumentContentProvider:() => ({dispose(){}})
    },
    commands:{registerCommand:() => ({dispose(){}})}
  };
  const review = registerJavaRefactoring({},vscode);
  t.after(() => review.dispose());
  return {root,owner,target,document,review,completed,workspaceEdit:{changes:{[owner.toString()]:[change(12,12,' implements Reading')]}},
    options:{kind:EXTRACT_INTERFACE_KIND,anchorDocument:document,
      createJavaFile:{uri:target.toString(),text:'interface Reading {}\r\n'}}};
}

test('refactoring previews a new Java interface and applies its exact bytes in one workspace edit', async t => {
  const h = fixture(t);
  const plan = await h.review.previewWorkspaceEdit(h.workspaceEdit,h.options);
  assert.deepEqual(plan.documents.map(item => [item.before,item.after]),[
    ['class Reader {}','class Reader implements Reading {}'],
    ['',h.options.createJavaFile.text]
  ]);
  assert.equal(fs.existsSync(h.target.fsPath),false);
  assert.equal((await h.review.apply(plan.id)).state,'applied');
  const [edit] = h.completed;
  assert.equal(edit.items.length,2);
  const creation = edit.items[1];
  assert.deepEqual(creation.options,{overwrite:false,ignoreIfExists:false,contents:Buffer.from(h.options.createJavaFile.text)});
  await assert.rejects(h.review.apply(plan.id), /expired/);
});

test('interface creation rejects broad permissions and a late destination collision', async t => {
  const h = fixture(t);
  await assert.rejects(h.review.previewWorkspaceEdit(h.workspaceEdit,{...h.options,kind:'refactor'}), /reviewed Extract Interface/);
  await assert.rejects(h.review.previewWorkspaceEdit({documentChanges:[create(h.target)]},{
    allowedResourceOperations:['create']
  }), /separate review workflow/);
  const plan = await h.review.previewWorkspaceEdit(h.workspaceEdit,h.options);
  const pathWithCaseCollision = path.join(h.root,'rEaDing.java');
  fs.writeFileSync(pathWithCaseCollision,'leave intact');
  await assert.rejects(h.review.apply(plan.id), /destination changed or already exists/);
  assert.equal(h.completed.length,0);
  assert.equal(fs.readFileSync(pathWithCaseCollision,'utf8'),'leave intact');
});

const jdtConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
test('actual JDT extracts a selected generic method and retypes only compatible usages', {
  skip:jdtConfig ? false : 'Independent JDT LS runtime is not configured.',timeout:120000
}, async t => {
  const { javaHome,serverPath } = JSON.parse(fs.readFileSync(jdtConfig,'utf8'));
  const storage = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rb-extract-jdt-'));
  t.after(() => fs.rmSync(storage,{recursive:true,force:true}));
  const project = path.join(storage,'project'), root = path.join(project,'src/main/java/fixture');
  const rootUri = pathToFileURL(project).href;
  fs.mkdirSync(root,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'fixtures/java/maven/pom.xml'),path.join(project,'pom.xml'));
  const owner = file(path.join(root,'Reader.java')), caller = file(path.join(root,'Caller.java'));
  const created = file(path.join(root,'Reading.java'));
  const sources = [{
    uri:owner.toString(),
    text:'package fixture;\npublic class Reader<T extends Number> {\n public T read(T t){return t;}\n public String extra(){return "extra";}\n}\n'
  },{
    uri:caller.toString(),
    text:'package fixture;\nclass Caller {\n Integer compatible(){ Reader<Integer> r=new Reader<>(); return r.read(2); }\n' +
      ' String concrete(){ Reader<Integer> r=new Reader<>(); return r.extra(); }\n}\n'
  }];
  for (const source of sources) fs.writeFileSync(fileURLToPath(source.uri),source.text);
  const settings = serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{extractInterfaceReplaceUsages:true});
  const lsp = new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(storage,'jdt')}));
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,
      workspaceFolders:[{uri:rootUri,name:'extract-interface-fixture'}],
      capabilities:{workspace:{configuration:true,applyEdit:false,
        workspaceEdit:{documentChanges:true,resourceOperations:['create','rename','delete']}},
        textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},
      initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings}
    },80000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    for (const source of sources) lsp.notify('textDocument/didOpen',{textDocument:{...source,languageId:'java',version:1}});
    const start = positionOf(sources[0].text,'Reader<T');
    const context = {textDocument:{uri:owner.toString()},range:{start,end:start},context:{diagnostics:[]}};
    const data = await until(async () => {
      const reply = await lsp.request('java/checkExtractInterfaceStatus',context,15000);
      return reply?.members?.length && reply?.destinationResponse?.destinations?.length ? reply : undefined;
    },72000);
    const members = interfaceMembers(data);
    assert.ok(members.some(item => item.name === 'extra'));
    const chosen = members.find(item => item.name === 'read');
    assert.ok(chosen);
    const target = data.destinationResponse.destinations.find(item => !path.relative(root,fileURLToPath(item.uri)));
    assert.ok(target);
    const reply = await lsp.request('java/getRefactorEdit',{
      command:'extractInterface',context,options:{tabSize:4,insertSpaces:true},
      commandArguments:[[chosen.id],'Reading',target]
    },45000);
    const edit = interfaceEdit(reply,{owner,created,sources,replaceUsages:true,parseUri:parse});
    assert.equal(edit.callerFiles,1);
    assert.match(edit.createJavaFile.text,/interface Reading<T extends Number>/);
    assert.match(edit.createJavaFile.text,/T read\(T t\);/);
    assert.doesNotMatch(edit.createJavaFile.text,/extra/);
    assert.match(edit.updated[1].text,/Reading<Integer> r=new Reader<>\(\); return r.read/);
    assert.match(edit.updated[1].text,/Reader<Integer> r=new Reader<>\(\); return r.extra/);
    const proof = await analyzeJavaSources({javaHome,storagePath:path.join(storage,'compiler'),
      sources:[...edit.updated,edit.createJavaFile],inspection:{kind:'check'}});
    assert.deepEqual(proof.errors,[]);
    assert.equal(fs.existsSync(created.fsPath),false);
    assert.deepEqual(sources.map(source => fs.readFileSync(fileURLToPath(source.uri),'utf8')),sources.map(source => source.text));
  } finally { await lsp.close(); }
});
