'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {until} = require('./helpers/stdio-lsp');
const {importedSpring,jdbcReadback} = require('./java-source-analysis-host');
const {matrix,readRuntimeMatrix,prepareEclipseMatrix} = require('./helpers/java-runtime-matrix-fixture');

async function runJavaRuntimeMatrixChecks(api,vscode,checks) {
  const workspace=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath),java=api.java,workbench=java.workbench;
  const manifest=await readRuntimeMatrix(process.env.ROCKETBRAIN_JAVA_RUNTIME_MATRIX_CONFIG);
  const configuration=()=>vscode.workspace.getConfiguration('rocketbrain.java',vscode.Uri.file(workspace));
  const previous=configuration().inspect('projectJdks')?.workspaceValue;
  const configured=manifest.jdks.map(item=>({name:item.major===8?'JavaSE-1.8':'JavaSE-'+item.major,path:item.home,default:item.major===25}));
  const root=await fs.mkdtemp(path.join(workspace,'rb-jvm-matrix-'));
  const samePath=(left,right)=>typeof left==='string'&&!path.relative(left,right);
  let modules=[],saved,run,changedSettings=false;
  try {
    for(const id of ['reviewRuntimes','changeRuntime'])assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.workbench.'+id));
    const before=java.getState().runtimeIdentity;
    if(JSON.stringify(configuration().get('projectJdks'))!==JSON.stringify(configured)) {
      await configuration().update('projectJdks',configured,vscode.ConfigurationTarget.Workspace);
      changedSettings=true;
      await until(()=>{
        const state=java.getState();return state.state==='running'&&state.runtimeIdentity&&state.runtimeIdentity!==before;
      },95000);
    }
    const spring=await importedSpring(api,workspace);
    const springReview=await workbench.reviewModuleRuntimes({projectUri:spring.uri});
    assert.equal(springReview.output.minimum,25);
    assert.equal(springReview.candidates.find(item=>item.major===21)?.state,'below-classfile-target');
    assert.equal(springReview.candidates.find(item=>item.major===25)?.state,'compatible');

    modules=await prepareEclipseMatrix(root,matrix.filter(item=>item.major===8||item.name==='service21'),manifest);
    for(const module of modules)await workbench.resyncProject({projectUri:pathToFileURL(module.root).href,allowProjectExecution:true});
    const observed=await until(async()=>{
      const result=await workbench.refresh();
      return modules.every(module=>result.projects.some(project=>samePath(project.root,module.root)))?result:false;
    },95000);
    const legacy=observed.projects.find(project=>samePath(project.root,modules[0].root));
    const modern=observed.projects.find(project=>samePath(project.root,modules[1].root));
    const legacyReview=await workbench.reviewModuleRuntimes({projectUri:legacy.uri});
    const modernReview=await workbench.reviewModuleRuntimes({projectUri:modern.uri});
    assert.equal(legacyReview.target,8);
    assert.equal(legacyReview.output.minimum,8);
    assert.equal(modernReview.target,21);
    assert.equal(modernReview.output.minimum,21);
    const chosen=modernReview.candidates.find(item=>item.major===21),older=modernReview.candidates.find(item=>item.major===17);
    assert.equal(chosen.state,'compatible'); assert.equal(older.state,'below-classfile-target');
    const entry=await until(async()=>(await workbench.mainClasses({projectUri:modern.uri})).find(item=>item.mainClass===modules[1].main),50000);
    const marker=path.join(root,'native-jdk.txt');
    saved=await workbench.saveRunConfiguration({projectUri:modern.uri,name:'Owned Java Runtime Matrix',
      mainClass:entry.mainClass,projectName:entry.projectName,javaHome:manifest.jdks[3].home,args:[marker],env:{RB_MATRIX_OWNED:'yes'}});
    const update=(review,home)=>workbench.applyRuntimeChoice(review,{configurationId:saved.id,home});
    await assert.rejects(update(modernReview,older.home),/marked usable/u);
    await assert.rejects(update({...modernReview},chosen.home),/marked usable/u);
    const replacement=await update(modernReview,chosen.home);
    assert.equal(replacement.id,saved.id);
    assert.equal(samePath(replacement.javaHome,chosen.home),true);
    assert.deepEqual(replacement.args,saved.args);
    assert.deepEqual(replacement.environmentKeys,saved.environmentKeys);
    run=await workbench.start({configurationId:replacement.id,debug:false});
    const markerText=await until(async()=>fs.readFile(marker,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;}),40000);
    assert.equal(markerText,'RB_MATRIX:service21:21:standalone:yes');
    const jdbc=await jdbcReadback();assert.ok(jdbc);
    checks.push('Native Java Projects compared actual Java 8, 21 and Spring Java 25 class outputs against four independently measured JVMs.');
    checks.push('Changing a saved launch kept its arguments and private environment, refused Java 17, and launched the module on the selected Java 21 JVM.');
    return {jvmVersions:modernReview.candidates.map(item=>item.version).filter(Boolean),java8Import:true,java21Import:true,
      spring25Classfiles:springReview.output.classFiles,liveNativeLaunch:markerText,tooOldRefused:true,forgedReviewRefused:true,
      savedEnvironmentPreserved:true,jdbc};
  } finally {
    if(run&&workbench.getSnapshot().runs.some(item=>item.runId===run.runId))await workbench.stop({runId:run.runId}).catch(()=>{});
    if(saved)await workbench.deleteRunConfiguration(saved.id);
    try {
      if(modules.length)await java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],modules.map(module=>pathToFileURL(module.root).href));
    } finally {
      if(changedSettings)await configuration().update('projectJdks',previous,vscode.ConfigurationTarget.Workspace);
      const real=await fs.realpath(root);
      assert.equal(real,root);assert.equal(path.dirname(root),workspace);
      await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:200});
    }
  }
}

module.exports={runJavaRuntimeMatrixChecks};
