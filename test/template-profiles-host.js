'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {fileURLToPath,pathToFileURL}=require('node:url');
const {template,profile}=require('./helpers/template-profile-fixture');
const {importedSpring,jdbcReadback}=require('./java-source-analysis-host');

const run=promisify(execFile);
async function runCompiledTemplate(api,project,name){
  assert.match(name,/^RbTemplateProfile[a-f0-9]{10}$/u);
  const observed=await api.java.requestWorkspaceCommand('java.project.getClasspaths',[project.uri,{scope:'runtime'}]);
  assert.ok(Array.isArray(observed.classpaths)&&observed.classpaths.length>1&&observed.classpaths.length<=2000);
  assert.deepEqual(observed.modulepaths,[]);
  const classpaths=observed.classpaths.map(value=>{
    assert.equal(typeof value,'string');
    const file=value.startsWith('file:')?fileURLToPath(value):value;
    assert.ok(path.isAbsolute(file)&&!file.startsWith('\\')&&!/[\x00-\x1f]/u.test(file));
    return file;
  });
  const directoryFlags=await Promise.all(classpaths.map(async entry=>{
    try{return (await fs.stat(entry)).isDirectory();}catch(error){
      if(error.code!=='ENOENT')throw error;
      return false;
    }
  }));
  const candidates=await Promise.all(classpaths.map(async (directory,index)=>{
    if(!directoryFlags[index])return null;
    try{return await fs.realpath(path.join(directory,'fixture','boot',name+'.class'));}catch(error){
      if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;
      return null;
    }
  }));
  const compiled=[...new Set(candidates.filter(Boolean))];
  assert.equal(compiled.length,1,'The observed JDT classpath must contain exactly one generated class.');
  const relative=path.relative(project.root,compiled[0]);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));
  assert.equal((await fs.readFile(compiled[0])).subarray(0,4).toString('hex'),'cafebabe');

  const runtime=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,'utf8'));
  const release=await fs.readFile(path.join(runtime.javaHome,'release'),'utf8');
  assert.match(release,/JAVA_VERSION="25\./u);
  assert.doesNotMatch(release,/JetBrains|JBR/iu);
  const tool=name=>path.join(runtime.javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  const sandbox=await fs.mkdtemp(path.join(project.root,'.rb-template-probe-'));
  const files=['RbTemplateProbe.java','java.args','classpath.mf','classpath.jar'];
  const [source,argumentsFile,manifest]=files.map(file=>path.join(sandbox,file));
  try{
    await fs.writeFile(source,'public class RbTemplateProbe { public static void main(String[] args) {\n'+
      'System.out.println(fixture.boot.'+name+'.class.isAnnotationPresent(org.springframework.stereotype.Component.class));\n'+
      'System.out.println(fixture.boot.'+name+'.outputValue());\n}}\n',{flag:'wx'});
    // Local file URLs preserve the observed JDT order and keep native Windows argfiles ASCII.
    const urls=classpaths.map((entry,index)=>pathToFileURL(directoryFlags[index]?entry+path.sep:entry).href);
    const value='Class-Path: '+urls.join(' ');
    assert.ok(value.length<=512*1024&&/^[\x20-\x7e]+$/u.test(value));
    const lines=['Manifest-Version: 1.0',value.slice(0,70)];
    for(let offset=70;offset<value.length;offset+=69)lines.push(' '+value.slice(offset,offset+69));
    await fs.writeFile(manifest,lines.join('\r\n')+'\r\n\r\n',{flag:'wx'});
    const options={cwd:sandbox,encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:1024*1024};
    await run(tool('jar'),['--create','--file','classpath.jar','--manifest','classpath.mf'],options);
    const args=['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-cp','classpath.jar','RbTemplateProbe.java'];
    await fs.writeFile(argumentsFile,args.join('\n')+'\n',{flag:'wx'});
    const {stdout}=await run(tool('java'),['@java.args'],options);
    assert.equal(stdout.replaceAll('\r',''),'true\n가나다 "quoted":12\n');
    return classpaths.length;
  }finally{
    for(const file of files)await fs.rm(path.join(sandbox,file),{force:true});
    await fs.rmdir(sandbox);
  }
}

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
  let created;
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
    const jdtClasspathEntries=await runCompiledTemplate(api,project,name);
    const jdbc=await jdbcReadback();
    assert.ok(jdbc,'Run with the owned Spring JDBC fixture.');
    checks.push('The installed Java template action applied the matching build-tool and source-root profile, rendered the typed variables, and opened the compiled Spring component.');
    checks.push('The new Java class ran on the real imported project classpath. Incompatible templates and profiles, invalid identifiers and duplicate files were refused.');
    return {springWorkspace:true,jdbc,buildTool:tool,profile:notice.name,typedVariables:3,compiledSpringComponent:true,
      output:'가나다 "quoted":12',sourceScopeChecked:true,toolScopeChecked:true,duplicateRefused:true,
      exactJdtClasspath:true,jdtClasspathEntries,pinnedJavaArgfile:true};
  }finally{
    try {
      if(created)await fs.rm(file,{force:true});
    }finally{
      for(const [key,value] of previous.reverse())await config.update(key,value,target);
    }
  }
}

module.exports={runJavaTemplateProfileChecks,runCompiledTemplate};
