'use strict';
const { parseYaml } = require('./configuration-yaml');
const { parseProfileExpression, matchesProfileTree } = require('./profile-expression');

const delimiter=/(?:^|[^\\])(?:\\\\)*\\$/;
const profileName=/^[A-Za-z0-9][\w.-]{0,79}$/;
const listSuffix=/^\[(\d+)\]$/;
function unescapeProperty(value) { return value.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (all, unicode, char) => unicode ? String.fromCharCode(parseInt(unicode, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' })[char] ?? char); }

function parseProperties(file) {
  const lines=file.text.split('\n').map(line=>line.endsWith('\r')?line.slice(0,-1):line);
  const documents=[{index:0,entries:[],issues:[]}], entries=[];
  for(let i=0;i<lines.length;i++){
    const start=i;
    let line=lines[i],doc=documents.at(-1);
    const separator=/^([#!])---$/.exec(line);
    if(separator&&!lines[i-1]?.startsWith(separator[1])&&!lines[i+1]?.startsWith(separator[1])){
      documents.push({index:documents.length,entries:[],issues:[]});
      continue;
    }
    if(/^\s*[#!]/.test(line)||!line.trim())continue;
    while(delimiter.test(line)&&i+1<lines.length)line=line.slice(0,-1)+lines[++i].trimStart();
    let keyEnd=line.length,escaped=false,keyStart=/^\s*/.exec(line)[0].length;
    for(let j=keyStart;j<line.length;j++){
      if(escaped){escaped=false;continue;}
      if(line[j]==='\\'){escaped=true;continue;}
      if(/[=:\s]/.test(line[j])){keyEnd=j;break;}
    }
    let valueStart=keyEnd;
    while(/\s/.test(line[valueStart]||'')&&valueStart<line.length)valueStart++;
    if(/[=:]/.test(line[valueStart]||''))valueStart++;
    while(/\s/.test(line[valueStart]||'')&&valueStart<line.length)valueStart++;
    const key=unescapeProperty(line.slice(keyStart,keyEnd));
    if(!key)continue;
    if(keyEnd>lines[start].length){
      doc.issues.push('A continued property key has no exact single-line source range.');
      continue;
    }
    const entry={key,value:unescapeProperty(line.slice(valueStart)),uri:file.uri,source:file.uri,document:doc.index,
      range:{start:{line:start,character:keyStart},end:{line:start,character:keyEnd}}};
    entries.push(entry);doc.entries.push(entry);
  }
  return {entries,documents,issues:documents.flatMap(doc=>doc.issues)};
}

function listValues(entries,key){
  const exact=entries.get(key), indexed=[];
  for(const [name,entry] of entries){
    if(!name.startsWith(key+'['))continue;
    const index=listSuffix.exec(name.slice(key.length));
    if(index)indexed.push([Number(index[1]),entry.value]);
  }
  return exact?exact.value.split(',').map(value=>value.trim()).filter(Boolean)
    :indexed.sort((left,right)=>left[0]-right[0]).map(item=>item[1].trim()).filter(Boolean);
}

function readProfiles(values,base,issues){
  if(values.length>64||values.some(value=>!profileName.test(value))){
    issues.push({message:'Active and default profiles must be bounded literal names.'});
    return null;
  }
  const result=[],seen=new Set();
  function include(profile,stack){
    if(stack.has(profile)||stack.size>16||result.length>=64)throw Error('Spring profile groups are cyclic or exceed the local model limit.');
    if(seen.has(profile))return;
    seen.add(profile);result.push(profile);
    const members=listValues(base,'spring.profiles.group.'+profile);
    if(members.some(value=>!profileName.test(value)))throw Error('Spring profile groups contain an unresolved profile.');
    const nested=new Set(stack).add(profile);
    for(const item of members)include(item,nested);
  }
  try{for(const value of values)include(value,new Set());}
  catch(error){issues.push({message:error.message});return null;}
  return result;
}

function documentState(entries, active){
  const expressions=listValues(entries,'spring.config.activate.on-profile');
  if(expressions.length){
    if(!active)return 'unknown';
    try{
      if(!expressions.some(value=>matchesProfileTree(parseProfileExpression(value).tree,active)))return 'inactive';
    }catch{return 'unknown';}
  }
  if(entries.has('spring.config.activate.on-cloud-platform'))return 'unknown';
  return 'active';
}

function configuration(files, options = {}) {
  const entries=new Map(),issues=[],unknownKeys=new Set(),unconditional=new Map();
  const directories=new Set(files.map(file=>file.uri.slice(0,file.uri.lastIndexOf('/'))));
  const multipleRoots=directories.size>1;
  if(multipleRoots)issues.push({message:'Application configuration comes from multiple directories or contexts. Select rocketbrain.spring.configurationRoots to bound the source model.'});
  const parsed=files.map(file=>{
    const isProperties=/\.properties$/i.test(file.uri), data=isProperties?parseProperties(file):parseYaml(file);
    return {uri:file.uri,data,priority:isProperties?1:0,
      profile:/\/application-([^/]+)\.(?:properties|ya?ml)$/i.exec(file.uri)?.[1]||''};
  }).sort((left,right)=>left.priority-right.priority||left.uri.localeCompare(right.uri));
  const base=parsed.filter(file=>!file.profile);
  let external=false,brokenBase=false;
  const overrides=new Map(Object.entries(options.properties||{}).filter(([,value])=>['string','number','boolean'].includes(typeof value))
    .map(([key,value])=>[key,{key,value:String(value),uri:null,range:null,source:'rocketbrain.spring.properties override'}]));
  const profilesFromSettings=Array.isArray(options.activeProfiles)?options.activeProfiles.filter(value=>typeof value==='string'&&value):[];

  function modelDocument(doc){return new Map(doc.entries.map(entry=>[entry.key,entry]));}
  for(const file of base){
    if(file.data.issues.length)brokenBase=true;
    for(const doc of file.data.documents){
      const local=modelDocument(doc);
      if(documentState(local,null)!=='active')continue;
      for(const [key,entry] of local)unconditional.set(key,entry);
    }
  }
  const unknownPrecedenceKeys=['spring.config.import','spring.config.location','spring.config.additional-location','spring.config.name'];
  const usesUnknownPrecedence=local=>unknownPrecedenceKeys.some(key=>local.has(key)||[...local.keys()].some(name=>name.startsWith(key+'[')));
  const unconditionalSource=usesUnknownPrecedence(unconditional)||usesUnknownPrecedence(overrides);
  const preferredActive=profilesFromSettings.length?profilesFromSettings:listValues(overrides,'spring.profiles.active');
  const declaredActive=listValues(unconditional,'spring.profiles.active');
  const configuredDefault=listValues(overrides,'spring.profiles.default');
  const builtInDefault=configuredDefault.length?configuredDefault:listValues(unconditional,'spring.profiles.default');
  const selected=preferredActive.length?preferredActive:declaredActive.length?declaredActive:builtInDefault.length?builtInDefault:['default'];
  const included=listValues(unconditional,'spring.profiles.include');
  const active=(multipleRoots||brokenBase||unconditionalSource)&&!preferredActive.length?null:readProfiles([...included,...selected],unconditional,issues);

  function apply(file,candidate){
    for(const message of file.data.issues)issues.push({uri:file.uri,message});
    if(file.data.issues.length)external=true;
    for(const doc of file.data.documents){
      const local=modelDocument(doc);
      const state=candidate?'unknown':documentState(local,active);
      if(state==='inactive')continue;
      if(usesUnknownPrecedence(local))external=true;
      const restricted=file.profile||state!=='active'||[...local.keys()].some(key=>key.startsWith('spring.config.activate.'));
      if(restricted&&[...local.keys()].some(key=>/^spring\.profiles\.(?:active|default|include|group)(?:[.\[]|$)/.test(key))){
        issues.push({uri:file.uri,message:'Profile-specific documents cannot redefine active, default, included or grouped profiles.'});
        external=true;
      }
      if(state==='unknown'){
        issues.push({uri:file.uri,message:'Document activation is unresolved for the selected source profiles or cloud platform.'});
        for(const [key,entry] of local){
          if(!entries.has(key))entries.set(key,entry);
          unknownKeys.add(key);
        }
        continue;
      }
      for(const [key,entry] of local){entries.set(key,entry);unknownKeys.delete(key);}
    }
  }
  function applySet(selectedFiles,candidate=false){
    if(selectedFiles.filter(file=>file.priority===0).length>1&&!multipleRoots){
      issues.push({message:'Both YAML filename variants are present in the same source location.'});
      external=true;
    }
    for(const file of selectedFiles)apply(file,candidate);
  }
  applySet(base);
  if(active){
    for(const profile of active)applySet(parsed.filter(file=>file.profile===profile));
  }else{
    for(const file of parsed.filter(file=>file.profile))apply(file,true);
  }
  if(external||unconditionalSource)issues.push({message:'Configuration imports, loader options or invalid sources can change precedence. Inspect the selected key with the connected Spring runtime for its effective origin.'});
  const ambiguousContext=multipleRoots||external||unconditionalSource;
  for(const [key,entry] of entries)if(ambiguousContext||unknownKeys.has(key))entries.set(key,{...entry,ambiguousContext:true});
  for(const [key,entry] of overrides)entries.set(key,entry);
  return {entries,profiles:active||[],issues,ambiguousContext,profileState:active?'known':'unknown'};
}
function resolveTemplate(template, entries, stack = []) {
  if (typeof template !== 'string') return { state: 'unknown', reason: 'The property expression is not a literal string.', definitions: [] };
  if (template.includes('#{')) return { state: 'unknown', reason: 'SpEL execution is not performed.', definitions: [] };
  if (stack.length > 20) return { state: 'unknown', reason: 'Placeholder recursion limit.', definitions: [] };
  let value = '', definitions = [], cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('${', cursor);
    if (open < 0) { value += template.slice(cursor); break; }
    value += template.slice(cursor, open); let end = open + 2, depth = 1, colon = -1;
    for (; end < template.length; end++) {
      if (template.startsWith('${', end)) { depth++; end++; }
      else if (template[end] === '}' && --depth === 0) break;
      else if (template[end] === ':' && depth === 1 && colon < 0) colon = end;
    }
    if (depth) return { state: 'unknown', reason: 'Unbalanced placeholder.', definitions };
    const keyText = template.slice(open + 2, colon >= 0 ? colon : end);
    const key = resolveTemplate(keyText, entries, stack);
    if (key.state !== 'resolved') return key;
    if (stack.includes(key.value)) return { state: 'unknown', reason: `Cyclic placeholder: ${[...stack, key.value].join(' → ')}`, definitions };
    const entry = entries.get(key.value);
    if (entry) {
      if (entry.ambiguousContext) return { state: 'unknown', reason: `Configuration context is ambiguous for ${key.value}; select one configuration root.`, definitions: [entry] };
      const resolved = resolveTemplate(entry.value, entries, [...stack, key.value]); definitions.push(entry, ...resolved.definitions);
      if (resolved.state !== 'resolved') return { ...resolved, definitions };
      value += resolved.value;
    } else if (colon >= 0) {
      const fallback = resolveTemplate(template.slice(colon + 1, end), entries, stack); definitions.push(...fallback.definitions);
      if (fallback.state !== 'resolved') return { ...fallback, definitions };
      value += fallback.value;
    } else return { state: 'unresolved', key: key.value, reason: `No local configuration value for ${key.value}; external property sources may provide it.`, definitions };
    cursor = end + 1;
  }
  return { state: 'resolved', value, definitions: [...new Map(definitions.map(item => [item.uri + '|' + item.key, item])).values()] };
}

module.exports = { parseProperties, parseYaml, configuration, resolveTemplate };
