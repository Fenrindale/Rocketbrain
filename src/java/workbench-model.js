'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{fileURLToPath,pathToFileURL}=require('node:url');
const {lexJava}=require('../spring/java');
const {describeSourceLayout,bindProjectOutputs}=require('./workbench-source-layout');
const {pomFacts}=require('./dependency-builds');
const LIMITS=Object.freeze({projects:30,sourceRoots:100,files:2000,entries:20000,directoryDepth:64,libraries:2000,fileBytes:1024*1024,sourceBytes:32*1024*1024,tasks:200,configurations:30,arguments:64,argumentBytes:8192,environment:64,environmentBytes:65536,metadataMs:30000,buildMs:600000});
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_JAVA_WORKBENCH'}),hash=value=>crypto.createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'),inside=(root,file)=>{const rel=path.relative(root,file);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const id=(kind,value)=>kind+':'+hash(value).slice(0,24),cancelled=c=>c?.isCancellationRequested||c?.aborted;
function local(value){if(typeof value!=='string'||!value||value.length>4096||value.includes('\0'))throw fail('Use a bounded local Java project path.');if(value.startsWith('file:')){const u=new URL(value);if(u.hostname&&u.hostname!=='localhost')throw fail('Network file hosts are unsupported.');return fileURLToPath(u);}if(!path.isAbsolute(value)||/^[a-z]+:/i.test(value)&&!(/^[A-Za-z]:[\\/]/.test(value)))throw fail('Use an absolute local file path or file URI.');return value;}
function workspacePath(value,roots,{directory=true}={}){const candidate=local(value),stat=fs.lstatSync(candidate);if(stat.isSymbolicLink())throw fail('Project paths must not be symbolic links.');const real=fs.realpathSync(candidate);if(!roots.some(root=>inside(root,real))||directory&&!stat.isDirectory()||!directory&&!stat.isFile())throw fail('Java project/source paths must remain inside an open local workspace.');return real;}
function workspaceRoots(folders){return folders.filter(f=>f?.uri?.scheme==='file'||typeof f==='string').map(f=>fs.realpathSync(local(typeof f==='string'?f:f.uri.toString())));}
function buildFingerprint(root){return hash(['pom.xml','build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties'].map(name=>{const p=path.join(root,name);if(!fs.existsSync(p))return[name,null];const st=fs.lstatSync(p);if(!st.isFile()||st.isSymbolicLink()||st.size>LIMITS.fileBytes)throw fail('Build files must be bounded regular local files.');return[name,hash(fs.readFileSync(p))];}));}
const includeNonJavaProjects=Object.freeze([Object.freeze({includeNonJava:true})]);

function projectIdentity(value,roots) {
 const physical=fs.realpathSync.native(workspacePath(value,roots));
 if(!roots.some(root=>{
  const parent=fs.realpathSync.native(root);
  return physical===parent||physical.startsWith(parent.endsWith(path.sep)?parent:parent+path.sep);
 }))throw fail('The physical project identity must remain inside the reviewed workspace.');
 return physical;
}

function localMavenFacts(root) {
 const file=path.join(root,'pom.xml');
 try {
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>LIMITS.fileBytes)return;
  return pomFacts({path:file,text:fs.readFileSync(file,'utf8')});
 } catch { /* An unsupported descriptor supplies no build-only identity. */ }
}

function mavenBuildOnlyPackaging(root) {
 const pom=localMavenFacts(root);
 if(pom?.gav.artifact&&['pom','ear'].includes(pom.packaging))return pom.packaging;
}

function observedProjectRoots(values,roots) {
 const physical=new Set();
 for(const value of values){
  try { physical.add(projectIdentity(value,roots)); } catch { /* Other workspace paths are out of scope. */ }
 }
 return physical;
}

function mavenReactorMembers(root,roots) {
 const reactor=localMavenFacts(root),gav=reactor?.gav;
 if(reactor?.packaging!=='pom'||reactor.profiles||!gav.group||!gav.artifact||!gav.version||
    !reactor.modules.length||reactor.modules.length>16)return;
 const members=new Set();
 for(const name of reactor.modules){
  if(!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(name))return;
  let member;
  try { member=projectIdentity(path.join(root,name),roots); } catch { return; }
  if(path.dirname(member)!==root||members.has(member))return;
  const child=localMavenFacts(member);
  if(child?.parentRelativePath!=='../pom.xml'||['group','artifact','version'].some(key=>child.parent?.[key]!==gav[key]))return;
  members.add(member);
 }
 return [...members];
}

