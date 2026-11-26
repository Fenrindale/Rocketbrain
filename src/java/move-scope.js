'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{fileURLToPath}=require('node:url');
const {inside}=require('./testing-projects');
const {projectFiles,resolveMoveProject}=require('./move');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const key=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
function literalGradleGraph(root,projects){
 const settings=path.join(root,'settings.gradle'),build=path.join(root,'build.gradle');
 if(!fs.existsSync(settings)||!fs.existsSync(build))throw Error('Cross-project Move currently requires an existing literal Gradle multi-project build.');
 const text=fs.readFileSync(settings,'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,''),includes=[...text.matchAll(/^\s*include\s+([^\r\n]+)$/gm)];
 if(!includes.length||/\b(?:projectDir|includeBuild|apply|pluginManagement|dependencyResolutionManagement)\b/.test(text))throw Error('Computed or composite Gradle project mappings require a separate Move review.');
 const names=includes.flatMap(match=>[...match[1].matchAll(/['"](:?[A-Za-z_$][\w$-]*)['"]/g)].map(m=>m[1].replace(/^:/,'')));
 if(new Set(names).size!==names.length||names.length!==projects.length||projects.some(project=>path.dirname(project.root)!==root||!names.includes(path.basename(project.root))))throw Error('Cross-project Move requires the complete bounded set of sibling projects declared by literal include entries.');
 if(/\b(?:dependencies|allprojects|apply\s+from|project\s*\()\b/.test(fs.readFileSync(build,'utf8')))throw Error('Injected root Gradle dependencies require a separate Move review.');
 const graph=new Map(),files=[settings,build];
 for(const project of projects){const file=path.join(project.root,'build.gradle');if(!fs.existsSync(file))throw Error('Each selected Gradle project needs a saved build.gradle.');files.push(file);const source=fs.readFileSync(file,'utf8').replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,''),edges=[...source.matchAll(/\b(implementation|api)\s+project\s*\(\s*['"]:([A-Za-z_$][\w$-]*)['"]\s*\)/g)];if((source.match(/\bproject\s*\(/g)||[]).length!==edges.length||/\b(?:allprojects|subprojects|apply\s+from|evaluationDependsOn)\b/.test(source))throw Error('Dynamic or non-runtime Gradle dependencies require a separate Move review.');const dependencies=edges.map(m=>m[2]);if(dependencies.some(name=>!names.includes(name)))throw Error('A declared dependency leaves the reviewed sibling project set.');graph.set(path.basename(project.root),dependencies);}
 const visit=(name,active=new Set())=>{if(active.has(name))throw Error('Cyclic project dependencies prevent this Move.');for(const next of graph.get(name)||[])visit(next,new Set([...active,name]));};for(const name of names)visit(name);
 return {files,graph};
}
async function moveScope(vscode,send,sourceUri,targetUri,cancellation,{allowPackageModule=false}={}){
 const source=await resolveMoveProject(send,vscode,sourceUri,cancellation),target=await resolveMoveProject(send,vscode,targetUri,cancellation),same=key(source.root)===key(target.root);let projects=same?[source]:[source,target];
 const namedPackageModule=allowPackageModule&&same&&fs.existsSync(path.join(source.root,'src','main','java','module-info.java'));
 const sourceWorkspace=vscode.workspace.getWorkspaceFolder(sourceUri),targetWorkspace=vscode.workspace.getWorkspaceFolder(targetUri);if(!sourceWorkspace||!targetWorkspace||sourceWorkspace.uri.toString()!==targetWorkspace.uri.toString())throw Error('Move requires both Java projects in the same open workspace folder.');
 let buildFiles=[],buildKind='same-project',buildProof=null,externalModels;
 if(same){let folder=source.root;const workspaceRoot=fs.realpathSync(sourceWorkspace.uri.fsPath);while(inside(workspaceRoot,folder)){for(const name of ['pom.xml','build.gradle','settings.gradle','build.gradle.kts','settings.gradle.kts','gradle.properties']){const file=path.join(folder,name);if(fs.existsSync(file))buildFiles.push(file);}if(key(folder)===key(workspaceRoot)||path.dirname(folder)===folder)break;folder=path.dirname(folder);}}
 if(!same){
  const B=require('./move-builds'),declared=B.findBuild(source.root,target.root,fs.realpathSync(sourceWorkspace.uri.fsPath));
  const sourceName=[...declared.roots].find(([,folder])=>key(folder)===key(source.root))?.[0];
  const targetName=[...declared.roots].find(([,folder])=>key(folder)===key(target.root))?.[0];
  if(!sourceName||!targetName||!B.compileReachable(declared,sourceName,targetName))throw Error('Declare an existing source-to-destination compile-exposed dependency before moving to that project.');
  if(declared.kind==='maven-reactor'&&[source,target].some(project=>key(project.sourceRoot)!==key(path.join(project.root,'src','main','java')))){
   throw Error('Cross-project Maven Move requires the observed standard main Java source roots of both default JAR modules.');
  }
  const clientContracts=B.moveClientProof(declared,sourceName,targetName);
  buildFiles=declared.files;buildKind=declared.kind;externalModels=declared.externalModels;
  buildProof={kind:declared.kind,root:declared.root,source:sourceName,target:targetName,compileExposed:true,clientContracts,
   ...(declared.dynamicContracts?{dynamicContracts:declared.dynamicContracts}:{}),
   ...(externalModels?{externalMavenModels:externalModels.pins}:{}),
   ...(declared.modelContracts?{mavenModel:declared.modelContracts}:{}),projects:[...declared.roots.keys()],
   edges:[...declared.graph].flatMap(([from,targets])=>targets.map(to=>({from,to,exposure:declared.edgeKinds.get(from)?.get(to)})))};
  projects=[];
  for(const folder of declared.roots.values()){
   const existing=[source,target].find(project=>key(project.root)===key(folder));
   if(existing){projects.push(existing);continue;}
   const sample=projectFiles(folder).find(file=>file.endsWith('.java'));
   if(!sample)throw Error('Every reviewed build project requires imported Java source.');
   projects.push(await resolveMoveProject(send,vscode,vscode.Uri.file(sample),cancellation));
  }
 }
 for(const project of projects){
  project.classpaths=await send('workspace/executeCommand',{command:'java.project.getClasspaths',arguments:[vscode.Uri.file(project.root).toString(),{scope:'runtime'}]},cancellation);
  if(project.classpaths.modulepaths?.length&&!namedPackageModule)throw Error('Java modules require a separate cross-project Move analysis.');
  if(!Array.isArray(project.classpaths.classpaths))throw Error('Build and import both Java projects before Move semantic validation.');
  if(namedPackageModule){
   const paths=[...project.classpaths.classpaths,...(project.classpaths.modulepaths||[])];
   const outputs=new Set(['bin/main','build/classes/java/main','build/resources/main','target/classes'].map(relative=>key(path.join(project.root,relative))));
   if(!paths.length||paths.length>8||paths.some(file=>typeof file!=='string'||!path.isAbsolute(file)||!outputs.has(key(file))||
    !fs.statSync(file,{throwIfNoEntry:false})?.isDirectory()||key(fs.realpathSync(file))!==key(file))){
    throw Error('Module service declarations require only observed owned main output directories and no external classpath or module path dependencies.');
   }
  }else if(!project.classpaths.classpaths.length)throw Error('Build and import both Java projects before Move semantic validation.');
 }
 if(!same&&!source.classpaths.classpaths.some(file=>inside(target.root,path.resolve(file))))throw Error('The imported source project does not expose the destination library on its runtime classpath.');
 const all=await send('workspace/executeCommand',{command:'java.project.getAll',arguments:[]},cancellation);if(!Array.isArray(all)||all.length>40)throw Error('Move requires a bounded observed Java project set.');
 for(const item of all){const raw=typeof item==='string'?item:item?.uri;if(!raw)throw Error('The Java engine returned an unknown project identity.');const uri=vscode.Uri.parse(raw);if(uri.scheme!=='file'||projects.some(p=>key(p.root)===key(uri.fsPath)))continue;const cp=await send('workspace/executeCommand',{command:'java.project.getClasspaths',arguments:[raw,{scope:'runtime'}]},cancellation);if([...(cp?.classpaths||[]),...(namedPackageModule?cp?.modulepaths||[]:[])].some(file=>projects.some(p=>inside(p.root,path.resolve(file)))))throw Error('An additional imported Java project depends on this Move scope. Review that client project separately: '+path.relative(sourceWorkspace.uri.fsPath,uri.fsPath));}
 const classpathIdentity=projects.flatMap(project=>[...project.classpaths.classpaths,...(namedPackageModule?project.classpaths.modulepaths||[]:[])]).filter(file=>fs.existsSync(file)).map(file=>{const real=fs.realpathSync(file),stat=fs.statSync(real);return {file,real,size:stat.size,mtime:stat.mtimeMs,ino:stat.ino};});
 return {source,target,projects,buildFiles,buildKind,buildProof,externalModels,same,namedPackageModule,classpathIdentity,metadata:JSON.stringify(projects.map(p=>({root:p.root,roots:p.sourceRoots,cp:p.classpaths}))),all:JSON.stringify(all)};
}
function scopeFiles(scope){return [...new Set([...scope.projects.flatMap(p=>projectFiles(p.root,{includeClassRegistrations:scope.includeClassRegistrations})),...scope.buildFiles])].sort();}
async function snapshotScope(scope,vscode,trusted,cancellation){const result=[];let bytes=0;for(const file of scopeFiles(scope)){trusted(cancellation);const data=fs.readFileSync(file);bytes+=data.length;if(data.length>2*1024*1024||bytes>16*1024*1024)throw Error('Move exceeds its reference source size limit.');const uri=vscode.Uri.file(file),doc=await vscode.workspace.openTextDocument(uri);if(doc.isDirty||doc.isClosed||doc.getText()!==data.toString('utf8').replace(/^\uFEFF/,''))throw Error('Save and synchronize every source, resource and build descriptor before Move.');result.push({file,uri:uri.toString(),text:doc.getText(),version:doc.version,hash:digest(doc.getText()),diskHash:digest(data)});}return result;}
function scopeGuards(scope,sources,vscode,trusted,cancellation){const before=sources.map(s=>key(s.file)).sort();return()=>{trusted(cancellation);const after=scopeFiles(scope).map(key).sort();if(before.length!==after.length||before.some((file,i)=>file!==after[i]))throw Error('The Move source/resource/build file set changed after review.');for(const saved of scope.classpathIdentity){const stat=fs.statSync(saved.file);if(fs.realpathSync(saved.file)!==saved.real||stat.size!==saved.size||stat.mtimeMs!==saved.mtime||stat.ino!==saved.ino)throw Error('The Java Move classpath changed after review.');}for(const source of sources){if(digest(fs.readFileSync(source.file))!==source.diskHash)throw Error('A Move source/resource/build descriptor changed after review.');const doc=vscode.workspace.textDocuments.find(d=>key(d.uri.fsPath)===key(source.file));if(doc&&(doc.isDirty||doc.version!==source.version||digest(doc.getText())!==source.hash))throw Error('A Move source/resource/build buffer changed after review.');}
 if(scope.externalModels){
  scope.externalModels.validate();
  if(vscode.workspace.textDocuments.some(doc=>doc.isDirty&&scope.externalModels.files.some(file=>key(doc.uri.fsPath)===key(file)))){
   throw Error('A pinned external Maven model has unsaved changes.');
  }
 }
 };}
async function validateScope(scope,vscode,send,sourceUri,targetUri,cancellation){const fresh=await moveScope(vscode,send,sourceUri,targetUri,cancellation,{allowPackageModule:scope.namedPackageModule});if(fresh.metadata!==scope.metadata||fresh.all!==scope.all||fresh.namedPackageModule!==!!scope.namedPackageModule)throw Error('The imported Java Move project/classpath/source-root metadata changed after review.');}
function textEntries(edit,sources){if(!edit||edit.changeAnnotations&&Object.keys(edit.changeAnnotations).length)throw Error('The Java move engine returned missing edits or unsupported conflicts.');const entries=[...Object.entries(edit.changes||{}).map(([uri,edits])=>({textDocument:{uri,version:null},edits})),...(edit.documentChanges||[])].map(entry=>{if(entry.kind||!entry.textDocument?.uri?.startsWith('file:'))throw Error('The Java engine returned unexpected file operations.');const raw=new URL(entry.textDocument.uri);if(raw.search||raw.hash||raw.host&&raw.host!=='localhost')throw Error('The Java engine returned a non-local or qualified file identity.');const source=sources.find(s=>key(s.file)===key(fileURLToPath(raw)));if(!source||!source.file.endsWith('.java'))throw Error('The Java engine returned edits outside the reviewed Java sources.');return {...entry,textDocument:{...entry.textDocument,uri:source.uri}};});if(!entries.length||new Set(entries.map(e=>e.textDocument.uri)).size!==entries.length)throw Error('The Java engine returned duplicate file operations or edits outside the reviewed Java sources.');return entries;}
function transformed(sources,entries,rename){const renames=Array.isArray(rename)?rename:rename?[rename]:[];return sources.filter(s=>s.file.endsWith('.java')).map(source=>{const entry=entries.find(e=>e.textDocument.uri===source.uri);let text=source.text;if(entry){const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);const offset=p=>{if(!p||!Number.isInteger(p.line)||!Number.isInteger(p.character)||p.line<0||p.line>=starts.length||p.character<0||starts[p.line]+p.character>(starts[p.line+1]??text.length))throw Error('Invalid Java Move text range.');return starts[p.line]+p.character;};const edits=entry.edits.map(e=>({start:offset(e.range.start),end:offset(e.range.end),text:e.newText})).sort((a,b)=>b.start-a.start);let previous=text.length+1;for(const edit of edits){if(edit.end<edit.start||edit.end>previous||typeof edit.text!=='string')throw Error('Overlapping or invalid Java Move text edits.');text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);previous=edit.start;}}const moved=renames.find(r=>source.uri===r.oldUri);return {uri:moved?moved.newUri:source.uri,text};});}
async function validateCompilation(scope,sources,entries,rename,runtime,cancellation,verifyBindings){
 const state=typeof runtime==='function'?runtime():runtime;
 if(!state?.javaHome||!state.storagePath)throw Error('Configure the independent Java runtime before Move semantic validation.');
 const {analyzeJavaSources}=require('./signature-compiler');
 const classpath=scope.namedPackageModule?[]:[...new Set(scope.projects.flatMap(p=>p.classpaths.classpaths))].filter(file=>fs.existsSync(file));
 const options={javaHome:state.javaHome,classpath,storagePath:state.storagePath,cancellation,namedModule:!!scope.namedPackageModule};
 const before=await analyzeJavaSources({...options,sources:sources.filter(s=>s.file.endsWith('.java')).map(s=>({uri:s.uri,text:s.text}))});
 if(before.errors.length)throw Error('Resolve existing Java compile errors before Move: '+before.errors[0].message);
 const after=await analyzeJavaSources({...options,sources:transformed(sources,entries,rename)});
 if(after.errors.length)throw Error('Move would introduce a Java compile error: '+after.errors[0].message);
 verifyBindings?.(before,after);
 return {report:{beforeErrors:0,afterErrors:0,sourceFiles:after.sources?.length||sources.filter(s=>s.file.endsWith('.java')).length,classpathFingerprint:after.classpathFingerprint,
  ...(scope.namedPackageModule?{independentNamedModuleCompilation:true}:{})},validate:()=>{before.validateClasspath();after.validateClasspath();}};
}
module.exports={key,digest,literalGradleGraph,moveScope,snapshotScope,scopeGuards,validateScope,textEntries,transformed,validateCompilation};
