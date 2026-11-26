'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {inside}=require('./testing-projects');
const {metadataFile}=require('./package-services');
const {namedAction,editorAnchor}=require('./extraction-actions');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
const key=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
function binaryIdentity(file){const stat=fs.lstatSync(file,{bigint:true});if(!stat.isFile()||stat.isSymbolicLink())throw Error('Reviewed binary resources require plain regular files.');return {real:fs.realpathSync(file),size:String(stat.size),mtimeNs:String(stat.mtimeNs),ctimeNs:String(stat.ctimeNs),ino:String(stat.ino),dev:String(stat.dev)};}
function offset(text,position){if(!Number.isInteger(position?.line)||!Number.isInteger(position?.character)||position.line<0||position.character<0)throw Error('Invalid refactoring edit position.');const lines=text.split('\n');if(position.line>=lines.length)throw Error('Refactoring position exceeds the source file.');const line=lines[position.line].replace(/\r$/,'');if(position.character>line.length)throw Error('Refactoring position exceeds its source line.');return lines.slice(0,position.line).reduce((n,l)=>n+l.length+1,0)+position.character;}
function editedText(text,edits){const spans=edits.map(edit=>{if(typeof edit.newText!=='string')throw Error('Invalid refactoring replacement.');return {start:offset(text,edit.range?.start),end:offset(text,edit.range?.end),text:edit.newText};}).sort((a,b)=>b.start-a.start||b.end-a.end);let previous=text.length+1,result=text;for(const span of spans){if(span.end<span.start||span.end>previous)throw Error('Overlapping refactoring edits were rejected.');result=result.slice(0,span.start)+span.text+result.slice(span.end);previous=span.start;}return result;}

