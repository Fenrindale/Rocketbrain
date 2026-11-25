'use strict';

const { SaxesParser } = require('saxes');
const { rangeAt } = require('../spring/java');
const { parseProperties,parseYaml } = require('../spring/configuration');

const BEANS = 'http://www.springframework.org/schema/beans';
const KEY = /^[A-Za-z0-9][\w.-]{0,199}$/;
const FQN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const CONFIG = /(?:^|\/)application(?:-[\w-]+)?\.(?:properties|ya?ml)$/i;

function placeholders(text,start = 0) {
  if (/#\{|\\/.test(text)) return [];
  return [...text.matchAll(/\$\{([\w.-]+)(?::[^${}]*)?\}/g)].filter(match => KEY.test(match[1]))
    .map(match => ({key:match[1],start:start+match.index+2,end:start+match.index+2+match[1].length}));
}

function association(text,uri,match,kind) {
  return {uri,key:match.key,provider:kind,range:rangeAt(text,match.start,match.end)};
}

function xmlAnchors(file) {
  const {uri,text} = file, anchors = [], stack = [];
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) return {anchors,unsupported:true};
  if (!text.includes(BEANS)) return {anchors,unsupported:false};
  const parser = new SaxesParser({xmlns:true});
  let unsupported = false;
  parser.on('error',() => { unsupported = true; });
  parser.on('opentag',tag => {
    stack.push(tag);
    if (stack[0].uri !== BEANS || stack[0].local !== 'beans' || tag.uri !== BEANS) return;
    const isClass = tag.local === 'bean';
    const isProperty = ['property','constructor-arg'].includes(tag.local) && stack.at(-2)?.local === 'bean' && stack.at(-2).uri === BEANS;
    if (!isClass && !isProperty) return;
    const expected = isClass ? 'class' : 'value', attr = tag.attributes[expected];
    if (!attr || attr.uri) return;
    const start = text.lastIndexOf('<',parser.position-1);
    const opener = text.slice(start,parser.position);
    for (const part of opener.matchAll(/\s+([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)) {
      const raw = part[3];
      if (part[1] !== expected || raw !== attr.value) continue;
      const offset = start+part.index+part[0].indexOf(part[2])+1;
      if (isClass && FQN.test(raw)) anchors.push(association(text,uri,{key:raw,start:offset,end:offset+raw.length},'spring-class'));
      if (isProperty) anchors.push(...placeholders(raw,offset).map(match => association(text,uri,match,'spring-property')));
    }
  });
  parser.on('closetag',() => stack.pop());
  parser.write(text).close();
  return {anchors:unsupported ? [] : anchors,unsupported};
}

function configurationAnchors(file) {
  if (!CONFIG.test(file.uri)) return {anchors:[],unsupported:false};
  const text = file.text.replace(/\r\n/g,'\n');
  const standard = {...file,text};
  const {entries,issues} = /\.properties$/i.test(file.uri) ? parseProperties(standard) : parseYaml(standard);
  return {anchors:entries.filter(item => KEY.test(item.key)).map(({key,uri,range}) => ({key,uri,range,provider:'spring-config',declaration:true})),
    unsupported:issues.length > 0};
}

function javaValueAnchors(model,file,offsetAt) {
  const {uri,text} = file, results = [];
  for (const site of model.injections || []) {
    if (site.uri !== uri || !site.valueRange || typeof site.expression !== 'string') continue;
    const start = offsetAt(site.valueRange.start), end = offsetAt(site.valueRange.end);
    const declared = /^@(?:[\w.]+\.)?Value\s*\(\s*(?:value\s*=\s*)?"([^"\\]*)"\s*\)$/u.exec(text.slice(start,end));
    if (!declared || declared[1] !== site.expression) continue;
    const value = start+declared[0].indexOf('"')+1;
    results.push(...placeholders(declared[1],value).map(match => association(text,uri,match,'spring-property')));
  }
  return results;
}

module.exports = { CONFIG,xmlAnchors,configurationAnchors,javaValueAnchors };
