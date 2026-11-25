'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {resolveNullChecks,nullCheckUpdates}=require('../src/java/null-checks');
const {configureNullChecks}=require('../src/java/null-checks-vscode');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {javaNullFixture,kotlinNullFixture,kotlinNullFixed,javaNullable,javaContract,javaResource,kotlinNullable}=require('./helpers/null-checks-fixture');

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,kotlinHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
const sameFile=(uri,file)=>{try{return !path.relative(fileURLToPath(uri),file);}catch{return false;}};
const run=promisify(execFile);

test('native null profiles require distinct qualified Java annotations and disabled policy is explicit',()=>{
  assert.deepEqual(resolveNullChecks(),{profile:'disabled',mode:'disabled',nullable:[],nonnull:[],nonnullbydefault:[]});
  assert.deepEqual(resolveNullChecks({profile:'jspecify'}).nonnullbydefault,['org.jspecify.annotations.NullMarked']);
  assert.deepEqual(resolveNullChecks({profile:'spring'}).nullable,['org.springframework.lang.Nullable']);
  const custom={profile:'custom',nullable:'example.Maybe',nonnull:'example.Required'};
  assert.deepEqual(resolveNullChecks(custom).nonnullbydefault,[]);
  assert.throws(()=>resolveNullChecks({...custom,nonnull:'NotQualified'}),/fully qualified/);
  assert.throws(()=>resolveNullChecks({...custom,nonnullByDefault:custom.nullable}),/distinct/);
  assert.throws(()=>resolveNullChecks({...custom,nullable:'example.class'}),/fully qualified/);
  assert.throws(()=>resolveNullChecks({profile:'__proto__'}),/known/);
});

test('null profile picker writes validated custom settings only in a trusted workspace and handles cancellation',async()=>{
  const written=[],inputs=[' example.Nullable ','example.NonNull',''];
  const vscode={ConfigurationTarget:{Workspace:2},workspace:{isTrusted:true,workspaceFolders:[{}],
    getConfiguration:()=>({get:()=>({profile:'disabled'}),update:(...args)=>written.push(args)})},
    window:{showQuickPick:items=>items.find(item=>item.profile==='custom'),showInputBox:options=>{
      const value=inputs.shift();
      assert.equal(options.validateInput(value),undefined);
      return value;
    }}};
  assert.equal(await configureNullChecks(vscode),'custom');
  assert.deepEqual(written,[['nullChecks',{profile:'custom',nullable:'example.Nullable',nonnull:'example.NonNull'},2]]);
  vscode.window.showInputBox=()=>undefined;
  assert.equal(await configureNullChecks(vscode),undefined);
  assert.equal(written.length,1);
  vscode.workspace.isTrusted=false;
  await assert.rejects(()=>configureNullChecks(vscode),/trusted workspace/);
  assert.equal(written.length,1);
});