async function collectMavenBuildProjects(projects,roots,request,cancellation) {
 const observed=await request('java.project.getAll',includeNonJavaProjects,cancellation);
 if(!Array.isArray(observed)||observed.length>LIMITS.projects)return;
 const seen=new Set(projects.map(project=>projectIdentity(project.root,roots)));
 const physical=observedProjectRoots(observed,roots);
 function add(root,packaging,reactorMembers){
  if(projects.length>=LIMITS.projects)throw fail('Inspect at most 30 imported Java and Maven build projects.');
  projects.push({id:id('project',root),uri:pathToFileURL(root).href,root,name:path.basename(root),jdk:null,
   compliance:null,natures:[],tool:'maven',buildOnly:true,packaging,buildFingerprint:buildFingerprint(root),
   ...(reactorMembers&&{reactorMembers}),sourceRoots:[],libraries:[],languages:[],outputRoots:[]});
  seen.add(root);
 }
 for(const root of physical){
  if(cancelled(cancellation))throw fail('Java project refresh cancelled.');
  if(seen.has(root))continue;
  const packaging=mavenBuildOnlyPackaging(root);
  if(packaging)add(root,packaging);
 }
 // m2e can keep the aggregator itself under Eclipse metadata while giving its
 // imported members their actual source paths. Prove the reactor from the POMs.
 for(const root of new Set([...physical].map(member=>path.dirname(member)))){
  if(cancelled(cancellation))throw fail('Java project refresh cancelled.');
  if(seen.has(root))continue;
  try { if(projectIdentity(root,roots)!==root)continue; } catch { continue; }
  const members=mavenReactorMembers(root,roots);
  if(members?.every(member=>physical.has(member)))add(root,'pom',members);
 }
}

function packageName(source,language='java'){const {tokens,issues}=lexJava(source);if(issues.some(x=>/Unicode|Unterminated/.test(x)))return null;const at=tokens.findIndex(t=>t.kind==='id'&&t.text==='package');if(at<0)return'';const parts=[];for(let i=at+1;i<tokens.length;i++){const t=tokens[i];if(language!=='java'&&/\r?\n/.test(source.slice(tokens[i-1].end,t.start)))return parts.length%2===1?parts.join(''):null;if(t.text===';')return parts.length%2===1?parts.join(''):null;if(parts.length%2===0&&t.kind==='id'||parts.length%2===1&&t.text==='.')parts.push(t.text);else return null;}return language!=='java'&&parts.length%2===1?parts.join(''):null;}
async function collectProjects({request,folders,cancellation}={}){const roots=workspaceRoots(folders||[]),raw=await request('java.project.getAll',[],cancellation);if(!Array.isArray(raw)||raw.length>LIMITS.projects)throw fail('Inspect at most 30 imported Java projects.');const projects=[];let files=0,bytes=0,entries=0;for(const value of raw){if(cancelled(cancellation))throw fail('Java project refresh cancelled.');let root;try{root=workspacePath(String(value),roots);}catch{continue;}if(projects.some(p=>p.root===root))continue;const uri=pathToFileURL(root).href,keys=['org.eclipse.jdt.ls.core.sourcePaths','org.eclipse.jdt.ls.core.vm.location','org.eclipse.jdt.ls.core.outputPath','org.eclipse.jdt.ls.core.natureIds','org.eclipse.jdt.ls.core.classpathEntries','org.eclipse.jdt.core.compiler.compliance'],settings=await request('java.project.getSettings',[uri,keys],cancellation);if(!settings||typeof settings!=='object'||Array.isArray(settings))throw fail('The Java engine returned invalid project settings.');const sources=settings[keys[0]]||[];if(!Array.isArray(sources)||sources.length>LIMITS.sourceRoots)throw fail('A Java project supports at most 100 source roots.');const cp=await request('java.project.getClasspaths',[uri,{scope:'runtime'}],cancellation);if(!cp||!Array.isArray(cp.classpaths)||!Array.isArray(cp.modulepaths)||cp.classpaths.length+cp.modulepaths.length>LIMITS.libraries)throw fail('The Java engine returned an unsupported classpath.');const project={id:id('project',root),uri,root,name:path.basename(root),jdk:typeof settings[keys[1]]==='string'?settings[keys[1]]:null,compliance:settings[keys[5]]||null,natures:Array.isArray(settings[keys[3]])?settings[keys[3]]:[],tool:fs.existsSync(path.join(root,'pom.xml'))?'maven':fs.existsSync(path.join(root,'build.gradle'))||fs.existsSync(path.join(root,'build.gradle.kts'))?'gradle':'java',buildFingerprint:buildFingerprint(root),sourceRoots:[],libraries:[],languages:[]};
 const conventional=project.tool==='java'?[]:['src/main/kotlin','src/test/kotlin','src/main/groovy','src/test/groovy'].map(folder=>path.join(root,folder)).filter(folder=>fs.existsSync(folder)&&!fs.lstatSync(folder).isSymbolicLink()&&fs.statSync(folder).isDirectory());
 const seenRoots=new Set(),languages=new Set();
 for(const source of [...new Set([...sources,...conventional])]){let sourceRoot;try{sourceRoot=workspacePath(source,roots);}catch{project.sourceRoots.push({id:id('source-unavailable',String(source)),path:String(source),unavailable:true,packages:[]});continue;}if(seenRoots.has(sourceRoot))continue;seenRoots.add(sourceRoot);const packages=new Map(),walk=(directory,depth=0)=>{if(depth>LIMITS.directoryDepth)throw fail('Logical Java browsing exceeds 64 directory levels.');const handle=fs.opendirSync(directory);try{let entry;while((entry=handle.readSync())!==null){if(++entries>LIMITS.entries)throw fail('Logical Java browsing exceeds 20000 directory entries.');if(cancelled(cancellation))throw fail('Java project refresh cancelled.');const file=path.join(directory,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){if(!['.git','node_modules','.gradle','.metadata'].includes(entry.name))walk(file,depth+1);continue;}if(!entry.isFile()||!/\.(?:java|kt|groovy)$/.test(entry.name))continue;const language=entry.name.endsWith('.kt')?'kotlin':entry.name.endsWith('.groovy')?'groovy':'java';languages.add(language);const st=fs.statSync(file);if(++files>LIMITS.files||st.size>LIMITS.fileBytes||(bytes+=st.size)>LIMITS.sourceBytes)throw fail('Logical Java browsing exceeds 2000 files, 1 MiB/file or 32 MiB total.');const pkg=packageName(fs.readFileSync(file,'utf8'),language),label=pkg===null?'(unresolved package)':pkg||'(default package)';if(!packages.has(label))packages.set(label,{id:id('package',[sourceRoot,label]),name:label,unresolved:pkg===null,files:[]});packages.get(label).files.push({id:id('file',file),name:entry.name,path:file,uri:pathToFileURL(file).href,language});}}finally{handle.closeSync();}};walk(sourceRoot);project.sourceRoots.push({id:id('source',sourceRoot),path:sourceRoot,name:path.relative(root,sourceRoot)||'.',packages:[...packages.values()].sort((a,b)=>a.name.localeCompare(b.name))});}
 for(const [kind,values]of [['classpath',cp.classpaths],['modulepath',cp.modulepaths]])for(const value of values){if(typeof value!=='string'||value.length>4096||value.includes('\0'))throw fail('Invalid observed Java library path.');let file;try{file=local(value);}catch{project.libraries.push({id:id('library',[kind,value]),name:value,kind,unavailable:true});continue;}project.libraries.push({id:id('library',[kind,file]),name:path.basename(file),path:file,kind});}project.languages=[...languages].sort();
 describeSourceLayout(project,settings[keys[4]],settings[keys[2]]);
 projects.push(project);}
 bindProjectOutputs(projects);
 await collectMavenBuildProjects(projects,roots,request,cancellation);
 return{format:'RocketbrainJavaWorkbench',formatVersion:1,projects,limits:LIMITS,observed:true,sourceFiles:files,sourceBytes:bytes,classpathSource:'Public JDT project settings/classpaths; package declarations from bounded local source, archive contents are not followed.'};}
