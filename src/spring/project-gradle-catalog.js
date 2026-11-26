'use strict';

const {fail} = require('./project-client');
const VERSION = /^\d+\.\d+\.\d+(?:[.\-][A-Za-z0-9.\-]+)?$/u;
const ALIAS = /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u;
const MODULE = /^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+$/u;
const VALUE = /^["'][A-Za-z0-9_.+:-]+["']$/u;
const BOOT = 'org.springframework.boot';
const BOOT_BOM = BOOT+':spring-boot-dependencies';
const configurations = new Set(['implementation','api','runtimeOnly','compileOnly','testImplementation','testRuntimeOnly',
  'testCompileOnly','annotationProcessor','testAnnotationProcessor','developmentOnly']);
const editableConfigurations = new Set(['implementation','runtimeOnly','testImplementation']);
const unsupported = message => fail('BUILD',message);

function withoutComment(line) {
  let quote;
  for (let i=0; i<line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === '\\') throw unsupported('Escaped catalog strings require manual starter editing.');
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0,i).trim();
  }
  if (quote) throw unsupported('Use single-line literal version catalog entries.');
  return line.trim();
}

function literal(text) {
  if (!VALUE.test(text) || text[0] !== text.at(-1)) throw unsupported('Use literal Gradle catalog coordinates and version references.');
  return text.slice(1,-1);
}

function fields(text) {
  if (!text.startsWith('{') || !text.endsWith('}')) throw unsupported('Use ordinary inline Gradle catalog entries.');
  const result = new Map();
  for (const field of text.slice(1,-1).split(',')) {
    const match = /^\s*([a-z]+(?:\.ref)?)\s*=\s*(.+?)\s*$/u.exec(field);
    if (!match || result.has(match[1])) throw unsupported('Use unique literal fields in Gradle catalog entries.');
    result.set(match[1],literal(match[2]));
  }
  return result;
}

function parseCatalog(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 256*1024) throw unsupported('Use one bounded local Gradle version catalog.');
  const known = new Map(['versions','libraries','plugins','bundles'].map(section=>[section,new Map()]));
  const seen = new Set();
  let section;
  for (const line of text.split(/\r?\n/u)) {
    const value = withoutComment(line);
    if (!value) continue;
    const heading = /^\[([a-z]+)\]$/u.exec(value);
    if (heading) {
      if (!known.has(heading[1]) || seen.has(heading[1])) throw unsupported('Use one ordinary declaration of each Gradle catalog section.');
      section = heading[1]; seen.add(section); continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]{0,79})\s*=\s*(.+)$/u.exec(value);
    const entries = known.get(section);
    if (!pair || !entries || entries.has(pair[1]) || entries.size >= 1500) throw unsupported('Use bounded unique bare catalog aliases.');
    entries.set(pair[1],pair[2]);
  }
  const versions = new Map([...known.get('versions')].map(([key,value])=>[key,literal(value)]));
  function versionOf(entry) {
    const versionRef = entry.get('version.ref');
    const fixed = entry.get('version');
    if (versionRef && (fixed || !ALIAS.test(versionRef) || !versions.has(versionRef))) {
      throw unsupported('Catalog version.ref must point to one locally declared literal version.');
    }
    return {version:versionRef ? versions.get(versionRef) : fixed,versionRef};
  }
  function aliases(section) {
    const results = new Map(), accessorNames = new Set();
    for (const [alias,text] of known.get(section)) {
      const spelling = alias.replace(/[-_]/gu,'.');
      const collision = spelling.toLowerCase();
      if (spelling.split('.').some(part=>!ALIAS.test(part)) || accessorNames.has(collision) ||
          ['versions','plugins','bundles'].includes(spelling.split('.')[0])) throw unsupported('Use unambiguous Gradle catalog accessors.');
      accessorNames.add(collision);
      let entry;
      if (section === 'plugins') {
        const values = fields(text);
        const id = values.get('id');
        if (!id || [...values.keys()].some(key=>!['id','version','version.ref'].includes(key))) {
          throw unsupported('Use a literal plugin ID and version or version.ref.');
        }
        entry = {id,...versionOf(values)};
      } else if (text.startsWith('{')) {
        const values = fields(text), joined = values.get('module'), group = values.get('group'), artifact = values.get('name');
        const coordinate = joined || (group && artifact && group+':'+artifact);
        if (!MODULE.test(coordinate || '') || joined && (group || artifact) ||
            [...values.keys()].some(key=>!['module','group','name','version','version.ref'].includes(key))) {
          throw unsupported('Use module or group/name coordinates in each Gradle library alias.');
        }
        entry = {coordinate,...versionOf(values)};
      } else {
        const [group,artifact,version,...rest] = literal(text).split(':');
        const coordinate = group+':'+artifact;
        if (rest.length || !artifact || !version || !MODULE.test(coordinate)) throw unsupported('Use ordinary Gradle library shorthand or an inline table.');
        entry = {coordinate,version};
      }
      const accessor = (section === 'plugins' ? 'libs.plugins.' : 'libs.')+spelling;
      results.set(accessor,{alias,accessor,...entry});
    }
    return results;
  }
  return {plugins:aliases('plugins'),libraries:aliases('libraries')};
}

