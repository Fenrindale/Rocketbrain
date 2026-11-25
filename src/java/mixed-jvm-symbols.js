'use strict';

const path = require('node:path');
const { lexJava } = require('../spring/java');
const { fail } = require('./workbench-model');

const lineStarts = new WeakMap();
function sourceLine(source,offset) {
  let starts = lineStarts.get(source);
  if (!starts) {
    starts = [0];
    for (let next=source.text.indexOf('\n'); next>=0; next=source.text.indexOf('\n',next+1)) starts.push(next+1);
    lineStarts.set(source,starts);
  }
  let low=0, high=starts.length;
  while (low+1 < high) {
    const middle = Math.floor((low+high)/2);
    if (starts[middle] <= offset) low=middle; else high=middle;
  }
  return low+1;
}
const simple = name => name.slice(name.lastIndexOf('/')+1);
const packageOf = name => name.includes('/') ? name.slice(0,name.lastIndexOf('/')).replaceAll('/','.') : '';
const beforeOrAt = (token,offset) => token.start <= offset && offset < token.end;

function sourceFor(index,owner) {
  const files = index.sources.files.filter(file => path.basename(file.file) === owner.source && file.package === packageOf(owner.name));
  return files.length === 1 ? files[0] : undefined;
}

function closeOf(tokens,start,open,close) {
  let depth = 0;
  for (let index=start; index<tokens.length; index++) {
    if (tokens[index].text === open) depth++;
    else if (tokens[index].text === close && --depth === 0) return index;
  }
  return -1;
}

function validTokens(source) {
  const result = lexJava(source.text);
  return result.issues.length ? [] : result.tokens;
}

function methodDeclarations(source,tokens,name,firstLine) {
  return tokens.filter((token,index) => {
    if (token.text !== name || tokens[index+1]?.text !== '(') return false;
    const previous = tokens[index-1], from = sourceLine(source,token.start);
    if (from > firstLine || firstLine-from > 24) return false;
    if (source.language === 'kotlin' ? previous?.text !== 'fun' :
      previous?.kind !== 'id' || ['return','new','throw','yield'].includes(previous.text)) return false;
    const end = closeOf(tokens,index+1,'(',')');
    if (end < 0) return false;
    // Signatures may continue with a return type or 'throws'; stop at the next declaration.
    for (let next=end+1; next<Math.min(tokens.length,end+50); next++) {
      const word = tokens[next].text;
      if (word === '=') return source.language === 'kotlin' && from === firstLine;
      if ([';','}','fun','class','val','var','('].includes(word)) return false;
      if (word === '{') {
        const close = closeOf(tokens,next,'{','}');
        return close >= 0 && firstLine <= sourceLine(source,tokens[close].end);
      }
    }
    return false;
  });
}

function kotlinProperties(source,tokens,method) {
  const getter = /^(get|is)([A-Z].*)$/.exec(method.name);
  if (!getter || !method.descriptor.startsWith('()')) return [];
  const property = getter[2][0].toLowerCase()+getter[2].slice(1);
  return tokens.filter((token,index) => ['val','var'].includes(tokens[index-1]?.text) &&
    (token.text === property || getter[1] === 'is' && token.text === method.name) &&
    sourceLine(source,token.start) === method.line);
}

function methodAnchor(source,method) {
  const tokens = validTokens(source);
  const declarations = methodDeclarations(source,tokens,method.name,method.line);
  if (source.language === 'kotlin') declarations.push(...kotlinProperties(source,tokens,method));
  return declarations.length === 1 ? declarations[0] : undefined;
}

function typeAnchor(source,name) {
  const tokens = validTokens(source);
  const declarations = tokens.filter((token,index) => token.text === name &&
    ['class','interface','record','enum'].includes(tokens[index-1]?.text));
  return declarations.length === 1 ? declarations[0] : undefined;
}

