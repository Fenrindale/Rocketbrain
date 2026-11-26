'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {inside}=require('./testing-projects');
const {parseJavaFile,lexJava}=require('../spring/java');
const {analyzeJavaSources}=require('./signature-compiler');
const {analyzeSpringContracts,inspectSpringMethodContract}=require('./spring-contract-analysis');
const {adaptSignatureReferences,verifyReferenceAdapters}=require('./change-signature-references');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const escapeRegex=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fileKey=value=>{const actual=fs.realpathSync(value);return process.platform==='win32'?actual.toLowerCase():actual;};
const uriKey=value=>{const file=path.resolve(require('node:url').fileURLToPath(value));return process.platform==='win32'?file.toLowerCase():file;};
const SIMPLE_TYPES=new Set(['byte','short','int','long','float','double','boolean','char','String','java.lang.String','Object','java.lang.Object']);
const KEYWORDS=new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record sealed permits yield _'.split(' '));
function offset(text,position){if(!Number.isInteger(position?.line)||!Number.isInteger(position?.character)||position.line<0||position.character<0)throw new Error('Select a method declaration.');const lines=text.split('\n');if(position.line>=lines.length||position.character>lines[position.line].replace(/\r$/,'').length)throw new Error('The selected Java position is outside the source.');return lines.slice(0,position.line).reduce((sum,line)=>sum+line.length+1,0)+position.character;}
function matching(tokens,index,open='(',close=')'){let depth=0;for(let i=index;i<tokens.length;i++){if(tokens[i].text===open)depth++;else if(tokens[i].text===close&&!--depth)return i;}throw new Error('Unbalanced Java source cannot be refactored.');}
function identifier(value){return typeof value==='string'&&/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)&&!KEYWORDS.has(value);}
function scalar(value,type){
 if(typeof value!=='string'||value.length>1000||/[\r\n]/.test(value))return false;
 const tokens=lexJava(value);if(tokens.issues.length)return false;const items=tokens.tokens;
 if(type==='String'||type==='java.lang.String')return value==='null'||items.length===1&&items[0].kind==='string'&&/^"(?:[^"\\\r\n]|\\[btnfr"'\\])*"$/.test(value);
 if(type==='Object'||type==='java.lang.Object')return value==='null';
 if(type==='boolean')return value==='true'||value==='false';
 if(type==='char')return items.length===1&&items[0].kind==='char'&&items[0].value?.length===1&&/^'(?:[^'\\\r\n]|\\[btnfr"'\\])'$/.test(value);
 if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?[fFdDlL]?$/.test(value))return false;
 if(['byte','short','int','long'].includes(type)){if(!/^-?(?:0|[1-9][0-9]*)[lL]?$/.test(value)||type!=='long'&&/[lL]/.test(value))return false;try{const n=BigInt(value.replace(/[lL]$/,'')),bounds={byte:[-128n,127n],short:[-32768n,32767n],int:[-2147483648n,2147483647n],long:[-9223372036854775808n,9223372036854775807n]}[type];return n>=bounds[0]&&n<=bounds[1]&&(/[lL]$/.test(value)||n>=-2147483648n&&n<=2147483647n);}catch{return false;}}
 if(type==='float'&&!/[fF]$/.test(value)||type==='double'&&/[lL]$/.test(value))return false;
 if(/^-?[0-9]+$/.test(value)){try{const n=BigInt(value);if(n< -2147483648n||n>2147483647n)return false;}catch{return false;}}
 const numeric=Number(value.replace(/[fFdD]$/,''));if(!Number.isFinite(numeric))return false;if(type==='float'&&(!Number.isFinite(Math.fround(numeric))||numeric!==0&&Math.fround(numeric)===0))return false;
 // A non-zero decimal mantissa that rounds to zero is rejected by javac.
 if(numeric===0&&/[1-9]/.test(value.split(/[eE]/)[0].replace(/[fFdD]$/,'')))return false;return true;
}
function selectedMethod(text,uri,range,{advanced=false}={}){
 const parsed=parseJavaFile({text,uri}),lexed=lexJava(text),issues=parsed.issues.filter(issue=>!advanced||issue!=='Generic type specialization is not modeled');if(issues.length||lexed.issues.length)throw new Error('This Java syntax needs a more complete signature analysis: '+[...issues,...lexed.issues].join('; '));
 const at=offset(text,range.start),end=offset(text,range.end),candidates=[];
 for(const owner of parsed.types)for(const method of owner.methods)if(at>=method.start&&at<=method.end&&end<=method.end)candidates.push({owner,method});
 if(candidates.length!==1)throw new Error('Select the method or constructor name in its declaration.');
 const {owner,method}=candidates[0],tokens=lexed.tokens,index=tokens.findIndex(t=>t.start===method.start);let begin=index-1;while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;
 const header=tokens.slice(begin+1,index),typeIndex=tokens.findIndex(t=>t.start===owner.start);let ownerBegin=typeIndex-2;while(ownerBegin>=0&&!['{','}',';'].includes(tokens[ownerBegin].text))ownerBegin--;
 const ownerHeader=tokens.slice(ownerBegin+1,typeIndex),close=matching(tokens,index+1);let body=close+1;while(body<tokens.length&&!['{',';'].includes(tokens[body].text))body++;
 if(advanced){
  if(!['class','interface'].includes(owner.kind)||method.annotations.some(a=>!['Override','java.lang.Override'].includes(a.name||a.type?.raw||a.text))||method.parameters.some(p=>p.annotations.length))throw new Error('Framework method annotations, record and annotated parameter contracts need additional analysis.');
  if(header.some(t=>['native','default'].includes(t.text))||method.parameters.some(p=>p.type.raw.includes('...')))throw new Error('Native, default and varargs parameter signatures need additional analysis.');
  let methodTypeParameters='';if(method.type.raw.startsWith('<')){let depth=0;for(let i=0;i<method.type.raw.length;i++){if(method.type.raw[i]==='<')depth++;else if(method.type.raw[i]==='>'&&!--depth){methodTypeParameters=method.type.raw.slice(0,i+1);break;}}}
  const bodyEnd=tokens[body]?.text==='{'?matching(tokens,body,'{','}'):body;return {owner,method,methodTypeParameters,bodyTokens:tokens.slice(body+1,bodyEnd),text,advanced:true};
 }
 if(owner.kind!=='class'||owner.superTypes.length||owner.annotations.length||method.annotations.length||method.parameters.some(p=>p.annotations.length))throw new Error('Framework annotations, inheritance, interface and record signatures need additional contract analysis.');
 if(!method.constructor&&!header.some(t=>['private','static','final'].includes(t.text))&&!ownerHeader.some(t=>t.text==='final'))throw new Error('Only plain non-polymorphic methods are supported: private/static/final methods or methods of a final class.');
 if(header.some(t=>['<','>','abstract','native','default'].includes(t.text))||tokens[body]?.text!== '{'||method.parameters.some(p=>!SIMPLE_TYPES.has(p.type.raw)))throw new Error('Generic, abstract, native, annotated, varargs and complex parameter signatures need additional analysis.');
 if(owner.methods.filter(m=>m.name===method.name).length!==1)throw new Error('Overloaded methods or constructors need overload-resolution conflict analysis.');
 const bodyEnd=matching(tokens,body,'{','}');return {owner,method,bodyTokens:tokens.slice(body+1,bodyEnd),text};
}
function callArguments(text,range,constructor){
 const lexed=lexJava(text);if(lexed.issues.length)throw new Error('A caller contains unsupported Java syntax.');const at=offset(text,range.start),end=offset(text,range.end),tokens=lexed.tokens;let index=tokens.findIndex(t=>t.start>=at&&t.end<=end);if(index<0)throw new Error('A caller could not be resolved precisely.');
 // JDT's constructor reference range covers the complete `new Type(args)` expression.
 if(constructor&&tokens[index].text==='new')index++;
 if(tokens[index-1]?.text===':'||tokens[index+1]?.text===':'||tokens[index+1]?.text!== '(')throw new Error('Method references and indirect invocations need additional signature analysis.');
 if(constructor&&tokens[index-1]?.text!=='new')throw new Error('Constructor chaining and constructor references need additional signature analysis.');
 const close=matching(tokens,index+1),values=tokens.slice(index+2,close),args=[];let current=[];for(const token of values){if(token.text===','){args.push(current);current=[];}else current.push(token);}if(current.length)args.push(current);
 for(const arg of args){if(arg.length===1&&(['id','number','string','char'].includes(arg[0].kind))&&!(arg[0].kind==='id'&&KEYWORDS.has(arg[0].text)&&!['null','true','false'].includes(arg[0].text)))continue;if(arg.length===2&&arg[0].text==='-'&&arg[1].kind==='number')continue;throw new Error('Caller expressions with evaluation effects need additional ordering analysis; use literal or local-name arguments.');}
 return args.length;
}
const SCOPE_EXTENSIONS=new Set(['.java','.xml','.yml','.yaml','.properties','.json','.sql','.kt','.groovy','.scala','.jsp','.html','.txt']);
const SKIP_DIRECTORIES=new Set(['.git','.gradle','.idea','.vscode','node_modules','build','target','bin','out','.settings']);
function projectScope(vscode,document,methodName){
 const workspace=vscode.workspace.getWorkspaceFolder(document.uri),boundary=fs.realpathSync(workspace.uri.fsPath);let root=path.dirname(document.uri.fsPath);
 while(inside(boundary,fs.realpathSync(root))&&!['pom.xml','build.gradle','build.gradle.kts'].some(file=>fs.existsSync(path.join(root,file)))){const parent=path.dirname(root);if(parent===root||root===boundary)throw new Error('Import a Maven or Gradle project before changing a signature.');root=parent;}
 root=fs.realpathSync(root);if(!inside(boundary,root))throw new Error('The signature project is outside the trusted workspace.');
 function capture(){const files=[],pending=[root];let bytes=0;const buffers=new Map((vscode.workspace.textDocuments||[]).filter(doc=>doc.uri.scheme==='file'&&!doc.isClosed).map(doc=>[path.resolve(doc.uri.fsPath).toLowerCase(),doc]));while(pending.length){const dir=pending.pop();for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw new Error('Signature scope contains a symbolic link; use a direct project path.');if(entry.isDirectory()){if(!SKIP_DIRECTORIES.has(entry.name))pending.push(file);continue;}if(!entry.isFile()||!SCOPE_EXTENSIONS.has(path.extname(file).toLowerCase()))continue;if(files.length>=500)throw new Error('Signature contract review is limited to 500 project source/resource files.');const disk=fs.readFileSync(file);bytes+=disk.length;if(bytes>8*1024*1024)throw new Error('Signature contract review exceeds 8 MiB.');const doc=buffers.get(path.resolve(file).toLowerCase()),text=doc?doc.getText():disk.toString('utf8');files.push({file,real:fs.realpathSync(file),diskHash:hash(disk),effectiveHash:hash(text),text});}}return files.sort((a,b)=>a.file.localeCompare(b.file));}
 const original=capture(),fingerprint=files=>JSON.stringify(files.map(({text,...rest})=>rest)),pattern=new RegExp('(^|[^A-Za-z0-9_$])'+escapeRegex(methodName)+'([^A-Za-z0-9_$]|$)');
 for(const file of original){if(path.extname(file.file).toLowerCase()==='.java'){const scanned=lexJava(file.text);if(scanned.issues.length)throw new Error('A project source contains syntax that prevents complete resource-contract inspection.');if(scanned.tokens.some(t=>(t.kind==='string'&&typeof t.value==='string'&&pattern.test(t.value))||t.kind==='text-block'&&t.text.includes(methodName)))throw new Error('A project string or reflection reference to '+methodName+' requires separate contract review.');}else if(pattern.test(file.text))throw new Error('A project resource reference to '+methodName+' requires separate contract review.');}
 function validate(){if(fingerprint(capture())!==fingerprint(original))throw new Error('A project source/resource or its file membership changed after signature inspection. Inspect it again.');}
 const contractSources=original.map(file=>({uri:require('node:url').pathToFileURL(file.file).href,text:file.text}));return {root,validate,files:original.length,sources:contractSources.filter(file=>/\.java$/i.test(file.uri)),contractSources};
}
function positionAt(text,at){const prefix=text.slice(0,at),line=prefix.split('\n').length-1;return {line,character:at-(prefix.lastIndexOf('\n')+1)};}
function inspectSemanticFamily(before,uri,nameStart){
 if(before.errors.length)throw new Error('The reviewed project must compile before signature analysis: '+before.errors[0].message);
 const selected=before.methods.filter(method=>uriKey(method.uri)===uriKey(uri)&&method.nameStart===nameStart);if(selected.length!==1)throw new Error('The compiler could not bind the selected declaration exactly.');
 const keys=new Set([selected[0].key]);let changed=true;while(changed){changed=false;for(const edge of before.overrideEdges)if(keys.has(edge.from)||keys.has(edge.to))for(const key of [edge.from,edge.to])if(!keys.has(key)){keys.add(key);changed=true;}}
 const family=before.methods.filter(method=>keys.has(method.key));if(family.length>30||family.some(method=>method.nameStart<0||method.varargs||method.parameters.some(p=>p.annotated)||method.annotations.some(a=>a!=='java.lang.Override')||method.modifiers.some(m=>['native','default'].includes(m))))throw new Error('Varargs, annotated, default and unresolved family declarations need separate contract analysis.');
 if(family.some(method=>method.generic&&(!Array.isArray(method.typeParameters)||!Array.isArray(method.ownerTypeParameters)||!Array.isArray(method.ownerSupertypes)||typeof method.erasureKey!=='string'||method.parameters.some(p=>typeof p.erasure!=='string'))))throw new Error('Generic source contracts require complete compiler bounds, substitutions and erasures.');
 if(family.filter(method=>method.ownerKind==='INTERFACE').length>1)throw new Error('Diamond or multiple interface signature contracts need separate family analysis.');
 if(before.externalOverrides.some(key=>keys.has(key)))throw new Error('The selected family overrides an external binary contract; its complete source family is unavailable.');
 const methodReferences=before.methodReferences.filter(reference=>keys.has(reference.methodKey));
 if(methodReferences.length>40||methodReferences.some(reference=>!reference.adapter)||
    methodReferences.length&&family.some(method=>method.ownerKind==='INTERFACE'||method.generic))
  throw new Error('Method or constructor references need additional signature adaptation analysis.');
 const calls=before.calls.filter(call=>keys.has(call.methodKey));if(calls.length>200||calls.some(call=>!call.safeArguments))throw new Error('Caller expressions with evaluation effects need additional ordering analysis; use literal or local-name arguments.');
 return {family,keys,calls,methodReferences};
}
function editedSources(sources,targets){
 const keyFor=uri=>{const file=path.resolve(require('node:url').fileURLToPath(uri));return process.platform==='win32'?file.toLowerCase():file;},changes=new Map();for(const [uri,edits]of targets){const key=keyFor(uri);changes.set(key,[...(changes.get(key)||[]),...edits]);}
 return sources.map(source=>{const edits=changes.get(keyFor(source.uri));if(!edits)return source;const values=edits.map(edit=>{if(typeof edit.newText!=='string')throw new Error('The Java engine returned an invalid text edit.');const start=offset(source.text,edit.range?.start),end=offset(source.text,edit.range?.end);if(end<start)throw new Error('The Java engine returned a reversed text edit.');return {start,end,text:edit.newText};}).sort((a,b)=>b.start-a.start||b.end-a.end);let text=source.text,last=source.text.length;for(const edit of values){if(edit.end>last)throw new Error('The Java engine returned overlapping signature edits.');text=text.slice(0,edit.start)+edit.text+text.slice(edit.end);last=edit.start;}return {...source,text};});
}
function verifySemanticChange(semantic,after,parameters,adapters=[]){
 if(after.errors.length)throw new Error('Signature conflict: '+after.errors[0].message);
 const canonical=type=>['String','Object'].includes(type)?'java.lang.'+type:type,mapping=new Map(semantic.family.map(method=>[method.key,method.owner+'#'+(method.constructor?'<init>':method.name)+'('+parameters.map(p=>p.originalIndex<0?canonical(p.type):method.parameters[p.originalIndex]?.type).join(',')+')']));
 if(new Set(mapping.values()).size!==mapping.size)throw new Error('Signature collision in the reviewed source family.');
 const expected=new Map(semantic.before.methods.map(method=>[mapping.get(method.key)||method.key,method]));if(expected.size!==semantic.before.methods.length||after.methods.length!==expected.size)throw new Error('Signature collision or unexpected declaration membership change.');
 for(const method of after.methods){const prior=expected.get(method.key);if(!prior||prior.uri!==method.uri||prior.returnType!==method.returnType||['throwsTypes','modifiers','annotations','typeParameters','ownerTypeParameters','ownerSupertypes'].some(key=>JSON.stringify(prior[key])!==JSON.stringify(method[key])))throw new Error('The engine changed an unreviewed declaration contract: '+method.key+' ('+(!prior?'unexpected binding':JSON.stringify({before:[prior.uri,prior.returnType,prior.throwsTypes,prior.modifiers],after:[method.uri,method.returnType,method.throwsTypes,method.modifiers]}))+').');
  if(semantic.keys.has(prior.key)){
   const names=parameters.map(p=>p.originalIndex<0?p.name:prior.parameters[p.originalIndex].name);
   if(JSON.stringify(method.parameters.map(p=>p.name))!==JSON.stringify(names))throw new Error('The engine changed the reviewed parameter order or names.');
   if(prior.erasureKey){const expectedErasure=prior.owner+'#'+(prior.constructor?'<init>':prior.name)+'('+parameters.map(p=>p.originalIndex<0?canonical(p.type):prior.parameters[p.originalIndex].erasure).join(',')+')';if(method.erasureKey!==expectedErasure)throw new Error('The signature edit changes a generic erasure contract.');}
  }
 }
 const edges=(values,transform)=>values.map(edge=>[transform?(mapping.get(edge.from)||edge.from):edge.from,transform?(mapping.get(edge.to)||edge.to):edge.to].join('|')).sort();if(JSON.stringify(edges(semantic.before.overrideEdges,true))!==JSON.stringify(edges(after.overrideEdges,false)))throw new Error('The signature edit changes an override or generic substitution family contract.');
 const externalBefore=semantic.before.externalOverrides.map(key=>mapping.get(key)||key).sort(),externalAfter=[...after.externalOverrides].sort();if(JSON.stringify(externalBefore)!==JSON.stringify(externalAfter))throw new Error('The signature edit creates or changes an external binary override contract.');
 const fingerprint=(calls,transformed)=>calls.map(call=>[call.uri,transformed?(mapping.get(call.enclosingKey)||call.enclosingKey):call.enclosingKey,call.ordinal,transformed?(mapping.get(call.methodKey)||call.methodKey):call.methodKey,call.constructor,call.resultType??''].join('|')).sort();
 const remainingCalls=verifyReferenceAdapters(semantic.before,after,adapters,mapping);
 if(JSON.stringify(fingerprint(semantic.before.calls,true))!==JSON.stringify(fingerprint(remainingCalls,false)))throw new Error('The signature edit changes overload resolution or an unrelated caller binding.');
}
function registerJavaChangeSignature(context,vscode,{request,refactoring,getJavaHome}={}){
 const infos=new Map(),operations=new Set();let closed=false;
 function trusted(cancellation){if(closed)throw new Error('Change Signature is closed.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before changing a Java signature.');if(cancellation?.isCancellationRequested)throw new Error('Java Change Signature was cancelled.');}
 function local(value){const uri=typeof value==='string'?vscode.Uri.parse(value):value;if(uri?.scheme!=='file'||uri.query||uri.fragment||!uri.fsPath.endsWith('.java'))throw new Error('Signature references must resolve to local Java sources.');const folder=vscode.workspace.getWorkspaceFolder(uri);if(!folder||!inside(fs.realpathSync(folder.uri.fsPath),fs.realpathSync(uri.fsPath)))throw new Error('Signature sources must remain inside an open workspace.');return uri;}
 async function send(method,params,cancellation){trusted(cancellation);let timer;try{const result=await Promise.race([request(method,params,cancellation),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Java Change Signature request timed out.')),30000);})]);trusted(cancellation);return result;}finally{clearTimeout(timer);}}
 async function snapshot(document){const uri=local(document.uri);if(document.isClosed||document.languageId!=='java')throw new Error('Open a Java source document first.');return {uri:uri.toString(),document,version:document.version,hash:hash(document.getText()),diskHash:hash(fs.readFileSync(uri.fsPath)),text:document.getText()};}
 function fresh(saved,cancellation){trusted(cancellation);for(const item of saved){const uri=local(item.uri);if(item.document.isClosed||item.document.version!==item.version||hash(item.document.getText())!==item.hash||hash(fs.readFileSync(uri.fsPath))!==item.diskHash)throw new Error('A Java signature source changed. Inspect it again.');}}
 async function declarationBarrier(anchor,target,documents,scope,cancellation){
  // Pinned JDT LS 1.63 joins document lifecycle jobs for the standard symbol
  // request, but its custom signature-info/edit requests do not join them.
  const symbols=await send('textDocument/documentSymbol',{textDocument:{uri:anchor.uri}},cancellation);fresh(documents,cancellation);scope.validate();
  const matches=[];function visit(values){for(const value of values||[]){if(value?.selectionRange&&[6,9].includes(value.kind)&&offset(anchor.text,value.selectionRange.start)===target.method.start&&offset(anchor.text,value.selectionRange.end)===target.method.end)matches.push(value);if(value?.children)visit(value.children);}}visit(symbols);
  const normalized=value=>value.replace(/\s+/g,'').replace(/java\.lang\./g,''),expected=target.method.name+'('+target.method.parameters.map(p=>p.type.raw).join(',')+')'+(target.methodTypeParameters||'');
  if(matches.length!==1||typeof matches[0].name!=='string'||normalized(matches[0].name)!==normalized(expected))throw new Error('Java declaration metadata is not synchronized with the selected source. Wait for analysis and inspect it again.');
 }
 async function info(document,range,{cancellation}={}){
  trusted(cancellation);const anchor=await snapshot(document),target=selectedMethod(anchor.text,anchor.uri,range,{advanced:typeof getJavaHome==='function'}),scope=projectScope(vscode,document,target.method.name),position=p=>({line:p.line,character:p.character}),params={textDocument:{uri:anchor.uri},range:{start:position(range.start),end:position(range.end)},context:{diagnostics:[]}};
  let semantic;
  if(target.advanced){
   const springContracts=analyzeSpringContracts(scope.contractSources),springContract=inspectSpringMethodContract(springContracts,{uri:anchor.uri,owner:target.owner.fqn,name:target.method.name,range});if(!springContract.allowed)throw new Error('Spring extension signature contract requires separate review: '+(springContract.reason||'source contract coverage is incomplete.'));
   const cp=await send('workspace/executeCommand',{command:'java.project.getClasspaths',arguments:[anchor.uri,{scope:'test'}]},cancellation);
   if(!cp||cp.modulepaths?.length||!Array.isArray(cp.classpaths||cp.classPaths))throw new Error('Observed plain Java project classpaths are required; module paths are not supported.');
   const settings=await send('workspace/executeCommand',{command:'java.project.getSettings',arguments:[anchor.uri,['org.eclipse.jdt.core.compiler.compliance','org.eclipse.jdt.core.compiler.source']]},cancellation),rawRelease=settings?.['org.eclipse.jdt.core.compiler.source']||settings?.['org.eclipse.jdt.core.compiler.compliance'];
   if(!/^\d+$/.test(String(rawRelease)))throw new Error('The Java engine did not provide a supported project language release.');
   const classpath=(cp.classpaths||cp.classPaths).filter(file=>fs.existsSync(file)),compilerOptions={javaHome:getJavaHome(),classpath,release:Number(rawRelease),storagePath:context.globalStorageUri?.fsPath,cancellation},before=await analyzeJavaSources({...compilerOptions,sources:scope.sources});fresh([anchor],cancellation);scope.validate();
   semantic=inspectSemanticFamily(before,anchor.uri,target.method.start);for(const member of semantic.family){const source=scope.sources.find(source=>uriKey(source.uri)===uriKey(member.uri)),contract=inspectSpringMethodContract(springContracts,{uri:source?.uri||member.uri,owner:member.owner,name:member.name});if(!contract.allowed)throw new Error('Spring extension family signature requires separate review: '+(contract.reason||'source contract coverage is incomplete.'));}semantic.compilerOptions=compilerOptions;semantic.validate=before.validateClasspath;semantic.before=before;
  }
  await declarationBarrier(anchor,target,[anchor],scope,cancellation);
  const signature=await send('java/getChangeSignatureInfo',params,cancellation);fresh([anchor],cancellation);
  if(!signature||signature.errorMessage||!signature.methodIdentifier||signature.methodName!==target.method.name||!Array.isArray(signature.parameters)||!Array.isArray(signature.exceptions))throw new Error(signature?.errorMessage||'The Java engine could not resolve this signature.');
  const spelling=value=>typeof value==='string'?value.replace(/\s+/g,'').replace(/java\.lang\./g,''):'';
  if(signature.parameters.length!==target.method.parameters.length||signature.parameters.length>30||signature.parameters.some((p,i)=>p.originalIndex!==i||p.name!==target.method.parameters[i].name||(semantic?spelling(p.type)!==spelling(target.method.parameters[i].type.raw):!SIMPLE_TYPES.has(p.type))))throw new Error('The Java engine signature does not match the reviewed declaration.');
  const references=await send('textDocument/references',{textDocument:{uri:anchor.uri},position:params.range.start,context:{includeDeclaration:false}},cancellation);if(!Array.isArray(references)||references.length>200)throw new Error('Signature references are incomplete or exceed the supported review limit.');
  const documents=new Map([[uriKey(anchor.uri),anchor]]);
  if(semantic){
   const relevant=new Set([...semantic.family,...semantic.calls,...semantic.methodReferences].map(item=>item.uri));
   for(const value of relevant){const uri=local(value);if(!inside(scope.root,fs.realpathSync(uri.fsPath)))throw new Error('A signature family or caller is outside the reviewed project.');if(!documents.has(uriKey(uri.toString())))documents.set(uriKey(uri.toString()),await snapshot(await vscode.workspace.openTextDocument(uri)));if(documents.size>30)throw new Error('Signature changes are limited to 30 source documents.');}
   for(const method of semantic.family){const saved=documents.get(uriKey(method.uri));const declaration=selectedMethod(saved.text,saved.uri,{start:positionAt(saved.text,method.nameStart),end:positionAt(saved.text,method.nameStart+method.name.length)},{advanced:true});await declarationBarrier(saved,declaration,[...documents.values()],scope,cancellation);}
  }
  for(const reference of references){const uri=local(reference.uri),key=uriKey(uri.toString());if(!inside(scope.root,fs.realpathSync(uri.fsPath)))throw new Error('Callers outside this Maven/Gradle project require a wider signature review.');let saved=documents.get(key);if(!saved){if(semantic)throw new Error('The engine reported a caller outside the compiler-resolved signature family.');saved=await snapshot(await vscode.workspace.openTextDocument(uri));documents.set(key,saved);}if(documents.size>30)throw new Error('Signature changes are limited to 30 source documents.');const referenceAt=offset(saved.text,reference.range.start);if(semantic){if(![...semantic.family,...semantic.calls,...semantic.methodReferences].some(item=>uriKey(item.uri)===key&&referenceAt>=(item.nameStart??item.start)&&referenceAt<=(item.end)))throw new Error('An indirect or unresolved reference requires separate signature review.');continue;}if(uriKey(saved.uri)===uriKey(anchor.uri)&&referenceAt===target.method.start)continue;const arity=callArguments(saved.text,reference.range,target.method.constructor);if(arity!==signature.parameters.length)throw new Error('A caller has an unresolved argument list.');}
  fresh([...documents.values()],cancellation);
  for(const saved of documents.values()){const tokens=lexJava(saved.text).tokens;if(tokens.some(t=>(t.kind==='string'||t.kind==='text-block')&&typeof t.value==='string'&&t.value.includes(signature.methodName)))throw new Error('A known string or reflection reference needs a separate contract review.');}
  for(const [id,saved]of infos)if(Date.now()>saved.expiresAt)infos.delete(id);while(infos.size>=10)infos.delete(infos.keys().next().value);
  scope.validate();const id=crypto.randomUUID(),record={id,signature:structuredClone(signature),target,params,anchor,scope,semantic,documents:[...documents.values()],references:semantic?semantic.calls.length+semantic.methodReferences.length:references.length,expiresAt:Date.now()+120000};infos.set(id,record);
  return {id,...structuredClone(signature),references:record.references,adaptableMethodReferences:semantic?.methodReferences.length||0,familyDeclarations:semantic?.family.length||1,genericContractsVerified:!!semantic?.family.some(method=>method.generic),expiresAt:record.expiresAt,scope:semantic?'Compiler-resolved source families, exact direct callers and supported Java method reference adapters within this project.':'Plain non-polymorphic source declarations and resolved direct callers; framework, reflection, external binaries and advanced Java contracts are not verified.'};
 }
 async function preview(id,changes,{cancellation}={}){
  trusted(cancellation);const record=infos.get(id);if(!record||Date.now()>record.expiresAt)throw new Error('The signature inspection expired. Inspect it again.');fresh(record.documents,cancellation);record.scope.validate();record.semantic?.validate();
  if(!changes||Object.keys(changes).some(k=>k!=='parameters')||!Array.isArray(changes.parameters)||changes.parameters.length>30)throw new Error('Change Signature currently accepts only an ordered parameters list.');
  const parameters=[],indices=new Set(),names=new Set();
  for(const input of changes.parameters){if(!input||Object.keys(input).some(k=>!['originalIndex','name','type','defaultValue'].includes(k))||!Number.isInteger(input.originalIndex)||input.originalIndex< -1||input.originalIndex>=record.signature.parameters.length||!identifier(input.name)||names.has(input.name)||typeof input.type!=='string'||input.originalIndex<0&&!SIMPLE_TYPES.has(input.type))throw new Error('Parameter indices, names or types are invalid or duplicated.');names.add(input.name);
   if(input.originalIndex===-1){if(!scalar(input.defaultValue,input.type))throw new Error('New parameters require a compatible, side-effect-free literal default value.');if(record.target.bodyTokens.some(t=>t.kind==='id'&&t.text===input.name)||record.semantic?.family.some(method=>method.bodyIdentifiers.includes(input.name)||method.parameters.some(p=>p.name===input.name)))throw new Error('The new parameter name conflicts with an existing family method-body identifier.');parameters.push({originalIndex:-1,name:input.name,type:input.type,defaultValue:input.defaultValue});}
   else{const original=record.signature.parameters[input.originalIndex];if(indices.has(input.originalIndex)||input.name!==original.name||input.type!==original.type)throw new Error('Existing parameter names and types must remain unchanged; only their order or removal is supported.');indices.add(input.originalIndex);parameters.push(structuredClone(original));}
  }
  for(const original of record.signature.parameters)if(!indices.has(original.originalIndex)&&record.target.bodyTokens.some(t=>t.kind==='id'&&t.text===original.name))throw new Error('The removed parameter '+original.name+' is still used by the method body.');
  if(record.semantic)for(const method of record.semantic.family)for(const [index,parameter]of method.parameters.entries())if(!indices.has(index)&&parameter.used)throw new Error('The removed parameter '+parameter.name+' is still used by a family method body.');
  if(JSON.stringify(parameters)===JSON.stringify(record.signature.parameters))throw new Error('The signature has no parameter changes.');
  await declarationBarrier(record.anchor,record.target,record.documents,record.scope,cancellation);
  // In pinned JDT LS 1.63 this last flag only wraps edits in blanket confirmation
  // annotations. Rocketbrain performs its own complete diff and modal review.
  // It does not bypass the engine's initial/final refactoring checks.
  const s=record.signature,response=await send('java/getRefactorEdit',{command:'changeSignature',context:record.params,commandArguments:[s.methodIdentifier,false,s.methodName,s.modifier,s.returnType,parameters,s.exceptions,false]},cancellation);fresh(record.documents,cancellation);
  if(!response||response.errorMessage||response.confirmationToken||response.command||!response.edit)throw new Error(response?.errorMessage||'The Java engine refused the change or requires an unsupported interaction.');
  const expectedTargets=new Set(record.documents.map(saved=>fileKey(local(saved.uri).fsPath))),anchorKey=fileKey(record.anchor.document.uri.fsPath),targets=Object.entries(response.edit.changes||{});let declarationEdited=false;
  for(const change of response.edit.documentChanges||[]){if(!change.textDocument||!Array.isArray(change.edits))throw new Error('Signature edits may only change the inspected declaration and direct source callers.');targets.push([change.textDocument.uri,change.edits]);}
  for(const [value,edits]of targets){const uri=local(value),key=fileKey(uri.fsPath);if(!inside(record.scope.root,fs.realpathSync(uri.fsPath))||!expectedTargets.has(key))throw new Error('The Java engine returned a signature edit outside the inspected declaration and direct source callers.');if(!Array.isArray(edits))throw new Error('The Java engine returned invalid signature edits.');if(key===anchorKey&&edits.length)declarationEdited=true;}
  if(!declarationEdited)throw new Error('The Java engine did not edit the inspected signature declaration.');
  let edit=response.edit,adapters=[];
  if(record.semantic){
   let sources=editedSources(record.scope.sources,targets);
   if(record.semantic.methodReferences.length){
    if(targets.some(([,edits])=>edits.some(value=>value.annotationId)))throw Error('Annotated signature changes require separate review.');
    const adapted=adaptSignatureReferences(record.scope.sources,sources,record.semantic.methodReferences,parameters);
    adapters=adapted.adapters;
    const replacements=new Map([...adapted.changed].map(([uri,text])=>[uriKey(uri),{uri,text}]));
    sources=sources.map(source=>replacements.has(uriKey(source.uri))?{...source,text:replacements.get(uriKey(source.uri)).text}:source);
    edit={...response.edit,
     changes:Object.fromEntries(Object.entries(response.edit.changes||{}).filter(([uri])=>!replacements.has(uriKey(uri)))),
     ...(response.edit.documentChanges&&{documentChanges:response.edit.documentChanges.filter(change=>
      !replacements.has(uriKey(change.textDocument.uri)))})};
    for(const [key,{uri,text}] of replacements){
     const original=record.documents.find(saved=>uriKey(saved.uri)===key).text;
     edit.changes[uri]=[{range:{start:{line:0,character:0},end:positionAt(original,original.length)},newText:text}];
    }
   }
   const after=await analyzeJavaSources({...record.semantic.compilerOptions,cancellation,sources});
   fresh(record.documents,cancellation);record.scope.validate();record.semantic.validate();verifySemanticChange(record.semantic,after,parameters,adapters);
  }
  const validate=()=>{fresh(record.documents,cancellation);record.scope.validate();record.semantic?.validate();},plan=await refactoring.previewWorkspaceEdit(edit,{title:'Change Signature · '+s.methodName,kind:'refactor.rewrite.changeSignature',anchorDocument:record.anchor.document,cancellation,guards:record.documents.map(({uri,version,hash,diskHash})=>({uri,version,hash,diskHash})),validate,preApply:validate});validate();infos.delete(id);return {...plan,signature:{methodName:s.methodName,before:structuredClone(s.parameters),after:parameters,resolvedReferences:record.references,adaptedMethodReferences:adapters.length,contractFiles:record.scope.files,familyDeclarations:record.semantic?.family.length||1,overloadBindingsVerified:!!record.semantic,genericContractsVerified:!!record.semantic?.family.some(method=>method.generic)},limitations:['Only the reviewed project source callers are covered.','Computed reflection and external binary callers require a separate review.']};
 }
 function tracked(fn){return(...args)=>{const operation=fn(...args);operations.add(operation);void operation.finally(()=>operations.delete(operation)).catch(()=>{});return operation;};}
 const command=vscode.commands.registerCommand('rocketbrain.java.changeSignature',async()=>{try{const editor=vscode.window.activeTextEditor;if(!editor)throw new Error('Select a Java method declaration.');const discovered=await api.info(editor.document,editor.selection),value=await vscode.window.showInputBox({title:'Change Signature · '+discovered.methodName,prompt:'Edit parameter order; remove unused parameters; add {originalIndex:-1,type,name,defaultValue} using a literal default.',value:JSON.stringify({parameters:discovered.parameters}),ignoreFocusOut:true});if(value===undefined)return;let changes;try{changes=JSON.parse(value);}catch{throw new Error('Enter a valid JSON parameters list.');}const plan=await api.preview(discovered.id,changes);return await refactoring.review(plan);}catch(error){if(!closed)void vscode.window.showErrorMessage('Rocketbrain Java: '+error.message);}});
 const api={info:tracked(info),preview:tracked(preview),async dispose(){closed=true;infos.clear();command.dispose();await Promise.allSettled([...operations]);}};return api;
}
module.exports={registerJavaChangeSignature,selectedMethod,callArguments,scalar,inspectSemanticFamily,verifySemanticChange,editedSources};
