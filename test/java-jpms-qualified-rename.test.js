'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {test} = require('node:test');
const {uri} = require('./helpers/java-signature-jdt-host');
const {StdioLsp,until} = require('./helpers/stdio-lsp');
const {packageRenameHeadless} = require('./helpers/package-rename-headless');
const {resolveLaunch,serverSettings} = require('../src/java/runtime');
const {registerJavaMove} = require('../src/java/move');
const {registerJavaRefactoring} = require('../src/java/refactoring');
const {reviewClosedModule} = require('../src/java/package-module');
const {bindModuleDescriptor,verifyModuleProjection} = require('../src/java/package-rename-module');
const {
  provider,consumer,oldPackage,newPackage,sourceFolder,targetFolder,owner,independent,
  providerDescriptor,consumerDescriptor,caller,projects,output,sources,populate,compileModules,runSpring
} = require('./helpers/java-jpms-qualified-rename-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH;
const dbFiles = ['mysql','mariadb'].map(engine => [engine,process.env['ROCKETBRAIN_PACKAGE_RENAME_'+engine.toUpperCase()+'_CONFIG']]);

test('qualified descriptor binding preserves target names even when they share the package prefix', () => {
  const root = path.resolve('test-output','qualified-module-policy');
  const file = path.join(root,'src/main/java/module-info.java');
  const peer = 'scope.old.client';
  const input = 'module scope.owner { exports scope.old to scope.old.client; opens scope.old to scope.old.client; }';
  const parse = text => reviewClosedModule(root,[{file,uri:uri(file).toString(),text}],{
    allowVisibility:true,qualifiedPeer:peer
  });
  const old = parse(input);
  const spans = old.declarations.filter(entry => ['exports','opens'].includes(entry.role))
    .map(entry => ({start:entry.start,end:entry.end,role:'reference'}));
  const proof = bindModuleDescriptor({module:old,spans},old,'scope.old');
  const changed = input.replace('exports scope.old ','exports scope.next ').replace('opens scope.old ','opens scope.next ');
  verifyModuleProjection(proof,{module:parse(changed)},'scope.old','scope.next');
  assert.throws(() => parse(changed.replace('to scope.old.client','to another.client')),/reviewed peer/);
  assert.throws(() => parse(changed.replace('to scope.old.client','to scope.old.client, another.client')), /reviewed peer/);
});

test('stock JDT and Javac package rename preserves two qualified JPMS modules and both real Spring JDBC runs', {
  skip:!runtimeFile || !cpFile || !dbFiles.every(([,file]) => file),timeout:240000
},async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile,'utf8'));
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent,'rb-qual-jpms-'));
  const root = path.join(owned,'project'), rootUri = uri(root).toString();
  let lsp,refactoring,move;
  t.after(async () => {
    await move?.dispose();
    await refactoring?.dispose();
    await lsp?.close();
    assert.equal(path.dirname(await fs.realpath(owned)),parent);
    await fs.rm(owned,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  await populate(root);
  const compile = async (renamed,install=false) => {
    const classes = await fs.mkdtemp(path.join(owned,'classes-'));
    const module = await compileModules(root,classes,runtime.javaHome,{
      renamed,install,visibilityRoot:await fs.mkdtemp(path.join(owned,'visibility-'))
    });
    const spring = await Promise.all(dbFiles.map(async ([engine,configFile]) => runSpring({
      root:await fs.mkdtemp(path.join(owned,'spring-')),classes,javaHome:runtime.javaHome,cpFile,configFile,engine
    })));
    return {module,spring};
  };
  const before = await compile(false,true);
  lsp = new StdioLsp(resolveLaunch({...runtime,storagePath:path.join(owned,'jdt')}));
  const settings = serverSettings([{name:'JavaSE-25',path:runtime.javaHome,default:true}]);
  settings.java.autobuild.enabled=false;
  await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'qualified-named-modules'}],
    capabilities:{workspace:{configuration:true,workspaceFolders:true,applyEdit:false,
      workspaceEdit:{documentChanges:true,resourceOperations:['create','rename','delete']}}},
    initializationOptions:{bundles:[],workspaceFolders:[rootUri],settings}},90000);
  lsp.notify('initialized',{});
  lsp.notify('workspace/didChangeConfiguration',{settings});
  const {vscode,submitted} = packageRenameHeadless(root,lsp,sourceFolder,targetFolder,() => refactoring);
  const document = await vscode.workspace.openTextDocument(uri(path.join(root,owner)));
  for (const file of sources.keys()) await vscode.workspace.openTextDocument(uri(path.join(root,file)));
  const classpaths = target => lsp.request('workspace/executeCommand',{command:'java.project.getClasspaths',
    arguments:[target,{scope:'test'}]},25000);
  await until(async () => {
    const consumerPath=await classpaths(uri(path.join(root,caller)).toString());
    return consumerPath?.modulepaths?.length===2 &&
      projects.every(([folder])=>consumerPath.modulepaths.some(file => path.relative(path.join(root,folder,output),file)===''));
  },90000);
  refactoring = registerJavaRefactoring({},vscode);
  let trimConsumer = false;
  move = registerJavaMove({},vscode,{
    refactoring,
    async request(method,params) {
      const result = await lsp.request(method,params,30000);
      if (trimConsumer && method==='workspace/willRenameFiles') {
        return {...result,documentChanges:result.documentChanges.filter(change => !change.textDocument?.uri.endsWith('/Probe.java'))};
      }
      return result;
    },
    runtime:() => ({javaHome:runtime.javaHome,storagePath:path.join(owned,'compiler')})
  });
  trimConsumer=true;
  await assert.rejects(move.prepareRenamePackage(document,'settlement'),/differ from the exact Javac package references/);
  trimConsumer=false;
  const plan = await move.prepareRenamePackage(document,'settlement');
  assert.deepEqual(plan.packageRename.qualifiedNamedModules,{provider,consumer,consumerFiles:1,targets:[
    {role:'exports',packageName:oldPackage,target:consumer},{role:'opens',packageName:oldPackage,target:consumer}
  ]});
  assert.equal(plan.packageRename.engineModuleDirectives,2);
  assert.equal(plan.resourceOperations.length,1);
  const descriptor=path.join(root,providerDescriptor);
  const descriptorText=sources.get(providerDescriptor);
  await assert.rejects(fs.stat(path.join(root,targetFolder)),{code:'ENOENT'});
  await fs.writeFile(descriptor,descriptorText.replace('to '+consumer,'to fixture.outsider'));
  await assert.rejects(refactoring.apply(plan.id),/reviewed|changed after review/);
  assert.equal(submitted.length,0);
  await fs.writeFile(descriptor,descriptorText);
  assert.equal((await refactoring.apply(plan.id)).state,'applied');
  assert.equal(submitted.length,1);
  await assert.rejects(refactoring.apply(plan.id),/expired/);
  assert.equal(await fs.readFile(descriptor,'utf8'),descriptorText.replaceAll(oldPackage+' to',newPackage+' to'));
  assert.equal(await fs.readFile(path.join(root,consumerDescriptor),'utf8'),sources.get(consumerDescriptor));
  assert.equal(await fs.readFile(path.join(root,independent),'utf8'),sources.get(independent));
  assert.equal(await fs.readFile(path.join(root,caller),'utf8'),sources.get(caller).replace(oldPackage,newPackage));
  const after = await compile(true);
  assert.deepEqual(before,after);
  const receipt = process.env.ROCKETBRAIN_JPMS_QUALIFIED_RENAME_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({...plan.packageRename,...after,
    missingConsumerEditRefused:true,changedTargetRefused:true,unrelatedPackagePreserved:true,
    oneWorkspaceEdit:true,replayRefused:true},null,2)+'\n',{flag:'wx'});
});
