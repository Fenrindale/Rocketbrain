'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {typeImportDraft}=require('../src/java/type-import');
const {staticImportFixture}=require('./helpers/java-static-import-fixture');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {problems,staticImportCandidates,staticImportSelection,confirmUnresolvedStaticMember,verifyStaticImport}=require('../src/java/static-import');

const configured=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,run=promisify(execFile);

test('static import candidates are taken only from bounded JDT edits to the selected source',()=>{
  const uri=pathToFileURL(path.resolve('Member.java')).href,other=pathToFileURL(path.resolve('Other.java')).href;
  const source='package fixture;\nclass Member { int n=max(2,4); }\n', offset=source.indexOf('max');
  const selected=staticImportSelection(source,offset+1,offset+1);
  const point={line:1,character:0},edits=[{range:{start:point,end:point},newText:'import static java.lang.Math.max;\n'}];
  const candidate=target=>({title:"Add static import for 'Math.max'",kind:'quickfix',edit:{changes:{[target]:edits}}});
  assert.deepEqual(staticImportCandidates([candidate(uri),candidate(other)],source,uri,'max'),['java.lang.Math.max']);
  assert.deepEqual(staticImportCandidates([{...candidate(uri),command:{command:'execute'}}],source,uri,'max'),[]);
  assert.deepEqual(staticImportCandidates([{...candidate(uri),edit:{documentChanges:[{kind:'rename'}]}}],source,uri,'max'),[]);
  const diagnostics=[{uri,start:offset,end:offset+3,code:'compiler.err.cant.resolve.location.args'}];
  const uses=confirmUnresolvedStaticMember(source,selected,uri,diagnostics);
  const draft=typeImportDraft(source,selected,'java.lang.Math.max',uses,{staticMember:true});
  assert.equal(draft.text.replace(draft.edit.newText,''),source);
  assert.throws(()=>staticImportSelection('Math.max(2,4)',5,8),/unqualified/);
  assert.throws(()=>confirmUnresolvedStaticMember(source,selected,uri,[...diagnostics,{...diagnostics[0],uri:other}]),/only the reviewed/);
  assert.throws(()=>verifyStaticImport({target:'java.lang.Math.max',bindings:[{...draft.selection,member:'java.lang.StrictMath.max',kind:'method',signature:'max'}]},
    'java.lang.Math.max',draft),/declaring type/);
});

