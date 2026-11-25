'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {typeImportFixture}=require('./helpers/type-import-fixture');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {UNDEFINED_TYPE,typeImportCandidates,typeImportSelection,confirmUnresolvedType,typeImportDraft,verifyTypeImport}=require('../src/java/type-import');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,run=promisify(execFile);
const matchesPath=(uri,file)=>{try{return !path.relative(fileURLToPath(uri),file);}catch{return false;}};

test('type import drafts preserve source bytes and reject missing or already resolved occurrences',()=>{
  const text=typeImportFixture('fixture','Sample').replace(/\n/g,'\r\n'),at=text.indexOf('Date'),uri='file:///Sample.java';
  const selection=typeImportSelection(text,at+1,at+1);
  const errors=[at,text.lastIndexOf('Date')].map(start=>({uri,start,end:start+4,code:'compiler.err.cant.resolve.location'}));
  const occurrences=confirmUnresolvedType(text,selection,uri,errors);
  assert.throws(()=>confirmUnresolvedType(text,selection,uri,errors.slice(0,1)),/only the selected/);
  assert.throws(()=>confirmUnresolvedType(text,selection,uri,[...errors,{uri:'file:///Other.java'}]),/only the selected/);
  const draft=typeImportDraft(text,selection,'java.sql.Date',occurrences);
  assert.equal(draft.text.replace(draft.edit.newText,''),text);
  assert.match(draft.text,/keep the unused import for separate cleanup\r\nimport java\.sql\.Date;\r\n/);
  assert.equal(draft.text.slice(draft.selection.start,draft.selection.end),'Date');
  assert.throws(()=>verifyTypeImport({target:'java.util.Date',bindings:[]},'java.sql.Date',draft),/verify/);
  const unqualified='// Header\n/** Type documentation. */\nclass Sample { Date value; }\n',selected=unqualified.indexOf('Date');
  const declared=typeImportSelection(unqualified,selected,selected+4);
  assert.match(typeImportDraft(unqualified,declared,'java.sql.Date',[declared]).text,
    /^\/\/ Header\nimport java\.sql\.Date;\n\n\/\*\* Type documentation\. \*\//);
  assert.deepEqual(typeImportCandidates([
    {title:"Import 'Date' (java.util)",kind:'quickfix'},
    {title:"Import 'Date' (java.sql)",kind:'quickfix'},
    {title:"Import 'Date' (java.sql)",kind:'quickfix'},
    {title:"Import 'Other' (java.io)",kind:'quickfix'},
    {title:"Import 'Date' (dangerous/path)",kind:'quickfix'}
  ],'Date'),['java.util.Date','java.sql.Date']);
});

test('real JDT offers two imports and javac proves the chosen binding and byte-preserved static/wildcard imports',{
  skip:!config,timeout:160000
},async t=>{
  const {javaHome,serverPath}=JSON.parse(await fs.readFile(config,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-type-import-')),project=path.join(root,'project');
  t.after(async()=>{
    const physical=await fs.realpath(root);
    assert.equal(path.dirname(physical),parent);assert.match(path.basename(physical),/^rb-type-import-/);
    await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const dir=path.join(project,'src/main/java/fixture');await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const file=path.join(dir,'Sample.java'),uri=pathToFileURL(file).href,rootUri=pathToFileURL(project).href;
  const text=typeImportFixture('fixture','Sample');await fs.writeFile(file,text,{flag:'wx'});
  const at=text.indexOf('Date'),selection=typeImportSelection(text,at,at+4);
  const lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')}));
  let candidates;
  try {
    const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
    await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Type Import'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{
        codeAction:{codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix','source.organizeImports']}},resolveSupport:{properties:['edit']}}
      }},initializationOptions:{workspaceFolders:[rootUri],settings}},65000);
    lsp.notify('initialized',{});lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,version:1,languageId:'java',text}});
    let diagnostic;
    try {
      diagnostic=await until(()=>lsp.notifications.filter(item=>item.method==='textDocument/publishDiagnostics'&&matchesPath(item.params.uri,file))
        .flatMap(item=>item.params.diagnostics).find(item=>item.message.includes('Date')&&String(item.code)===UNDEFINED_TYPE),65000);
    }catch(error){
      throw Error('JDT did not publish the unresolved type: '+JSON.stringify(lsp.notifications.filter(item=>item.method==='textDocument/publishDiagnostics').slice(-3)),{cause:error});
    }
    const actions=await lsp.request('textDocument/codeAction',{textDocument:{uri},range:diagnostic.range,context:{diagnostics:[diagnostic],only:['quickfix']}});
    candidates=typeImportCandidates(actions,'Date').sort();
    assert.deepEqual(candidates,['java.sql.Date','java.util.Date'],JSON.stringify(actions?.map(item=>[item.title,item.kind])));
  }finally{await lsp.close();}

  const fqn='java.sql.Date';
  const inspect=(source,span)=>analyzeJavaSources({javaHome,storagePath:root,sources:[{uri,text:source}],
    inspection:{kind:'typeImport',uri,start:span.start,end:span.end,fqn}});
  const initial=await inspect(text,selection);
  const unresolved=confirmUnresolvedType(text,selection,uri,initial.errors);
  assert.equal(unresolved.length,2);
  const draft=typeImportDraft(text,selection,fqn,unresolved);
  const verified=await inspect(draft.text,draft.selection);
  assert.deepEqual(verified.errors,[]);
  verifyTypeImport(verified.typeImport,fqn,draft);
  assert.equal(draft.text.replace(draft.edit.newText,''),text);
  await fs.writeFile(file,draft.text);
  const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  await run(tool('javac'),['-proc:none','-d',root,file],{timeout:25000,windowsHide:true});
  const actual=(await run(tool('java'),['-cp',root,'fixture.Sample'],{timeout:20000,windowsHide:true})).stdout;
  assert.equal(actual,'java.sql.Date:0');
  if(process.env.ROCKETBRAIN_TYPE_IMPORT_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_TYPE_IMPORT_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',jdt:'1.63.0',candidates,selected:fqn,verifiedUses:unresolved.length,
      observedOutput:actual,staticAndWildcardRetained:true,unrelatedSourcePreserved:true},null,2)+'\n');
});
