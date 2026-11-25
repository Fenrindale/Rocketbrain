'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {registerFileStructure}=require('../src/java/file-structure-vscode');
const {createTypedFileStructure}=require('../src/java/typed-file-structure');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {inheritedStructureFixture}=require('./helpers/java-inherited-structure-fixture');

const run=promisify(execFile);
const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const receipt=process.env.ROCKETBRAIN_INHERITED_STRUCTURE_RECEIPT;

test('typed Java filters use the reviewed command and guard source and binary navigation',async ()=>{
  const text='class Child extends Base {}\n',baseText='class Base {\r\n  int field;\r\n}\r\n';
  const paths=['Child','Base'].map(name=>path.resolve(name+'.java'));
  const docs=paths.map((file,id)=>({
    uri:{scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href},
    languageId:'java',version:1,isClosed:false,isDirty:false,getText:()=>id?baseText.replace(/\r\n/g,'\n'):text
  }));
  const current=docs[0],saved=docs.map((document,id)=>({uri:document.uri.toString(),text:id?baseText:text,sha:String(id)}));
  const project={id:'project'},state={state:'running',runtimeIdentity:'initial',projects:[project]};
  let callback,choices=0,shown,missing,updated=false,staleClasspath=false;
  const vscode={Uri:{parse:value=>docs.find(doc=>doc.uri.toString()===value).uri},Range:class {
    constructor(a,b,c,d){this.start={line:a,character:b};this.end={line:c,character:d};}
  },ProgressLocation:{Notification:1},workspace:{isTrusted:true,getWorkspaceFolder:()=>({}),
    openTextDocument:async uri=>docs.find(doc=>doc.uri===uri)},
  commands:{registerCommand(_id,action){callback=action;return {dispose(){}};}},
  window:{activeTextEditor:{document:current,selection:{}},withProgress:(_options,work)=>work(),
    showQuickPick:async items=>choices++%2===0?items.find(item=>item.group==='inherited'):items.find(item=>item.member.sourced!==Boolean(missing)),
    showErrorMessage:assert.fail,showInformationMessage:message=>{missing=message;},
    showTextDocument:async (document,options)=>shown={document,options}}};
  const java={getState:()=>state};
  const inspector=createTypedFileStructure(vscode,{java,assertReady:()=>{},projects:async()=>state,findProject:()=>project,
    classSources:async()=>saved,snapshot:async()=>saved[0],
    assertUnchangedSourceSnapshots:()=>{if(updated)throw Error('A declaration changed.');},
    compile:async()=>({typeStructure:{members:[
      {label:'field',kind:'Field',path:'Base',signature:'',uri:saved[1].uri,start:baseText.indexOf('field'),end:baseText.indexOf('field')+5},
      {label:'wait',kind:'Method',path:'java.lang.Object',signature:'()',uri:null,start:null,end:null}
    ]},validateClasspath(){if(staleClasspath)throw Error('Classpath changed.');}})});
  const service=registerFileStructure(vscode,{java,readJava:assert.fail,output:{appendLine:assert.fail}});
  const registration=service.registerJavaInspection(inspector);
  try {
    const found=await callback();
    assert.equal(found.group,'inherited');
    assert.equal(shown.document,docs[1]);
    assert.deepEqual(shown.options.selection.start,{line:1,character:6});
    await assert.rejects(service.reveal(found,1),/source is unavailable/);
    await assert.rejects(service.reveal({...found},0),/known file structure member/);
    updated=true;
    await assert.rejects(service.reveal(found,0),/declaration changed/);
    updated=false; staleClasspath=true;
    await assert.rejects(service.reveal(found,0),/Classpath changed/);
    staleClasspath=false;
    missing=true;
    await callback();
    assert.match(missing,/source is unavailable/);
    current.version++;
    await assert.rejects(service.reveal(found,0),/source or its Java runtime changed/);
    await assert.rejects(service.inspect({document:{...current,languageId:'kotlin'},group:'nested'}),/Choose a Java source/);
  } finally {registration.dispose();service.dispose();}
});