for(const language of ['java','kotlin'])test('actual '+language+' compiler publishes null diagnostics and clears them from an unsaved safe edit',{
  skip:!config||language==='kotlin'&&!kotlinHome,timeout:200000
},async t=>{
  const {javaHome,serverPath,gradleHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const kotlin=language==='kotlin',parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-null-checks-'));
  t.after(async()=>{
    const verified=await fs.realpath(root);
    assert.equal(path.dirname(verified),parent);assert.match(path.basename(verified),/^rb-null-checks-/);
    await fs.rm(verified,{recursive:true,force:true,maxRetries:10,retryDelay:250});
  });
  const project=path.join(root,'project');
  let sample,uriFor;
  if(kotlin) {
    await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
    const file=path.join(project,'src/main/kotlin/editor/fixture/KotlinNull.kt');
    sample={file,source:kotlinNullFixture,fixed:kotlinNullFixed};
    await fs.writeFile(file,sample.source,{flag:'wx'});
    uriFor=kotlinProtocolUri;
  }else{
    await fs.mkdir(project);
    await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
    sample=await javaNullFixture(project,'editor.fixture','JavaNull');
    uriFor=file=>pathToFileURL(file).href;
  }
  const uri=uriFor(sample.file),rootUri=uriFor(project);
  const runtimes=[{name:'JavaSE-25',path:javaHome,default:true}];
  const settings=kotlin?{}:serverSettings(runtimes);
  const launch=kotlin?await kotlinEditorLaunch({serverHome:kotlinHome,javaHome,gradleHome,root:project,
    gradleUserHome:process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(root,'gradle'),storageRoot:path.join(root,'storage')}):
    resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch);
  const diagnostics=after=>lsp.notifications.slice(after).filter(item=>item.method==='textDocument/publishDiagnostics'&&
    sameFile(item.params.uri,sample.file)).at(-1)?.params.diagnostics;
  async function wait(after,predicate) {
    try {return await until(()=>{const result=diagnostics(after);return result&&predicate(result)?result:undefined;},60000);}
    catch(error){throw Error(`${language} diagnostics: ${JSON.stringify(diagnostics(0))}`,{cause:error});}
  }
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Null Checks Fixture'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{publishDiagnostics:{relatedInformation:true,versionSupport:true}}},
      initializationOptions:{workspaceFolders:[rootUri],settings}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text:sample.source}});
    let observed,verifiedDefaultSwitch=false;
    if(kotlin) observed=await wait(0,items=>items.some(kotlinNullable));
    else {
      const disabled=await wait(0,items=>items.every(item=>!javaNullable(item)&&!javaContract(item)));
      assert.ok(disabled.every(item=>!javaNullable(item)&&!javaContract(item)));
      const active=serverSettings(runtimes,{nullChecks:sample.profile});
      const choose=async(from,to,predicate)=>{
        const before=lsp.notifications.length;
        for(const next of nullCheckUpdates(from,to))lsp.notify('workspace/didChangeConfiguration',{settings:next});
        return wait(before,predicate);
      };
      const contractAt=line=>items=>items.some(item=>javaContract(item)&&item.range.start.line===line);
      const expected=items=>items.some(javaNullable)&&contractAt(6)(items)&&contractAt(11)(items);
      await choose(settings,active,expected);
      const alternate=serverSettings(runtimes,{nullChecks:{...sample.profile,nonnullByDefault:'editor.fixture.AlternateDefault'}});
      await choose(active,alternate,items=>items.some(javaNullable)&&contractAt(6)(items)&&!contractAt(11)(items));
      observed=await choose(alternate,active,expected);
      verifiedDefaultSwitch=true;
    }
    const expected=kotlin?[kotlinNullable]:[javaNullable,javaContract];
    const selected=expected.map(predicate=>observed.find(predicate));
    assert.equal(selected[0].range.start.line,kotlin?2:5);
    if(!kotlin) {
      assert.equal(selected[1].range.start.line,6);
      assert.equal(observed.find(javaResource)?.range.start.line,8);
    }
    const begin=lsp.notifications.length;
    lsp.notify('textDocument/didChange',{textDocument:{uri,version:2},contentChanges:[{text:sample.fixed}]});
    const fixed=await wait(begin,items=>!expected.some(predicate=>items.some(predicate))&&!items.some(javaResource));
    assert.ok(fixed.every(item=>item.severity!==1),JSON.stringify(fixed));
    assert.equal(await fs.readFile(sample.file,'utf8'),sample.source);
    let compiledFixedOutput;
    if(!kotlin) {
      const compile=path.join(root,'compile'),classPath=path.join(root,'classes');
      await fs.mkdir(compile);await fs.mkdir(classPath);
      const fixedFile=path.join(compile,path.basename(sample.file));
      await fs.writeFile(fixedFile,sample.fixed,{flag:'wx'});
      const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
      await run(tool('javac'),['-proc:none','-d',classPath,...sample.files.filter(file=>file!==sample.file),fixedFile],
        {timeout:25000,windowsHide:true});
      compiledFixedOutput=(await run(tool('java'),['-cp',classPath,'editor.fixture.JavaNull'],{timeout:20000,windowsHide:true})).stdout;
      assert.equal(compiledFixedOutput,'0:5:ready:ready');
    }
    if(process.env.ROCKETBRAIN_NULL_CHECK_RECEIPTS)await fs.writeFile(
      path.join(process.env.ROCKETBRAIN_NULL_CHECK_RECEIPTS,'v77-'+language+'-null-checks.json'),
      JSON.stringify({language,engine:kotlin?'Kotlin LSP 1.4.0-rc1':'Eclipse JDT LS 1.63.0',selected,
        resource:observed.find(javaResource)??null,liveProfileApplied:!kotlin,verifiedDefaultSwitch,unsavedFixCleared:true,
        originalOnDisk:true,compiledFixedOutput},null,2)+'\n');
  }finally{try{await lsp.close();}finally{await launch.dispose?.();}}
});
