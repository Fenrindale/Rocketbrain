'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {minimatch} = require('minimatch');

const MAX_BYTES = 64*1024;
const MAX_LEVELS = 48;
const VALUE = {
  indent_style:value => ['tab','space'].includes(value),
  indent_size:value => value === 'tab' || width(value) !== undefined,
  tab_width:value => width(value) !== undefined,
  end_of_line:value => ['lf','crlf'].includes(value)
};
const samePath = (left,right) => !path.relative(left,right);

function width(value) {
  return /^\d+$/.test(String(value)) && Number(value)>0 && Number(value)<=64 ? Number(value) : undefined;
}

function parseEditorConfig(text) {
  const sections = [];
  let root = false, section;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[#;]/.test(line)) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      const glob = line.slice(1,-1);
      section = {glob,settings:new Map()};
      sections.push(section);
      continue;
    }
    const equals = line.indexOf('=');
    if (equals < 0) continue;
    const key = line.slice(0,equals).trim().toLowerCase(), value = line.slice(equals+1).trim().toLowerCase();
    if (!section && key==='root') root = value==='true';
    if (section && Object.hasOwn(VALUE,key) && (value==='unset' || VALUE[key](value))) section.settings.set(key,value);
  }
  return {root,sections};
}

function matches(file,glob) {
  if (!glob || glob.length>256) return false;
  try {
    return minimatch(file,glob.replace(/^\//,''),{matchBase:!glob.includes('/'),dot:true,platform:'linux',
      nocomment:true,nonegate:true,noext:true,braceExpandMax:512,maxGlobstarRecursion:32});
  } catch { return false; }
}

function readConfig(file) {
  let info;
  try { info = fs.lstatSync(file); }
  catch (error) { if (error.code==='ENOENT') return; throw error; }
  if (!info.isFile() || !samePath(file,fs.realpathSync(file)) || info.size>MAX_BYTES) {
    throw Error('Use a physical .editorconfig file within 64 KiB.');
  }
  const bytes = fs.readFileSync(file);
  const next = fs.lstatSync(file);
  if (bytes.length>MAX_BYTES || !next.isFile() || info.ino!==next.ino || info.dev!==next.dev ||
      info.size!==next.size || info.mtimeMs!==next.mtimeMs || info.ctimeMs!==next.ctimeMs) {
    throw Error('The .editorconfig file changed during formatting. Try again.');
  }
  return {hash:createHash('sha256').update(bytes).digest('hex'),...parseEditorConfig(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}

function editorConfig(file,workspace) {
  const root = fs.realpathSync(workspace), directory = path.dirname(file);
  const location = fs.realpathSync(directory), relative = path.relative(root,location);
  if (!samePath(location,directory) || relative==='..' || relative.startsWith('..'+path.sep) || path.isAbsolute(relative)) {
    throw Error('EditorConfig formatting requires a physical local workspace source.');
  }
  const ancestral = [];
  for (let current=location; ; current=path.dirname(current)) {
    if (ancestral.length===MAX_LEVELS) throw Error('The .editorconfig search exceeds its folder depth limit.');
    const configuration = path.join(current,'.editorconfig');
    const parsed = readConfig(configuration);
    ancestral.push({current,configuration,parsed});
    if (parsed?.root || samePath(root,current)) break;
  }
  const settings = new Map(), sources = [];
  for (const {current,configuration,parsed} of [...ancestral].reverse()) {
    if (!parsed) continue;
    const target = path.relative(current,file).split(path.sep).join('/');
    for (const section of parsed.sections) {
      if (!section.settings.size || !matches(target,section.glob)) continue;
      sources.push(path.relative(root,configuration));
      for (const [property,value] of section.settings) {
        if (value==='unset') settings.delete(property);
        else settings.set(property,value);
      }
    }
  }
  const fingerprint = JSON.stringify(ancestral.map(({configuration,parsed})=>[configuration,parsed?.hash || null]));
  return {settings:Object.fromEntries(settings),sources:[...new Set(sources)],fingerprint};
}

function styleOptions(settings,{insertSpaces,tabSize}) {
  const defaultWidth = width(tabSize) || 4;
  const configuredIndent = width(settings.indent_size), configuredTab = width(settings.tab_width);
  const usesSpaces = settings.indent_style ? settings.indent_style==='space' : insertSpaces!==false;
  const tabWidth = configuredTab || configuredIndent || defaultWidth;
  const indentSize = configuredIndent || (settings.indent_size==='tab' || !usesSpaces ? tabWidth : defaultWidth);
  return {insertSpaces:usesSpaces,indentSize,tabWidth,endOfLine:settings.end_of_line};
}

module.exports = {parseEditorConfig,editorConfig,styleOptions};
