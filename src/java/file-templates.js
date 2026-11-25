'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { lexJava } = require('../spring/java');

const KEYWORDS = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum '
  + 'extends final finally float for goto if implements import instanceof int interface long native new package private protected '
  + 'public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false '
  + 'null record sealed permits var yield _').split(' '));
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const IDENTIFIER = /^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u;
const MAX_TEMPLATE_BYTES = 32 * 1024;
const BUILD_TOOLS = new Set(['maven','gradle','java']);
const SOURCE_KINDS = new Set(['main','test','any']);
const VARIABLE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const VARIABLE_KINDS = new Set(['identifier','string','integer']);
const HEADER_PLACEHOLDERS = new Set(['year','name','package']);
const ESCAPE = /\\u+[0-9a-f]{4}/i;
const TYPES = {
  'Java class': 'public class ${name} {\n}\n',
  'Java interface': 'public interface ${name} {\n}\n',
  'Java enum': 'public enum ${name} {\n}\n',
  'Java record': 'public record ${name}() {\n}\n',
  'Java annotation': 'public @interface ${name} {\n}\n'
};

function annotatedImport(type, packagePath) {
  return 'import ' + packagePath + '.' + type + ';\n\n@' + type + '\npublic class ${name} {\n}\n';
}

const BUILTIN_TEMPLATES = Object.freeze([
  ...Object.entries(TYPES).map(([name, template]) => Object.freeze({
    name, source: 'any', template: '${packageDeclaration}' + template
  })),
  ...[
    ['Spring component', 'Component', 'org.springframework.stereotype'],
    ['Spring service', 'Service', 'org.springframework.stereotype'],
    ['Spring configuration', 'Configuration', 'org.springframework.context.annotation'],
    ['Spring REST controller', 'RestController', 'org.springframework.web.bind.annotation']
  ].map(([name, type, packagePath]) => Object.freeze({
    name, source: 'main', template: '${packageDeclaration}' + annotatedImport(type, packagePath)
  })),
  Object.freeze({
    name: 'JUnit Jupiter test', source: 'test',
    template: '${packageDeclaration}import org.junit.jupiter.api.Test;\n\nclass ${name} {\n    @Test\n    void example() {\n    }\n}\n'
  })
]);

function validIdentifier(value) {
  return typeof value === 'string' && value.length <= 120 && IDENTIFIER.test(value) &&
    !KEYWORDS.has(value) && !WINDOWS_DEVICE.test(value);
}

function checkPackage(value) {
  if (typeof value !== 'string' || value.length > 300 ||
      (value && !value.split('.').every(validIdentifier))) {
    throw Error('Use a valid Java package name, or leave it empty for the default package.');
  }
  return value;
}

function scopeOf(item) {
  const source=item.source??'any',tools=item.buildTools;
  if (!SOURCE_KINDS.has(source)) throw Error('Choose an allowed source kind for the Java template or copyright profile.');
  if (tools!==undefined&&(!Array.isArray(tools)||!tools.length||tools.length>BUILD_TOOLS.size||
      new Set(tools).size!==tools.length||tools.some(value=>!BUILD_TOOLS.has(value)))) {
    throw Error('Choose distinct Maven, Gradle or Java build tools.');
  }
  return {source,...(tools&&{buildTools:[...tools]})};
}

function matchesFileScope(item,source,tool) {
  return (item.source==='any'||item.source===source)&&(!item.buildTools||item.buildTools.includes(tool));
}

function templateVariableError(kind,value) {
  if (typeof value!=='string'||value.length>512||/[\x00-\x1f\x7f]/.test(value)) return 'Enter at most 512 characters on one line.';
  if (kind==='identifier'&&!validIdentifier(value)) return 'Enter a valid Java identifier.';
  if (kind==='integer'&&(!/^-?\d{1,10}$/.test(value)||Number(value)<-2147483648||Number(value)>2147483647)) {
    return 'Enter a 32-bit Java integer.';
  }
}

