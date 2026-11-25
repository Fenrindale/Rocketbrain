'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL,fileURLToPath} = require('node:url');
const {test} = require('node:test');
const {classVersion,javaFeature,reviewModuleRuntimes} = require('../src/java/module-runtimes');
const {createRuntimeReview} = require('../src/java/module-runtimes-vscode');
const {resolveLaunch,serverSettings} = require('../src/java/runtime');
const {execute} = require('../src/java/testing/provision');
const {StdioLsp,until} = require('./helpers/stdio-lsp');
const {matrix,tool,readRuntimeMatrix,prepareGradleMatrix,runGradleMatrix,prepareEclipseMatrix} = require('./helpers/java-runtime-matrix-fixture');
const {springJdbcClasspath} = require('./helpers/instance-inline-fixture');

const manifest=process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_CONFIG;
const label=major=>major===8?'JavaSE-1.8':'JavaSE-'+major;
const candidates=config=>config.jdks.map(item=>({home:item.home,label:label(item.major)}));
const springClasspath=process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_SPRING_CP;
const dbFiles=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_JAVA_RUNTIME_MATRIX_'+engine.toUpperCase()+'_CONFIG']]);

async function owned(t,temporary=os.tmpdir()) {
  assert.ok(path.isAbsolute(temporary));
  const parent=await fs.realpath(temporary),root=await fs.mkdtemp(path.join(parent,'rb-java-runtime-matrix-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  return root;
}

test('classfile version review recognizes JVM target and exact preview semantics',()=>{
  assert.equal(javaFeature('1.8.0_512'),8);
  assert.equal(javaFeature('21.0.13.1'),21);
  assert.equal(javaFeature('17-ea'),17);
  assert.equal(javaFeature('Java 25'),null);
  assert.deepEqual(classVersion(Buffer.from('cafebabe00000034','hex')),{major:52,minor:0,release:8,preview:false});
  assert.deepEqual(classVersion(Buffer.from('cafebabeffff0041','hex')),{major:65,minor:65535,release:21,preview:true});
  assert.throws(()=>classVersion(Buffer.from('cafebabe00010041','hex')),/invalid classfile version/u);
  assert.throws(()=>classVersion(Buffer.from('00000000','hex')),/invalid classfile header/u);
  const current=path.resolve('.');
  for(const name of ['JavaSE-8','JavaSE-1.8'])assert.equal(serverSettings([{name,path:current}]).java.configuration.runtimes[0].name,'JavaSE-1.8');
});

test('Gradle toolchains compile and launch an actual interdependent Java 8, 17, 21, 25 and preview matrix',{
  skip:!manifest,timeout:220000
},async t=>{
  const config=await readRuntimeMatrix(manifest),root=await owned(t,process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_GRADLE_TEMP),modules=await prepareGradleMatrix(root,config);
  const output=await runGradleMatrix(root,config,modules);
  const runtimes=candidates(config),claims=[];
  for (const module of modules) {
    const measured=await reviewModuleRuntimes({root:module.root,outputPaths:[module.output],candidates:runtimes,
      settings:{target:module.major,source:module.major,preview:module.preview?'enabled':'disabled'}});
    assert.equal(measured.output.minimum,module.major);
    assert.ok(measured.output.classFiles>=1);
    assert.deepEqual(measured.output.previews,module.preview?[21]:[]);
    assert.deepEqual(output[module.name],{language:module.major===8?'1.8':String(module.major),value:module.preview?'template':'legacy',compiler:module.major});
    for(const item of measured.candidates){
      const expected=module.preview?(item.major===21?'preview-required':'preview-version-mismatch'):
        (item.major>=module.major?'compatible':'below-classfile-target');
      assert.equal(item.state,expected);
    }
    assert.equal(measured.candidates.find(item=>item.home===measured.recommended).major,module.major);
    claims.push({module:module.name,minimum:measured.output.minimum,classes:measured.output.classFiles,
      preview:measured.output.previews,executed:output[module.name]});
  }
  const preview=modules.find(item=>item.preview),jdk=major=>config.jdks.find(item=>item.major===major).home;
  for (const [major,flags] of [[21,[]],[25,['--enable-preview']]]) {
    const failed=await execute(tool(jdk(major),'java'),[...flags,'-cp',preview.output,preview.main],{timeoutMs:15000});
    assert.notEqual(failed.code,0);
    assert.match(failed.output,/UnsupportedClassVersionError/u);
  }
  const modern=modules.find(item=>item.major===25);
  const wrong=await reviewModuleRuntimes({root:modern.root,outputPaths:[modern.output],candidates:[{home:jdk(25),label:'JavaSE-17'}],settings:{target:'17'}});
  assert.equal(wrong.candidates[0].state,'version-label-mismatch');
  assert.equal(wrong.recommended,null);
  assert.match(wrong.warnings[0],/target Java 25.*target is Java 17/u);
  const project={root:preview.root,uri:pathToFileURL(preview.root).href,name:preview.name,jdk:jdk(25)};
  const archives=Array.from({length:132},(_,index)=>path.join(preview.root,'library-'+index+'.jar'));
  await Promise.all(archives.map(archive=>fs.writeFile(archive,'')));
  const externalOutput=modern.output;
  const saved={id:'runtime-preview',projectUri:project.uri,mainClass:preview.main,projectName:project.name,
    name:'Owned preview run',args:['existing'],vmArgs:['-ea']};
  const controller=createRuntimeReview({}, {trusted(){},java:{getState:()=>({javaHome:jdk(25),runtimeIdentity:'owned'})},
    ensureProject:async()=>project,request:async command=>command==='java.project.getSettings'?{}:
      {classpaths:[preview.output,...archives],modulepaths:[externalOutput]},
    config:()=>({get:()=>runtimes.map(item=>({path:item.home,name:item.label}))}),getConfiguration:()=>saved,
    save:async (replacement,verify)=>{await verify();return replacement;}});
  const inspected=await controller.inspect({projectUri:project.uri});
  assert.deepEqual(inspected.output.roots,[path.relative(preview.root,preview.output)]);
  assert.equal(inspected.output.minimum,21);
  const select=enablePreview=>controller.apply(inspected,{configurationId:saved.id,home:jdk(21),enablePreview});
  await assert.rejects(select(false),/Explicitly enable preview/u);
  assert.deepEqual((await select(true)).vmArgs,['-ea','--enable-preview']);
  assert.deepEqual((await select(true)).args,['existing']);
  const classfile=path.join(preview.output,...preview.main.split('.'))+'.class';
  await fs.copyFile(classfile,path.join(preview.output,'NewOutput.class'));
  await assert.rejects(select(true),/classfile requirements.*changed/u);
  if (process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_RECEIPT,
    JSON.stringify({gradle:'9.1.0',runtimes:config.jdks.map(item=>({major:item.major,release:item.release})),modules:claims,
      realPreviewWithoutFlagRefused:true,realPreviewWrongJdkRefused:true,declarationMismatch:true,staleLaunchChoiceRefused:true})+'\n');
});

test('the pinned JDT language server imports modules with independent Java 8, 17, 21 and 25 environments',{
  skip:!manifest,timeout:155000
},async t=>{
  const config=await readRuntimeMatrix(manifest),root=await owned(t),javaHome=config.jdks.find(item=>item.major===25).home;
  const project=path.join(root,'workspace');await fs.mkdir(project);
  const modules=await prepareEclipseMatrix(project,matrix.filter(item=>!item.preview),config),rootUri=pathToFileURL(project).href;
  const folders=modules.map(module=>({uri:pathToFileURL(module.root).href,name:module.name}));
  const launch=resolveLaunch({javaHome,serverPath:config.serverPath,storagePath:path.join(root,'jdt')});
  const lsp=new StdioLsp(launch);
  const settings=serverSettings(candidates(config).map(item=>({name:item.label,path:item.home,default:item.label==='JavaSE-25'})));
  const request=(command,...args)=>lsp.request('workspace/executeCommand',{command,arguments:args});
  try {
    await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,workspaceFolders:folders,
      capabilities:{workspace:{configuration:true,workspaceFolders:true}},initializationOptions:{workspaceFolders:folders.map(item=>item.uri),settings}},55000);
    lsp.notify('initialized',{});lsp.notify('workspace/didChangeConfiguration',{settings});
    let projects;
    await until(async()=>{
      projects=await request('java.project.getAll');
      return Array.isArray(projects)&&modules.every(module=>projects.some(uri=>!path.relative(fileURLToPath(uri),module.root)));
    },65000).catch(error=>{throw Error(error.message+' Observed projects '+JSON.stringify(projects));});
    for(const module of modules){
      const uri=pathToFileURL(module.root).href,keys=['org.eclipse.jdt.ls.core.vm.location','org.eclipse.jdt.core.compiler.codegen.targetPlatform'];
      const observed=await request('java.project.getSettings',uri,keys);
      assert.equal(javaFeature(observed[keys[1]]),module.major,JSON.stringify(observed));
      assert.ok(observed[keys[0]],JSON.stringify(observed));
      assert.equal(await fs.realpath(observed[keys[0]]),await fs.realpath(config.jdks.find(item=>item.major===module.major).home));
      const classpath=await request('java.project.getClasspaths',uri,{scope:'runtime'});
      assert.ok(classpath.classpaths.some(value=>!path.relative(value,module.output)),JSON.stringify(classpath));
    }
  } finally {await lsp.close();}
});

