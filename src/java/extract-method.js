'use strict';

const {validIdentifier}=require('./file-templates');
const {rangeAt}=require('../spring/java');
const {editedText}=require('./refactoring');

const BODY_FIELDS=['owner','staticMethod','returnsValue','returnType','sourceTypeParameters','typeNames','throwsTypes','statementCount','selected','bindings','outputs'];
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const shape=({name,type})=>({name,type});

function validateMethodName(name) {
  return validIdentifier(name)?undefined:'Enter a valid Java method name.';
}

function buildMethodExtraction(text,proof,name) {
  if (proof?.error) throw Error(proof.error);
  if (!proof||validateMethodName(name)) throw Error('Select complete Java statements and enter a valid helper name.');
  const {start,end,methodStart,methodEnd,staticMethod,className,typeNames,returnsValue,sourceReturn,sourceTypeParameters,sourceThrows,captures}=proof;
  const outputs=proof.outputs||[];
  if (![start,end,methodStart,methodEnd].every(Number.isSafeInteger)||methodStart<0||start<=methodStart||end<=start||
      methodEnd<=end||methodEnd>text.length||captures.length>16) throw Error('Extract up to sixteen distinct captured Java variables.');
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const linePrefix=offset=>text.slice(text.lastIndexOf('\n',offset-1)+1,offset);
  const declarationIndent=linePrefix(methodStart),bodyIndent=linePrefix(start);
  if (!/^[ \t]*$/.test(declarationIndent)||!/^[ \t]+$/.test(bodyIndent)) {
    throw Error('Select statements and a method that begin on their own source lines.');
  }
  const following=text.indexOf('\n',methodEnd);
  const insertion=following<0?methodEnd:following+1;
  if (following<0||!/^[ \t\r]*(?:\/\/[^\r\n]*)?\r?$/.test(text.slice(methodEnd,following))) {
    throw Error('The Java method closing brace must end its source line.');
  }
  const selected=text.slice(start,end);
  const captureNames=captures.map(capture=>capture.name);
  const argumentsText=captureNames.join(', ');
  const qualifier=staticMethod?className:'this';
  const call=qualifier+'.'+(typeNames.length?'<'+typeNames.join(', ')+'>':'')+name+'('+argumentsText+')';
  const resultType=name[0].toUpperCase()+name.slice(1)+'Values';
  const resultVariable=name+'Result';
  const prefix=outputs.length?resultType+' '+resultVariable+' = ':returnsValue?'return ':'';
  const invocation=[prefix+call+';',...outputs.map(({name:local,type,final},index)=>
    (final?'final ':'')+type+' '+local+' = '+resultVariable+'.value'+index+'();')].join(eol+bodyIndent);
  const generics=sourceTypeParameters.length?'<'+sourceTypeParameters.join(', ')+'> ':'';
  const throwsClause=sourceThrows.length?' throws '+sourceThrows.join(', '):'';
  const parameters=captures.map(capture=>capture.type+' '+capture.name).join(', ');
  const methodHead=eol+declarationIndent+'private '+(staticMethod?'static ':'')+generics+(outputs.length?resultType:sourceReturn)+' '+name+
    '('+parameters+')'+throwsClause+' {'+eol+bodyIndent;
  const returnOutputs=outputs.length?eol+bodyIndent+'return new '+resultType+'('+outputs.map(value=>value.name).join(', ')+');':'';
  const resultDefinition=outputs.length?eol+declarationIndent+'private record '+resultType+'('+
    outputs.map(({type},index)=>type+' value'+index).join(', ')+') {}'+eol:'';
  const helper=methodHead+selected+returnOutputs+eol+declarationIndent+'}'+eol+resultDefinition;
  const newStart=insertion+invocation.length-selected.length+methodHead.length;
  const edits=[{range:rangeAt(text,start,end),newText:invocation},{range:rangeAt(text,insertion,insertion),newText:helper}];
  return {edits,text:editedText(text,edits),start:newStart,end:newStart+selected.length,callOffset:start+prefix.length};
}

function verifyMethodExtraction(before,after) {
  if (!after||after.error||!after.call||BODY_FIELDS.some(key=>!same(before[key],after[key]))||
      !same(before.captures,after.call.arguments)||!same(before.captures.map(shape),after.parameters.map(shape))||
      !same(before.captures.map(shape),after.captures.map(shape))||after.call.caller!==before.method||
      after.call.type!==(before.outputs?.length?after.outputType:before.returnType)) {
    throw Error('Javac could not verify the extracted body, captures or the replacement call.');
  }
}

module.exports={validateMethodName,buildMethodExtraction,verifyMethodExtraction};
