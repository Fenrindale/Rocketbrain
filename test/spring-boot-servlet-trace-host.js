'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {exercise}=require('./helpers/spring-boot-servlet-trace-fixture');
const {jdbcReadback}=require('./java-source-analysis-host');

async function runSpringBootServletTraceChecks(api,vscode,checks) {
  const service=api.springRegistration;
  assert.ok(service?.copyBootHelpers);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.spring.copyBootServletRegistrationTrace'));
  const config=JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const root=await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  const base=await fs.realpath(os.tmpdir());
  const sources=await fs.mkdtemp(path.join(root,'rb-boot-trace-sources-'));
  const outputs=await fs.mkdtemp(path.join(base,'rb-boot-trace-runtime-'));
  const owned=await Promise.all([sources,outputs].map(async folder=>fs.lstat(folder,{bigint:true})));
  try {
    const target=vscode.Uri.file(sources);
    const copied=await service.copyBootHelpers(target);
    assert.deepEqual(copied.map(uri=>path.basename(uri.fsPath)),['RegistrationTrace.java','BootServletRegistrationTrace.java']);
    assert.ok(copied.every(uri=>!path.relative(path.dirname(path.dirname(path.dirname(uri.fsPath))),sources)));
    const before=await Promise.all(copied.map(uri=>fs.readFile(uri.fsPath,'utf8')));
    await assert.rejects(service.copyBootHelpers(target),/existing Spring trace helper/);
    assert.deepEqual(await Promise.all(copied.map(uri=>fs.readFile(uri.fsPath,'utf8'))),before);
    const java=await api.java.start();
    assert.ok(java.javaHome);
    const runtime=await exercise({
      javaHome:java.javaHome,classpathFile:path.join(config.projectPath,'build/runtime-classpath.txt'),
      helperFiles:copied.map(uri=>uri.fsPath),work:outputs,engine:config.dbEngine,configFile:config.dbConfigPath,
      readTrace:file=>service.inspect(vscode.Uri.file(file))
    });
    assert.ok(await jdbcReadback());
    checks.push('The installed Spring trace helper records ordinary Boot servlet registrations from independent callbacks and late registry actions.');
    checks.push('A real HTTP and JDBC read, the lazy supplier and shutdown agree with ordinary Boot startup. Both AOT paths are refused and the original exception is preserved.');
    return {...runtime,nativeHelperCopy:true,nativeTraceInspection:true};
  } finally {
    for (const [index,[folder,parent]] of [[sources,root],[outputs,base]].entries()) {
      const physical=await fs.realpath(folder),at=await fs.lstat(physical,{bigint:true});
      assert.equal(path.dirname(physical),parent);
      assert.deepEqual([at.dev,at.ino],[owned[index].dev,owned[index].ino]);
      await fs.rm(physical,{recursive:true,force:true,maxRetries:8,retryDelay:250});
    }
  }
}
module.exports={runSpringBootServletTraceChecks};