function registerJavaRefactoring(context,vscode,{request}={}) {
 const plans=new Map(),checkedPlans=new Map(),validators=new Map(),subscriptions=[],operations=new Set();let closed=false,prepareConstant;
 const trusted=()=>{if(closed)throw Error('Java refactoring is closed.');if(!vscode.workspace.isTrusted)throw Error('Trust the workspace before refactoring Java sources.');};
 const cancelled=token=>{if(token?.isCancellationRequested)throw Error('Java refactoring was cancelled.');};
 async function send(method,params,cancellation){let timer;try{return await Promise.race([request(method,params,cancellation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Java refactoring request timed out. Try again after project import completes.')),30000);})]);}finally{clearTimeout(timer);}}
 function sourceUri(value,{destination=false,guard=false,resource=false,kotlinFormatting=false,kotlinRename=false}={}){
  const uri=typeof value==='string'?vscode.Uri.parse(value):value;
  const kotlinSource=kotlinFormatting||kotlinRename;
  if(uri?.scheme!=='file'||uri.authority||uri.query||uri.fragment||(!guard&&!resource&&!uri.fsPath.endsWith(kotlinSource?'.kt':'.java')))throw Error(kotlinSource?'Kotlin edits must target reviewed local Kotlin sources.':'Refactoring edits must target local Java source files.');
  const folder=vscode.workspace.getWorkspaceFolder(uri);if(!folder)throw Error('Refactoring files must remain inside an open workspace.');
  const root=fs.realpathSync(folder.uri.fsPath),candidate=destination?path.dirname(uri.fsPath):uri.fsPath;
  if(!inside(root,fs.realpathSync(candidate)))throw Error('Refactoring files must remain inside an open workspace.');
  const relative=path.relative(path.resolve(folder.uri.fsPath),path.resolve(candidate));
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Refactoring files must remain inside an open workspace.');
  let current=path.resolve(folder.uri.fsPath);
  for(const segment of relative.split(path.sep).filter(Boolean)){current=path.join(current,segment);if(fs.lstatSync(current).isSymbolicLink())throw Error('Refactoring through symbolic links or junctions is not supported.');}
  if(!destination&&!fs.statSync(uri.fsPath).isFile())throw Error('Only individual source files can be refactored.');
  if(destination&&!fs.statSync(path.dirname(uri.fsPath)).isDirectory())throw Error('Choose an existing destination package directory.');
  return uri;
 }
 function vacantJavaDestination(value,expectedParent){
  const uri=sourceUri(value,{destination:true}),parent=path.dirname(uri.fsPath);
  const real=fs.realpathSync(parent),name=path.basename(uri.fsPath).toLowerCase();
  if(expectedParent&&key(real)!==key(expectedParent)||fs.readdirSync(parent).some(entry=>entry.toLowerCase()===name)){
   throw Error('The new Java file destination changed or already exists.');
  }
  return {uri,parentRealPath:real};
 }
 function parameters(document,range,only){trusted();sourceUri(document.uri);if(document.isClosed||document.languageId!=='java')throw Error('Open a Java source document first.');const position=p=>({line:p.line,character:p.character});return {textDocument:{uri:document.uri.toString()},range:{start:position(range.start),end:position(range.end)},context:{diagnostics:[],...(only?{only}:{})}};}
 async function list(document,range,{only=['refactor','source.organizeImports'],cancellation}={}){
  const params=parameters(document,range,only),version=document.version,text=document.getText();cancelled(cancellation);const values=await send('textDocument/codeAction',params,cancellation);trusted();
  if(cancellation?.isCancellationRequested||document.isClosed||document.version!==version||document.getText()!==text)throw Error('Java source changed while discovering refactorings. Try again.');return (values||[]).filter(value=>value&&!value.disabled&&typeof value.title==='string').slice(0,100);
 }
 async function resolveAction(document,range,{title,kind,only,cancellation}={}){
  const actions=await list(document,range,{only,cancellation}),version=document.version,text=document.getText();let action=actions.find(value=>(!title||value.title===title)&&(!kind||value.kind===kind));if(!action)throw Error('The selected Java refactoring is not available for this source range.');if(action.data&&!action.edit)action=await send('codeAction/resolve',action,cancellation);trusted();if(cancellation?.isCancellationRequested||document.isClosed||document.version!==version||document.getText()!==text)throw Error('Java source changed while resolving the refactoring.');if(action.command||!action.edit)throw Error('This refactoring requires an additional Java engine interaction that is not integrated yet.');return action;
 }
 async function preview(document,range,options={}){
  const action=await resolveAction(document,range,options);
  if(action.kind==='refactor.extract.constant'){
   if(!prepareConstant)throw Error('Start Java source analysis before reviewing Extract Constant.');
   return prepareConstant({document,range,cancellation:options.cancellation});
  }
  return previewWorkspaceEdit(action.edit,{title:action.title,kind:action.kind,cancellation:options.cancellation,anchorDocument:document});
 }
 function registerConstantPreparation(prepare){
  if(prepareConstant||typeof prepare!=='function')throw Error('The Java constant refactoring planner is already registered or invalid.');
  prepareConstant=prepare;
  return {dispose(){if(prepareConstant===prepare)prepareConstant=undefined;}};
 }
 function removePlan(id){plans.delete(id);checkedPlans.delete(id);validators.delete(id);}
 async function previewWorkspaceEdit(workspaceEdit,{title='Java refactoring',kind='refactor',cancellation,anchorDocument,allowedResourceOperations=[],allowedResourceRenames=[],allowedServiceEdits=[],allowedBeanClassEdits=[],createJavaFile,guards=[],warnings=[],validate:extraValidate,preApply,formattingEndOfLine}={}){
  trusted();cancelled(cancellation);if(!workspaceEdit||typeof workspaceEdit!=='object'||Array.isArray(workspaceEdit))throw Error('The Java engine did not return a WorkspaceEdit.');if(Object.keys(workspaceEdit.changeAnnotations||{}).length)throw Error('Annotated refactoring conflicts require a separate review workflow.');
  const kotlinFormatting=kind==='source.format.kotlin';
  const kotlinRename=kind==='refactor.rename.kotlin';
  if(kotlinFormatting&&(!anchorDocument||anchorDocument.languageId!=='kotlin'||createJavaFile||guards.length||allowedResourceOperations.length||allowedResourceRenames.length||allowedServiceEdits.length))throw Error('Kotlin formatting requires one anchored text-only source review.');
  if(kotlinRename&&(!anchorDocument||anchorDocument.languageId!=='kotlin'||createJavaFile||guards.length||allowedResourceOperations.length||allowedResourceRenames.length||allowedServiceEdits.length))throw Error('Kotlin rename requires anchored text-only source changes.');
  if(!Array.isArray(warnings)||warnings.length>20||warnings.some(value=>typeof value!=='string'||value.length>1000||/[\u0000-\u0008\u000b-\u001f]/.test(value)))throw Error('Invalid refactoring review warnings.');const anchor=anchorDocument&&{document:anchorDocument,version:anchorDocument.version,text:anchorDocument.getText()};if(anchor){sourceUri(anchorDocument.uri,{kotlinFormatting,kotlinRename});if(anchorDocument.isClosed)throw Error('The selected source document is closed.');}
  if(!Array.isArray(allowedResourceRenames)||allowedResourceRenames.length>30)throw Error('Invalid reviewed resource rename set.');
  const resourcePermissions=new Map();for(const entry of allowedResourceRenames){if(!entry||!/^[a-f0-9]{64}$/.test(entry.sha256)||entry.binary!==undefined&&entry.binary!==true)throw Error('A reviewed resource rename requires its exact byte hash and valid binary permission.');if(entry.binary&&(!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>64*1024))throw Error('Reviewed binary resource permissions require an exact bounded byte length.');const old=sourceUri(entry.oldUri,{resource:true}),next=sourceUri(entry.newUri,{destination:true,resource:true}),id=key(old.fsPath);if(old.fsPath.endsWith('.java')||next.fsPath.endsWith('.java')||entry.binary&&(!['.bin','.png','.jpg','.jpeg'].includes(path.extname(old.fsPath))||path.extname(old.fsPath)!==path.extname(next.fsPath))||resourcePermissions.has(id)||hash(fs.readFileSync(old.fsPath))!==entry.sha256||entry.binary&&fs.statSync(old.fsPath).size!==entry.bytes)throw Error('Invalid, duplicate or stale reviewed resource rename.');resourcePermissions.set(id,{oldUri:old.toString(),newUri:next.toString(),sha256:entry.sha256,...(entry.binary?{binary:true,bytes:entry.bytes}:{})});}
  const servicePermissions=new Map();
  if(!Array.isArray(allowedServiceEdits)||allowedServiceEdits.length>24||allowedServiceEdits.length&&kind!=='refactor.move.package')throw Error('Invalid Package Move service descriptor permissions.');
  for(const entry of allowedServiceEdits){
   if(!entry||!/^[a-f0-9]{64}$/.test(entry.beforeSha256)||!/^[a-f0-9]{64}$/.test(entry.afterSha256)||entry.beforeSha256===entry.afterSha256&&!entry.newUri)throw Error('Service descriptor changes require both exact byte hashes.');
   const uri=sourceUri(entry.uri,{resource:true}),id=key(uri.fsPath);
   if(!metadataFile(uri.fsPath)||servicePermissions.has(id)||resourcePermissions.has(id)||fs.statSync(uri.fsPath).size>8192||hash(fs.readFileSync(uri.fsPath))!==entry.beforeSha256)throw Error('Invalid, duplicate or stale service descriptor permission.');
   const destination=entry.newUri===undefined?null:sourceUri(entry.newUri,{destination:true,resource:true});
   if(destination&&(!metadataFile(destination.fsPath)||path.dirname(destination.fsPath)!==path.dirname(uri.fsPath)))throw Error('The reviewed descriptor rename must remain in the same META-INF/services directory.');
   servicePermissions.set(id,{uri:uri.toString(),beforeSha256:entry.beforeSha256,afterSha256:entry.afterSha256,...(destination?{newUri:destination.toString()}:{})});
  }
  const beanPermissions=new Map();
  if(!Array.isArray(allowedBeanClassEdits)||allowedBeanClassEdits.length>16||
    allowedBeanClassEdits.length&&(kind!=='refactor.rename.java.type'||!anchor||resourcePermissions.size||servicePermissions.size)){
   throw Error('Spring XML bean class edits require a reviewed public Java type rename.');
  }
  for(const entry of allowedBeanClassEdits){
   if(!entry||!/^[a-f0-9]{64}$/.test(entry.beforeSha256)||!/^[a-f0-9]{64}$/.test(entry.afterSha256)||entry.beforeSha256===entry.afterSha256){
    throw Error('Spring XML bean class edits require distinct exact byte hashes.');
   }
   const uri=sourceUri(entry.uri,{resource:true}),id=key(uri.fsPath);
   if(path.extname(uri.fsPath).toLowerCase()!=='.xml'||beanPermissions.has(id)||fs.statSync(uri.fsPath).size>256*1024||
     hash(fs.readFileSync(uri.fsPath))!==entry.beforeSha256){throw Error('Invalid, duplicate or stale Spring XML bean class permission.');}
   beanPermissions.set(id,{...entry,uri:uri.toString()});
  }
  const edits=new Map(),versions=new Map(),resources=[],resourceKeys=new Set();let resourceSeen=false;
  function addText(value,changes,version){if(!Array.isArray(changes))throw Error('Invalid Java refactoring text edits.');if(changes.some(change=>change.annotationId))throw Error('Annotated refactoring conflicts require a separate review workflow.');const candidate=typeof value==='string'?vscode.Uri.parse(value):value,id=candidate&&key(candidate.fsPath),permission=servicePermissions.get(id)||beanPermissions.get(id),uri=sourceUri(value,{resource:!!permission&&permission.uri===candidate.toString(),kotlinFormatting,kotlinRename}),saved=edits.get(id);edits.set(id,{uri,edits:[...(saved?.edits||[]),...structuredClone(changes)]});if(version!==undefined&&version!==null){if(versions.has(id)&&versions.get(id)!==version)throw Error('Conflicting Java document versions.');versions.set(id,version);}}
  for(const [uri,changes]of Object.entries(workspaceEdit.changes||{}))addText(uri,changes);
  for(const change of workspaceEdit.documentChanges||[]){
   if(change.textDocument&&Array.isArray(change.edits)){if(resourceSeen)throw Error('Text edits following file operations require a separate review workflow.');addText(change.textDocument.uri,change.edits,change.textDocument.version);continue;}
   resourceSeen=true;if(!allowedResourceOperations.includes(change.kind)||!['rename','delete'].includes(change.kind))throw Error('File creation, deletion and movement need a separate review workflow.');
   if(Object.values(change.options||{}).some(Boolean))throw Error('Overwriting, recursive deletion and ignored file conflicts are not allowed.');
   const candidate=typeof (change.oldUri||change.uri)==='string'?vscode.Uri.parse(change.oldUri||change.uri):null;
   const id=candidate&&key(candidate.fsPath),permission=resourcePermissions.get(id),service=servicePermissions.get(id);
   if((permission||service)&&(change.kind!=='rename'||change.newUri!==(permission||service).newUri||service&&candidate.toString()!==service.uri))throw Error('A reviewed resource or service descriptor may only move to its exact approved destination.');
   const old=sourceUri(change.kind==='rename'?change.oldUri:change.uri,{resource:!!permission||!!service}),oldKey=key(old.fsPath);if(resourceKeys.has(oldKey))throw Error('Repeated or chained file operations require a separate review workflow.');resourceKeys.add(oldKey);const operation={kind:change.kind,uri:old.toString(),...(permission?{resourceSha256:permission.sha256,...(permission.binary?{binary:true,bytes:permission.bytes}:{})}:{}),...(service?{serviceDescriptor:true}:{})};
   if(change.kind==='rename'){
    const next=sourceUri(change.newUri,{destination:true,resource:!!permission||!!service}),nextKey=key(next.fsPath),a=vscode.workspace.getWorkspaceFolder(old),b=vscode.workspace.getWorkspaceFolder(next);
    if(key(a.uri.fsPath)!==key(b.uri.fsPath))throw Error('Move source and destination must belong to the same workspace folder.');
    if(oldKey===nextKey||fs.existsSync(next.fsPath)||resourceKeys.has(nextKey))throw Error('The destination already exists, collides by case, or is part of another file operation.');
    if(fs.readdirSync(path.dirname(next.fsPath)).some(name=>name.toLowerCase()===path.basename(next.fsPath).toLowerCase()))throw Error('The destination has a case-insensitive file name collision.');
    operation.newUri=next.toString();operation.parentRealPath=fs.realpathSync(path.dirname(next.fsPath));resourceKeys.add(nextKey);
   }
   resources.push(operation);if(!edits.has(oldKey))edits.set(oldKey,{uri:old,edits:[]});
  }
  if([...resourcePermissions.values()].some(permission=>!resources.some(operation=>operation.uri===permission.oldUri&&operation.newUri===permission.newUri&&operation.resourceSha256===permission.sha256)))throw Error('Every reviewed resource rename must appear exactly once.');
  for(const [id,service]of servicePermissions){
   if(service.newUri&&!resources.some(operation=>operation.uri===service.uri&&operation.newUri===service.newUri&&operation.serviceDescriptor)||
       !service.newUri&&resourceKeys.has(id)||!edits.has(id)||service.beforeSha256!==service.afterSha256&&!edits.get(id).edits.length){
    throw Error('Every reviewed service descriptor change must include its exact text edits and approved filename operation.');
   }
  }
  if(beanPermissions.size&&(resources.length!==1||resources[0].kind!=='rename'||resources[0].uri!==anchor.document.uri.toString()||
    [...beanPermissions.keys()].some(id=>resourceKeys.has(id)||!edits.get(id)?.edits.length))){
   throw Error('Every Spring XML permission must match text edits in the reviewed Java type rename.');
  }
  let creation;
  if(createJavaFile!==undefined){
   if(kind!=='refactor.extract.interface'||!anchor||resources.length||!edits.get(key(anchor.document.uri.fsPath))?.edits.length||
       typeof createJavaFile?.text!=='string'||!createJavaFile.text.trim()||createJavaFile.text.includes('\0')||
       Buffer.byteLength(createJavaFile.text)>512*1024)throw Error('A new Java file requires one reviewed Extract Interface operation.');
   const {uri,parentRealPath}=vacantJavaDestination(createJavaFile.uri);
   const ownerFolder=vscode.workspace.getWorkspaceFolder(anchor.document.uri),targetFolder=vscode.workspace.getWorkspaceFolder(uri);
   if(key(ownerFolder.uri.fsPath)!==key(targetFolder.uri.fsPath))throw Error('The new interface must be in the owner workspace.');
   creation={uri:uri.toString(),before:'',after:createJavaFile.text,edits:[],created:true,resourceOperation:'create'};
   resources.push({kind:'create',uri:creation.uri,parentRealPath});
  }
  if(!edits.size||edits.size+Number(Boolean(creation))>30||resources.length>30)throw Error('A Java refactoring must review between 1 and 30 files.');if(!Array.isArray(guards)||guards.length>2000)throw Error('Refactoring dependency review exceeds its file limit.');
  const oneAnchor=edits.size===1&&anchor&&edits.has(key(anchor.document.uri.fsPath))&&!resources.length;
  if(kotlinFormatting&&!oneAnchor)throw Error('Kotlin formatting requires one anchored text-only source review.');
  if(kotlinRename&&!edits.has(key(anchor.document.uri.fsPath)))throw Error('Kotlin rename edits must include the selected source.');
  if(formattingEndOfLine!==undefined&&(!['lf','crlf'].includes(formattingEndOfLine)||!kotlinFormatting&&kind!=='source.format.java'||!oneAnchor))throw Error('Line ending conversion requires one reviewed Java or Kotlin formatting document.');
  const documents=[],guardSnapshots=[];let size=0,count=0;
  function assertBinaryClosed(uri){if((vscode.workspace.textDocuments||[]).some(doc=>!doc.isClosed&&key(doc.uri.fsPath)===key(uri.fsPath)))throw Error('Close every text document for the reviewed binary resource before moving it.');}
  function captureBinary(uri,resource,changes){assertBinaryClosed(uri);if(changes.length)throw Error('Reviewed binary resources cannot receive text edits.');const identity=binaryIdentity(uri.fsPath),disk=fs.readFileSync(uri.fsPath);if(JSON.stringify(binaryIdentity(uri.fsPath))!==JSON.stringify(identity)||disk.length!==resource.bytes||hash(disk)!==resource.resourceSha256)throw Error('A reviewed binary resource identity or exact byte hash changed.');size+=disk.length;if(size>8*1024*1024)throw Error('Refactoring review exceeds its source or edit limit.');return {uri:uri.toString(),binary:true,bytes:disk.length,identity,diskHash:hash(disk),resourceSha256:resource.resourceSha256,before:null,after:null,edits:[],resourceOperation:resource.kind,newUri:resource.newUri};}
  async function capture(uri,changes,guard){
   const doc=await vscode.workspace.openTextDocument(uri),before=doc.getText(),disk=fs.readFileSync(uri.fsPath);
   size+=Buffer.byteLength(before);count+=changes.length;if(size>8*1024*1024||count>5000)throw Error('Refactoring review exceeds its source or edit limit.');
   const id=key(uri.fsPath),expected=versions.get(id);if(expected!==undefined&&expected!==doc.version)throw Error('The Java engine returned edits for an older document version.');
   const resource=resources.find(value=>key(vscode.Uri.parse(value.uri).fsPath)===id),service=servicePermissions.get(id),bean=beanPermissions.get(id);
   if(resource&&doc.isDirty)throw Error('Save the Java source before moving or deleting its file.');if(service&&doc.isDirty)throw Error('Save the service descriptor before applying Package Move.');
   if(resource?.resourceSha256){let decoded;try{decoded=new TextDecoder('utf-8',{fatal:true}).decode(disk);}catch{throw Error('Reviewed resource renames require plain UTF-8 text.');}if(changes.length||before!==decoded||hash(disk)!==resource.resourceSha256)throw Error('A reviewed resource buffer or exact byte hash changed.');}
   const edited=resource?.kind==='delete'?'':editedText(before,changes),eol=!guard&&formattingEndOfLine;
   const after=eol?edited.replace(/\r?\n/g,eol==='crlf'?'\r\n':'\n'):edited;
   if(service&&(!disk.equals(Buffer.from(before))||hash(disk)!==service.beforeSha256||hash(after)!==service.afterSha256))throw Error('A service descriptor buffer or its exact reviewed edit changed.');
   if(bean&&(doc.isDirty||!disk.equals(Buffer.from(before))||hash(disk)!==bean.beforeSha256||hash(after)!==bean.afterSha256))throw Error('A Spring XML buffer or its exact reviewed edit changed.');
   return {uri:uri.toString(),version:doc.version,hash:hash(before),diskHash:hash(disk),before,after,edits:changes,...(eol?{formattingEndOfLine:eol}:{}),...(kotlinFormatting?{kotlinFormatting:true}:{}),...(kotlinRename?{kotlinRename:true}:{}),...(resource?{resourceOperation:resource.kind,newUri:resource.newUri,...(resource.resourceSha256?{resourceSha256:resource.resourceSha256}:{})}:{}),...(service?{serviceDescriptor:true}:{}),...(bean?{beanClassReference:true}:{}),...(guard?{guard:true}:{})};
  }
  for(const {uri,edits:changes}of edits.values()){cancelled(cancellation);const resource=resources.find(value=>value.uri===uri.toString());documents.push(resource?.binary?captureBinary(uri,resource,changes):await capture(uri,changes,false));}
  if(creation){size+=Buffer.byteLength(creation.after);if(size>8*1024*1024)throw Error('Refactoring review exceeds its source limit.');documents.push(creation);}
  const captured=new Set(documents.map(saved=>key(vscode.Uri.parse(saved.uri).fsPath)));for(const value of guards){const uri=sourceUri(typeof value==='string'?value:value.uri,{guard:true}),id=key(uri.fsPath);if(!captured.has(id)){cancelled(cancellation);guardSnapshots.push(await capture(uri,[],true));captured.add(id);}}
  trusted();cancelled(cancellation);if(anchor&&(anchor.document.isClosed||anchor.document.version!==anchor.version||anchor.document.getText()!==anchor.text))throw Error('The selected source changed during refactoring review.');
  for(const [id,plan]of plans)if(Date.now()>plan.expiresAt)removePlan(id);while(plans.size>=10)removePlan(plans.keys().next().value);
  const id=crypto.randomUUID(),plan={id,title,kind,documents,resourceOperations:resources,guardCount:guardSnapshots.length,warnings:[...warnings],expiresAt:Date.now()+120000};plans.set(id,{...plan,guardSnapshots});validators.set(id,{validate:extraValidate,preApply});
  try{await validate(id,cancellation);}catch(error){removePlan(id);throw error;}return structuredClone(plan);
 }
 function checkResources(plan){
  for(const operation of plan.resourceOperations){
   if(operation.kind==='create'){
    vacantJavaDestination(operation.uri,operation.parentRealPath);
    continue;
   }
   const resource=!!operation.resourceSha256||!!operation.serviceDescriptor,uri=sourceUri(operation.uri,{resource});
   if(operation.resourceSha256&&hash(fs.readFileSync(uri.fsPath))!==operation.resourceSha256)throw Error('A reviewed resource byte hash changed.');
   if(operation.kind==='rename'){
    const next=sourceUri(operation.newUri,{destination:true,resource});
    if(fs.existsSync(next.fsPath)||key(fs.realpathSync(path.dirname(next.fsPath)))!==key(operation.parentRealPath)||
        fs.readdirSync(path.dirname(next.fsPath)).some(name=>name.toLowerCase()===path.basename(next.fsPath).toLowerCase()))throw Error('A move destination changed after review. Preview again.');
   }
  }
 }
 function reviewedUri(saved,value=saved.uri){return sourceUri(value,{guard:!!saved.guard,resource:!!saved.resourceSha256||!!saved.serviceDescriptor||!!saved.beanClassReference,kotlinFormatting:!!saved.kotlinFormatting,kotlinRename:!!saved.kotlinRename});}
 async function validate(id,cancellation){trusted();cancelled(cancellation);const plan=plans.get(id);if(!plan||Date.now()>plan.expiresAt)throw Error('The Java refactoring review expired. Preview it again.');const custom=validators.get(id)?.validate;if(custom)await custom(cancellation);trusted();cancelled(cancellation);const checked=[];for(const saved of [...plan.documents,...plan.guardSnapshots]){if(saved.created)continue;const uri=reviewedUri(saved),doc=saved.binary?null:await vscode.workspace.openTextDocument(uri);checked.push({saved,doc,uri});cancelled(cancellation);}checkSnapshots(checked);checkResources(plan);checkedPlans.set(id,checked);return {state:'fresh',id,documents:plan.documents.length,resourceOperations:plan.resourceOperations.length};}
 function checkSnapshots(checked){trusted();for(const {saved,doc,uri}of checked){reviewedUri(saved,uri);if(saved.binary){if((vscode.workspace.textDocuments||[]).some(value=>!value.isClosed&&key(value.uri.fsPath)===key(uri.fsPath))||JSON.stringify(binaryIdentity(uri.fsPath))!==JSON.stringify(saved.identity)||hash(fs.readFileSync(uri.fsPath))!==saved.diskHash)throw Error('A reviewed binary resource or text buffer changed after review.');continue;}if(doc.isClosed||doc.version!==saved.version||hash(doc.getText())!==saved.hash||hash(fs.readFileSync(uri.fsPath))!==saved.diskHash||((saved.resourceOperation||saved.serviceDescriptor||saved.beanClassReference)&&doc.isDirty))throw Error('A refactoring source file changed after review. Preview again.');}}
 function runFinalGuard(id,cancellation) {
  const guard=validators.get(id)?.preApply;
  if(guard){const value=guard(cancellation);if(value?.then)throw Error('The final refactoring guard must be synchronous.');}
  trusted();cancelled(cancellation);checkSnapshots(checkedPlans.get(id));checkResources(plans.get(id));
 }
 async function applyFormattingEndOfLine(id,file,cancellation) {
  const {doc,uri}=checkedPlans.get(id).find(entry=>entry.saved.uri===file.uri);
  const editor=await vscode.window.showTextDocument(doc,{preview:false,preserveFocus:false});
  if(!plans.has(id) || editor.document!==doc) throw Error('The formatting review is no longer open.');
  runFinalGuard(id,cancellation);
  if(!file.edits.length) {
   if(!await editor.edit(edit=>edit.setEndOfLine(doc.eol),{undoStopBefore:true,undoStopAfter:true})) return false;
   if(!plans.has(id)) throw Error('The formatting review is no longer open.');
   runFinalGuard(id,cancellation);
  }
  removePlan(id);
  const version=doc.version;
  if(file.edits.length) {
   const changes=file.edits.map(change=>({range:new vscode.Range(change.range.start.line,change.range.start.character,
    change.range.end.line,change.range.end.character),text:change.newText}));
   if(!await editor.edit(edit=>{for(const change of changes)edit.replace(change.range,change.text);},
    {undoStopBefore:true,undoStopAfter:true})) return false;
   const expected=editedText(file.before,file.edits);
   if(doc.isClosed||doc.version!==version+1||doc.getText()!==expected||!vscode.workspace.isTrusted||
    cancellation?.isCancellationRequested||hash(fs.readFileSync(uri.fsPath))!==file.diskHash) {
    throw Error('Text formatting was applied. The document changed before line-ending conversion. Review the document again.');
   }
  }
  const eol=file.formattingEndOfLine==='crlf'?vscode.EndOfLine.CRLF:vscode.EndOfLine.LF;
  // VS Code applies the EOL before undoStopBefore. The preceding call already closed the stack.
  const converted=await editor.edit(edit=>edit.setEndOfLine(eol),{undoStopBefore:false,undoStopAfter:true});
  if(!converted&&file.edits.length) throw Error('Text formatting was applied. Line-ending conversion failed. Review the document again.');
  return converted;
 }
 async function apply(id,cancellation){
  await validate(id,cancellation);
  const plan=plans.get(id),edit=new vscode.WorkspaceEdit();
  const formatting=plan.documents.find(file=>file.formattingEndOfLine);
  let applied;
  if(formatting) applied=await applyFormattingEndOfLine(id,formatting,cancellation);
  else {
   for(const file of plan.documents){
    if(!file.edits.length)continue;
    const changes=file.edits.map(change=>new vscode.TextEdit(
     new vscode.Range(change.range.start.line,change.range.start.character,change.range.end.line,change.range.end.character),change.newText));
    edit.set(reviewedUri(file),changes);
   }
   for(const operation of plan.resourceOperations){
    if(operation.kind==='create'){
     const contents=Buffer.from(plan.documents.find(file=>file.created&&file.uri===operation.uri).after);
     edit.createFile(sourceUri(operation.uri,{destination:true}),{overwrite:false,ignoreIfExists:false,contents});
    }else if(operation.kind==='rename'){
     const resource=!!operation.resourceSha256||!!operation.serviceDescriptor;
     edit.renameFile(sourceUri(operation.uri,{resource}),sourceUri(operation.newUri,{destination:true,resource}),{overwrite:false,ignoreIfExists:false});
    }else edit.deleteFile(sourceUri(operation.uri),{recursive:false,ignoreIfNotExists:false});
   }
   runFinalGuard(id,cancellation);
   removePlan(id);
   applied=await vscode.workspace.applyEdit(edit);
  }
  return {state:applied?'applied':'rejected',title:plan.title,files:plan.documents.map(file=>file.uri),warnings:[...plan.warnings],
   resourceOperations:structuredClone(plan.resourceOperations),savedToDisk:false,
   resourceOperationsSavedToDisk:plan.resourceOperations.length?(applied?true:'unknown'):false,atomicAcrossExternalWriters:false};
 }
 const provider={provideTextDocumentContent(uri){const parts=uri.path.split('/').filter(Boolean),plan=plans.get(parts[0]),file=plan?.documents[Number(parts[1])],before=/^before\.(java|kt|xml)$/.test(parts[2]);return file?(file.binary?'Opaque binary resource: '+file.bytes+' bytes; SHA-256 '+file.resourceSha256+(before?' (source)':' (same bytes at destination)'):(before?file.before:file.after)):'This refactoring review expired.';}};subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-java-refactor',provider));
 async function review(plan){
  await validate(plan.id);plan=plans.get(plan.id);
  for(let index=0;index<plan.documents.length;index++){
   const file=plan.documents[index];if(file.binary)continue;const extension=file.beanClassReference?'xml':file.kotlinFormatting||file.kotlinRename?'kt':'java';
   await vscode.commands.executeCommand('vscode.diff',
    vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/'+index+'/before.'+extension),
    vscode.Uri.parse('rocketbrain-java-refactor:/'+plan.id+'/'+index+'/after.'+extension),
    plan.title+' · '+path.basename(vscode.Uri.parse(file.uri).fsPath));
  }
  const resources=plan.resourceOperations.map(value=>{
   const file=vscode.Uri.parse(value.uri).fsPath;
   if(value.kind==='create')return 'Create '+file;
   if(value.kind==='delete')return 'Delete '+file;
   return 'Move '+path.basename(file)+' → '+vscode.Uri.parse(value.newUri).fsPath+
    (value.binary?' (opaque binary, '+value.bytes+' bytes, SHA-256 '+value.resourceSha256+')':'');
  });
  const action=plan.kind==='source.format.java'||plan.kind==='source.format.kotlin'?'Apply Formatting':'Apply Refactoring';
  const choice=await vscode.window.showInformationMessage('Apply '+plan.title+' to '+plan.documents.length+' file(s)?'+
   (resources.length?'\n\n'+resources.join('\n'):'')+(plan.warnings.length?'\n\n'+plan.warnings.join('\n'):'')+
   '\n\nReview all diffs. File operations affect disk. Changes to existing source text remain unsaved. '+
   (plan.resourceOperations.some(value=>value.kind==='delete')?
    'Restore deleted Java files with Rocketbrain: Restore Deleted Java File during this session.':'Use normal Undo after applying.'),
   {modal:true},action);
  if(choice===action)return api.apply(plan.id);
  return {state:'cancelled',id:plan.id};
 }
 subscriptions.push(vscode.commands.registerCommand('rocketbrain.java.refactor',async()=>{
  try{
   const editor=vscode.window.activeTextEditor;
   if(!editor||editor.document.languageId!=='java')throw Error('Select Java source to refactor.');
   const {document,selection}=editor,version=document.version,actions=await api.list(document,selection);
   const selected=await vscode.window.showQuickPick(actions.map(action=>({label:action.title,description:action.kind,action})),{title:'Refactor Java selection'});
   if(!selected)return;
   if(document.isClosed||document.version!==version)throw Error('The Java source changed after listing refactorings. Select the expression again.');
   const {title,kind}=selected.action,named=namedAction(kind,title);
   if(named&&!document.isDirty&&!selection.isEmpty)return await vscode.commands.executeCommand(named.command,editorAnchor(document,selection));
   return await api.review(await api.preview(document,selection,{title,kind}));
  }catch(error){if(!closed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);}
 }));
 function tracked(fn){return (...args)=>{const work=fn(...args);operations.add(work);void work.finally(()=>operations.delete(work)).catch(()=>{});return work;};}
 const api={list:tracked(list),resolveAction:tracked(resolveAction),preview:tracked(preview),previewWorkspaceEdit:tracked(previewWorkspaceEdit),review:tracked(review),apply:tracked(apply),validate:tracked(validate),registerConstantPreparation,async dispose(){closed=true;prepareConstant=undefined;plans.clear();checkedPlans.clear();validators.clear();await Promise.allSettled([...operations]);for(const sub of subscriptions)sub.dispose();}};return api;
}
module.exports={registerJavaRefactoring,editedText};
