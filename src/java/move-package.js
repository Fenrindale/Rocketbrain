'use strict';
const fs=require('node:fs'),path=require('node:path'),S=require('./move-scope'),P=require('./package-resources'),{parseJavaFile}=require('../spring/java'),{inside}=require('./testing-projects');
const {reviewPackageServices}=require('./package-services');
const {proveLocalBuildMapping,proveClasspathPaths}=require('./package-classpath');
function packageDirectory(vscode,uri){if(uri?.scheme!=='file'||uri.query||uri.fragment||!fs.lstatSync(uri.fsPath).isDirectory()||fs.lstatSync(uri.fsPath).isSymbolicLink())throw Error('Choose a plain existing local Java package directory.');const folder=vscode.workspace.getWorkspaceFolder(uri);if(!folder||!inside(fs.realpathSync(folder.uri.fsPath),fs.realpathSync(uri.fsPath)))throw Error('Package Move must remain physically inside the open workspace.');return uri;}
function proveSourceSet(project,sourceRoot,targetRoot){if(S.key(sourceRoot)===S.key(targetRoot))return {kind:'same-source-root'};const file=path.join(project,'build.gradle');if(!fs.existsSync(file))throw Error('Cross-root Package Move requires literal Gradle main source-set declarations; test/custom Maven roots need separate analysis.');const text=fs.readFileSync(file,'utf8');require('./move-builds').gradleGrammar(text);const roots=[path.join(project,'src/main/java'),...[...text.matchAll(/sourceSets\.main\.java\.srcDir\(\s*['"](src\/[A-Za-z_$][\w$/-]*)['"]\s*\)/g)].map(match=>path.join(project,match[1]))].filter(root=>fs.existsSync(root)).map(root=>S.key(fs.realpathSync(root)));if(!roots.includes(S.key(sourceRoot))||!roots.includes(S.key(targetRoot)))throw Error('Package Move cannot cross production/test or unclassified source sets. Both roots must belong to the same literal main source set.');return {kind:'literal-gradle-main',descriptor:file};}
async function preparePackageMove(deps,sourceUri,targetUri,{cancellation}={}){
 const {vscode,send,trusted,refactoring,runtime,synchronizeFiles}=deps;trusted(cancellation);packageDirectory(vscode,sourceUri);packageDirectory(vscode,targetUri);if(S.key(sourceUri.fsPath)===S.key(targetUri.fsPath))throw Error('Choose a different destination package.');
 const tree=P.collectTree(sourceUri.fsPath,targetUri.fsPath),first=vscode.Uri.file(tree.files[0].file),scope=await S.moveScope(vscode,send,first,targetUri,cancellation,{allowPackageModule:true});if(!scope.same)throw Error('Package Move currently requires one imported project; its observed source sets may differ.');
 const sourceRoot=scope.source.sourceRoot,targetRoot=scope.target.sourceRoot,relative=folder=>path.relative(folder===sourceUri?sourceRoot:targetRoot,fs.realpathSync(folder.fsPath)),packageName=folder=>relative(folder).split(path.sep).filter(Boolean).join('.'),oldPackage=packageName(sourceUri),newPackage=packageName(targetUri);if(!oldPackage||!newPackage||oldPackage===newPackage||![oldPackage,newPackage].every(p=>p.split('.').every(name=>/^[$A-Za-z_][\w$]*$/.test(name))))throw Error('Package Move requires different valid named Java packages in observed source roots.');
 const sourceSet=proveSourceSet(scope.source.root,sourceRoot,targetRoot),resources=P.resourceTree(scope.source.root,sourceRoot,targetRoot,oldPackage,newPackage,{expanded:true,formats:'v24',sourceRoots:scope.source.sourceRoots}),rename=file=>({kind:'rename',oldUri:vscode.Uri.file(file.file).toString(),newUri:vscode.Uri.file(file.newFile).toString(),options:{overwrite:false,ignoreIfExists:false}}),javaRenames=tree.files.map(rename),resourceRenames=(resources?.files||[]).map(rename),renames=[...javaRenames,...resourceRenames];
 if(synchronizeFiles)for(const entry of javaRenames)await synchronizeFiles([{uri:entry.oldUri,type:1},{uri:entry.newUri,type:3}]);for(const entry of javaRenames){const symbols=await send('textDocument/documentSymbol',{textDocument:{uri:entry.oldUri}},cancellation);if(!symbols?.length)throw Error('Wait for every selected package class to finish importing.');}
 const sources=await S.snapshotScope(scope,vscode,trusted,cancellation),moved=new Map(tree.files.map(file=>[vscode.Uri.file(file.file).toString(),file]));
 const project=scope.source.root,resourceRoots=resources.resourceRoots;
 const services=reviewPackageServices({project,roots:resourceRoots.roots,directoryExists:P.resourceDirectoryInsideProject,sources,moved,oldPackage,newPackage,uriFor:file=>vscode.Uri.file(file).toString()});
 if(!!services.module!==scope.namedPackageModule)throw Error('The reviewed main module descriptor differs from the observed Java project.');
 renames.push(...services.renames);
 for(const source of sources){
  if(moved.has(source.uri)){
   const item=moved.get(source.uri),sub=path.dirname(item.relative),expected=oldPackage+(sub==='.'?'':'.'+sub.split(path.sep).join('.'));
   if(parseJavaFile(source).packageName!==expected)throw Error('A nested package member declaration does not match its observed directory package.');
   const serviceFactory=services.factories.has(source.uri),serviceInterface=services.providers.get(source.uri)||services.factories.get(source.uri);
   if(!services.interfaces.has(source.uri)){
    require('./move').inspectMoveClass(source.text,source.uri,sources,{compilerGenericPeers:true,serviceInterface,serviceFactory});
    if(!serviceInterface)require('./member-move').inspectMoveOwner(source.text,source.uri);
   }
  }
  if(/\b(?:Class\s*\.\s*forName|loadClass|ComponentScan|EntityScan|EnableJpaRepositories)\b/.test(source.text))throw Error('Dynamic or configured package references require a separate package Move review.');
  if(source.file.endsWith('.java')&&/\bSpringBootApplication\b/.test(source.text)){
   const application=parseJavaFile(source).packageName;
   if(/SpringBootApplication\s*\(/.test(source.text)||!application||!(newPackage===application||newPackage.startsWith(application+'.')))throw Error('The new package leaves the observed Spring Boot scan scope.');
  }
 }
 const resourceProof=P.reviewLookups(sources,tree,resources,oldPackage,newPackage,services.services);
 const classpaths=[...scope.source.classpaths.classpaths,...(services.module?scope.source.classpaths.modulepaths||[]:[])];
 const identities=new Map(),classEntry=name=>name.replaceAll('.','/')+'.class';
 for(const service of services.services.values()){
  if([sourceRoot,targetRoot].some(root=>S.key(root)!==S.key(path.join(project,'src/main/java'))))throw Error('Service providers and interfaces require movement within the same standard main Java source set.');
  if(service.moduleName){
   identities.set('module-info.class',{classFile:true});
   identities.set('META-INF/services/'+service.service,null);
   identities.set('META-INF/services/'+service.nextService,null);
   for(const factory of service.providerFactories){
    identities.set(classEntry(factory.implementation),{classFile:true});
    if(factory.nextImplementation!==factory.implementation)identities.set(classEntry(factory.nextImplementation),null);
   }
  }else identities.set(service.path,{sha256:service.sha256});
  identities.set(classEntry(service.service),{classFile:true});
  for(const provider of service.providers)identities.set(classEntry(provider),{classFile:true});
  for(const change of service.rewrites)identities.set(classEntry(change.to),null);
  if(service.nextService!==service.service){
   if(!service.moduleName)identities.set(service.newPath,null);
   identities.set(classEntry(service.nextService),null);
  }
 }
 for(const lookup of resourceProof.lookup){
  if(!['spring-classloader','system-classloader'].includes(lookup.loader))continue;
  identities.set(lookup.oldPath,{sha256:lookup.resourceSha256});
  identities.set(lookup.newPath,null);
 }
 if(identities.size)proveLocalBuildMapping(project,resourceRoots,scope.buildFiles);
 const classpathProof=await proveClasspathPaths(classpaths,project,resourceRoots.roots,identities);
 const springProvider=resourceProof.springProviderRequired?await P.proveSpringResourceProvider(classpaths):null;
 if(springProvider)resourceProof.springProvider=springProvider.proof;
 const guard=S.scopeGuards(scope,sources,vscode,trusted,cancellation),groups=new Map();for(const entry of javaRenames){const destination=path.dirname(vscode.Uri.parse(entry.newUri).fsPath),id=S.key(destination),group=groups.get(id)||{destination,renames:[],mapping:[]},source=sources.find(value=>value.uri===entry.oldUri),type=parseJavaFile(source).types[0],item=moved.get(entry.oldUri),sub=path.dirname(item.relative),destinationPackage=newPackage+(sub==='.'?'':'.'+sub.split(path.sep).join('.'));group.renames.push(entry);group.mapping.push({oldFqn:type.fqn,newFqn:destinationPackage+'.'+type.name});groups.set(id,group);}
 const responses=[];
 for(const group of groups.values()){
  guard();
  const response=await send('workspace/willRenameFiles',{files:group.renames.map(entry=>({oldUri:entry.oldUri,newUri:entry.newUri}))},cancellation);
  const engineEntries=S.textEntries(response,sources);
  // The complete descriptor is parsed above. Apply only the exact reviewed
  // service and provider name spans instead of asking JDT to infer JPMS edits.
  responses.push({...group,entries:engineEntries.filter(entry=>entry.textDocument.uri!==services.module?.uri)});
  guard();
 }
 const merged=P.mergePackageEngineEdits(sources,responses);
 const moduleEntries=services.moduleEntry?[services.moduleEntry]:[];
 const entries=P.mergeEntries(merged.entries,[...resourceProof.entries,...moduleEntries]);
 const after=S.transformed(sources,entries,javaRenames);
 const engineMove={strategy:'one-request-per-destination-folder',requestCount:groups.size,groups:[...groups.values()].map(group=>({destination:vscode.Uri.file(group.destination).toString(),javaFiles:group.renames.length,mapping:group.mapping})),mergeProof:merged.proof,automaticRetries:0,missingEditsOrConflictsAccepted:false};
 services.verifyProviders(after,javaRenames);
 P.verifyServiceClients(resourceProof.serviceCalls,after,javaRenames,services.services);
 for(const item of tree.files){const uri=vscode.Uri.file(item.newFile).toString(),sub=path.dirname(item.relative),expected=newPackage+(sub==='.'?'':'.'+sub.split(path.sep).join('.')),transformed=after.find(s=>s.uri===uri);if(!transformed||parseJavaFile({text:transformed.text,uri}).packageName!==expected)throw Error('The Java engine did not update every nested package declaration.');}
 const compiled=await S.validateCompilation(scope,sources,entries,javaRenames,runtime,cancellation,(before,after)=>{
  P.verifyResourceBindings(resourceProof.bindings,sources,entries,javaRenames,before,after);
  services.verifyCompilerBindings(before,after,javaRenames);
 });
 const preApply=()=>{guard();compiled.validate();springProvider?.validate();classpathProof?.validate();P.verifyTree(tree);P.verifyTree(resources);services.validate();};
 preApply();
 const allowedResourceRenames=resources.files.map(file=>({oldUri:vscode.Uri.file(file.file).toString(),newUri:vscode.Uri.file(file.newFile).toString(),sha256:file.sha256,...(file.binary?{binary:true,bytes:file.bytes}:{})}));
 const document=await vscode.workspace.openTextDocument(first);
 const plan=await refactoring.previewWorkspaceEdit({documentChanges:[...entries,...services.edits,...renames]},{
  title:'Move package '+oldPackage+' to '+newPackage,kind:'refactor.move.package',anchorDocument:document,cancellation,
  allowedResourceOperations:['rename'],allowedResourceRenames,allowedServiceEdits:services.permissions,guards:sources.map(s=>({uri:s.uri})),
  validate:async()=>{await S.validateScope(scope,vscode,send,first,targetUri,cancellation);preApply();},preApply,
  warnings:[services.module?'Named module service declarations retain their directive and provider order. Review the concrete uses and provides identifier changes and the factory bindings.':'Reviewed package data and opaque resources retain their exact bytes. Service registrations update provider names in order and follow a moved interface to its new descriptor filename.',
   'Reviewed class, classloader and Spring stream lookups must resolve through the observed classpath. Custom loaders, processing and external clients require separate analysis.']
 });
 return {...plan,move:{kind:'package',source:sourceUri.toString(),destination:targetUri.toString(),oldPackage,newPackage,sourceRoot,targetRoot,sourceSet,sourceSetChange:S.key(sourceRoot)!==S.key(targetRoot),movedFiles:renames.length,movedJavaFiles:javaRenames.length,movedResourceFiles:resourceRenames.length,movedServiceDescriptors:services.renames.length,nestedDirectories:tree.directories.length-1,reviewedFiles:sources.length,semantic:compiled.report,engineMove,resourceProof:{...resourceProof,entries:undefined,bindings:undefined,compilerCheckedCalls:resourceProof.bindings.length,compilerCheckedServiceDeclarations:services.compilerContractCount,services:[...services.services.values()],...(services.module?{namedModule:services.module}:{}),classpathIsolation:classpathProof?.proof,files:resources.files.map(({file,newFile,bytes,sha256,binary,resourceRoot,format})=>({file,newFile,bytes,sha256,...(binary?{binary:true}:{}),...(resourceRoot?{resourceRoot}:{}),...(format?{format}:{})})),roots:resourceRoots,descriptor:resources.descriptor,bytePreservingRenames:true,binaryTextModelsOpened:false},scope:'A bounded utility package tree and reviewed scalar service interfaces and providers move in one imported project. Classpath registration or a closed single dependency-free named module is reviewed with compiler and file snapshots. Binary resources retain their exact bytes. Cross-module moves, custom processors, dynamic loaders and external clients require separate analysis.'}};
}
module.exports={preparePackageMove,packageDirectory,proveSourceSet};
