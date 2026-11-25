'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {template,profile}=require('./helpers/template-profile-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

async function runJavaTemplateProfileChecks(api,vscode,checks) {
  const workspace=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const project=await importedSpring(api,workspace);
  assert.ok(['maven','gradle'].includes(project.tool));
  const tool=project.tool,other=tool==='maven'?'gradle':'maven';
  const sourceRoot=path.join(workspace,'src/main/java'),name='RbTemplateProfile'+randomBytes(5).toString('hex');
  const file=path.join(sourceRoot,'fixture/boot',name+'.java'),config=vscode.workspace.getConfiguration('rocketbrain.java',vscode.Uri.file(file));
  const target=vscode.ConfigurationTarget.Global,previous=[];
  const generator=template(tool,'main',{spring:true}),notice=profile(tool,'main'),foreign=profile(other,'main'),
    testOnly=template(tool,'test'),wrongTool=template(other,'main');
  let created,scratch;
  try {
    for(const [key,value] of [['fileTemplates',[generator,testOnly,wrongTool]],['copyrightProfiles',[notice,foreign]],
      ['defaultCopyrightProfile',notice.name]]) {
      previous.push([key,config.inspect(key)?.globalValue]);
      await config.update(key,value,target);
    }
    const fixture={sourceRoot,packageName:'fixture.boot',name,templateName:generator.name,
      variables:{method:'outputValue',label:'가나다 "quoted"',count:'012'}};
    await assert.rejects(api.javaUtilities.createFile({...fixture,templateName:testOnly.name}),/available template/);
    await assert.rejects(api.javaUtilities.createFile({...fixture,templateName:wrongTool.name}),/available template/);
    await assert.rejects(api.javaUtilities.createFile({...fixture,copyrightProfile:foreign.name}),/copyright profile available/);
    await assert.rejects(api.javaUtilities.createFile({...fixture,variables:{method:'package',label:'bad'}}),/valid Java identifier/);
    await assert.rejects(fs.stat(file),{code:'ENOENT'});
    created=await vscode.commands.executeCommand('rocketbrain.java.newFileFromTemplate',fixture);
    assert.equal(created.projectTool,tool);
    assert.equal(created.copyrightProfile,notice.name);
    assert.equal(path.relative(file,created.uri.fsPath),'');
    const document=await vscode.workspace.openTextDocument(created.uri);
    const source=document.getText().replace(/\r\n/g,'\n');
    assert.ok(source.startsWith('// Copyright '+new Date().getUTCFullYear()+' Fixture contributors\n// fixture.boot.'+name+' · '+tool));
    assert.match(source,/static String outputValue\(\) \{ return "가나다 \\"quoted\\"" \+ ":" \+ 12; \}/);
    await assert.rejects(api.javaUtilities.createFile(fixture),/already exists/);
    assert.equal(await fs.readFile(file,'utf8'),source);
    const build=await api.java.buildWorkspace();
    assert.ok(build===0||build===1||build?.status==='succeed','JDT build '+JSON.stringify(build));
    scratch=await api.javaUtilities.openScratch({name});
    const snippet=await vscode.workspace.openTextDocument(scratch.uri),edit=new vscode.WorkspaceEdit();
    edit.replace(scratch.uri,new vscode.Range(snippet.positionAt(0),snippet.positionAt(snippet.getText().length)),
      'fixture.boot.'+name+'.class.isAnnotationPresent(org.springframework.stereotype.Component.class);\n'+
      'System.out.println(fixture.boot.'+name+'.outputValue());\n');
    assert.equal(await vscode.workspace.applyEdit(edit),true);
    const response=await api.javaUtilities.runScratch({uri:scratch.uri,projectUri:project.uri});
    assert.equal(response.state,'finished',response.output);
    assert.match(response.output.replaceAll('\r',''),/^true\n가나다 "quoted":12\n/m);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Java template action applied the matching build-tool and source-root profile, rendered the typed variables, and opened the compiled Spring component.');
    checks.push('The new Java class ran on the real imported project classpath. Incompatible templates and profiles, invalid identifiers and duplicate files were refused.');
    return {springWorkspace:true,jdbc,buildTool:tool,profile:notice.name,typedVariables:3,compiledSpringComponent:true,
      output:'가나다 "quoted":12',sourceScopeChecked:true,toolScopeChecked:true,duplicateRefused:true};
  }finally{
    try {
      if(scratch) {
        const document=vscode.workspace.textDocuments.find(item=>item.uri.toString()===scratch.uri.toString());
        if(document?.isDirty)await document.save();
        await fs.rm(scratch.uri.fsPath,{force:true});
      }
      if(created)await fs.rm(file,{force:true});
    }finally{
      for(const [key,value] of previous.reverse())await config.update(key,value,target);
    }
  }
}

module.exports={runJavaTemplateProfileChecks};
