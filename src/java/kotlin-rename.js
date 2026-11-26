'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {createHash} = require('node:crypto');
const {inside,fail} = require('./workbench-model');
const {lexJava} = require('../spring/java');

const MAX_FILES = 80;
const MAX_EDITS = 1000;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/u;
const VARIANTS = new Set(['val','var','fun','class','interface','object','package','import','is','in','as','break','continue',
  'do','while','for','return','throw','try','when','else','if','true','false','null','this','super','typealias','typeof',
  'annotation','by','catch','constructor','delegate','dynamic','field','file','finally','get','init','param','property',
  'receiver','set','setparam','value','where','actual','abstract','companion','const','crossinline','data','enum','expect',
  'external','final','infix','inline','inner','internal','lateinit','noinline','open','operator','out','override','private',
  'protected','public','reified','sealed','suspend','tailrec','vararg','it']);
const BUILD = ['build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradle/libs.versions.toml'];
const key = file => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const canonicalText = text => text.replace(/\r\n/gu,'\n');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function verifyName(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || /^_+$/u.test(value) || VARIANTS.has(value)) {
    throw fail('Enter a plain Kotlin identifier that differs from reserved names.');
  }
  return value;
}

function physicalInput(file,root) {
  if (!inside(root,file)) throw fail('Kotlin rename inputs must stay inside the selected Gradle project.');
  let current = root;
  for (const piece of path.relative(root,file).split(path.sep).filter(Boolean)) {
    current = path.join(current,piece);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw fail('Kotlin rename does not follow linked sources or configuration files.');
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > 512*1024 || key(fs.realpathSync(file)) !== key(file)) {
    throw fail('Use ordinary bounded physical Kotlin, Java and Gradle sources.');
  }
  const bytes = fs.readFileSync(file);
  let contents;
  try { contents = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
  catch { throw fail('Kotlin rename requires UTF-8 project sources.'); }
  if (contents.includes('\0')) throw fail('Kotlin rename requires ordinary UTF-8 text sources.');
  return {file,key:key(file),text:contents,sha:digest(bytes)};
}

function inventory(root) {
  const result = new Map();
  let total = 0, visited = 0;
  function add(file) {
    const value = physicalInput(file,root);
    total += Buffer.byteLength(value.text);
    if (result.size >= MAX_FILES || total > 6*1024*1024) throw fail('The Kotlin rename source inventory exceeds its project limit.');
    if (result.has(value.key)) throw fail('Kotlin rename detected a case-ambiguous source path.');
    result.set(value.key,value);
  }
  for (const name of BUILD) {
    const file = path.join(root,name);
    if (fs.existsSync(file)) add(file);
  }
  const settings = [...result.values()].filter(value=>/^settings\.gradle(?:\.kts)?$/u.test(path.basename(value.file)));
  const builds = [...result.values()].filter(value=>/^build\.gradle(?:\.kts)?$/u.test(path.basename(value.file)));
  if (settings.length !== 1 || builds.length !== 1 ||
      /\b(?:include|includeBuild|projectDir|sourceSets|srcDirs?|setSrcDirs|setSource|apply)\b/u.test(settings[0].text+'\n'+builds[0].text)) {
    throw fail('Review Kotlin rename in one Gradle JVM project with standard source roots.');
  }
  function walk(directory,depth) {
    if (depth > 24) throw fail('Kotlin rename source directories exceed their nesting limit.');
    if (fs.lstatSync(directory).isSymbolicLink()) throw fail('Kotlin rename does not follow linked source directories.');
    for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if (++visited > 2500 || entry.isSymbolicLink()) throw fail('Kotlin rename requires a bounded, unlinked source tree.');
      const file = path.join(directory,entry.name);
      if (entry.isDirectory()) walk(file,depth+1);
      else if (/\.(?:kt|java)$/u.test(entry.name)) {
        const relative = path.relative(root,file).split(path.sep);
        if (!['main','test'].includes(relative[1]) || !['kotlin','java'].includes(relative[2])) {
          throw fail('Kotlin rename requires standard main and test JVM source roots.');
        }
        add(file);
      }
    }
  }
  const source = path.join(root,'src');
  if (fs.existsSync(source)) walk(source,0);
  return result;
}