test('one Java 17 Spring JDBC classfile runs unchanged on approved Java 17, 21 and 25 with both owned engines',{
  skip:!manifest||!springClasspath||!dbFiles.every(([,file])=>file),timeout:120000
},async t=>{
  const config=await readRuntimeMatrix(manifest),root=await owned(t),output=path.join(root,'classes');
  const source=path.join(root,'SpringRuntimeProbe.java');await fs.mkdir(output);
  await fs.writeFile(source,[
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'class SpringRuntimeProbe { public static void main(String[] args) {',
    '  var source = new DriverManagerDataSource(System.getenv("RB_RUNTIME_JDBC_URL"),',
    '      System.getenv("RB_RUNTIME_JDBC_USER"), System.getenv("RB_RUNTIME_JDBC_PASSWORD"));',
    '  var jdbc = new JdbcTemplate(source);',
    '  System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + Runtime.version().feature() +',
    '      "|" + jdbc.queryForObject("SELECT 42", Integer.class));',
    '} }',''
  ].join('\n'),{flag:'wx'});
  const libraries=await springJdbcClasspath(springClasspath,'mysql'),java17=config.jdks.find(item=>item.major===17);
  const compile=await execute(tool(java17.home,'javac'),['--release','17','-proc:none','-cp',libraries.join(path.delimiter),'-d',output,source],{timeoutMs:30000});
  assert.equal(compile.code,0,compile.output);
  const review=await reviewModuleRuntimes({root,outputPaths:[output],candidates:candidates(config),settings:{target:'17'}});
  assert.equal(review.output.minimum,17);
  assert.equal(review.candidates.find(item=>item.major===8)?.state,'below-classfile-target');
  const results=[];
  for(const [engine,file] of dbFiles){
    const server=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(server.host,'127.0.0.1');
    assert.ok(Number.isInteger(server.port)&&server.port>0&&server.port<65536);
    assert.match(server.database,/^[a-z_]+$/u);
    const cp=[output,...await springJdbcClasspath(springClasspath,engine)];
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^(_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/iu.test(key)));
    Object.assign(env,{RB_RUNTIME_JDBC_URL:'jdbc:'+engine+'://127.0.0.1:'+server.port+'/'+server.database+
      (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),RB_RUNTIME_JDBC_USER:server.user,RB_RUNTIME_JDBC_PASSWORD:server.password});
    for(const runtime of review.candidates.filter(item=>item.state==='compatible')){
      const run=await execute(tool(runtime.home,'java'),['-cp',cp.join(path.delimiter),'SpringRuntimeProbe'],{env,timeoutMs:20000});
      assert.equal(run.code,0,run.output);
      const [version,java,value]=run.output.split('|');
      assert.match(version,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
      assert.equal(Number(java),runtime.major);assert.equal(Number(value),42);
      results.push({engine,version,java:Number(java),readback:Number(value)});
    }
  }
  assert.equal(results.length,6);
  if(process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_SPRING_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_SPRING_RECEIPT,
    JSON.stringify({springJdbc:'7.0.10',compiledOn:17,minimum:review.output.minimum,olderJdkRejected:true,results})+'\n');
});
