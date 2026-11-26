'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {until} = require('./helpers/stdio-lsp');
const {
  provider,consumer,sourceFolder,targetFolder,owner,caller,projects,output,providerDescriptor,sources,
  populate,compileModules,runSpring
} = require('./helpers/java-jpms-qualified-rename-fixture');

async function runJavaJpmsQualifiedRenameChecks(api,vscode,checks) {
  const workspace = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const spring = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const cpFile = process.env.ROCKETBRAIN_PACKAGE_RENAME_CLASSPATH || path.join(spring.projectPath,'build/runtime-classpath.txt');
  const parent = await fs.realpath(os.tmpdir());
  const compiler = await fs.mkdtemp(path.join(parent,'rb-qual-jpms-native-'));
  const root = await fs.mkdtemp(path.join(workspace,'rb-qual-jpms-work-'));
  const old = path.join(root,sourceFolder), next = path.join(root,targetFolder);
  const files = projects.map(([folder])=>path.join(root,folder,'.project'));
  const imported = projects.map(([folder])=>vscode.Uri.file(path.join(root,folder)).toString());
  const open = file => vscode.workspace.openTextDocument(vscode.Uri.file(file));
  const show = async file => vscode.window.showTextDocument(await open(file),{preview:false,preserveFocus:false});
  const normalized = text => text.replace(/\r\n/g,'\n');
  const exists = file => fs.stat(file).then(() => true,error => {
    if (error.code==='ENOENT') return false;
    throw error;
  });
  const inside = (base,file) => {
    const rel = path.relative(base,file);
    return rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
  };
  let plan,requestedImport=false;
  try {
    await populate(root,{projectPrefix:'rbq'+randomBytes(4).toString('hex')});
    await api.java.start();
    const javaHome = api.java.getState().javaHome;
    const execute = async (renamed,install=false) => {
      const classes = await fs.mkdtemp(path.join(compiler,'classes-'));
      const module = await compileModules(root,classes,javaHome,
        {renamed,install,visibilityRoot:await fs.mkdtemp(path.join(compiler,'visibility-'))});
      const runtime = await runSpring({
        root:await fs.mkdtemp(path.join(compiler,'spring-')),classes,javaHome,
        cpFile,configFile:spring.dbConfigPath,engine:spring.dbEngine
      });
      return {module,runtime};
    };
    const before = await execute(false,true);
    requestedImport = true;
    await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',
      files.map(file=>vscode.Uri.file(file).toString()),[],[]);
    const document = (await show(path.join(root,owner))).document;
    for (const file of sources.keys()) await open(path.join(root,file));
    await until(async()=>{
      const model=await api.java.executeWorkspaceCommand('java.project.getClasspaths',
        vscode.Uri.file(path.join(root,caller)).toString(),{scope:'test'});
      return model?.modulepaths?.length===2 && projects.every(([folder])=>
        model.modulepaths.some(file=>path.relative(path.join(root,folder,output),file)===''));
    },100000);
    const result = await api.java.buildWorkspace();
    assert.ok(result===0 || result===1 || result?.status==='succeed','JDT build result '+JSON.stringify(result));
    plan = await api.java.move.prepareRenamePackage(document,'settlement');
    assert.equal(plan.packageRename.qualifiedNamedModules.provider,provider);
    assert.equal(plan.packageRename.qualifiedNamedModules.consumer,consumer);
    assert.equal(plan.packageRename.qualifiedNamedModules.consumerFiles,1);
    assert.equal(plan.packageRename.engineModuleDirectives,2);
    assert.equal(plan.resourceOperations.length,1);
    const index = plan.documents.findIndex(file =>
      !path.relative(path.join(root,providerDescriptor),vscode.Uri.parse(file.uri).fsPath));
    assert.ok(index>=0);
    const diff = await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/'+index+'/after.java'));
    assert.equal(normalized(diff.getText()),normalized(plan.documents[index].after));
    function destination(file,after) {
      const item = vscode.Uri.parse(file.uri).fsPath;
      return after && inside(old,item) ? path.join(next,path.relative(old,item)) : item;
    }
    async function verify(after) {
      await until(async()=>await exists(old)===!after && await exists(next)===after,10000);
      for (const file of plan.documents) {
        assert.equal(normalized((await open(destination(file,after))).getText()),normalized(after ? file.after : file.before));
      }
    }
    assert.equal((await api.java.refactoring.apply(plan.id)).state,'applied');
    await verify(true);
    for (const [command,after] of [['undo',false],['redo',true]]) {
      await show(path.join(root,caller));
      await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
      await vscode.commands.executeCommand(command);
      await verify(after);
    }
    for (const file of plan.documents) assert.equal(await (await open(destination(file,true))).save(),true);
    const after = await execute(true);
    assert.deepEqual(before,after);
    checks.push('Qualified JPMS package rename preserves the exact exports/opens peer and updates the actual consumer. Undo and Redo cover both modules.');
    checks.push('The rebuilt named consumer accesses the public API and private field. An unlisted module remains denied, and real Spring JDBC agrees before and after.');
    return {...plan.packageRename,...after,nativeUndo:true,nativeRedo:true,descriptorPreview:true};
  } finally {
    try {
      for (const document of vscode.workspace.textDocuments.filter(doc=>doc.uri.scheme==='file' && inside(root,doc.uri.fsPath))) {
        if (!document.isDirty) continue;
        await vscode.window.showTextDocument(document,{preview:false});
        await vscode.commands.executeCommand('workbench.action.files.revert');
      }
      const tabs = vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>{
        const resource = tab.input?.uri;
        return resource?.scheme==='file' && inside(root,resource.fsPath) ||
          plan && resource?.scheme==='rocketbrain-java-refactor' && resource.path.startsWith('/'+plan.id+'/');
      });
      if (tabs.length) await vscode.window.tabGroups.close(tabs);
      if (requestedImport) await api.java.executeWorkspaceCommand('java.project.changeImportedProjects',[],[],imported);
    } finally {
      for (const [folder,boundary,prefix] of [[root,workspace,'rb-qual-jpms-work-'],[compiler,parent,'rb-qual-jpms-native-']]) {
        const physical = await fs.realpath(folder);
        assert.equal(path.relative(boundary,path.dirname(physical)),'');
        assert.ok(path.basename(physical).startsWith(prefix));
        await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
      }
    }
  }
}
module.exports = {runJavaJpmsQualifiedRenameChecks};