test('pinned JDT and javac verify inherited substitution, exact declarators and anonymous/local type identity',{
  skip:!config,timeout:180000
},async t=>{
  const {javaHome,serverPath}=JSON.parse(await fs.readFile(config,'utf8'));
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'rb-inherited-'));
  t.after(async()=>{
    const real=await fs.realpath(root);
    assert.equal(real,root);assert.equal(path.dirname(real),temp);assert.match(path.basename(real),/^rb-inherited-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const project=path.join(root,'project'),dir=path.join(project,'src/main/java/outline/fixture');
  await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const sources=await Promise.all(Object.entries(inheritedStructureFixture('outline.fixture','Base','Child')).map(async ([name,text])=>{
    const file=path.join(dir,name);await fs.writeFile(file,text,{flag:'wx'});
    return {file,uri:pathToFileURL(file).href,text};
  }));
  const [base,child]=sources;
  await run(path.join(javaHome,'bin',process.platform==='win32'?'javac.exe':'javac'),
    ['-proc:none','-d',path.join(root,'classes'),...sources.map(source=>source.file)],{timeout:30000});
  const rootUri=pathToFileURL(project).href,settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')}));
  let nativeSymbols;
  try {
    const startup=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Inherited structure fixture'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},
      initializationOptions:{workspaceFolders:[rootUri],settings}},90000);
    assert.ok(startup.capabilities.documentSymbolProvider);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri:child.uri,languageId:'java',version:1,text:child.text}});
    const result=await until(async()=>{
      const raw=await lsp.request('textDocument/documentSymbol',{textDocument:{uri:child.uri}},40000);
      return raw?.length?raw:undefined;
    },55000);
    assert.ok(JSON.stringify(result).includes('Member'));
    nativeSymbols=result.length;
  } finally {await lsp.close();}
  const inspect=async (group,marker)=>{
    const result=await analyzeJavaSources({javaHome,storagePath:path.join(root,'analyzed'),sources,
      inspection:{kind:'typeStructure',uri:child.uri,offset:child.text.indexOf(marker),group}});
    assert.deepEqual(result.errors,[]);
    assert.equal(result.processorsEnabled,false);assert.equal(result.classGenerationEnabled,false);
    assert.ok(!result.typeStructure.error,result.typeStructure.error);
    return result.typeStructure;
  };
  const {type,members}=await inspect('inherited','int hidden');
  assert.equal(type,'outline.fixture.Child');
  const sourced=members.filter(item=>item.uri===base.uri);
  const method=sourced.find(item=>item.label==='inherited'&&item.signature==='(java.lang.String)');
  assert.equal(method.detail,'java.lang.String');
  assert.equal(base.text.slice(method.start,method.end),'inherited');
  assert.ok(base.text.slice(method.end).startsWith('(T value)'));
  assert.ok(sourced.some(item=>item.label==='inherited'&&item.signature==='(int)'));
  assert.equal(sourced.find(item=>item.label==='shared').detail,'java.lang.String');
  const multi=sourced.find(item=>item.label==='duplicate');
  assert.equal(multi.start,base.text.lastIndexOf('duplicate'));
  assert.ok(sourced.some(item=>item.label==='contract'&&item.path.endsWith('BaseContract')&&item.signature==='(java.lang.String)'));
  assert.ok(sourced.some(item=>item.label==='SharedType'));
  assert.ok(!members.some(item=>['hidden','secret','replaced'].includes(item.label)));
  assert.ok(members.some(item=>item.label==='hashCode'&&item.path==='java.lang.Object'&&item.uri===null));
  const {members:nested}=await inspect('nested','Override public void run');
  assert.deepEqual(nested.map(item=>item.origin),['MEMBER','LOCAL','ANONYMOUS','LOCAL','ANONYMOUS']);
  assert.deepEqual(nested.map(item=>child.text.slice(item.start,item.end)),
    ['Member','Local','Runnable','Local','java.util.function.Consumer<String>']);
  assert.notEqual(nested[1].path,nested[3].path);
  assert.equal(nested.find(item=>item.current).label,'Anonymous Runnable');
  assert.ok(nested[4].detail.includes('java.util.function.Consumer<java.lang.String>'));
  const anonymous=await inspect('inherited','Override public void run');
  assert.match(anonymous.type,/create\(\) › <anonymous>/);
  assert.ok(anonymous.members.some(item=>item.label==='toString'));
  const proof={runtime:'Temurin JDK 25.0.5+8 / JDT LS 1.63.0',nativeSymbols,exactInherited:sourced.length,
    genericOverloads:2,binary:true,hiding:true,nestedTypes:nested.length,anonymousOrigins:2,
    distinctLocalParents:true,anonymousCurrent:true,processorsEnabled:false,classGenerationEnabled:false};
  if(receipt) await fs.writeFile(receipt,JSON.stringify(proof,null,2)+'\n');
});