function variablesOf(template) {
  const entries=template.variables??[];
  if (!Array.isArray(entries)||entries.length>8) throw Error('Declare at most eight Java template variables.');
  const names=new Set(),variables=[];
  for (const item of entries) {
    if(!item||typeof item.name!=='string'||!VARIABLE_NAME.test(item.name)||names.has(item.name)||!VARIABLE_KINDS.has(item.kind)||
        item.prompt!==undefined&&(typeof item.prompt!=='string'||!item.prompt.trim()||item.prompt.length>120||/[\x00-\x1f]/.test(item.prompt))) {
      throw Error('Each Java template variable needs a distinct name and an identifier, string or integer kind.');
    }
    if (item.default!==undefined) {
      const invalid=templateVariableError(item.kind,item.default);
      if(invalid)throw Error('Invalid default for '+item.name+'. '+invalid);
    }
    names.add(item.name);
    variables.push({name:item.name,kind:item.kind,prompt:item.prompt??item.name,...(item.default!==undefined&&{default:item.default})});
  }
  return {names,variables};
}

function validateTemplate(template) {
  if (!template || typeof template.name !== 'string' || !template.name.trim() ||
      template.name.length > 80 || /[\r\n\0]/.test(template.name) ||
      typeof template.template !== 'string' || !template.template.includes('${name}') ||
      template.template.includes('\0') || Buffer.byteLength(template.template) > MAX_TEMPLATE_BYTES) {
    throw Error('Each Java file template needs a name, an allowed source kind and text with a ${name} placeholder.');
  }
  const scope=scopeOf(template),{names,variables}=variablesOf(template),used=new Set();
  const body=template.template.replace(/\$\{(name|package|packageDeclaration|variable\.([A-Za-z][A-Za-z0-9_]{0,39}))\}/g,
    (placeholder,_key,variable)=>{
      if (!variable) return '';
      if (!names.has(variable)) return placeholder;
      used.add(variable);
      return '';
    });
  if (body.includes('${')) throw Error('Java file templates support ${name}, ${package}, ${packageDeclaration} and declared ${variable.name} placeholders.');
  if (used.size!==names.size) throw Error('Use each declared variable in the Java template.');
  return {name:template.name.trim(),...scope,template:template.template,...(variables.length&&{variables})};
}

function listFileTemplates(custom = []) {
  if (!Array.isArray(custom) || custom.length > 30) throw Error('Configure at most 30 custom Java file templates.');
  const entries = new Map(BUILTIN_TEMPLATES.map(item => [item.name, item]));
  for (const entry of custom) {
    const template = validateTemplate(entry);
    // A configured name may override a built-in definition.
    entries.set(template.name, template);
  }
  return [...entries.values()];
}

function listCopyrightProfiles(profiles=[]) {
  if(!Array.isArray(profiles)||profiles.length>20)throw Error('Configure at most 20 Java copyright profiles.');
  const entries=new Map();
  for(const item of profiles) {
    if(!item||typeof item.name!=='string'||!item.name.trim()||item.name.length>80||/[\x00-\x1f]/.test(item.name)||
        typeof item.notice!=='string'||!item.notice.trim()||Buffer.byteLength(item.notice)>4096||
        /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(item.notice)||ESCAPE.test(item.notice)) {
      throw Error('A Java copyright profile requires a short name and ordinary notice text.');
    }
    const name=item.name.trim();
    if(entries.has(name))throw Error('Java copyright profile names must be distinct.');
    const body=item.notice.replace(/\$\{(\w+)\}/g,(placeholder,key)=>HEADER_PLACEHOLDERS.has(key)?'':placeholder);
    if(body.includes('${'))throw Error('Java copyright profiles support ${year}, ${name} and ${package}.');
    entries.set(name,{name,notice:item.notice.replace(/\r\n?/g,'\n').trim(),...scopeOf(item)});
  }
  return [...entries.values()];
}

function copyrightHeader(profile,name,packageName,year) {
  if (!profile) return '';
  const [checked]=listCopyrightProfiles([profile]);
  const substitutions={name,package:packageName,year:String(year)};
  const expanded=checked.notice.replace(/\$\{(\w+)\}/g,(_,key)=>substitutions[key]);
  return expanded.split('\n').map(line=>line?'// '+line:'//').join('\n')+'\n\n';
}