test('pinned JDT proposes static methods and fields, and Javac proves exact overloads before real JDK runs',{
  skip:!configured,timeout:180000
},async t=>{
  const {javaHome,serverPath}=JSON.parse(await fs.readFile(configured,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-static-import-'));
  t.after(async()=>{
    const actual=await fs.realpath(root);
    assert.equal(path.dirname(actual),parent);assert.match(path.basename(actual),/^rb-static-import-/);
    await fs.rm(actual,{recursive:true,maxRetries:8,retryDelay:200});
  });
  const project=path.join(root,'project'),dir=path.join(project,'src/main/java/fixture'),out=path.join(root,'classes');
  await fs.mkdir(dir,{recursive:true});await fs.mkdir(out);
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  const rootUri=pathToFileURL(project).href,lsp=new StdioLsp(resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')}));
  const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  const results={},owner=path.join(dir,'WorkspaceOptions.java');
  const ownerSource='package fixture; public class WorkspaceOptions { public static final int RB_STATIC_LIMIT=42; }\n';
  await fs.writeFile(owner,ownerSource,{flag:'wx'});
  try {
    const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{
      favoriteStaticMembers:['java.lang.Math.*','java.lang.StrictMath.*','java.lang.Integer.MAX_VALUE']
    });
    await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,workspaceFolders:[{uri:rootUri,name:'Static Import'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true,workspaceEdit:{documentChanges:true}},textDocument:{
        codeAction:{codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix']}},resolveSupport:{properties:['edit']}}
      }},initializationOptions:{workspaceFolders:[rootUri],settings}},65000);
    lsp.notify('initialized',{});lsp.notify('workspace/didChangeConfiguration',{settings});
    for(const [kind,name,token,fqn,expected] of [
      ['method','MethodChoice','max','java.lang.Math.max','7:2.0'],
      ['field','FieldChoice','MAX_VALUE','java.lang.Integer.MAX_VALUE','2147483647:2147483647'],
      ['explicit','ExplicitChoice','RB_STATIC_LIMIT','fixture.WorkspaceOptions.RB_STATIC_LIMIT','42:42']
    ]){
      const file=path.join(dir,name+'.java'),uri=pathToFileURL(file).href,text=staticImportFixture('fixture',name,kind);
      await fs.writeFile(file,text,{flag:'wx'});
      lsp.notify('workspace/didChangeWatchedFiles',{changes:[{uri,type:1}]});
      lsp.notify('textDocument/didOpen',{textDocument:{uri,version:1,languageId:'java',text}});
      const start=text.indexOf(token),selected=staticImportSelection(text,start,start+token.length);
      const diagnostic=await until(()=>lsp.notifications.filter(event=>event.method==='textDocument/publishDiagnostics'&&event.params.uri.endsWith('/'+name+'.java'))
        .flatMap(event=>event.params.diagnostics).find(item=>problems.has(String(item.code))&&item.message.includes(token)),65000);
      const actions=await lsp.request('textDocument/codeAction',{textDocument:{uri},range:diagnostic.range,context:{diagnostics:[diagnostic],only:['quickfix']}});
      const candidates=staticImportCandidates(actions,text,uri,token);
      if(kind==='explicit')assert.deepEqual(candidates,[]);
      else assert.ok(candidates.includes(fqn),JSON.stringify({candidates,actions:actions?.map(item=>item.title)}));
      if(kind==='method')assert.ok(candidates.includes('java.lang.StrictMath.max'),JSON.stringify(candidates));
      const inspect=(source,range,desired=fqn)=>analyzeJavaSources({javaHome,storagePath:root,sources:[{uri,text:source},...(kind==='explicit'?[{uri:pathToFileURL(owner).href,text:ownerSource}]:[])],
        inspection:{kind:'staticImport',uri,start:range.start,end:range.end,fqn:desired}});
      const baseline=await inspect(text,selected);
      const uses=confirmUnresolvedStaticMember(text,selected,uri,baseline.errors);
      assert.equal(uses.length,2);
      const draft=typeImportDraft(text,selected,fqn,uses,{staticMember:true});
      const proof=await inspect(draft.text,draft.selection);
      assert.deepEqual(proof.errors,[]);
      const measured=verifyStaticImport(proof.staticImport,fqn,draft);
      assert.equal(measured.kind,kind==='method'?'method':'field');
      if(kind==='method'){
        assert.deepEqual(measured.signatures,['java.lang.Math#max(int,int)','java.lang.Math#max(double,double)']);
        const wrong='java.lang.Integer.max',wrongDraft=typeImportDraft(text,selected,wrong,uses,{staticMember:true});
        assert.ok((await inspect(wrongDraft.text,wrongDraft.selection,wrong)).errors.length);
      }
      assert.equal(draft.text.replace(draft.edit.newText,''),text);
      lsp.notify('textDocument/didClose',{textDocument:{uri}});
      await fs.writeFile(file,draft.text);
      await run(tool('javac'),['-proc:none','-d',out,file,...(kind==='explicit'?[owner]:[])],{timeout:25000,windowsHide:true});
      const result=(await run(tool('java'),['-cp',out,'fixture.'+name],{timeout:20000,windowsHide:true})).stdout;
      assert.equal(result,expected);
      results[kind]={candidates,chosen:fqn,uses:uses.length,signatures:measured.signatures,output:result};
    }
  }finally{await lsp.close();}
  if(process.env.ROCKETBRAIN_STATIC_IMPORT_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_STATIC_IMPORT_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',jdt:'1.63.0',...results,existingImportsPreserved:true,wrongOverloadOwnerRejected:true})+'\n');
});