function offset(text,value) {
  if (!Number.isSafeInteger(value?.line) || !Number.isSafeInteger(value?.character) ||
      value.line < 0 || value.character < 0) throw fail('The Kotlin server returned an invalid source position.');
  const lines = text.split('\n');
  if (value.line >= lines.length || value.character > lines[value.line].replace(/\r$/u,'').length) {
    throw fail('The Kotlin server returned a source position outside the reviewed text.');
  }
  return lines.slice(0,value.line).reduce((sum,line)=>sum+line.length+1,0)+value.character;
}

function sourceKey(value) {
  try {
    const uri = new URL(value);
    if (uri.protocol !== 'file:' || uri.hostname || uri.search || uri.hash) throw Error();
    return key(fileURLToPath(uri));
  } catch { throw fail('Kotlin rename only accepts local file URI changes.'); }
}

function sourceSpan(site,files,oldName) {
  const id = sourceKey(site?.targetUri || site?.uri);
  const file = files.get(id), range = site?.targetSelectionRange || site?.range;
  if (!file?.file.endsWith('.kt')) throw fail('A Kotlin reference or rename edit leaves the reviewed project sources.');
  const start = offset(file.text,range?.start), end = offset(file.text,range?.end);
  if (file.text.slice(start,end) !== oldName ||
      /[\p{L}\p{N}_`]/u.test(file.text[start-1] || '') || /[\p{L}\p{N}_`]/u.test(file.text[end] || '')) {
    throw fail('The Kotlin server returned an edit or reference that is not the exact selected identifier.');
  }
  return {id:id+'\0'+start+'\0'+end,file,start,range};
}

function selectedRange(text,position) {
  offset(text,position);
  const line = text.split('\n')[position.line];
  const before = /[A-Za-z0-9_]+$/u.exec(line.slice(0,position.character))?.[0].length || 0;
  const after = /^[A-Za-z0-9_]+/u.exec(line.slice(position.character))?.[0].length || 0;
  return {start:{line:position.line,character:position.character-before},
    end:{line:position.line,character:position.character+after}};
}

function sameRange(first,second) {
  return ['start','end'].every(point=>first?.[point]?.line===second?.[point]?.line &&
    first?.[point]?.character===second?.[point]?.character);
}

function filePrivateFunction(declaration) {
  const {tokens,issues} = lexJava(declaration.file.text);
  // Nested comments have different nesting rules in Kotlin. Keep this mixed-project
  // visibility check confined to ordinary, explicitly private function declarations.
  if (issues.length || /\/\*[\s\S]*?\/\*/u.test(declaration.file.text)) return false;
  const index = tokens.findIndex(token=>token.start===declaration.start);
  return index > 1 && tokens[index-2].text==='private' && tokens[index-1].text==='fun' &&
    tokens[index+1]?.text==='(' && declaration.file.text.slice(0,tokens[index-2].start).split('\n').at(-1).trim()==='';
}

function uniqueDeclaration(definitions) {
  const resolved = definitions ? Array.isArray(definitions) ? definitions : [definitions] : [];
  if (resolved.length > 1) throw fail('The Kotlin server returned multiple declaration candidates.');
  return resolved[0];
}

function referenceParameters(original,definitions,files) {
  const declaration = uniqueDeclaration(definitions);
  const uri = declaration?.targetUri || declaration?.uri || original.textDocument.uri;
  const position = (declaration?.targetSelectionRange || declaration?.range)?.start || original.position;
  const source = files.get(sourceKey(uri));
  if (!source?.file.endsWith('.kt')) throw fail('The Kotlin declaration leaves the reviewed project sources.');
  offset(source.text,position);
  return {textDocument:{uri},position,context:{includeDeclaration:true}};
}

