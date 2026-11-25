'use strict';

const assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');
const {test}=require('node:test');
const {StdioLsp,positionOf,until}=require('./helpers/stdio-lsp');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {prepareLibraryFixture}=require('./helpers/library-source-fixture');
const {DapClient}=require('./java-debug-dap');
const {debugSettings}=require('../src/java/debug-exceptions');
const {libraryClass,inspectSourceArchive,contentMode}=require('../src/java/library-source');
const {registerLibrarySources}=require('../src/java/library-source-vscode');

const configuration=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('library source inspection recognizes pinned JDT URI shapes and refuses unrelated documents',()=>{
  const target='jdt://contents/meter.jar/library.fixture/Meter%24Nested.java?=Fixture%3CClass';
  assert.deepEqual(libraryClass(target).entries,['library/fixture/Meter$Nested.java','library/fixture/Meter.java']);
  assert.throws(()=>libraryClass('file:///project/Meter.java'),/resolved by JDT/);
  assert.throws(()=>libraryClass('jdt://contents/meter.jar/xx%2Fyy/Meter.java?x'),/resolved by JDT/);
  assert.throws(()=>libraryClass('jdt://contents/meter.jar/library.fixture/Meter.java'),/resolved by JDT/);
});

test('pinned JDT decompiles actual binary instructions and switches to and from approved original archive', {
  skip:!configuration,timeout:160000
},async t=>{
  const {javaHome,serverPath,debugBundlePath}=JSON.parse(await fs.readFile(configuration,'utf8'));
  const temp=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(temp,'rb-libsrc-')),
    workspace=path.join(root,'workspace'),project=path.join(workspace,'project'),seed=path.join(workspace,'seed');
  t.after(async()=>{
    const verified=await fs.realpath(root);
    assert.equal(path.dirname(verified),temp);assert.match(path.basename(verified),/^rb-libsrc-/);
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await fs.mkdir(seed,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(seed,'pom.xml'));
  const launch=resolveLaunch({javaHome,serverPath,debugBundlePath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch);
  const rootUri=pathToFileURL(workspace).href,projectUri=pathToFileURL(project).href;
  const command=(name,...args)=>lsp.request('workspace/executeCommand',{command:name,arguments:args},25000);
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,
      workspaceFolders:[{uri:rootUri,name:'Library Source Fixture'}],capabilities:{workspace:{workspaceFolders:true,configuration:true}},
      initializationOptions:{bundles:launch.bundles,workspaceFolders:[rootUri],settings,
        extendedClientCapabilities:{classFileContentsSupport:true}}},75000);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings});
    const imported=location=>until(async()=>(await command('java.project.getAll'))?.some(uri=>!path.relative(fileURLToPath(uri),location)),60000);
    await imported(seed);
    const fixture=await prepareLibraryFixture({project,scratch:root,javaHome}),uri=pathToFileURL(fixture.file).href;
    await command('java.project.changeImportedProjects',[pathToFileURL(fixture.config).href],[],[]);
    await imported(project);
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text:fixture.source}});
    const target=await until(async()=>{
      const found=await lsp.request('textDocument/definition',{textDocument:{uri},position:positionOf(fixture.source,'convert(8)',2)},25000);
      return found?.map(item=>item.uri||item.targetUri).find(item=>item?.startsWith('jdt:'));
    },60000);
    const classContent=()=>lsp.request('java/classFileContents',{uri:target});
    const resolve=()=>command('java.project.resolveSourceAttachment',{classFileUri:target});
    const initial=await resolve();
    assert.equal(initial.errorMessage,undefined,JSON.stringify(initial));
    assert.equal(path.relative(initial.attributes.jarPath,fixture.binary),'',JSON.stringify(initial));
    assert.equal(initial.attributes.sourceAttachmentPath,undefined);
    const code=await classContent();
    assert.match(code,/FernFlower/);
    assert.match(code,/\* 3/);
    assert.match(code,/> 20/);
    assert.doesNotMatch(code,/exact comment/);
    assert.equal(contentMode(code),'decompiled');
    const selected=await inspectSourceArchive(fixture.sources,libraryClass(target).entries);
    assert.equal(selected.entry,fixture.entry);
    assert.equal(selected.text,fixture.original);
    await assert.rejects(inspectSourceArchive(fixture.binary,libraryClass(target).entries),/lacks the Java source entry/);
    const updates=[],parse=value=>({scheme:'jdt',authority:'contents',path:new URL(value).pathname,toString:()=>value});
    const stub={dispose(){}};
    const service=registerLibrarySources({
      EventEmitter:class{fire(uri){updates.push(uri.toString());}dispose(){}},
      Uri:{parse},commands:{registerCommand:()=>stub},
      workspace:{isTrusted:true,textDocuments:[{uri:parse(target)}],registerTextDocumentContentProvider:()=>stub}
    },{java:{executeWorkspaceCommand:command},readContent:classContent});
    try {
      const inspected=await service.inspect(target);
      const reviewed=await service.reviewSource(inspected,fixture.sources);
      const added=await service.setAttachment(inspected,reviewed);
      assert.equal(added.mode,'source');
      assert.equal(path.relative(added.attachment,fixture.sources),'');
      const attached=await classContent();
      assert.equal(attached.replace(/\r\n/g,'\n'),fixture.original);
      assert.equal(contentMode(attached),'source');
      await assert.rejects(service.setAttachment(inspected,reviewed),/changed/);
      const removed=await service.setAttachment(await service.inspect(target));
      assert.equal(removed.mode,'decompiled');
      assert.equal(removed.attachment,null);
      assert.equal(await classContent(),code);
      assert.deepEqual(updates,[target,target]);
    }finally{service.dispose();}
    const output=path.join(root,'out');
    await fs.mkdir(output);
    await fixture.tool('javac',['-proc:none','-cp',fixture.binary,'-d',output,fixture.file]);
    const actual=(await fixture.tool('java',['-cp',[output,fixture.binary].join(path.delimiter),'consumer.Sample'])).stdout;
    assert.equal(actual,'20:10');
    const disassembly=(await fixture.tool('javap',['-verbose','-classpath',fixture.binary,'library.fixture.Meter'])).stdout;
    assert.match(disassembly,/LineNumberTable:\s+line 8:/);
    let debugMapping;
    if(launch.bundles.length) {
      const main=await until(async()=>(await command('vscode.java.resolveMainClass',projectUri))?.find(item=>item.mainClass==='consumer.Sample'),30000);
      const javaExec=await command('vscode.java.resolveJavaExecutable',main.mainClass,main.projectName);
      const decompiledLine=code.split(/\r?\n/).findIndex(line=>/\* 3/.test(line))+1;
      await command('vscode.java.updateDebugSettings',debugSettings({}, {javaHome}));
      const dap=new DapClient(await command('vscode.java.startDebugSession'));
      try {
        await dap.request('initialize',{adapterID:'rocketbrain-java',clientID:'library-source-test',linesStartAt1:true,columnsStartAt1:true,
          pathFormat:'path',supportsRunInTerminalRequest:false,supportsVariableType:true});
        const started=dap.request('launch',{type:'rocketbrain-java',name:'Library source fixture',...main,cwd:project,
          classPaths:[output,fixture.binary],modulePaths:[],javaExec,console:'internalConsole',sourcePaths:[],encoding:'UTF-8'});
        void started.catch(()=>{});
        await dap.event('initialized');
        const installed=await dap.request('setBreakpoints',{source:{name:'Meter.java',path:target},breakpoints:[{line:decompiledLine}]});
        await dap.request('configurationDone');await started;
        const stopped=await dap.event('stopped',0,18000).catch(error=>{throw Error(JSON.stringify(installed),{cause:error});});
        assert.equal(stopped.reason,'breakpoint');
        const {stackFrames}=await dap.request('stackTrace',{threadId:stopped.threadId});
        const frame=stackFrames[0];
        assert.match(frame.name,/Meter.convert/);
        assert.equal(frame.line,decompiledLine);
        assert.equal(decodeURIComponent(new URL(frame.source.path).search),decodeURIComponent(new URL(target).search));
        await dap.request('setBreakpoints',{source:{name:'Meter.java',path:target},breakpoints:[]});
        await dap.request('continue',{threadId:stopped.threadId});
        await dap.event('terminated');
        debugMapping={decompiledLine,classLine:8,stopped:true};
      }finally{await dap.close();}
    }
    if(process.env.ROCKETBRAIN_LIBRARY_SOURCE_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_LIBRARY_SOURCE_RECEIPT,
      JSON.stringify({jdk:'Temurin 25.0.5+8',jdt:'1.63.0',target,sourceArchiveAttachment:true,staleReviewRefused:true,
        detachedToSameDecompile:true,generatedBranch:true,actual,javapLineTable:true,debugMapping},null,2)+'\n');
  }finally{await lsp.close();}
});
