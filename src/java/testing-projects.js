'use strict';
const fs=require('node:fs'),path=require('node:path');
const {fileURLToPath}=require('node:url');
const inside=(root,file)=>{const relative=path.relative(root,file);return !relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
function localPath(value,root){if(typeof value!=='string'||!value||value.includes('\0'))throw new Error('Use local test project paths.');return value.startsWith('file:')?fileURLToPath(value):path.resolve(root,value);}
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
    const paths=name=>(raw[name]||[]).map(value=>localPath(value,workspace));
    if(!Array.isArray(raw.classPath)||!raw.classPath.length)throw new Error('A Java test project requires a compiled test classpath. Import and build the project first.');
    const result={...raw,id:raw.id||workspace,label:raw.label||path.basename(workspace),workspace,javaHome:localPath(raw.javaHome||javaConfig.get('javaHome'),workspace),runtimePath:raw.runtimePath||runtimePath,classPath:paths('classPath'),testClassPaths:paths('testClassPaths'),sourceRoots:paths('sourceRoots'),classDirectories:paths('classDirectories'),outputRoot:raw.outputRoot||path.join(context.globalStorageUri.fsPath,'java-test-results')};
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
    if(cp.modulepaths?.length)throw new Error('Automatic Java module-path test launching is not supported yet. Use an explicit classpath profile.');
    const settings=await command('java.project.getSettings',uri.toString(),['org.eclipse.jdt.ls.core.sourcePaths','org.eclipse.jdt.ls.core.vm.location']);
    const workspace=cp.projectRoot?localPath(cp.projectRoot,guessed):guessed;
    const classPath=(cp.classpaths||cp.classPaths||[]).filter(file=>fs.existsSync(file)||path.extname(file).toLowerCase()==='.jar');
    const directories=classPath.filter(file=>fs.existsSync(file)&&fs.statSync(file).isDirectory()&&inside(workspace,file));
    const sourceRoots=(settings?.['org.eclipse.jdt.ls.core.sourcePaths']||[path.join(workspace,'src/main/java'),path.join(workspace,'src/test/java')]).filter(file=>fs.existsSync(file));
    const base={workspace,classPath,testClassPaths:directories,sourceRoots,classDirectories:directories.filter(file=>!/(?:[\\/]bin[\\/]test|[\\/]classes[\\/](?:java[\\/])?test|[\\/]test-classes)(?:[\\/]|$)/i.test(file)),javaHome:settings?.['org.eclipse.jdt.ls.core.vm.location']||javaConfig.get('javaHome')};
    const hasTestNG=classPath.some(file=>/^testng-\d[^\\/]*\.jar$/i.test(path.basename(file))),hasJUnit=classPath.some(file=>/^(?:junit(?:-jupiter|-vintage|-platform)?[^\\/]*|junit)\d*[-.][^\\/]*\.jar$/i.test(path.basename(file)));
    if(!hasTestNG||hasJUnit)projects.push(normalize({...base,framework:'junit'},workspace));
    if(hasTestNG)projects.push(normalize({...base,id:workspace+'::testng',label:path.basename(workspace)+' · TestNG',framework:'testng'},workspace));
  }
  return projects;
}
module.exports={resolveTestingProjects,inside};
