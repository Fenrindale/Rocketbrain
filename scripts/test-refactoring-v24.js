'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {runTests}=require('@vscode/test-electron');

const root=path.resolve(__dirname,'..');
const workspaces={state:'refactoring-v24-state',package:'refactoring-v24-package',spring:'refactoring-v24-spring',maven:'refactoring-v24-maven'};
const group=process.env.ROCKETBRAIN_V24_GROUP;
if(!Object.hasOwn(workspaces,group))throw Error('Select a v0.24 native fixture group.');
const runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG));
const profile=path.join(root,'.vscode-test','refactoring-v24-'+group+'-'+crypto.randomUUID());
const extensions=path.join(root,'.vscode-test','core-extensions');
const settings={'telemetry.telemetryLevel':'off','update.mode':'none','extensions.autoCheckUpdates':false,
 'extensions.autoUpdate':false,'workbench.startupEditor':'none','workbench.editor.enablePreview':false};
for(const key of ['serverPath','javaHome','projectJdks','gradleHome','gradleJavaHome','debugBundlePath']){
 if(runtime[key]!==undefined)settings['rocketbrain.java.'+key]=runtime[key];
}
fs.mkdirSync(path.join(profile,'User'),{recursive:true});
fs.mkdirSync(extensions,{recursive:true});
fs.writeFileSync(path.join(profile,'User/settings.json'),JSON.stringify(settings,null,2));
delete process.env.ELECTRON_RUN_AS_NODE;
runTests({
 vscodeExecutablePath:process.env.ROCKETBRAIN_VSCODE||path.join(process.env.LOCALAPPDATA,'Programs/Microsoft VS Code/Code.exe'),
 extensionDevelopmentPath:process.env.ROCKETBRAIN_TEST_EXTENSION_PATH||root,
 extensionTestsPath:path.join(root,'test/java-refactoring-v24-host.js'),
 reuseMachineInstall:false,
 launchArgs:[path.join(root,'test/fixtures',workspaces[group]),'--user-data-dir='+profile,'--extensions-dir='+extensions,
  '--disable-extensions','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--disable-updates','--disable-telemetry'],
 extensionTestsEnv:{GRADLE_USER_HOME:path.join(root,'test-output/java-gradle-user-home')}
}).catch(error=>{console.error(error);process.exitCode=1;});