function reconcileRename({files,uri,position,prepared,definitions,references,edit,newName}) {
  verifyName(newName);
  const source = files.get(sourceKey(uri)), preparedRange = prepared?.range || prepared;
  if (!source?.file.endsWith('.kt') || !preparedRange?.start || !preparedRange?.end) {
    throw fail('Choose a Kotlin declaration or an ordinary Kotlin identifier reference.');
  }
  const range = selectedRange(source.text,position);
  const oldName = source.text.slice(offset(source.text,range.start),offset(source.text,range.end));
  if (!IDENTIFIER.test(oldName) || prepared.placeholder && prepared.placeholder !== oldName || oldName === newName) {
    throw fail('Choose a supported existing Kotlin identifier and a different name.');
  }
  const anchor = sourceSpan({uri,range},files,oldName);
  if (!edit || edit.changeAnnotations && Object.keys(edit.changeAnnotations).length || edit.documentChanges && edit.changes) {
    throw fail('The Kotlin server did not return plain reviewed text edits.');
  }
  const edits = edit.documentChanges || Object.entries(edit.changes || {}).map(([uri,edits])=>({textDocument:{uri},edits}));
  if (!Array.isArray(edits) || !edits.length || edits.length > 30 ||
      !Array.isArray(references) || references.length > MAX_EDITS) throw fail('The Kotlin rename edit set exceeds its bounds or lacks references.');
  const exact = new Map(), changed = new Map();
  for (const operation of edits) {
    if (!operation?.textDocument?.uri || operation.textDocument.version != null || operation.kind ||
        !Array.isArray(operation.edits) || !operation.edits.length) {
      throw fail('Kotlin rename reviews only exact text changes to existing sources.');
    }
    for (const change of operation.edits) {
      if (change?.annotationId !== undefined || change?.newText !== newName || exact.size >= MAX_EDITS) {
        throw fail('The Kotlin server returned a replacement outside the reviewed identifier change.');
      }
      const span = sourceSpan({uri:operation.textDocument.uri,range:change.range},files,oldName);
      if (exact.has(span.id)) throw fail('The Kotlin server returned overlapping or duplicate rename edits.');
      exact.set(span.id,span);
      if (!changed.has(span.file.key)) changed.set(span.file.key,{file:span.file,edits:[]});
      changed.get(span.file.key).edits.push({range:span.range,newText:newName});
    }
  }
  const uses = new Set(references.map(item=>sourceSpan(item,files,oldName).id));
  const definition = uniqueDeclaration(definitions);
  const declaration = definition ? sourceSpan(definition,files,oldName) : anchor;
  // The pinned server can return the declaration's range from prepareRename
  // when invoked at a use. Reconcile both independently checked source spans.
  if (!sameRange(preparedRange,anchor.range) && !sameRange(preparedRange,declaration.range)) {
    throw fail('The Kotlin rename preparation does not agree with the selected token or resolved declaration.');
  }
  const expected = new Set([...uses,declaration.id]);
  if (!exact.has(anchor.id) || exact.size !== expected.size || [...expected].some(id=>!exact.has(id))) {
    throw fail('Kotlin rename does not agree with the verified declaration and reference ranges.');
  }
  const mixed = [...files.values()].some(file=>file.file.endsWith('.java'));
  if (mixed && (!filePrivateFunction(declaration) || [...changed.keys()].some(id=>id!==declaration.file.key))) {
    throw fail('Mixed Kotlin/Java projects can review ordinary private function rename within its declaring Kotlin file.');
  }
  const collision = new RegExp('(?<![\\p{L}\\p{N}_])'+newName+'(?![\\p{L}\\p{N}_])','u');
  const scope = mixed ? [declaration.file] : [...files.values()].filter(file=>file.file.endsWith('.kt'));
  if (scope.some(file=>collision.test(file.text))) {
    throw fail('The proposed Kotlin name already appears in the reviewed source scope. Choose a different name.');
  }
  return {changed,oldName,declaration,referenceCount:expected.size-1,scope:mixed?'private-function':'kotlin-project'};
}

module.exports = {inventory,reconcileRename,referenceParameters,verifyName,sourceKey,canonicalText};
