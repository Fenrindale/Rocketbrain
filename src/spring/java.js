'use strict';

const MODIFIERS = new Set(['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native', 'default', 'transient', 'volatile', 'strictfp', 'sealed', 'non-sealed']);
const KNOWN = {
  Component: 'org.springframework.stereotype.Component', Service: 'org.springframework.stereotype.Service', Repository: 'org.springframework.stereotype.Repository', Controller: 'org.springframework.stereotype.Controller',
  RestController: 'org.springframework.web.bind.annotation.RestController', Configuration: 'org.springframework.context.annotation.Configuration', Bean: 'org.springframework.context.annotation.Bean', Primary: 'org.springframework.context.annotation.Primary', Fallback: 'org.springframework.context.annotation.Fallback', Profile: 'org.springframework.context.annotation.Profile', Conditional: 'org.springframework.context.annotation.Conditional',
  Autowired: 'org.springframework.beans.factory.annotation.Autowired', Qualifier: 'org.springframework.beans.factory.annotation.Qualifier', Value: 'org.springframework.beans.factory.annotation.Value',
  ConfigurationProperties: 'org.springframework.boot.context.properties.ConfigurationProperties', EnableConfigurationProperties: 'org.springframework.boot.context.properties.EnableConfigurationProperties', SpringBootApplication: 'org.springframework.boot.autoconfigure.SpringBootApplication',
  ConditionalOnProperty: 'org.springframework.boot.autoconfigure.condition.ConditionalOnProperty', ConditionalOnBean: 'org.springframework.boot.autoconfigure.condition.ConditionalOnBean', ConditionalOnMissingBean: 'org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean', ConditionalOnClass: 'org.springframework.boot.autoconfigure.condition.ConditionalOnClass', ConditionalOnExpression: 'org.springframework.boot.autoconfigure.condition.ConditionalOnExpression',
  FeignClient: 'org.springframework.cloud.openfeign.FeignClient', RouterFunction: 'org.springframework.web.reactive.function.server.RouterFunction',
  RequestMapping: 'org.springframework.web.bind.annotation.RequestMapping', GetMapping: 'org.springframework.web.bind.annotation.GetMapping', PostMapping: 'org.springframework.web.bind.annotation.PostMapping', PutMapping: 'org.springframework.web.bind.annotation.PutMapping', DeleteMapping: 'org.springframework.web.bind.annotation.DeleteMapping', PatchMapping: 'org.springframework.web.bind.annotation.PatchMapping',
  Inject: 'jakarta.inject.Inject', Named: 'jakarta.inject.Named'
};