function verifySettings(settings, tokenize) {
  if (settings === undefined) throw unsupported('Use a saved root settings file to identify the default Gradle catalog.');
  const parts = tokenize(settings);
  if (!parts.length) return;
  const [project,dot,name,equals,value,semicolon] = parts;
  if (parts.length < 5 || parts.length > 6 || project.value !== 'rootProject' || dot?.value !== '.' ||
      name?.value !== 'name' || equals?.value !== '=' || value?.type !== 'string' || !value.literal ||
      semicolon && semicolon.value !== ';') {
    throw unsupported('Custom Gradle settings, catalog names and composite projects require manual starter editing.');
  }
}

function takeAccessor(tokens,start,aliases) {
  if (tokens[start]?.type !== 'id' || tokens[start].value !== 'libs') return undefined;
  let end = start+1;
  while (tokens[end]?.value === '.' && tokens[end+1]?.type === 'id') end += 2;
  const key = tokens.slice(start,end).map(token=>token.value).join('');
  const resolved = aliases.get(key);
  if (!resolved) throw unsupported('The Gradle script uses an unresolved or unsupported catalog accessor '+key+'.');
  return {resolved,end};
}

function blocks(tokens) {
  const result = [];
  let depth = 0;
  for (let i=0; i<tokens.length; i++) {
    const item = tokens[i];
    if (item.type === 'string') continue;
    if (item.value === '{') depth++;
    else if (item.value === '}') depth--;
    else if (depth === 0 && item.type === 'id' && tokens[i+1]?.value === '{') {
      let nested = 1, close = i+2;
      for (; close<tokens.length && nested; close++) {
        if (tokens[close].type === 'string') continue;
        if (tokens[close].value === '{') nested++;
        if (tokens[close].value === '}') nested--;
      }
      if (nested) throw unsupported('Unbalanced Gradle build block.');
      result.push({name:item.value,start:i+2,end:close-1});
      i = close-1;
    }
    if (depth < 0) throw unsupported('Unbalanced Gradle build script.');
  }
  if (depth) throw unsupported('Unbalanced Gradle build script.');
  const only = name => {
    const matches = result.filter(block=>block.name===name);
    if (matches.length !== 1) throw unsupported('Use one top-level '+name+' block for catalog starter edits.');
    return matches[0];
  };
  return {plugins:only('plugins'),dependencies:only('dependencies'),declared:result};
}

function separate(text,tokens,next,end) {
  if (next < end && tokens[next].value !== ';' && !/[\r\n]/u.test(text.slice(tokens[next-1].end,tokens[next].start))) {
    throw unsupported('Use standalone direct Gradle plugin and dependency declarations.');
  }
}

function bootPlugin(text,tokens,block,catalog) {
  const found = [];
  for (let index=block.start;index<block.end;) {
    const token = tokens[index++];
    if (token.value === ';') continue;
    if (token.value === 'alias' && tokens[index]?.value === '(') {
      const reference = takeAccessor(tokens,index+1,catalog.plugins);
      if (reference?.resolved.id !== BOOT || tokens[reference.end]?.value !== ')') {
        throw unsupported('Use a directly applied Spring Boot catalog plugin without an apply modifier.');
      }
      found.push(reference.resolved);
      index = reference.end+1;
    } else if (token.value === 'id') {
      const call = tokens[index]?.value === '(';
      if (call) index++;
      const id = tokens[index++];
      if (id?.type !== 'string' || !id.literal || !['java','java-library'].includes(id.value) ||
          call && tokens[index++]?.value !== ')') throw unsupported('Use the ordinary Java plugin and one direct Boot plugin alias.');
    } else if (token.value !== 'java') {
      throw unsupported('Use the ordinary Java plugin and one direct Boot plugin alias.');
    }
    separate(text,tokens,index,block.end);
  }
  if (found.length !== 1 || !VERSION.test(found[0].version || '')) throw unsupported('Use one literal or locally versioned Spring Boot plugin alias.');
  return found[0];
}