function argumentsList(value=[]){if(!Array.isArray(value)||value.length>LIMITS.arguments||value.some(v=>typeof v!=='string'||v.includes('\0'))||Buffer.byteLength(JSON.stringify(value))>LIMITS.argumentBytes)throw fail('Use at most 64 arguments totaling 8 KiB.');return [...value];}
function environment(value={}){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length>LIMITS.environment||Buffer.byteLength(JSON.stringify(value))>LIMITS.environmentBytes)throw fail('Use at most 64 environment variables totaling 64 KiB.');for(const [k,v]of Object.entries(value))if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)||typeof v!=='string'||v.includes('\0'))throw fail('Invalid environment variable.');return{...value};}
function splitArguments(text){const result=[];let value='',quote=null,active=false;for(let i=0;i<text.length;i++){const c=text[i];if(c==='\\'&&['"',"'",'\\'].includes(text[i+1])){value+=text[++i];active=true;}else if(quote){if(c===quote)quote=null;else value+=c;}else if(c==='"'||c==="'"){quote=c;active=true;}else if(/\s/.test(c)){if(active){result.push(value);value='';active=false;}}else{value+=c;active=true;}}if(quote)throw fail('Close the quoted argument.');if(active)result.push(value);return argumentsList(result);}
module.exports={LIMITS,fail,hash,id,inside,local,workspacePath,workspaceRoots,buildFingerprint,packageName,collectProjects,argumentsList,environment,splitArguments,cancelled,projectIdentity,mavenBuildOnlyPackaging,mavenReactorMembers,observedProjectRoots,includeNonJavaProjects};
