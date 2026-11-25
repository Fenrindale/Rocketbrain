'use strict';

const {lexJava,rangeAt}=require('../spring/java');
const {validIdentifier}=require('./file-templates');
const {editedText}=require('./refactoring');

const UNDEFINED_TYPE='16777218';
const NOT_RESOLVED=new Set(['compiler.err.cant.resolve.location','compiler.err.cant.resolve']);
const qualified=value=>typeof value==='string'&&value.length<1024&&value.includes('.')&&value.split('.').every(validIdentifier);

function typeImportCandidates(actions,simpleName) {
  const candidates=new Set();
  for(const action of (Array.isArray(actions)?actions:[]).slice(0,100)) {
    if(action?.disabled||action?.kind!=='quickfix'||typeof action.title!=='string')continue;
    const match=/^Import ['‘]([^'’]+)['’] \(([^)]+)\)$/.exec(action.title);
    if(match?.[1]===simpleName&&qualified(match[2]+'.'+simpleName))candidates.add(match[2]+'.'+simpleName);
  }
  return [...candidates];
}

function typeImportSelection(text,start,end) {
  const {tokens,issues}=lexJava(text);
  if(issues.length)throw Error('Resolve ambiguous Java source tokens before adding an import.');
  const matches=tokens.filter(token=>token.kind==='id'&&start>=token.start&&end<=token.end&&start<=end&&
    (start<token.end||end>start));
  const selected=matches.length===1?matches[0]:undefined;
  if(!selected||!validIdentifier(selected.text))throw Error('Select an unresolved Java type name.');
  return {name:selected.text,start:selected.start,end:selected.end};
}

function confirmUnresolvedType(text,selection,uri,errors) {
  const {tokens,issues}=lexJava(text);
  const occurrences=tokens.filter(token=>token.kind==='id'&&token.text===selection.name);
  const key=({start,end})=>start+':'+end;
  const observed=new Set(errors.filter(error=>error.uri===uri&&NOT_RESOLVED.has(error.code)).map(key));
  if(issues.length||!errors.length||observed.size!==errors.length||occurrences.length!==observed.size||
      !observed.has(key(selection))||!occurrences.every(token=>observed.has(key(token)))) {
    throw Error('Javac could not confirm that only the selected unresolved type uses will change.');
  }
  return occurrences;
}

function typeImportDraft(text,selection,fqn,occurrences) {
  if(!qualified(fqn)||fqn.split('.').at(-1)!==selection.name)throw Error('Select a matching qualified Java type.');
  const {tokens,issues}=lexJava(text);
  if(issues.length||!tokens.length)throw Error('Resolve ambiguous Java source tokens before adding an import.');
  const eol=text.includes('\r\n')?'\r\n':'\n';
  let at=0,previous;
  while(['package','import'].includes(tokens[at]?.text)) {
    const start=at++;
    while(at<tokens.length&&tokens[at].text!==';')at++;
    if(at===tokens.length)throw Error('Complete the Java package and import declarations first.');
    const declaration=tokens.slice(start,at+1);
    if(declaration[0].text==='import'&&declaration.slice(1,-1).map(token=>token.text).join('')===fqn) {
      throw Error('The selected Java type is already imported.');
    }
    previous=tokens[at++];
  }
  let insertion=previous?.end??tokens[0].start;
  if(insertion>selection.start)throw Error('Select an unresolved type outside the package and import declarations.');
  let replacement='import '+fqn+';'+eol;
  if(previous) {
    const nextLine=text.indexOf('\n',insertion);
    const lineTail=nextLine<0?text.slice(insertion):text.slice(insertion,nextLine);
    if(nextLine>=0&&/^[ \t\r]*(?:\/\*[^\r\n]*?\*\/[ \t\r]*)*(?:\/\/[^\r\n]*)?\r?$/.test(lineTail))insertion=nextLine+1;
    else {
      if(/\/\*/.test(lineTail))throw Error('Place a multiline import comment on its own line before adding an import.');
      replacement=eol+replacement;
    }
  } else {
    const prefix=text.slice(0,insertion),comments=[...prefix.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)];
    const attached=comments.at(-1);
    if(attached?.[0].startsWith('/**')&&!prefix.slice(attached.index+attached[0].length).trim())insertion=attached.index;
    replacement+=eol;
  }
  const edit={range:rangeAt(text,insertion,insertion),newText:replacement};
  const map=span=>({start:span.start+replacement.length,end:span.end+replacement.length});
  return {edit,text:editedText(text,[edit]),selection:map(selection),occurrences:occurrences.map(map)};
}

function verifyTypeImport(proof,fqn,draft) {
  const key=({start,end})=>start+':'+end;
  const expected=new Set(draft.occurrences.map(key));
  if(proof?.target!==fqn||proof.bindings?.length!==expected.size||
      proof.bindings.some(binding=>binding.type!==fqn||!expected.delete(key(binding)))||expected.size) {
    throw Error('Javac could not verify the selected Java import resolves every reviewed type use.');
  }
}

module.exports={UNDEFINED_TYPE,qualified,typeImportCandidates,typeImportSelection,confirmUnresolvedType,typeImportDraft,verifyTypeImport};
