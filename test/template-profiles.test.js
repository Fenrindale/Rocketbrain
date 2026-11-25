'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {listFileTemplates,listCopyrightProfiles,matchesFileScope,renderJavaFile,writeTemplateFile}=require('../src/java/file-templates');
const {registerJavaUtilities,sourceRoots,COMMANDS}=require('../src/java/utilities-vscode');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {collectProjects}=require('../src/java/workbench-model');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {template,profile}=require('./helpers/template-profile-fixture');

const run=promisify(execFile),config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const marker='한글 "quoted" \\u000a ${name}';
const year=()=>new Date().getUTCFullYear();
const uri=file=>({scheme:'file',fsPath:file,toString:()=>pathToFileURL(file).href});

async function temporary(t) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-template-'));
  t.after(async()=>{
    const actual=await fs.realpath(root);
    assert.equal(path.dirname(actual),parent);assert.match(path.basename(actual),/^rb-template-/);
    await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  return root;
}

test('typed template profiles validate names, scope, defaults, Java strings and non-code notices',()=>{
  const source=template('gradle','main'),copyright=profile('gradle','main');
  const model=listFileTemplates([source]).at(-1),[notice]=listCopyrightProfiles([copyright]);
  assert.ok(matchesFileScope(model,'main','gradle'));
  assert.ok(matchesFileScope(notice,'main','gradle'));
  assert.equal(matchesFileScope(model,'test','gradle'),false);
  assert.equal(matchesFileScope(notice,'main','maven'),false);
  const text=renderJavaFile(source,'Fixture','example',{variables:{label:marker},copyrightProfile:copyright});
  assert.ok(text.startsWith('// Copyright '+year()+' Fixture contributors\n// example.Fixture · gradle\n\npackage example;'));
  assert.ok(text.includes('return '+JSON.stringify(marker)+' + ":" + 7;'));
  assert.match(text,/String message\(\)/);
  assert.throws(()=>listCopyrightProfiles([{...copyright,notice:'break \\u000a package outside;'}]),/ordinary notice/);
  assert.throws(()=>listCopyrightProfiles([copyright,copyright]),/distinct/);
  assert.throws(()=>renderJavaFile(source,'Fixture','example'),/Enter a value.*label/);
  assert.throws(()=>renderJavaFile(source,'Fixture','example',{variables:{label:'a',method:'class'}}),/valid Java identifier/);
  assert.throws(()=>renderJavaFile(source,'Fixture','example',{variables:{label:'a',count:'2147483648'}}),/32-bit/);
  assert.throws(()=>renderJavaFile(source,'Fixture','example',{variables:{label:'a',unused:'b'}}),/Only supply declared/);
});

test('normal file-template prompts use scoped defaults, allow no header and refuse cancellation or changed settings',async t=>{
  const root=await temporary(t),main=path.join(root,'src/main/java'),pom=path.join(root,'pom.xml');
  await fs.mkdir(main,{recursive:true});
  await fs.writeFile(pom,'<project/>');
  const configured={fileTemplates:[template('maven','main'),template('gradle','main'),template('maven','test')],
    copyrightProfiles:[profile('maven','main'),profile('gradle','main')],defaultCopyrightProfile:'maven main notice'};
  const commands=new Map(),messages=[];
  let mode='create',shown;
  const documentSettings={get:(name,fallback)=>configured[name]??fallback};
  const vscode={Uri:{file:uri},workspace:{isTrusted:true,workspaceFolders:[{name:'fixture',uri:uri(root)}],
    getConfiguration:()=>documentSettings,findFiles:async()=>[uri(pom)],textDocuments:[],
    openTextDocument:async target=>({uri:target,getText:()=>fs.readFile(target.fsPath,'utf8')})},
  window:{createOutputChannel:()=>({dispose(){}}),async showTextDocument(doc){shown=doc;},
    async showQuickPick(items,{title}) {
      if(title.endsWith('Source Root'))return items.find(item=>item.source.source==='main');
      if(title.endsWith('Type')) {
        assert.ok(items.some(item=>item.label==='maven main component'));
        assert.ok(!items.some(item=>['gradle main component','maven test component'].includes(item.label)));
        return items.find(item=>item.label==='maven main component');
      }
      assert.equal(items[0].label,'maven main notice');
      assert.ok(!items.some(item=>item.label==='gradle main notice'));
      return mode==='without'?items.find(item=>item.label==='No copyright header'):items[0];
    },
    async showInputBox(options) {
      if(options.title.endsWith('Type Name'))return {create:'Created',without:'WithoutNotice',cancel:'Cancelled',stale:'Stale'}[mode];
      if(options.title.endsWith('Package'))return 'example';
      if(options.title.endsWith('method'))return options.value;
      if(options.title.endsWith('label'))return mode==='cancel'?undefined:marker;
      if(mode==='stale')configured.copyrightProfiles[0]={...configured.copyrightProfiles[0],notice:'Changed'};
      return options.value;
    },showErrorMessage:message=>messages.push(message)},
  commands:{registerCommand(id,handler){commands.set(id,handler);return {dispose(){}};}}};
  const util=registerJavaUtilities({storageUri:uri(root)},vscode,{java:{}});
  try {
    const generate=()=>commands.get(COMMANDS.newFile)();
    const result=await generate();
    assert.equal(result.projectTool,'maven');
    assert.equal(result.copyrightProfile,'maven main notice');
    assert.equal(shown.uri.fsPath,result.path);
    const original=await shown.getText();
    assert.ok(original.startsWith('// Copyright '+year()));
    await assert.rejects(util.createFile({sourceRoot:main,templateName:'maven main component',name:'Created',
      packageName:'example',variables:{label:'other'}}),/already exists/);
    assert.equal(await fs.readFile(result.path,'utf8'),original);
    mode='without';const noNotice=await generate();
    assert.equal(noNotice.copyrightProfile,null);
    assert.match(await fs.readFile(noNotice.path,'utf8'),/^package example;/);
    mode='cancel';assert.equal(await generate(),undefined);
    await assert.rejects(fs.stat(path.join(main,'example/Cancelled.java')),{code:'ENOENT'});
    mode='stale';assert.equal(await generate(),null);
    assert.match(messages.at(-1),/profile or source root changed/);
    await assert.rejects(fs.stat(path.join(main,'example/Stale.java')),{code:'ENOENT'});
  }finally{await util.dispose();}
});

test('real Maven and Gradle source roots build and run generated profile/template sources with independent JDT and Java',{
  skip:!config,timeout:310000
},async t=>{
  const {javaHome,serverPath,gradleHome}=JSON.parse(await fs.readFile(config,'utf8')),root=await temporary(t);
  const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
  const mavenHome=process.env.ROCKETBRAIN_MAVEN_HOME||path.resolve(path.dirname(config),
    '../research/implementation/runtimes/v0.18-maven-cache/extracted/apache-maven-3.9.11');
  const gradleBootstrap=(await fs.readdir(path.join(gradleHome,'lib'))).find(name=>/^gradle-launcher-[\d.]+\.jar$/.test(name));
  const mavenBootstrap=(await fs.readdir(path.join(mavenHome,'boot'))).find(name=>/^plexus-classworlds-[\d.]+\.jar$/.test(name));
  assert.ok(gradleBootstrap&&mavenBootstrap);
  const maven=path.join(root,'maven'),gradle=path.join(root,'gradle'),gradleUserHome=path.join(root,'gradle-home');
  const mavenMain=path.join(maven,'src/main/java'),gradleTest=path.join(gradle,'src/test/java');
  for(const dir of [mavenMain,gradleTest,path.join(gradle,'src/main/java')])await fs.mkdir(dir,{recursive:true});
  const pom=path.join(maven,'pom.xml'),build=path.join(gradle,'build.gradle');
  await fs.writeFile(pom,'<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>'+
    '<groupId>fixture</groupId><artifactId>templates</artifactId><version>1</version><properties>'+
    '<maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>'+
    '<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>'+
    '<version>3.14.1</version></plugin><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId>'+
    '<version>3.3.1</version></plugin></plugins></build></project>');
  await fs.writeFile(path.join(gradle,'settings.gradle'),"rootProject.name = 'template-profiles-fixture'\n");
  await fs.writeFile(build,"plugins { id 'java' }\njava { toolchain { languageVersion = JavaLanguageVersion.of(25) } }\n"+
    "tasks.withType(JavaCompile).configureEach { options.encoding = 'UTF-8' }\n");
  const generated=await Promise.all([['maven','main',maven,mavenMain,'MavenProfile'],['gradle','test',gradle,gradleTest,'GradleProfile']]
    .map(async ([tool,kind,project,sourceRoot,name])=>({
      tool,kind,name,sourceRoot,...await writeTemplateFile({workspaceRoot:project,sourceRoot,name,packageName:'fixture.generators',
        template:template(tool,kind),copyrightProfile:profile(tool,kind),variables:{label:marker},assertTrusted(){}})
    })));
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}],{gradleHome,gradleJavaHome:javaHome});
  const launch=resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')});
  launch.options.env={...process.env,GRADLE_USER_HOME:gradleUserHome};
  const options=cwd=>({cwd,timeout:75000,windowsHide:true,maxBuffer:1024*1024,
    env:{...process.env,JAVA_HOME:javaHome,GRADLE_USER_HOME:gradleUserHome}});
  const gradleCli=['-Dorg.gradle.java.home='+javaHome,'-cp',path.join(gradleHome,'lib',gradleBootstrap),'org.gradle.launcher.GradleMain'];
  const mavenCli=['-Dfile.encoding=UTF-8','-Dmaven.home='+mavenHome,'-Dclassworlds.conf='+path.join(mavenHome,'bin/m2.conf'),
    '-Dmaven.multiModuleProjectDirectory='+maven,'-cp',path.join(mavenHome,'boot',mavenBootstrap),'org.codehaus.plexus.classworlds.launcher.Launcher'];
  const stopGradle=()=>run(java,[...gradleCli,'--stop'],{...options(gradle),timeout:15000});
  const lsp=new StdioLsp(launch);
  const folders=[maven,gradle].map(file=>({uri:uri(file).toString(),name:path.basename(file)}));
  let observed;
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri:uri(root).toString(),rootPath:root,workspaceFolders:folders,
      capabilities:{workspace:{configuration:true,workspaceFolders:true},textDocument:{documentSymbol:{hierarchicalDocumentSymbolSupport:true}}},
      initializationOptions:{workspaceFolders:folders.map(item=>item.uri),settings}},100000);
    lsp.notify('initialized',{});lsp.notify('workspace/didChangeConfiguration',{settings});
    for(const product of generated)lsp.notify('textDocument/didOpen',{textDocument:{uri:uri(product.path).toString(),
      languageId:'java',version:1,text:await fs.readFile(product.path,'utf8')}});
    const request=(command,args)=>lsp.request('workspace/executeCommand',{command,arguments:args},35000);
    observed=await until(async()=>{
      const roots=await request('java.project.getAll',[]);
      const known=roots?.map(String)||[];
      if(!folders.every(folder=>known.some(value=>value.toLowerCase().includes('/'+folder.name))))return;
      const proof=await collectProjects({request,folders:[root]});
      if(proof.projects.some(p=>p.tool==='maven'&&p.sourceRoots.length)&&proof.projects.some(p=>p.tool==='gradle'&&p.sourceRoots.length))return proof.projects;
    },100000);
    const selected=await sourceRoots({workspace:{workspaceFolders:[{uri:uri(root),name:'fixture'}],findFiles:async()=>[uri(pom),uri(build)]}},
      {workbench:{getSnapshot:()=>({projects:observed})}});
    for(const product of generated) {
      const model=selected.find(entry=>!path.relative(entry.path,product.sourceRoot));
      assert.equal(model?.tool,product.tool);
      assert.equal(model?.source,product.kind);
      const symbols=await lsp.request('textDocument/documentSymbol',{textDocument:{uri:uri(product.path).toString()}},30000);
      assert.match(JSON.stringify(symbols),new RegExp(product.name));
    }
    const result=await lsp.request('java/buildWorkspace',true,90000);
    assert.equal(result,1);
  }finally{try{await lsp.close();}finally{await stopGradle();}}
  const scenarios=[
    {binary:path.join(maven,'target/classes'),output:(await run(java,[...mavenCli,'-B','-o','-ntp','compile'],options(maven))).stdout},
    {binary:path.join(gradle,'build/classes/java/test'),
      output:(await run(java,[...gradleCli,'--offline','--no-daemon','--console=plain','compileTestJava'],options(gradle))).stdout}
  ];
  for(const scenario of scenarios)assert.match(scenario.output,/BUILD SUCCESS/i);
  const results=await Promise.all(generated.map(async (item,index)=>{
    const actual=(await run(java,['-Dstdout.encoding=UTF-8','-cp',scenarios[index].binary,'fixture.generators.'+item.name],options(root))).stdout;
    assert.equal(actual,marker+':7');
    return {tool:item.tool,source:item.kind,profile:profile(item.tool,item.kind).name,output:actual};
  }));
  if(process.env.ROCKETBRAIN_TEMPLATE_PROFILE_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_TEMPLATE_PROFILE_RECEIPT,
    JSON.stringify({jdk:'Temurin 25.0.5+8',jdt:'1.63.0',importedSources:results,jdtBuild:true,mavenCompile:true,gradleCompileTestJava:true},null,2)+'\n');
});