function dependencies(text,tokens,block,catalog) {
  const deps = [], platforms = [];
  for (let index=block.start; index<block.end;) {
    const first = tokens[index++];
    if (first.value === ';') continue;
    if (!configurations.has(first.value)) throw unsupported('Use direct Gradle module declarations in the catalog dependency block.');
    const call = tokens[index]?.value === '(';
    if (call) index++;
    let platform = false;
    if (tokens[index]?.value === 'platform' && tokens[index+1]?.value === '(') {
      index += 2; platform = true;
    }
    const reference = takeAccessor(tokens,index,catalog.libraries);
    let value;
    if (reference) {
      value = reference.resolved;
      index = reference.end;
    } else {
      const token = tokens[index++], parts = token?.value?.split(':') || [];
      const coordinate = parts.slice(0,2).join(':');
      if (token?.type !== 'string' || !token.literal || !MODULE.test(coordinate) ||
          parts.length > 3 || parts.length === 3 && !/^[A-Za-z0-9_.-]+$/u.test(parts[2])) {
        throw unsupported('Use direct library aliases or literal Gradle modules.');
      }
      value = {coordinate,version:parts[2]};
    }
    if (platform && tokens[index++]?.value !== ')' || call && tokens[index++]?.value !== ')') {
      throw unsupported('Use ordinary Gradle dependency declarations without build logic.');
    }
    separate(text,tokens,index,block.end);
    if (platform) {
      if (!value.alias || value.coordinate !== BOOT_BOM || first.value !== 'implementation') {
        throw unsupported('Use one direct implementation platform referencing the Spring Boot BOM catalog alias.');
      }
      platforms.push(value);
    } else {
      const [groupId,artifactId] = value.coordinate.split(':');
      const scope = first.value.startsWith('test') ? 'test' : first.value === 'runtimeOnly' ? 'runtime' : 'compile';
      deps.push({groupId,artifactId,version:value.version,scope,configuration:first.value,editable:!value.version &&
        editableConfigurations.has(first.value),start:first.start,end:tokens[index-1].end,alias:value.alias});
    }
  }
  return {deps,platforms};
}

function inspectCatalogBuild(text,kind,context,tokenize,parsedTokens) {
  verifySettings(context.settings,tokenize);
  const catalog = parseCatalog(context.versionCatalog);
  const {plugins,dependencies:direct,declared} = blocks(parsedTokens);
  const outsideCatalogBlocks = index => (index < plugins.start || index >= plugins.end) && (index < direct.start || index >= direct.end);
  if (declared.some(block=>['buildscript','subprojects','allprojects','configurations','dependencyManagement'].includes(block.name)) ||
      parsedTokens.some((token,index)=>token.type==='id'&&(
        ['resolutionStrategy','configurations','dependencySubstitution'].includes(token.value) ||
        outsideCatalogBlocks(index)&&['apply','libs'].includes(token.value) ||
        token.value==='dependencies'&&index!==direct.start-2))) {
    throw unsupported('Custom dependency resolution and multi-project build logic require manual Gradle catalog editing.');
  }
  const plugin = bootPlugin(text,parsedTokens,plugins,catalog);
  const {deps,platforms} = dependencies(text,parsedTokens,direct,catalog);
  if (platforms.length !== 1 || platforms[0].version !== plugin.version) {
    throw unsupported('The direct Gradle platform alias must resolve to the same Boot version as the applied plugin.');
  }
  const platform = platforms[0];
  return {kind,bootVersion:plugin.version,deps,insertAt:parsedTokens[direct.end].start,catalogContext:context,
    catalogLibraries:[...catalog.libraries.values()],management:{kind:'gradle-catalog-bom',coordinate:BOOT_BOM,version:plugin.version,
      property:platform.versionRef||null,pluginAlias:plugin.alias,platformAlias:platform.alias,overrides:[]}};
}

module.exports = {inspectCatalogBuild};
