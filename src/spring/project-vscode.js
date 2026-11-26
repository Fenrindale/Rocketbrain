'use strict';
const fs=require('node:fs'),path=require('node:path'),{fileURLToPath}=require('node:url'),{SpringProjectTools}=require('./project-tools'),{sha,fail}=require('./project-client');
const { registerSpringAot } = require('./aot-vscode');
const SCHEME='rocketbrain-spring-projects';
function registerSpringProjectTools(context,vscode,{java,fetchImpl}={}){
 let disposed=false;const subscriptions=[],outcomes=new Map();const trusted=()=>{if(disposed||vscode.workspace.isTrusted===false)throw fail('TRUST','Trust the workspace before using Spring project tools.');};
 function documentSnapshot(uri){
  const target=vscode.Uri.parse(uri);
  const identity=file=>{try{const resolved=fs.realpathSync(file);return process.platform==='win32'?resolved.toLowerCase():resolved;}catch{return undefined;}};
  const physical=identity(target.fsPath);
  const matches=vscode.workspace.textDocuments.filter(doc=>doc.uri.scheme==='file'&&physical&&identity(doc.uri.fsPath)===physical);
  if(matches.some(doc=>doc.isDirty))return {dirty:true};
  const doc=matches[0];
  return doc&&!doc.isClosed?{version:doc.version,dirty:doc.isDirty,text:doc.getText()}:undefined;
 }
 const aot = registerSpringAot(vscode);
 const controller=new SpringProjectTools({
  fetchImpl,getWorkspaceRoots:()=>vscode.workspace.workspaceFolders?.map(folder=>folder.uri.fsPath)||[],assertTrusted:trusted,documentSnapshot,
  getMavenRepository:root=>vscode.workspace.getConfiguration('rocketbrain.spring',vscode.Uri.file(root)).get('mavenModelRepository',''),
  async writeBuildFile(change){
   trusted();
   const uri=vscode.Uri.parse(change.uri),doc=await vscode.workspace.openTextDocument(uri);
   change.guard();
   if(doc.isDirty||doc.getText()!==change.before||change.documentVersion!==undefined&&doc.version!==change.documentVersion||
      sha(fs.readFileSync(uri.fsPath))!==change.beforeSha256)throw fail('STALE','The build document or disk file changed before applying.');
   const version=doc.version,edit=new vscode.WorkspaceEdit();
   edit.replace(uri,new vscode.Range(doc.positionAt(0),doc.positionAt(doc.getText().length)),change.after);
   change.guard();
   for(const source of change.readOnlySources){
    const open=documentSnapshot(source.uri);
    if(open?.dirty||open&&open.text!==source.text)throw fail('STALE','A reviewed build input buffer changed before applying.');
   }
   if(doc.version!==version||doc.getText()!==change.before)throw fail('STALE','The build document changed before applying.');
   if(!await vscode.workspace.applyEdit(edit))throw fail('EDITOR','The editor declined the reviewed build-file edit.');
   return {nativeUndo:true,saved:await doc.save()};
  },
  async resyncProject(input){
   trusted();
   if(!java?.workbench?.resyncProject)throw fail('RESYNC','Start the Java project workbench before resync.');
   const result=await java.workbench.resyncProject(input);
   await java.spring?.refresh?.();
   return result;
  }
 });
 const api={aot,metadata:input=>controller.metadata(input),previewCreate:input=>controller.previewCreate(input),previewDependencies:input=>controller.previewDependencies(input),async inspectDependencies(input){const value=await controller.inspectDependencies(input);return{projectUri:value.projectUri,buildUri:value.buildUri,kind:value.kind,bootVersion:value.bootVersion,management:value.management,sourceSha256:value.sourceSha256,choices:value.choices,sources:value.sources,endpoint:value.endpoint,mavenProfiles:value.mavenProfiles,mavenProfile:value.mavenProfile};},async apply(input){const result=await controller.apply(input);outcomes.set(result.reviewId,JSON.stringify(result,null,2));await context.workspaceState.update('rocketbrain.spring.projects.last',result.projectUri);return result;},resync:input=>controller.resync(input),getReview:id=>controller.getReview(id),reviews:()=>[...controller.reviews.keys()].map(id=>controller.getReview(id)),reviewFile:(id,name)=>controller.reviewFile(id,name),discard:id=>controller.discard(id),async dispose(){if(disposed)return;disposed=true;aot.dispose();controller.dispose();outcomes.clear();for(const item of subscriptions)item.dispose();}};
 function managementLines(management){
  if(!management)return[];
  if(management.kind==='gradle-catalog-bom')return [
   'Gradle catalog platform '+management.coordinate+' '+management.version,
   'Boot plugin alias '+management.pluginAlias+' · BOM alias '+management.platformAlias+
    (management.property?' · version.ref '+management.property:'')
  ];
  const kind=management.kind==='boot-bom-import'?'Direct Maven BOM import':
   management.kind==='inherited-boot-bom'?'Inherited Maven BOM import':'Maven parent';
  const version=management.property?' via local property '+management.property:'';
  return [kind+' '+management.coordinate+' '+management.version+version,
   ...(management.chain||[]).map(item=>'Local parent '+item.coordinate+' · '+item.source),
   ...(management.supplemental||[]).map(item=>'Supplemental Maven BOM '+item.coordinate+' · SHA-256 '+item.sha256),
   ...management.overrides.map(item=>'Protected management '+item.coordinate+' '+item.version+(item.source?' · '+item.source:''))];
 }
 function reviewText(review){if(!review)return'# Spring project review unavailable';if(review.kind==='dependencies')return['# Review starter changes','',review.review,'','Build: '+review.buildUri,'Boot: '+review.bootVersion,...managementLines(review.management),
  ...(review.mavenProfile?['Maven profile '+review.mavenProfile]:[]),
  ...(review.sources||[]).map(source=>'Reviewed input '+source.name+' · SHA-256 '+source.sha256),
  '','Add: '+review.add.join(', '),'Remove: '+review.remove.join(', '),'','Before SHA-256: '+review.beforeSha256,'After SHA-256: '+review.afterSha256,'','Use the before/after virtual documents to inspect the exact change. Save/apply is separate from project resync.','',review.requiresProjectExecutionApproval?'This project is inside an open workspace. Initial import may execute its build configuration; separate execution approval is required.':'This change does not explicitly start project import or build.'].join('\n');return['# Review new Spring project','',review.review,'','Destination: '+review.projectUri,'Service: '+review.endpoint,'Archive SHA-256: '+review.archiveSha256,'','Language · packaging: '+review.selection.language+' · '+review.selection.packaging.toUpperCase(),
  'Build: '+review.archiveShape.buildFile,'Source: '+review.archiveShape.mainSourceDirectory,
  ...(review.archiveShape.configurationFile?['Configuration: '+review.archiveShape.configurationFile]:[]),
  'Selection: '+JSON.stringify(review.selection),'','Files:',...review.files.map(file=>'- ['+file.path+']('+SCHEME+':/'+review.reviewId+'/file/'+file.path.split('/').map(encodeURIComponent).join('/')+') · '+file.bytes+' bytes · '+file.sha256),'','No existing target directory is overwritten. Wrappers/build scripts are downloaded as files, and can execute only through subsequent import/build actions.'].join('\n');}
 subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME,{provideTextDocumentContent(uri){const parts=uri.path.split('/').filter(Boolean),id=parts.shift(),kind=parts.shift();if(kind==='outcome.md')return outcomes.get(id)||'No saved outcome is available.';if(kind==='file')return api.reviewFile(id,parts.map(decodeURIComponent).join('/'))||'The reviewed file is unavailable.';if(kind==='before'||kind==='after')return api.reviewFile(id,kind)||'The reviewed source is unavailable.';return reviewText(api.getReview(id));}}));
 const documentUri=(id,suffix)=>vscode.Uri.parse(SCHEME+':/'+id+'/'+suffix);
 async function openReview(review){const doc=await vscode.workspace.openTextDocument(documentUri(review.reviewId,'review.md'));await vscode.window.showTextDocument(doc,{preview:false});if(review.kind==='dependencies')await vscode.commands.executeCommand('vscode.diff',documentUri(review.reviewId,'before'),documentUri(review.reviewId,'after'),'Review Spring starter changes');return review;}
 const configuredEndpoint=()=>vscode.workspace.getConfiguration('rocketbrain.spring.initializr').get('endpoint','https://start.spring.io/');
 async function service(){const selected=await vscode.window.showInputBox({title:'Spring Initializr service',prompt:'Project coordinates and dependency choices are sent to this service',value:configuredEndpoint(),ignoreFocusOut:true});trusted();return selected;}
 async function pick(items,title){const result=await vscode.window.showQuickPick(items,{title,ignoreFocusOut:true});trusted();return result;}
 async function chooseProject(){const files=await vscode.workspace.findFiles('**/{pom.xml,build.gradle,build.gradle.kts}','**/{node_modules,.git,.vscode-test,test-output,build,target,.gradle}/**',101);if(files.length>100)throw fail('SIZE','Choose a project folder explicitly when the workspace contains more than100 build files.');const items=files.map(uri=>({label:vscode.workspace.asRelativePath(uri),uri:vscode.Uri.file(path.dirname(uri.fsPath)).toString()}));items.push({label:'Choose another local project folder',folder:true});const selected=await pick(items,'Select Spring project');if(!selected)return;if(selected.uri)return selected.uri;const folders=await vscode.window.showOpenDialog({title:'Spring project folder',canSelectFolders:true,canSelectFiles:false,canSelectMany:false});trusted();return folders?.[0]?.toString();}
 const command=(id,action)=>subscriptions.push(vscode.commands.registerCommand(id,async()=>{try{trusted();return await action();}catch(error){if(!disposed)await vscode.window.showErrorMessage('Rocketbrain Spring Projects: '+(error.code?.startsWith('ROCKETBRAIN_')?error.message:'The operation failed. Inspect the source and retained project state before retrying.'));}}));
 command('rocketbrain.spring.createProject',async()=>{
  const endpoint=await service();if(endpoint===undefined)return;
  let metadata=await api.metadata({endpoint});
  const choose=(values,title)=>pick(values.map(item=>({label:item.name||item.id,id:item.id})),title);
  const type=await choose(metadata.types,'Spring project build system');if(!type)return;
  const boot=await choose(metadata.bootVersions,'Spring Boot version');if(!boot)return;
  metadata=await api.metadata({endpoint,bootVersion:boot.id});
  if(!metadata.languages.length||!metadata.packaging.length)throw fail('CHOICE','This service did not advertise a supported source language and packaging.');
  const language=await choose(metadata.languages,'Project source language');if(!language)return;
  const packaging=await choose(metadata.packaging,'Project packaging');if(!packaging)return;
  const format=metadata.configurationFormats.length?await choose(metadata.configurationFormats,'Application configuration format'):null;
  if(format===undefined)return;
  const javaVersion=await choose(metadata.javaVersions.map(value=>({...value,name:'Java '+(value.name||value.id)})),'Project Java version');
  if(!javaVersion)return;
  const groupId=await vscode.window.showInputBox({title:'Project group',value:metadata.defaults.groupId,ignoreFocusOut:true});
  trusted();if(groupId===undefined)return;
  const artifactId=await vscode.window.showInputBox({title:'Project artifact and folder name',value:metadata.defaults.artifactId,ignoreFocusOut:true});
  trusted();if(artifactId===undefined)return;
  const packageName=await vscode.window.showInputBox({title:'Root JVM package',value:groupId+'.'+artifactId.replaceAll('-',''),ignoreFocusOut:true});
  trusted();if(packageName===undefined)return;
  const dependencies=await vscode.window.showQuickPick(metadata.dependencies.map(d=>({label:d.name,description:d.group+' · '+d.id,id:d.id})),
   {title:'Compatible Spring dependencies',canPickMany:true,ignoreFocusOut:true});
  trusted();if(dependencies===undefined)return;
  const parent=await vscode.window.showOpenDialog({title:'Parent folder for the NEW project',canSelectFolders:true,canSelectFiles:false,canSelectMany:false});
  trusted();if(!parent?.[0])return;
  const selection={type:type.id,bootVersion:boot.id,javaVersion:javaVersion.id,language:language.id,packaging:packaging.id,
   ...(format?{configurationFileFormat:format.id}:{}),groupId,artifactId,name:artifactId,packageName,dependencies:dependencies.map(d=>d.id)};
  return openReview(await api.previewCreate({endpoint,parentUri:parent[0].toString(),selection}));
 });
 command('rocketbrain.spring.editStarters',async()=>{
  const projectUri=await chooseProject();if(!projectUri)return;
  const endpoint=await service();if(endpoint===undefined)return;
  let current=await api.inspectDependencies({endpoint,projectUri});
  const expectedSourceSha256=current.sourceSha256;
  let mavenProfile;
  if(current.mavenProfiles?.length){
   const selected=await pick([{label:'Main POM dependencies'},...current.mavenProfiles.map(id=>({label:'Maven profile '+id,id}))],
    'Choose the Maven dependency scope');
   trusted();if(!selected)return;
   mavenProfile=selected.id;
   if(mavenProfile!==undefined)current=await api.inspectDependencies({endpoint,projectUri,mavenProfile,expectedSourceSha256});
  }
  const choices=current.choices.filter(item=>item.editable);
  if(!choices.length)throw fail('DEPENDENCY','The project has no editable direct starters in the selected catalog.');
  const protectedCount=current.choices.length-choices.length;
  const title=mavenProfile?'Spring Boot starters and drivers · Maven profile '+mavenProfile:
   current.management?.kind==='gradle-catalog-bom'?'Spring Boot starters and drivers · Gradle catalog '+current.bootVersion:
   current.management?.kind==='boot-bom-import'?'Direct Spring Boot starters and drivers · Maven BOM '+current.bootVersion:
   current.management?.kind==='inherited-boot-bom'?'Spring starters and drivers · Inherited Maven BOM '+current.bootVersion:
    'Direct Boot-managed starters and database drivers';
  const selected=await vscode.window.showQuickPick(choices.map(item=>({label:item.name,description:item.id+' · '+item.groupId+':'+item.artifactId,
   detail:item.catalogAlias?'Gradle alias '+item.catalogAlias:undefined,picked:item.selected,id:item.id})),{
   title,canPickMany:true,ignoreFocusOut:true,...(protectedCount?{placeHolder:protectedCount+' protected declarations are excluded from editing'}:{})
  });
  trusted();if(!selected)return;
  const ids=new Set(selected.map(item=>item.id)),add=choices.filter(item=>ids.has(item.id)&&!item.selected).map(item=>item.id),
   remove=choices.filter(item=>item.selected&&!ids.has(item.id)).map(item=>item.id);
  if(!add.length&&!remove.length)return;
  return openReview(await api.previewDependencies({endpoint,projectUri,mavenProfile,expectedSourceSha256,add,remove}));
 });
 command('rocketbrain.spring.applyProjectReview',async()=>{const picked=await pick(api.reviews().map(review=>({label:(review.kind==='create'?'Create project':'Edit starters')+' · '+review.projectUri,review})),'Apply reviewed Spring change');if(!picked)return;const review=picked.review;if(await vscode.window.showWarningMessage('Write the exact reviewed project files?',{modal:true},'Apply reviewed files')!=='Apply reviewed files')return;trusted();let allowProjectExecution=false;if(review.requiresProjectExecutionApproval){const label=review.kind==='create'?'Create and import':'Apply and allow project configuration';if(await vscode.window.showWarningMessage('This target is inside an open Java workspace. Initial project import may execute downloaded or existing build configuration. Continue only after reviewing the project scripts.',{modal:true},label)!==label)return;trusted();allowProjectExecution=true;}const result=await api.apply({reviewId:review.reviewId,allowWrite:true,allowProjectExecution});const doc=await vscode.workspace.openTextDocument(documentUri(result.reviewId,'outcome.md'));await vscode.window.showTextDocument(doc,{preview:false});await vscode.window.showInformationMessage(result.state==='editor-unsaved'?'The editor change is not saved. Save/reconcile it before resync.':'Files are saved. Use Resync Spring Project when ready to import/update configuration, then the Java workbench to build/run.');return result;});
 command('rocketbrain.spring.resyncProject',async()=>{const projectUri=await chooseProject();if(!projectUri)return;if(await vscode.window.showWarningMessage('Resync can execute Maven/Gradle project configuration and resolve dependencies. Build/run remain separate actions.',{modal:true},'Resync reviewed project')!=='Resync reviewed project')return;trusted();return api.resync({projectUri,allowProjectExecution:true});});
 context.subscriptions.push(...subscriptions);return api;
}
module.exports={registerSpringProjectTools,SCHEME};
