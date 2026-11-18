'use strict';
const {parseJavaFile,lexJava}=require('../spring/java'),S=require('./move-scope');
const primitive=new Set(['boolean','byte','short','int','long','char','float','double','String']);
const literal=token=>token&&(['number','string','char'].includes(token.kind)||['true','false'].includes(token.text));
const words=tokens=>tokens.map(token=>token.text).join(' ');
function fieldTokens(model,field){
 const tokens=model.tokens,at=tokens.findIndex(token=>token.start===field.start);let begin=at-1,end=at+1;
 while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;
 while(end<tokens.length&&tokens[end].text!==';')end++;
 if(at<0||!tokens[end]||field.annotations.length||words(tokens.slice(begin+1,at))!=='private final '+field.type.raw)throw Error('Instance Move state requires private final fields without annotations or additional modifiers.');
 const value=tokens.slice(at+2,end);
 if(tokens[at+1]?.text!=='='||!value.length)throw Error('Instance Move state requires an explicit immutable field initializer.');
 return {field,value,tokens:tokens.slice(begin+1,end+1)};
}
function tokensFor(text,uri,{targetName,role='target'}={}){
 const parsed=parseJavaFile({text,uri}),lex=lexJava(text),type=parsed.types[0];
 if(parsed.issues.length||lex.issues.length||parsed.types.length!==1||type.kind!=='class'||type.superTypes.length||type.annotations.length||lex.tokens.filter(token=>token.text==='class').length!==1||lex.tokens.some(token=>['import','@','extends','implements','this','super','static','synchronized','volatile','transient'].includes(token.text)))throw Error('Instance Move requires plain final classes without imports, annotations, inheritance or unreviewed source receiver state.');
 const at=lex.tokens.findIndex(token=>token.start===type.start);
 if(words(lex.tokens.slice(at-3,at))!=='public final class'||lex.tokens[at+1]?.text!=='{'||type.methods.some(method=>method.constructor)||lex.tokens.filter(token=>token.text==='{').length!==type.methods.length+1)throw Error('Instance Move requires public final classes with implicit constructors and no initializer blocks.');
 const model={parsed,type,tokens:lex.tokens,fields:[]};
 if(new Set(type.fields.map(field=>field.name)).size!==type.fields.length)throw Error('Instance Move requires unique immutable field identities.');
 for(const field of type.fields){
  const shape=fieldTokens(model,field),isLiteral=primitive.has(field.type.raw)&&shape.value.length===1&&literal(shape.value[0]);
  const isTarget=role==='source'&&field.type.raw===targetName&&words(shape.value)==='new '+targetName+' ( )';
  if(!isLiteral&&!isTarget)throw Error('Instance Move fields require primitive/String literal state or a source-owned final target initialized with a new implicit constructor.');
  model.fields.push({...shape,kind:isTarget?'target':'literal'});
 }
 return model;
}
function methodTokens(model,method){
 const tokens=model.tokens,index=tokens.findIndex(token=>token.start===method.start);let begin=index-1;
 while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;
 let open=index;while(open<tokens.length&&tokens[open].text!=='{')open++;
 let end=open+1;while(end<tokens.length&&tokens[end].text!=='}')end++;
 if(!tokens[end]||tokens.slice(open+1,end).some(token=>token.text==='{')||words(tokens.slice(begin+1,index))!=='public '+method.type.raw||!primitive.has(method.type.raw)||method.annotations.length)throw Error('Instance Move supports public primitive/String concrete methods without annotations.');
 return {header:tokens.slice(begin+1,open),body:tokens.slice(open+1,end),all:tokens.slice(begin+1,end+1),open,end};
}
function inspectInstanceMove(sourceText,sourceUri,targetText,targetUri,offset,targetParameter){
 const target=tokensFor(targetText,targetUri),source=tokensFor(sourceText,sourceUri,{targetName:target.type.name,role:'source'});
 if(source.parsed.packageName!==target.parsed.packageName||!source.parsed.packageName||source.type.name===target.type.name)throw Error('Instance Move currently requires different classes in the same named Java package.');
 const method=source.type.methods.find(candidate=>offset>=candidate.start&&offset<=candidate.end);
 if(!method||source.type.methods.filter(candidate=>candidate.name===method.name).length!==1||target.type.methods.some(candidate=>candidate.name===method.name))throw Error('Select a unique non-overloaded instance method absent from the target.');
 const first=method.parameters[0],parameter=first?.name===targetParameter&&first.type.raw===target.type.name?first:null;
 const field=source.fields.find(shape=>shape.field.name===targetParameter&&shape.kind==='target');
 if(parameter&&parameter.annotations.length||!parameter&&!field||!parameter&&method.parameters.some(candidate=>candidate.name===targetParameter))throw Error('Instance Move requires an explicit first target parameter or a definitely non-null private final target field.');
 const receiver=parameter?{...parameter,isField:false}:{...field.field,isField:true},parameters=parameter?method.parameters.slice(1):method.parameters;
 if(parameters.some(candidate=>!primitive.has(candidate.type.raw)||candidate.annotations.length))throw Error('Instance Move requires plain primitive/String parameters after the explicit target receiver or on the field-receiver method.');
 const getters=new Set();
 for(const candidate of target.type.methods){
  const shape=methodTokens(target,candidate),value=shape.body[1],state=target.fields.find(item=>item.field.name===value?.text&&item.kind==='literal');
  if(candidate.parameters.length||shape.body.length!==3||shape.body[0].text!=='return'||shape.body[2].text!==';'||!literal(value)&&!(state&&state.field.type.raw===candidate.type.raw)||getters.has(candidate.name))throw Error('Instance Move destination methods must be public no-argument literal getters or exact-type getters over private final literal fields.');
  getters.add(candidate.name);
 }
 const selected=methodTokens(source,method),expression=selected.body.slice(1,-1),names=new Set(parameters.map(candidate=>candidate.name));
 if(selected.body[0]?.text!=='return'||selected.body.at(-1)?.text!==';'||!expression.length)throw Error('Instance Move requires one pure return expression.');
 let targetUses=0;for(let i=0;i<expression.length;i++){
  const token=expression[i];
  if(token.text===receiver.name){if(expression[i+1]?.text!=='.'||!getters.has(expression[i+2]?.text)||expression[i+3]?.text!=='('||expression[i+4]?.text!==')')throw Error('The target receiver may only invoke a reviewed immutable literal getter.');i+=4;targetUses++;continue;}
  if(token.kind==='id'&&!names.has(token.text)&&!['true','false'].includes(token.text)||token.kind==='symbol'&&!['+','-','*','/','%','(',')','?',':','!','<','>','=','&','|','^','~'].includes(token.text)||!['id','symbol','number','string','char'].includes(token.kind))throw Error('Instance Move return expressions cannot use source state, arbitrary calls or effects.');
 }
 if(!targetUses)throw Error('The moved method must actually use its target receiver.');
 const calls=[],wrappers=[];
 for(const candidate of source.type.methods){
  if(candidate===method)continue;
  const shape=methodTokens(source,candidate),body=shape.body;
  if(candidate.parameters.length||body[0]?.text!=='return'||body[1]?.text!==method.name||body[2]?.text!=='('||body.at(-2)?.text!==')'||body.at(-1)?.text!==';')throw Error('Instance Move callers must be no-argument source-owner wrappers invoking the method directly with literal arguments.');
  let argumentsTokens=body.slice(3,-2);
  if(!receiver.isField){if(words(argumentsTokens.slice(0,4))!=='new '+target.type.name+' ( )')throw Error('Instance Move callers require a new non-null target and literal arguments.');argumentsTokens=argumentsTokens.slice(4);if(parameters.length){if(argumentsTokens[0]?.text!==',')throw Error('Instance Move caller argument arity differs from the selected method.');argumentsTokens=argumentsTokens.slice(1);}}
  const argumentsList=[];for(let i=0;i<argumentsTokens.length;i+=2){if(!literal(argumentsTokens[i])||i+1<argumentsTokens.length&&argumentsTokens[i+1]?.text!==',')throw Error('Instance Move arguments must be side-effect-free literal values.');argumentsList.push(argumentsTokens[i]);}
  if(argumentsList.length!==parameters.length||argumentsTokens.length&&argumentsTokens.length!==argumentsList.length*2-1)throw Error('Instance Move caller argument arity differs from the selected method.');
  calls.push(body[1].start);wrappers.push({method:candidate,arguments:argumentsTokens});
 }
 if(!calls.length)throw Error('Instance Move requires an observed definitely non-null source-owner call.');
 return {source,target,method,receiver,parameters,calls,wrappers,selected,selection:method.start,immutableState:source.fields.length>0||target.fields.length>0};
}
function matchesReviewedTokens(actual,expected){
 let at=0;
 for(const token of expected){
  if(token.allowThis===true&&actual[at]?.text==='this'&&actual[at+1]?.text==='.')at+=2;
  if(actual[at++]?.text!==token.text)return false;
 }
 return at===actual.length;
}
function restoreReceiverEncapsulation(model,sources,entries){
 if(!model.receiver.isField)return {entries,normalization:{receiverVisibilityRestored:false}};
 const source=sources.find(item=>item.uri===model.source.parsed.uri),transformed=S.transformed(sources,entries),after=transformed.find(item=>item.uri===source.uri),parsed=parseJavaFile(after),tokens=lexJava(after.text).tokens,field=parsed.types[0]?.fields.find(item=>item.name===model.receiver.name),before=model.source.fields.find(item=>item.field.name===model.receiver.name);
 if(!source||!field||parsed.issues.length)throw Error('The field-receiver engine result cannot establish its original encapsulation.');
 const at=tokens.findIndex(token=>token.start===field.start);let begin=at-1,end=at+1;while(begin>=0&&!['{','}',';'].includes(tokens[begin].text))begin--;while(end<tokens.length&&tokens[end].text!==';')end++;
 const declaration=tokens.slice(begin+1,end+1),original=words(before.tokens);
 if(words(declaration)===original)return {entries,normalization:{receiverVisibilityRestored:false}};
 if(words(declaration)!==words(before.tokens.slice(1))||tokens[begin+1]?.text!=='final'||before.tokens[0]?.text!=='private')throw Error('The field-receiver engine changed more than the observed private visibility removal.');
 const corrected=after.text.slice(0,tokens[begin+1].start)+'private '+after.text.slice(tokens[begin+1].start),lines=source.text.split('\n'),replace={range:{start:{line:0,character:0},end:{line:lines.length-1,character:lines.at(-1).length}},newText:corrected};
 const normalized=entries.map(entry=>entry.textDocument.uri===source.uri?{...entry,edits:[replace]}:entry);
 return {entries:normalized,normalization:{receiverVisibilityRestored:true,kind:'restore-exact-original-private-final-receiver',field:model.receiver.name,originalDeclaration:original,engineDeclaration:words(declaration),independentCorrection:'private prefix restored before exact state/call/member and before/after compiler validation'}};
}
function inspectStatefulResult(model,sourceText,targetText){
 // Compilation alone does not prove receiver order. Retain the original state
 // and require the engine to perform exactly the bounded reviewed relocation.
 const parse=(text,uri)=>{const parsed=parseJavaFile({text,uri}),lex=lexJava(text),type=parsed.types[0],at=lex.tokens.findIndex(token=>token.start===type?.start);if(parsed.issues.length||lex.issues.length||parsed.types.length!==1||type.kind!=='class'||words(lex.tokens.slice(at-3,at))!=='public final class'||lex.tokens[at+1]?.text!=='{'||type.methods.some(method=>method.constructor)||lex.tokens.filter(token=>token.text==='{').length!==type.methods.length+1||lex.tokens.filter(token=>token.text==='class').length!==1)throw Error('The stateful instance Move result has unreviewed Java structure or lifecycle.');return {parsed,type,tokens:lex.tokens};};
 const source=parse(sourceText,model.source.parsed.uri),target=parse(targetText,model.target.parsed.uri);
 for(const [before,after]of [[model.source,source],[model.target,target]]){
  if(after.type.fqn!==before.type.fqn||after.type.superTypes.length||after.type.annotations.length||words(after.tokens.filter(token=>['import','@','extends','implements','static','synchronized','volatile','transient'].includes(token.text))))throw Error('The stateful instance Move changed owner identity or lifecycle.');
  if(after.type.fields.length!==before.fields.length)throw Error('The stateful instance Move changed immutable field membership.');
  for(const field of before.fields){const moved=after.type.fields.find(candidate=>candidate.name===field.field.name);if(!moved||words(fieldTokens(after,moved).tokens)!==words(field.tokens))throw Error('The stateful instance Move changed an immutable field initializer or ownership.');}
 }
 const moved=target.type.methods.find(candidate=>candidate.name===model.method.name);
 if(source.type.methods.some(candidate=>candidate.name===model.method.name)||!moved||target.type.methods.length!==model.target.type.methods.length+1||source.type.methods.length!==model.source.type.methods.length-1||moved.parameters.length!==model.parameters.length||moved.parameters.some((parameter,index)=>parameter.name!==model.parameters[index].name||parameter.type.raw!==model.parameters[index].type.raw)||moved.type.raw!==model.method.type.raw)throw Error('The stateful instance Move must relocate exactly the reviewed method and parameters.');
 const expected=[];for(let i=0;i<model.selected.body.length;i++){
  const token=model.selected.body[i];
  if(token.text===model.receiver.name){expected.push({text:model.selected.body[i+2].text,allowThis:true},model.selected.body[i+3],model.selected.body[i+4]);i+=4;continue;}
  expected.push({text:token.text});
 }
 if(!matchesReviewedTokens(methodTokens(target,moved).body,expected))throw Error('The stateful instance Move changed the pure return expression, Java field/parameter binding or receiver evaluation.');
 for(const original of model.target.type.methods){const current=target.type.methods.find(candidate=>candidate.name===original.name);if(!current||words(methodTokens(target,current).all)!==words(methodTokens(model.target,original).all))throw Error('The stateful instance Move changed an existing destination getter.');}
 for(const wrapper of model.wrappers){const current=source.type.methods.find(candidate=>candidate.name===wrapper.method.name);if(!current||current.parameters.length||current.type.raw!==wrapper.method.type.raw)throw Error('The stateful instance Move changed source-owner callers.');const body=methodTokens(source,current).body,receiver=model.receiver.isField?[{text:model.receiver.name,allowThis:true}]:['new',model.target.type.name,'(',')'].map(text=>({text})),expected=[{text:'return'},...receiver,{text:'.'},{text:model.method.name},{text:'('},...wrapper.arguments.map(token=>({text:token.text})),{text:')'},{text:';'}];if(!matchesReviewedTokens(body,expected))throw Error('The stateful instance Move changed call evaluation or introduced source-state passing.');}
 return {immutableFieldsPreserved:true,ownerOnlyLiteralCallsPreserved:true,returnExpressionPreserved:true,receiverNonNullByFinalInitializer:model.receiver.isField,receiverKind:model.receiver.isField?'field':'parameter'};
}
async function prepareInstanceMove(deps,document,range,targetDocument,{targetParameter,cancellation}={}){
 const {vscode,send,trusted,refactoring,runtime,synchronizeFiles,memberMoveParameters,protocolOffset}=deps;trusted(cancellation);for(const doc of [document,targetDocument])if(doc?.uri?.scheme!=='file'||doc.languageId!=='java'||doc.isDirty||doc.isClosed)throw Error('Open and save local source and target Java classes before Instance Move.');
 const params=memberMoveParameters(document.uri.toString(),range),text=document.getText(),offset=protocolOffset(text,params.range.start),model=inspectInstanceMove(text,document.uri.toString(),targetDocument.getText(),targetDocument.uri.toString(),offset,targetParameter);
 if(synchronizeFiles)await synchronizeFiles([{uri:document.uri.toString(),type:1},{uri:targetDocument.uri.toString(),type:1}]);for(const doc of [document,targetDocument]){const symbols=await send('textDocument/documentSymbol',{textDocument:{uri:doc.uri.toString()}},cancellation);if(!symbols?.length)throw Error('Wait for both instance Move classes to finish importing.');}
 const scope=await S.moveScope(vscode,send,document.uri,targetDocument.uri,cancellation);if(!scope.same)throw Error('Instance Move currently requires the same imported Java project.');const sources=await S.snapshotScope(scope,vscode,trusted,cancellation),guard=S.scopeGuards(scope,sources,vscode,trusted,cancellation);
 for(const source of sources){if(source.uri!==document.uri.toString()&&(lexJava(source.text).tokens.some(token=>token.text===model.method.name||['string','char','text-block'].includes(token.kind)&&(token.value===model.method.name||token.kind==='text-block'&&token.text.includes(model.method.name)))||!source.file.endsWith('.java')&&source.text.includes(model.method.name))||/\b(?:Class\s*\.\s*forName|loadClass|ServiceLoader|ClassLoader|getDeclaredMethod|getMethod|MethodHandles|ReflectionUtils)\b/.test(source.text))throw Error('Instance Move cannot preserve external, reflective or effectful selected-method clients.');
 }
 const references=await send('textDocument/references',{textDocument:{uri:document.uri.toString()},position:params.range.start,context:{includeDeclaration:true}},cancellation),expected=new Set([model.selection,...model.calls]);if(!Array.isArray(references)||references.length!==expected.size)throw Error('The instance Move reference model does not match all reviewed declaration/call positions.');for(const reference of references){if(S.key(vscode.Uri.parse(reference.uri).fsPath)!==S.key(document.uri.fsPath)||!expected.delete(protocolOffset(text,reference.range?.start)))throw Error('Instance Move found a caller outside its definitely non-null pure owner scope.');}if(expected.size)throw Error('Instance Move reference coverage is incomplete.');
 const destinations=await send('java/getMoveDestinations',{moveKind:'moveInstanceMethod',params},cancellation);if(destinations?.errorMessage)throw Error(destinations.errorMessage);const matches=destinations?.destinations?.filter(item=>item?.name===targetParameter&&item.type===model.target.type.name&&item.isField===model.receiver.isField&&typeof item.bindingKey==='string');if(matches?.length!==1)throw Error('The Java engine did not offer the exact reviewed instance receiver binding.');guard();
 const response=await send('java/move',{moveKind:'moveInstanceMethod',params,destination:{...matches[0]},updateReferences:true},cancellation);if(response?.errorMessage||response?.confirmationToken)throw Error('The Java engine requires a separate instance Move conflict review: '+(response.errorMessage||'confirmation'));const normalized=restoreReceiverEncapsulation(model,sources,S.textEntries(response?.edit,sources)),entries=normalized.entries,after=S.transformed(sources,entries);if(!entries.some(entry=>entry.textDocument.uri===document.uri.toString())||!entries.some(entry=>entry.textDocument.uri===targetDocument.uri.toString()))throw Error('The Java engine did not relocate the instance method.');for(const [uri,count]of [[document.uri.toString(),0],[targetDocument.uri.toString(),1]])if(parseJavaFile({uri,text:after.find(source=>source.uri===uri).text}).types.flatMap(type=>type.methods).filter(method=>method.name===model.method.name).length!==count)throw Error('The Java engine did not move exactly the selected instance declaration.');
 const immutableState=model.immutableState?inspectStatefulResult(model,after.find(source=>source.uri===document.uri.toString()).text,after.find(source=>source.uri===targetDocument.uri.toString()).text):null;
 const compiled=await S.validateCompilation(scope,sources,entries,null,runtime,cancellation),preApply=()=>{guard();compiled.validate();};preApply();const plan=await refactoring.previewWorkspaceEdit({documentChanges:entries},{title:'Move '+model.method.name+' to '+model.target.type.name,kind:'refactor.move.instanceMethod',anchorDocument:document,cancellation,guards:sources.map(source=>({uri:source.uri})),validate:async()=>{await S.validateScope(scope,vscode,send,document.uri,targetDocument.uri,cancellation);preApply();},preApply,warnings:['Only saved source-owner calls with literal arguments and a proven non-null target are admitted. Immutable private final literal state is retained on its original owner. Mutable state, custom constructors, binary, external and reflective clients require separate analysis.']});
 return {...plan,memberMove:{kind:'instance-method',member:model.method.name,source:model.source.type.fqn,destination:model.target.type.fqn,targetParameter,receiverKind:model.receiver.isField?'field':'parameter',immutableState,normalization:normalized.normalization,reviewedCalls:model.calls.length,reviewedFiles:sources.length,semantic:compiled.report,scope:'Final same-package owners; first target parameter or private final target field initialized with a new implicit constructor; primitive/String parameters; pure getters over literal or private final literal state; owner-only literal calls. State mutation, source-state passing, nullable/effectful receivers, custom constructors, external calls, overloads, hierarchy and annotations require separate analysis.'}};
}
module.exports={inspectInstanceMove,inspectStatefulResult,restoreReceiverEncapsulation,prepareInstanceMove};