function targetMethod(classes,call) {
  let current = classes.get(call.owner);
  const visited = new Set();
  while (current && !visited.has(current.name)) {
    visited.add(current.name);
    const exact = current.methods.filter(method => method.name === call.name && method.descriptor === call.descriptor);
    if (exact.length) return exact.length === 1 && exact[0].line > 0 ? {owner:current,method:exact[0]} : undefined;
    current = classes.get(current.superName);
  }
}

function superCandidate(owners,tokens,selected,source,line) {
  const previous = tokens.filter(token => token.start < selected.start && sourceLine(source,token.start) === line);
  const declaration = previous.findIndex(token => token.text === 'class');
  if (declaration < 0 || !previous.slice(declaration+2).some(token => ['extends',':'].includes(token.text))) return undefined;
  const types = owners.filter(owner => simple(owner.name) === previous[declaration+1]?.text &&
    simple(owner.superName) === selected.text);
  return types.length === 1 ? types[0].superName : undefined;
}

function definitionForCompiledReference(index,{file,offset}) {
  const source = index.sources.files.find(item => !path.relative(item.file,file));
  if (!source || !Number.isSafeInteger(offset) || offset < 0 || offset >= source.text.length) return undefined;
  const classes = new Map(index.classes.map(item => [item.name,item]));
  const owners = index.classes.filter(item => sourceFor(index,item) === source);
  const tokens = validTokens(source);
  const selectedAt = tokens.findIndex(token => token.kind === 'id' && beforeOrAt(token,offset));
  if (selectedAt < 0) return undefined;
  const selected = tokens[selectedAt], line = sourceLine(source,selected.start), name = selected.text;
  const parent = superCandidate(owners,tokens,selected,source,line);
  const materialize = (owner,anchor,kind,descriptor,member) => {
    const file = owner && sourceFor(index,owner);
    return file && file.language !== source.language && anchor ? {
      file:file.file,range:{start:anchor.start,end:anchor.end},kind,owner:owner.name,member,descriptor,callLine:line
    } : undefined;
  };
  if (parent) {
    const owner = classes.get(parent), target = owner && sourceFor(index,owner);
    return materialize(owner,target && typeAnchor(target,simple(parent)),'supertype');
  }

  const call = tokens[selectedAt+1]?.text === '(';
  const kotlinProperty = !call && source.language === 'kotlin' && tokens[selectedAt-1]?.text === '.';
  if (!call && !kotlinProperty) return undefined;
  if (tokens.filter((item,at) => item.text === name && sourceLine(source,item.start) === line &&
      (call ? tokens[at+1]?.text === '(' : tokens[at-1]?.text === '.')).length !== 1) {
    throw fail('Select a cross-language reference on a line with one matching compiled call.');
  }
  const capitalized = name[0].toUpperCase()+name.slice(1);
  const wanted = kotlinProperty ? new Set(['get'+capitalized,'is'+capitalized,name]) : new Set([name]);
  const invocations = owners.flatMap(owner => owner.calls).filter(item => item.line === line &&
    (wanted.has(item.name) || call && item.name === '<init>' && simple(item.owner) === name));
  const unique = new Map(invocations.map(item => [JSON.stringify([item.owner,item.name,item.descriptor]),item]));
  if (unique.size > 1) throw fail('The compiled line has multiple possible JVM targets. Select a line with a unique reference.');
  const [reference] = unique.values();
  if (!reference) return undefined;
  if (reference.name === '<init>') {
    const owner = classes.get(reference.owner), target = owner && sourceFor(index,owner);
    return materialize(owner,target && typeAnchor(target,name),'constructor',reference.descriptor);
  }
  const resolved = targetMethod(classes,reference);
  if (!resolved) return undefined;
  const {owner,method} = resolved, target = sourceFor(index,owner);
  return materialize(owner,target && methodAnchor(target,method),kotlinProperty ? 'property' : 'call',method.descriptor,method.name);
}

module.exports = { definitionForCompiledReference };
