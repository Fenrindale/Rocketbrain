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

function validateTemplate(template) {
  if (!template || typeof template.name !== 'string' || !template.name.trim() ||
      template.name.length > 80 || /[\r\n\0]/.test(template.name) ||
      !['main','test','any'].includes(template.source ?? 'any') ||
      typeof template.template !== 'string' || !template.template.includes('${name}') ||
      template.template.includes('\0') || Buffer.byteLength(template.template) > MAX_TEMPLATE_BYTES) {
    throw Error('Each Java file template needs a name, an allowed source kind and text with a ${name} placeholder.');
  }
  const body = template.template.replaceAll(/\$\{(?:name|package|packageDeclaration)\}/g, '');
  if (body.includes('${')) throw Error('Java file templates support ${name}, ${package} and ${packageDeclaration}.');
  return { name: template.name.trim(), source: template.source ?? 'any', template: template.template };
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

function renderJavaFile(template, name, packageName = '') {
  if (!validIdentifier(name)) throw Error('Use a valid Java type name without the .java extension.');
  checkPackage(packageName);
  const values = { name, package: packageName, packageDeclaration: packageName ? 'package ' + packageName + ';\n\n' : '' };
  const text = validateTemplate(template).template
    .replace(/\$\{(name|package|packageDeclaration)\}/g, (_, key) => values[key])
    .replaceAll(/\r\n?/g, '\n');
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
  createSourceRoot = false, assertTrusted, assertTarget = () => {}}) {
  if (!path.isAbsolute(workspaceRoot) || !path.isAbsolute(sourceRoot) || !contained(workspaceRoot, sourceRoot)) {
    throw Error('Select a Java source root inside the open workspace.');
  }
  const content = renderJavaFile(template, name, packageName);
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

module.exports = { listFileTemplates, validIdentifier, checkPackage, renderJavaFile, writeTemplateFile, contained, physicalDirectory };
