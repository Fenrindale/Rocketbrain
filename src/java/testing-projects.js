'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fileURLToPath}=require('node:url');
const {lexJava}=require('../spring/java');
const {namedModule,modularJUnitJar}=require('./testing/module-path');
const inside=(root,file)=>{const relative=path.relative(root,file);return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function localPath(value,root){if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Use local test project paths.');return value.startsWith('file:')?fileURLToPath(value):path.resolve(root,value);}
const isNamedOutput=file=>fs.statSync(file,{throwIfNoEntry:false})?.isDirectory()&&
  fs.statSync(path.join(file,'module-info.class'),{throwIfNoEntry:false})?.isFile();
function declaredTestModule(workspace){
  const file=path.join(workspace,'src','test','java','module-info.java');
  const stat=fs.lstatSync(file,{throwIfNoEntry:false});
  if(!stat)return;
  if(!stat.isFile()||stat.size>65536||!inside(fs.realpathSync(workspace),fs.realpathSync(file)))throw new Error('Use a saved local Java test module descriptor.');
  const {tokens,issues}=lexJava(fs.readFileSync(file,'utf8'));
  const start=tokens[0]?.text==='open'?1:0,open=tokens.findIndex(token=>token.text==='{');
  const parts=tokens.slice(start+1,open),name=parts.map(token=>token.text).join('');
  if(issues.length||tokens[start]?.text!=='module'||open<start+2||!namedModule(name)||
     parts.some((token,index)=>index%2?token.text!=='.':token.kind!=='id')){
    throw new Error('Review src/test/java/module-info.java or configure an explicit named test profile.');
  }
  return name;
}
async function resolveTestingProjects(context,vscode,java,supplied,cancellation){
  if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before discovering or running Java tests.');
  const configuration=vscode.workspace.getConfiguration('rocketbrain.java.testing'),javaConfig=vscode.workspace.getConfiguration('rocketbrain.java');
  const folders=vscode.workspace.workspaceFolders||[],workspaceRoots=folders.filter(f=>f.uri.scheme==='file').map(f=>f.uri.fsPath);
  const runtimePath=configuration.get('runtimePath')||path.join(context.globalStorageUri.fsPath,'java-testing','java-testing-runtime.json');
  const normalize=(raw,base)=>{
    if(!raw||typeof raw!=='object')throw new Error('A Java test project profile must be an object.');
    if(raw.framework!==undefined&&!['junit','testng'].includes(raw.framework))throw new Error('Choose junit or testng as the test framework.');
    const workspace=localPath(raw.workspace||base,base);
    if(!workspaceRoots.some(root=>inside(root,workspace)))throw new Error('Java test projects must be inside an open local workspace.');
    if(!workspaceRoots.some(root=>inside(fs.realpathSync(root),fs.realpathSync(workspace))))throw new Error('Java test project links must stay inside the open workspace.');
    const paths=name=>{
      const values=raw[name]??[];
      if(!Array.isArray(values))throw new Error('Java test project paths must be arrays.');
      return values.map(value=>localPath(value,workspace));
    };
    const classPath=paths('classPath'),modulePath=paths('modulePath');
    if(!classPath.length&&!modulePath.length)throw new Error('A Java test project requires a compiled test classpath or module path. Build the project first.');
    if((modulePath.length||raw.testModule!==undefined)&&(!modulePath.length||!namedModule(raw.testModule)||classPath.length||raw.framework==='testng')){
      throw new Error('A named Java test project requires a testModule, a Jupiter module path and one compiled test module output.');
    }
    const result={...raw,id:raw.id||workspace+(raw.testModule?'::module:'+raw.testModule:''),label:raw.label||path.basename(workspace)+(raw.testModule?' · '+raw.testModule:''),workspace,javaHome:localPath(raw.javaHome||javaConfig.get('javaHome'),workspace),runtimePath:raw.runtimePath||runtimePath,classPath,modulePath,testClassPaths:paths('testClassPaths'),sourceRoots:paths('sourceRoots'),classDirectories:paths('classDirectories'),outputRoot:raw.outputRoot||path.join(context.globalStorageUri.fsPath,'java-test-results')};
    if(raw.testModule&&(result.testClassPaths.length!==1||!result.sourceRoots.length))throw new Error('Name the compiled test module output and saved source roots in the test profile.');
    if(raw.envFile){const envPath=localPath(raw.envFile,workspace);if(!inside(workspace,envPath)||!inside(fs.realpathSync(workspace),fs.realpathSync(envPath))||(fs.statSync(envPath).size>65536))throw new Error('Test environment files must be bounded local files inside the project.');const env=JSON.parse(fs.readFileSync(envPath,'utf8'));if(!env||typeof env!=='object'||Array.isArray(env))throw new Error('Test environment JSON must be an object.');result.env={...env,...raw.env};}
    if(!result.testClassPaths.length)result.testClassPaths=result.classPath.filter(file=>fs.existsSync(file)&&fs.statSync(file).isDirectory()&&inside(workspace,file));
    return result;
  };
  const configured=supplied||configuration.get('projects',[]);
  if(!Array.isArray(configured)||configured.length>30)throw new Error('Configure at most 30 Java test projects.');
  if(configured.length)return configured.map(raw=>normalize(raw,workspaceRoots[0]||''));
  const uris=await vscode.workspace.findFiles('**/src/test/**/*.java','**/{node_modules,.git,build,target,bin,out,.gradle}/**',501);
  if(uris.length>500)throw new Error('Automatic test-project resolution is limited to 500 Java test source files. Configure explicit test projects for a larger workspace.');
  if(!uris.length)return [];
  const command=(name,...args)=>java.requestWorkspaceCommand?java.requestWorkspaceCommand(name,args,cancellation):java.executeWorkspaceCommand(name,...args);
  const seen=new Set(),projects=[];
  for(const uri of uris){
    const guessed=uri.fsPath.split(path.sep+'src'+path.sep+'test'+path.sep)[0];if(seen.has(guessed))continue;seen.add(guessed);
    const cp=await command('java.project.getClasspaths',uri.toString(),{scope:'test'});
    const settings=await command('java.project.getSettings',uri.toString(),['org.eclipse.jdt.ls.core.sourcePaths','org.eclipse.jdt.ls.core.vm.location']);
    const workspace=cp.projectRoot?localPath(cp.projectRoot,guessed):guessed;
    const classPath=(cp.classpaths||cp.classPaths||[]).filter(file=>fs.existsSync(file)||path.extname(file).toLowerCase()==='.jar');
    const configuredModulePath=cp.modulepaths||cp.modulePaths||[];
    const directories=classPath.filter(file=>fs.existsSync(file)&&fs.statSync(file).isDirectory()&&inside(workspace,file));
    const sourceRoots=(settings?.['org.eclipse.jdt.ls.core.sourcePaths']||[path.join(workspace,'src/main/java'),path.join(workspace,'src/test/java')]).filter(file=>fs.existsSync(file));
    const base={workspace,classPath,testClassPaths:directories,sourceRoots,classDirectories:directories.filter(file=>!/(?:[\\/]bin[\\/]test|[\\/]classes[\\/](?:java[\\/])?test|[\\/]test-classes)(?:[\\/]|$)/i.test(file)),javaHome:settings?.['org.eclipse.jdt.ls.core.vm.location']||javaConfig.get('javaHome')};
    const testModule=declaredTestModule(workspace);
    if(testModule||configuredModulePath.length){
      const modulePath=[...new Set([...configuredModulePath,...classPath])];
      const conventionalTestOutputs=['target/test-classes','build/classes/java/test','bin/test'].map(file=>path.resolve(workspace,file));
      const testClassPaths=conventionalTestOutputs.filter(file=>modulePath.some(entry=>path.relative(file,entry)==='')&&isNamedOutput(file));
      if(!testModule||testClassPaths.length!==1||classPath.some(file=>!isNamedOutput(file)&&!modularJUnitJar(file)&&!configuredModulePath.includes(file))){
        throw new Error('The imported test paths do not identify a separate named test module. Configure a reviewed module-path test profile.');
      }
      projects.push(normalize({...base,framework:'junit',classPath:[],modulePath,testModule,testClassPaths},workspace));
      continue;
    }
    const hasTestNG=classPath.some(file=>/^testng-\d[^\\/]*\.jar$/i.test(path.basename(file))),hasJUnit=classPath.some(file=>/^(?:junit(?:-jupiter|-vintage|-platform)?[^\\/]*|junit)\d*[-.][^\\/]*\.jar$/i.test(path.basename(file)));
    if(!hasTestNG||hasJUnit)projects.push(normalize({...base,framework:'junit'},workspace));
    if(hasTestNG)projects.push(normalize({...base,id:workspace+'::testng',label:path.basename(workspace)+' · TestNG',framework:'testng'},workspace));
  }
  return projects;
}
module.exports={resolveTestingProjects,inside};