function positionAt(text, offset) { const lines = text.slice(0, offset).split('\n'); return { line: lines.length - 1, character: lines.at(-1).length }; }
function rangeAt(text, start, end) { return { start: positionAt(text, start), end: positionAt(text, end) }; }
function decodeString(raw) {
  try { return raw.slice(1, -1).replace(/\\(?:u([a-fA-F0-9]{4})|([btnfr"'\\]))/g, (all, unicode, char) => unicode ? String.fromCharCode(parseInt(unicode, 16)) : ({ b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', "'": "'", '\\': '\\' })[char]); } catch { return null; }
}
function lexJava(text) {
  const tokens = [], issues = []; let i = 0;
  if (/\\u+[a-fA-F0-9]{4}/.test(text)) issues.push('Java Unicode pre-lexing escapes are not fully modeled');
  while (i < text.length) {
    const start = i, char = text[i];
    if (/\s/.test(char)) { i++; continue; }
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); if (end < 0) { issues.push('Unterminated block comment'); break; } i = end + 2; continue; }
    if (text.startsWith('"""', i)) {
      i += 3; let closed = false;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text.startsWith('"""', i)) { i += 3; closed = true; break; } i++; }
      if (!closed) issues.push('Unterminated text block');
      tokens.push({ kind: 'text-block', text: text.slice(start, i), value: null, start, end: i }); continue;
    }
    if (char === '"' || char === "'") {
      i++; let closed = false;
      while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i++] === char) { closed = true; break; } }
      if (!closed) issues.push('Unterminated string/character literal');
      const raw = text.slice(start, i); tokens.push({ kind: char === '"' ? 'string' : 'char', text: raw, value: closed ? decodeString(raw) : null, start, end: i }); continue;
    }
    if (/[\p{L}_$]/u.test(char)) { i++; while (i < text.length && /[\p{L}\p{N}_$]/u.test(text[i])) i++; tokens.push({ kind: 'id', text: text.slice(start, i), start, end: i }); continue; }
    if (/[0-9]/.test(char)) { i++; while (i < text.length && /[\w.]/.test(text[i])) i++; tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i }); continue; }
    tokens.push({ kind: 'symbol', text: char, start, end: ++i });
  }
  return { tokens, issues };
}
function matching(tokens, index, open = tokens[index]?.text, close = ({ '(': ')', '{': '}', '[': ']' })[open]) {
  let depth = 0;
  for (let i = index; i < tokens.length; i++) { if (tokens[i].text === open) depth++; else if (tokens[i].text === close && --depth === 0) return i; }
  return -1;
}
function splitTop(tokens, delimiter = ',') {
  const result = []; let start = 0, depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const text = tokens[i].text;
    if (['(', '{', '[', '<'].includes(text)) depth++;
    else if ([')', '}', ']', '>'].includes(text)) depth--;
    else if (!depth && text === delimiter) { result.push(tokens.slice(start, i)); start = i + 1; }
  }
  result.push(tokens.slice(start)); return result;
}
function resolveName(name, info, javaLang = false) {
  if (!name) return '';
  if (name.includes('.')) return name;
  if (info.imports[name]) return info.imports[name];
  if (['Deprecated', 'Override', 'SuppressWarnings', 'SafeVarargs', 'FunctionalInterface'].includes(name)) return 'java.lang.' + name;
  if (javaLang && ['String', 'Integer', 'Long', 'Boolean', 'Double', 'Object', 'Number', 'Class', 'Void'].includes(name)) return 'java.lang.' + name;
  const known = KNOWN[name];
  if (known && info.wildcards.includes(known.slice(0, known.lastIndexOf('.')))) return known;
  if (javaLang) {
    for (const pkg of ['java.util', 'org.springframework.beans.factory']) if (info.wildcards.includes(pkg)) return pkg + '.' + name;
  }
  return (info.packageName ? info.packageName + '.' : '') + name;
}
function parseAnnotation(tokens, index, info) {
  if (tokens[index]?.text !== '@' || tokens[index + 1]?.kind !== 'id') return null;
  let cursor = index + 2, name = tokens[index + 1].text;
  while (tokens[cursor]?.text === '.' && tokens[cursor + 1]?.kind === 'id') { name += '.' + tokens[cursor + 1].text; cursor += 2; }
  let args = [], end = cursor;
  if (tokens[cursor]?.text === '(') { const close = matching(tokens, cursor); if (close < 0) return null; args = tokens.slice(cursor + 1, close); end = close + 1; }
  const attributes = {};
  for (const part of splitTop(args)) {
    if (!part.length) continue;
    if (part[0]?.kind === 'id' && part[1]?.text === '=') attributes[part[0].text] = part.slice(2);
    else attributes.value = part;
  }
  const resolved = resolveName(name, info);
  const shortName = name.split('.').at(-1);
  return { name: resolved, shortName, known: KNOWN[shortName] === resolved, attributes, start: tokens[index].start, end: tokens[end - 1].end, next: end };
}
function strings(annotation, key = 'value') {
  let tokens = annotation?.attributes[key];
  if (!tokens) return [];
  if (tokens[0]?.text === '{' && tokens.at(-1)?.text === '}') tokens = tokens.slice(1, -1);
  const parts = splitTop(tokens);
  if (parts.some(part => part.length !== 1 || part[0].kind !== 'string' || part[0].value === null)) return null;
  return parts.map(part => part[0].value);
}
function literal(annotation, key, fallback) {
  const tokens = annotation?.attributes[key];
  if (!tokens) return fallback;
  if (tokens.length !== 1) return undefined;
  if (tokens[0].kind === 'string') return tokens[0].value;
  if (tokens[0].text === 'true') return true;
  if (tokens[0].text === 'false') return false;
  return undefined;
}
function annotation(items, name) { return items.find(item => item.known && item.shortName === name); }
function typeRef(tokens, info) {
  const clean = tokens.filter(token => !MODIFIERS.has(token.text));
  const raw = clean.map(token => token.text).join('');
  const base = raw.split(/[<\[]/)[0];
  const genericStart = clean.findIndex(token => token.text === '<');
  const genericEnd = clean.map(token => token.text).lastIndexOf('>');
  return { raw, name: resolveName(base, info, true), arguments: genericStart >= 0 && genericEnd > genericStart ? splitTop(clean.slice(genericStart + 1, genericEnd)).map(part => typeRef(part, info)) : [], array: raw.endsWith('[]') };
}
function parameters(tokens, info) {
  return splitTop(tokens).filter(part => part.length).map(part => {
    const annotations = []; let i = 0;
    while (part[i]?.text === '@') { const item = parseAnnotation(part, i, info); if (!item) return null; annotations.push(item); i = item.next; }
    const rest = part.slice(i).filter(token => token.text !== 'final');
    const name = rest.at(-1);
    if (name?.kind !== 'id' || rest.length < 2) return null;
    return { name: name.text, type: typeRef(rest.slice(0, -1), info), annotations, start: name.start, end: name.end, declarationStart:part[0].start };
  }).filter(Boolean);
}
function parseMembers(tokens, start, end, type, info, issues, collectNested) {
  const fields = [], methods = [], nested = []; let i = start;
  while (i < end) {
    if (tokens[i].text === ';') { i++; continue; }
    const annotations = [];
    while (tokens[i]?.text === '@') { const item = parseAnnotation(tokens, i, info); if (!item) break; annotations.push(item); i = item.next; }
    const headerStart = i;
    let cursor = i, delimiter;
    while (cursor < end) {
      if (['class', 'record', 'interface', 'enum'].includes(tokens[cursor].text)) {
        const body = tokens.findIndex((token, index) => index > cursor && token.text === '{');
        const close = body >= 0 ? matching(tokens, body) : -1;
        if (collectNested && close > cursor && close < end) {
          const item = collectNested(cursor, annotations, close);
          if (item) nested.push(item);
        } else if (!collectNested) issues.push('Nested types are excluded from the Spring model');
        i = close > cursor && close < end ? close + 1 : end;
        delimiter = 'nested';
        break;
      }
      if (['(', ';', '{', '='].includes(tokens[cursor].text)) { delimiter = tokens[cursor].text; break; }
      cursor++;
    }
    if (delimiter === 'nested') continue;
    if (!delimiter) break;
    if (delimiter === '(') {
      const close = matching(tokens, cursor); if (close < 0 || close > end) { issues.push('Unbalanced method parameters'); break; }
      const name = tokens[cursor - 1];
      const header = tokens.slice(headerStart, cursor - 1).filter(token => !MODIFIERS.has(token.text));
      if (name?.kind === 'id') methods.push({ name: name.text, constructor: name.text === type.name, type: typeRef(header, info), annotations, parameters: parameters(tokens.slice(cursor + 1, close), info), start: name.start, end: name.end,
        modifiers:tokens.slice(headerStart,cursor-1).filter(token=>MODIFIERS.has(token.text)).map(token=>token.text) });
      let tail = close + 1; while (tail < end && !['{', ';'].includes(tokens[tail].text)) tail++;
      i = tokens[tail]?.text === '{' ? matching(tokens, tail) + 1 : tail + 1;
    } else if (delimiter === '{') {
      i = matching(tokens, cursor) + 1;
    } else {
      let tail = cursor;
      while (tail < end) { if (tokens[tail].text === ';') break; if (['(', '[', '{'].includes(tokens[tail].text)) { const close = matching(tokens, tail); if (close < 0) break; tail = close; } tail++; }
      const header = tokens.slice(headerStart, cursor).filter(token => !MODIFIERS.has(token.text));
      if (splitTop(header).length === 1 && header.length >= 2 && header.at(-1).kind === 'id') { const name = header.at(-1); fields.push({ name: name.text, type: typeRef(header.slice(0, -1), info), annotations, start: name.start, end: name.end,
        declarationStart:annotations[0]?.start??tokens[headerStart].start,
        modifiers:tokens.slice(headerStart,cursor).filter(token=>MODIFIERS.has(token.text)).map(token=>token.text) }); }
      else if (annotations.length) issues.push('Unsupported annotated field declaration');
      i = tail + 1;
    }
    if (i <= headerStart) break;
  }
  return { fields, methods, ...(collectNested ? { nested } : {}) };
}
function parseJavaFile(file, options) { return parseJavaTokens(file,lexJava(file.text),options); }

function parseJavaTokens(file, lexical, { nestedTypes = false } = {}) {
  const { tokens } = lexical, issues = [...lexical.issues];
  const info = { packageName: '', imports: {}, wildcards: [] }, types = [];
  function declaration(at, annotations, owner, depth, expectedClose) {
    const token=tokens[at], name=tokens[at+1];
    if (name?.kind!=='id') return;
    let open=at+2;
    while (open<tokens.length&&tokens[open].text!=='{') open++;
    const close=matching(tokens,open);
    if (close<0 || expectedClose!==undefined&&close!==expectedClose) { issues.push('Unbalanced type body'); return; }
    const fqn=(owner?owner+'.':info.packageName?info.packageName+'.':'')+name.text;
    const type={name:name.text,fqn,kind:token.text,annotations,start:name.start,end:name.end,uri:file.uri,
      range:rangeAt(file.text,name.start,name.end),superTypes:[],...(owner?{owner}:{} )};
    const header=tokens.slice(at+2,open);
    let section=[], inheritance=false;
    for (const part of header) {
      if (part.text==='extends'||part.text==='implements') {
        if (inheritance&&section.length) type.superTypes.push(...splitTop(section).map(value=>typeRef(value,info).name));
        section=[];inheritance=true;
      } else if (part.text==='permits') {
        if (inheritance&&section.length) type.superTypes.push(...splitTop(section).map(value=>typeRef(value,info).name));
        section=[];inheritance=false;
      } else if (inheritance) section.push(part);
    }
    if (section.length&&inheritance) type.superTypes.push(...splitTop(section).map(value=>typeRef(value,info).name));
    if (header[0]?.text==='<') {
      issues.push('Generic type specialization is not modeled');
      if (nestedTypes) type.generic=true;
    }
    const children=nestedTypes?(index,annotations,last)=>{
      if (depth>=12) { issues.push('Nested type depth exceeds its source limit');return; }
      return declaration(index,annotations,fqn,depth+1,last)?.type;
    }:undefined;
    Object.assign(type,parseMembers(tokens,open+1,close,type,info,issues,children));
    if (token.text==='record') issues.push('Record constructor/property binding is not analyzed');
    return {type,close};
  }
  let i = 0, pending = [];
  while (i < tokens.length) {
    const token = tokens[i];
    if (token.text === 'package' || token.text === 'import') {
      const mode = token.text; let end = i + 1; while (end < tokens.length && tokens[end].text !== ';') end++;
      const parts = tokens.slice(i + 1, end).map(item => item.text);
      if (mode === 'package') info.packageName = parts.join('');
      else if (parts[0] !== 'static') { const name = parts.join(''); if (name.endsWith('.*')) info.wildcards.push(name.slice(0, -2)); else info.imports[name.split('.').at(-1)] = name; }
      i = end + 1; continue;
    }
    if (token.text === '@') { const item = parseAnnotation(tokens, i, info); if (item) { pending.push(item); i = item.next; continue; } }
    if (['class', 'interface', 'record', 'enum'].includes(token.text) && tokens[i + 1]?.kind === 'id') {
      const read=declaration(i,pending,undefined,0);
      if (!read) break;
      types.push(read.type); pending=[]; i=read.close+1; continue;
    }
    if (!MODIFIERS.has(token.text)) pending = [];
    i++;
  }
  return { ...file, ...info, types, issues: [...new Set(issues)] };
}

module.exports = { parseJavaFile, parseJavaTokens, lexJava, matching, splitTop, strings, literal, annotation, parseAnnotation, rangeAt, positionAt, typeRef, KNOWN };
