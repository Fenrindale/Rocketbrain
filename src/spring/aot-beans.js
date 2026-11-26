'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { lexJava, parseJavaTokens, matching, splitTop, rangeAt } = require('./java');

const layouts = ['build/generated/aotSources', 'target/spring-aot/main/sources'];
const generatedAnnotation = 'org.springframework.aot.generate.Generated';
const beanFactory = 'org.springframework.beans.factory.support.DefaultListableBeanFactory';
const maxFileBytes = 256 * 1024;
const maxEntries = 384;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const words = tokens => tokens.map(token => token.text).join('');
const qualified = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u;
const beanName = /^[A-Za-z0-9_$][\w.$:#-]{0,199}$/u;

function inside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function physical(file) {
  return path.relative(file, fs.realpathSync(file)) === '' && !fs.lstatSync(file).isSymbolicLink();
}

function snapshot(root, file) {
  if (!inside(root, file) || !physical(file)) throw Error('Use physical, local Spring sources within the reviewed project.');
  const before = fs.statSync(file, { bigint: true });
  if (!before.isFile() || before.size < 1n || before.size > BigInt(maxFileBytes)) {
    throw Error('The Spring AOT source must be a bounded regular file.');
  }
  const bytes = fs.readFileSync(file);
  const after = fs.statSync(file, { bigint: true });
  if (bytes.length !== Number(before.size) || ['dev','ino','size','mtimeNs','ctimeNs'].some(key => before[key] !== after[key])) {
    throw Error('The Spring AOT source changed while it was being read.');
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { file, text, sha256: sha256(bytes) };
}

function parse(input) {
  const lexical = lexJava(input.text);
  if (lexical.issues.length) throw Error('Spring AOT generated Java has unsupported syntax.');
  return { ...parseJavaTokens(input, lexical), tokens: lexical.tokens };
}

function generated(input, suffix) {
  const source = parse(input);
  const name = path.basename(input.file, '.java');
  const type = source.types.find(candidate => candidate.name === name);
  if (!name.endsWith(suffix) || !type || source.imports.Generated !== generatedAnnotation ||
      !type.annotations.some(annotation => annotation.shortName === 'Generated')) {
    throw Error('Choose a regular Spring-generated ' + suffix + ' Java source.');
  }
  return source;
}

function resolveType(source, name) {
  if (!qualified.test(name)) return undefined;
  return name.includes('.') ? name : source.imports[name] || (source.packageName ? source.packageName + '.' + name : name);
}

function calls(tokens, name) {
  const result = [];
  for (let index = 0; index < tokens.length - 1; index++) {
    if (tokens[index].text !== name || tokens[index + 1].text !== '(') continue;
    const end = matching(tokens,index + 1);
    if (end < 0) throw Error('The generated call has unbalanced arguments.');
    result.push({ index, arguments: splitTop(tokens.slice(index + 2,end)), token:tokens[index] });
  }
  return result;
}

function textLiteral(tokens) {
  const [token] = tokens || [];
  return tokens?.length === 1 && token.kind === 'string' && beanName.test(token.value || '') ? token.value : undefined;
}

function methodBody(source, name) {
  const methods = calls(source.tokens,name).filter(call => {
    const opening = matching(source.tokens,call.index + 1) + 1;
    const prior = source.tokens[call.index - 1];
    return source.tokens[opening]?.text === '{' && (prior?.kind === 'id' || prior?.text === '>');
  });
  if (methods.length !== 1) return [];
  const start = matching(source.tokens,methods[0].index + 1) + 1;
  const end = matching(source.tokens,start);
  return end > start ? source.tokens.slice(start + 1,end) : [];
}

function registryCalls(source, name, callName) {
  const body = methodBody(source,name);
  const results = [];
  for (let index = 0; index < body.length;) {
    const header = words(body.slice(index,index + 4));
    if (header !== 'beanFactory.' + callName + '(') return { results, unsupported:body[index] };
    const end = matching(body,index + 3);
    if (end < 0 || body[end + 1]?.text !== ';') return { results, unsupported:body[index] };
    results.push({ arguments:splitTop(body.slice(index + 4,end)),token:body[index + 2] });
    index = end + 2;
  }
  return { results };
}

function classLiteral(source, tokens) {
  const value = words(tokens || []);
  return value.endsWith('.class') ? resolveType(source,value.slice(0,-6)) : undefined;
}

function position(source, token) {
  return { file:source.file, sha256:source.sha256, range:rangeAt(source.text,token.start,token.end) };
}

function sourceFactory(project, source, definitionBody, localSources) {
  const suppliers = calls(definitionBody,'setInstanceSupplier');
  if (suppliers.length !== 1 || suppliers[0].arguments.length !== 1) return undefined;
  const supplier = /^([A-Za-z_$][\w$]*)\(\)$/u.exec(words(suppliers[0].arguments[0]));
  if (!supplier) return undefined;
  const factories = calls(methodBody(source,supplier[1]),'forFactoryMethod');
  if (factories.length !== 1 || factories[0].arguments.length !== 2) return undefined;
  const owner = classLiteral(source,factories[0].arguments[0]);
  const method = textLiteral(factories[0].arguments[1]);
  if (!owner || !method) return undefined;
  const file = path.join(project,'src/main/java',owner.replaceAll('.',path.sep) + '.java');
  if (!fs.existsSync(file)) return { owner,method };
  if (!localSources.has(file)) localSources.set(file,parse(snapshot(project,file)));
  const local = localSources.get(file);
  const target = local.types.find(type => type.fqn === owner);
  const candidates = target?.methods.filter(member => member.name === method);
  if (candidates?.length !== 1 || candidates[0].parameters.length ||
      !candidates[0].annotations.some(annotation => annotation.name === 'org.springframework.context.annotation.Bean')) {
    return { owner,method };
  }
  const exact = candidates[0];
  return { owner,method,source:{ file,sha256:local.sha256,range:rangeAt(local.text,exact.start,exact.end) } };
}

function inspectAotBeans(project, artifact) {
  if (!path.isAbsolute(project || '') || !path.isAbsolute(artifact || '') || !physical(project)) {
    throw Error('Choose a physical local Spring project and generated registrations file.');
  }
  const layout = layouts.find(item => inside(path.join(project,item),artifact));
  if (!layout) throw Error('Choose a Spring AOT registration file from the project’s Gradle or Maven generated sources.');
  const output = path.join(project,layout);
  if (!physical(output)) throw Error('A linked AOT output directory cannot be reviewed.');
  const app = generated(snapshot(project,artifact),'__BeanFactoryRegistrations');
  if (app.imports.DefaultListableBeanFactory !== beanFactory) {
    throw Error('The generated registrars do not identify the standard Spring bean factory.');
  }
  const definitions = new Map(), localSources = new Map(), names = new Set(), entries = [], unresolved = [];
  function addUnresolved(method, token) {
    unresolved.push({ method,generated:position(app,token) });
  }
  const registrations = registryCalls(app,'registerBeanDefinitions','registerBeanDefinition');
  const aliases = registryCalls(app,'registerAliases','registerAlias');
  if (registrations.results.length + aliases.results.length > maxEntries || !registrations.results.length) {
    throw Error('A nonempty, bounded Spring AOT registration artifact is required.');
  }
  if (registrations.unsupported) addUnresolved('registerBeanDefinitions',registrations.unsupported);
  if (aliases.unsupported) addUnresolved('registerAliases',aliases.unsupported);
  for (const call of registrations.results) {
    const name = textLiteral(call.arguments[0]);
    const receiver = words(call.arguments[1] || []);
    const definitionCall = /^([\w$.]+__BeanDefinitions)\.([A-Za-z_$][\w$]*)\(\)$/u.exec(receiver);
    if (!name || !definitionCall || call.arguments.length !== 2 || names.has(name)) {
      addUnresolved('registerBeanDefinition',call.token);
      continue;
    }
    names.add(name);
    const definitionType = resolveType(app,definitionCall[1]);
    const file = definitionType && path.join(output,definitionType.replaceAll('.',path.sep) + '.java');
    const entry = { name,aliases:[],generated:position(app,call.arguments[0][0]) };
    if (file && fs.existsSync(file)) {
      if (!definitions.has(file)) definitions.set(file,generated(snapshot(project,file),'__BeanDefinitions'));
      const source = definitions.get(file);
      const body = methodBody(source,definitionCall[2]);
      const constructors = calls(body,'RootBeanDefinition');
      if (constructors.length === 1) entry.type = classLiteral(source,constructors[0].arguments[0]);
      entry.factory = sourceFactory(project,source,body,localSources);
    }
    entries.push(entry);
  }
  const byName = new Map(entries.map(entry => [entry.name,entry]));
  for (const call of aliases.results) {
    const entry = byName.get(textLiteral(call.arguments[0]));
    const name = textLiteral(call.arguments[1]);
    if (!entry || !name || names.has(name) || call.arguments.length !== 2) {
      addUnresolved('registerAlias',call.token);
      continue;
    }
    names.add(name);
    entry.aliases.push(name);
  }
  const inputs = [app,...definitions.values(),...localSources.values()]
    .map(input=>[path.relative(project,input.file).split(path.sep).join('/'),input.sha256])
    .sort(([left],[right])=>left.localeCompare(right,'en'));
  const manifestSha256 = sha256(JSON.stringify(inputs));
  return { project,artifact,layout,sha256:app.sha256,manifestSha256,entries,unresolved,executedProjectCode:false };
}

function compareAotBeans(before, after) {
  if (before.project !== after.project || before.artifact !== after.artifact) {
    throw Error('Compare two snapshots of the same Spring AOT registration artifact.');
  }
  if (before.unresolved.length || after.unresolved.length) {
    throw Error('Unresolved generated registrations prevent an exact bean comparison.');
  }
  const left = new Map(before.entries.map(entry => [entry.name,entry]));
  const right = new Map(after.entries.map(entry => [entry.name,entry]));
  const identity = ({ type,factory,aliases }) => JSON.stringify([type,factory?.owner,factory?.method,[...aliases].sort()]);
  return {
    beforeSha256:before.manifestSha256 || before.sha256,afterSha256:after.manifestSha256 || after.sha256,
    added:[...right.keys()].filter(name => !left.has(name)),
    removed:[...left.keys()].filter(name => !right.has(name)),
    changed:[...left.keys()].filter(name => right.has(name) && identity(left.get(name)) !== identity(right.get(name)))
  };
}

module.exports = { inspectAotBeans, compareAotBeans, snapshot };