function variableValues(declared,values) {
  if (!values||typeof values!=='object'||Array.isArray(values)) throw Error('Supply the declared Java template variables by name.');
  const keys=new Set(declared.map(item=>item.name));
  if(Object.keys(values).some(name=>!keys.has(name)))throw Error('Only supply declared Java template variables.');
  const rendered=new Map();
  for(const item of declared) {
    const value=Object.hasOwn(values,item.name)?values[item.name]:item.default;
    if (value===undefined) throw Error('Enter a value for Java template variable '+item.name+'.');
    const invalid=templateVariableError(item.kind,value);
    if(invalid)throw Error(item.name+'. '+invalid);
    const source=item.kind==='integer'?String(Number(value)):item.kind==='string'?JSON.stringify(value):value;
    rendered.set(item.name,source);
  }
  return rendered;
}

function renderJavaFile(template, name, packageName = '', {variables={},copyrightProfile}={}) {
  if (!validIdentifier(name)) throw Error('Use a valid Java type name without the .java extension.');
  checkPackage(packageName);
  const values = { name, package: packageName, packageDeclaration: packageName ? 'package ' + packageName + ';\n\n' : '' };
  const definition=validateTemplate(template),rendered=variableValues(definition.variables??[],variables);
  const body = definition.template
    .replace(/\$\{(name|package|packageDeclaration|variable\.([A-Za-z][A-Za-z0-9_]{0,39}))\}/g,
      (_,key,variable)=>variable?rendered.get(variable):values[key])
    .replaceAll(/\r\n?/g, '\n');
  const text=copyrightHeader(copyrightProfile,name,packageName,new Date().getUTCFullYear())+body;
  if(Buffer.byteLength(text)>64*1024)throw Error('The generated Java source exceeds 64 KiB.');
  const { tokens } = lexJava(text);
  const packages = tokens.filter(token => token.kind === 'id' && token.text === 'package');
  const declared = packages.length === 1 ?
    /^\s*([^;]+);/.exec(text.slice(packages[0].end))?.[1]?.trim().replace(/\s*\.\s*/g, '.') : undefined;
  if (packages.length > 1 || (declared ?? '') !== packageName || (packages.length && !declared)) {
    throw Error('The rendered Java template must declare the selected package. Use ${packageDeclaration}.');
  }
  return text.endsWith('\n') ? text : text + '\n';
}

function contained(directory, location) {
  const relative = path.relative(directory, location);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

async function physicalDirectory(directory) {
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || path.relative(await fs.realpath(directory), directory)) {
    throw Error('Java file creation uses physical directories inside the selected workspace.');
  }
  return directory;
}

async function writeTemplateFile({workspaceRoot, sourceRoot, template, name, packageName = '',
  variables, copyrightProfile, createSourceRoot = false, assertTrusted, assertTarget = () => {}}) {
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(sourceRoot) || !contained(workspaceRoot, sourceRoot)) {
    throw Error('Select a Java source root inside the open workspace.');
  }
  const content = renderJavaFile(template, name, packageName,{variables,copyrightProfile});
  await physicalDirectory(workspaceRoot);
  async function ensureDirectory(parent, segment) {
    const directory = path.join(parent, segment);
    assertTrusted();
    try { await fs.mkdir(directory); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return physicalDirectory(directory);
  }
  let destination = sourceRoot;
  if (createSourceRoot) {
    destination = workspaceRoot;
    for (const segment of path.relative(workspaceRoot, sourceRoot).split(path.sep)) {
      destination = await ensureDirectory(destination, segment);
    }
  } else {
    await physicalDirectory(sourceRoot);
  }
  for (const segment of packageName ? packageName.split('.') : []) {
    destination = await ensureDirectory(destination, segment);
  }
  const file = path.join(destination, name + '.java');
  // Exclusive creation preserves concurrent files and existing editor buffers.
  assertTrusted();
  assertTarget(file);
  try { await fs.writeFile(file, content, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('A Java source file with this name already exists in the selected package.');
    throw error;
  }
  return { path: file, name, packageName, template: template.name };
}

module.exports = { listFileTemplates, listCopyrightProfiles, matchesFileScope, templateVariableError, validIdentifier, checkPackage,
  renderJavaFile, writeTemplateFile, contained, physicalDirectory };
