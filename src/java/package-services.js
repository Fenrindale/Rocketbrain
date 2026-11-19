'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lexJava, parseJavaFile, rangeAt } = require('../spring/java');

const DOTTED_TYPE = /^[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/;
const SERVICE_PREFIX = 'META-INF/services/';
const MAX_FILES = 24;
const MAX_BYTES = 8192;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inPackage = (name, packageName) => name.startsWith(packageName + '.');

function metadataFile(file) {
  return path.basename(path.dirname(file)) === 'services' &&
    path.basename(path.dirname(path.dirname(file))) === 'META-INF' &&
    DOTTED_TYPE.test(path.basename(file)) && !file.endsWith('.java');
}

function parseDescriptor(data) {
  if (data.length > MAX_BYTES) throw Error('A service descriptor exceeds its 8 KiB review bound.');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    throw Error('Service registration files require valid UTF-8.');
  }
  if (text.startsWith('\uFEFF') || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|\r(?!\n)/u.test(text)) {
    throw Error('Service registration files require plain UTF-8 and normal line endings.');
  }
  if (text.includes('\r\n') && /(?<!\r)\n/u.test(text)) throw Error('Mixed service descriptor line endings require a separate review.');
  const providers = [];
  const names = new Set();
  for (const match of text.matchAll(/[^\r\n]+/gu)) {
    const line = match[0].split('#', 1)[0];
    const entry = /^[ \t]*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)[ \t]*$/u.exec(line);
    if (!line.trim()) continue;
    if (!entry || names.has(entry[1]) || providers.length === 16) {
      throw Error('Service registration requires at most 16 distinct top-level provider names without indirection.');
    }
    names.add(entry[1]);
    const start = match.index + line.indexOf(entry[1]);
    providers.push({ name: entry[1], start, end: start + entry[1].length });
  }
  return { text, providers };
}

function readServiceInventory(project, roots, directoryExists) {
  const files = [];
  const testRoot = path.join(project, 'src/test/resources');
  const rootEntries = [...new Set([...roots, testRoot])];
  for (const root of rootEntries) {
    const parts = path.relative(project, root).split(path.sep);
    if (!directoryExists(project, [...parts, 'META-INF', 'services'])) continue;
    if (!fs.readdirSync(root).includes('META-INF') || !fs.readdirSync(path.join(root, 'META-INF')).includes('services')) {
      throw Error('Use the exact case-sensitive META-INF/services registration path.');
    }
    const folder = path.join(root, 'META-INF', 'services');
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      if (!metadataFile(file) || !stat.isFile() || stat.isSymbolicLink() || files.length === MAX_FILES || stat.size > MAX_BYTES) {
        throw Error('Service metadata requires a bounded set of regular top-level descriptor files.');
      }
      const data = fs.readFileSync(file);
      const { text, providers } = parseDescriptor(data);
      files.push({ root, file, service: name, text, providers, sha256: sha256(data), test: root === testRoot });
    }
  }
  return files;
}

function scalarService(source) {
  const { tokens, issues } = lexJava(source.text);
  const declaration = tokens.findIndex(token => token.text === 'interface');
  const body = tokens.slice(declaration + 2).map(token => token.text);
  if (issues.length || tokens.some(token => token.text === '@') || tokens[declaration - 1]?.text !== 'public' || body.length !== 7 ||
      body[0] !== '{' || !/^(?:boolean|byte|short|int|long|char|float|double|String)$/.test(body[1]) ||
      !/^[A-Za-z_][\w]*$/.test(body[2]) || body.slice(3).join('') !== '();}') {
    throw Error('A service descriptor needs one public source interface with a single no-argument scalar method.');
  }
  return { type: body[1], method: body[2] };
}

function validateProvider(source, model, service, contract) {
  const { tokens, issues } = lexJava(source.text);
  const at = tokens.findIndex(token => token.start === model.start);
  const word = index => tokens[index]?.text;
  let open = at + 2;
  while (open < tokens.length && word(open) !== '{') open++;
  const implemented = tokens.slice(at + 2, open).map(token => token.text).join('');
  const parsed = parseJavaFile(source);
  const simpleService = service.split('.').at(-1);
  const samePackage = service.slice(0, service.lastIndexOf('.')) === parsed.packageName;
  const exactInterface = implemented === service ||
    implemented === simpleService && (parsed.imports[simpleService] === service || samePackage && !parsed.imports[simpleService]);
  if (issues.length || parsed.issues.length || parsed.wildcards.length || parsed.types.length !== 1 ||
      word(at - 3) !== 'public' || word(at - 2) !== 'final' || word(at - 1) !== 'class' ||
      word(at + 1) !== 'implements' || !exactInterface || model.superTypes.length !== 1 ||
      tokens.some(token => ['@', 'extends', 'sealed', 'permits', 'static'].includes(token.text))) {
    throw Error('A service provider needs a plain public final source class implementing its exact source interface.');
  }
  let body = tokens.slice(open + 1);
  const constructor = ['public', model.name, '(', ')', '{', '}'];
  if (body.slice(0, constructor.length).every((token, index) => token.text === constructor[index])) body = body.slice(constructor.length);
  const method = ['public', contract.type, contract.method, '(', ')', '{', 'return'];
  const value = body[method.length];
  if (body.length !== method.length + 4 ||
      !body.slice(0, method.length).every((token, index) => token.text === method[index]) ||
      !value || !(['number', 'char', 'string'].includes(value.kind) || ['true', 'false'].includes(value.text)) ||
      body.slice(-3).map(token => token.text).join('') !== ';}}') {
    throw Error('A service provider needs an empty public constructor and one literal scalar return, with no state or custom initialization.');
  }
}

function providerBody(text) {
  const { tokens, issues } = lexJava(text);
  const declarationEnd = tokens.findIndex(token => token.text === ';');
  if (issues.length || tokens[0]?.text !== 'package' || declarationEnd < 0) {
    throw Error('A reviewed service provider must have a plain package declaration.');
  }
  return JSON.stringify(tokens.slice(declarationEnd + 1).map(token => token.text));
}

function reviewPackageServices({ project, roots, directoryExists, sources, moved, oldPackage, newPackage, uriFor }) {
  const inventory = readServiceInventory(project, roots, directoryExists);
  const data = new Map();
  if (inventory.some(item => inPackage(item.service, oldPackage) || item.providers.some(provider => inPackage(provider.name, oldPackage)))) {
    for (const source of sources.filter(value => value.file.endsWith('.java'))) {
      for (const type of parseJavaFile(source).types) {
        if (data.has(type.fqn)) throw Error('Duplicate source class identity prevents service registration analysis.');
        data.set(type.fqn, { source, type });
      }
    }
  }
  const isMainSource = (entry, name) => entry &&
    path.relative(path.join(project, 'src/main/java', ...name.split('.')) + '.java', entry.source.file) === '';
  const services = new Map();
  const providers = new Map();
  const edits = [];
  const permissions = [];
  for (const descriptor of inventory) {
    if (inPackage(descriptor.service, oldPackage)) throw Error('Moving a service interface requires a separate descriptor filename and external client review.');
    const changing = descriptor.providers.filter(provider => inPackage(provider.name, oldPackage));
    if (!changing.length) continue;
    if (descriptor.test || inventory.filter(item => item.service.toLowerCase() === descriptor.service.toLowerCase()).length !== 1) {
      throw Error('Competing service descriptors or test-only service registrations require a separate Package Move review.');
    }
    const spi = data.get(descriptor.service);
    if (!isMainSource(spi, descriptor.service) || spi.type.kind !== 'interface' || moved.has(spi.source.uri)) {
      throw Error('The exact public service interface must remain in the reviewed main source set.');
    }
    const contract = scalarService(spi.source);
    const rewrites = [];
    for (const registered of descriptor.providers) {
      const provider = data.get(registered.name);
      if (!isMainSource(provider, registered.name) || provider.type.kind !== 'class') {
        throw Error('All registered providers must bind to reviewed top-level main source classes.');
      }
      validateProvider(provider.source, provider.type, descriptor.service, contract);
      const shouldMove = changing.includes(registered);
      if (shouldMove !== moved.has(provider.source.uri)) throw Error('A registered provider does not match the selected Java package tree.');
      if (!shouldMove) continue;
      if (providers.has(provider.source.uri)) throw Error('Provider sharing between service descriptors needs separate analysis.');
      const nextName = newPackage + registered.name.slice(oldPackage.length);
      if (data.has(nextName) || descriptor.providers.some(item => item.name.toLowerCase() === nextName.toLowerCase())) {
        throw Error('A destination service provider identity already exists.');
      }
      providers.set(provider.source.uri, descriptor.service);
      rewrites.push({ ...registered, nextName });
    }
    const after = rewrites.reduceRight((text, item) => text.slice(0, item.start) + item.nextName + text.slice(item.end), descriptor.text);
    const uri = uriFor(descriptor.file);
    const edit = { textDocument: { uri, version: null }, edits: rewrites.map(item => ({
      range: rangeAt(descriptor.text, item.start, item.end), newText: item.nextName
    })) };
    edits.push(edit);
    permissions.push({ uri, beforeSha256: descriptor.sha256, afterSha256: sha256(after) });
    services.set(descriptor.service, {
      service: descriptor.service, file: descriptor.file, path: SERVICE_PREFIX + descriptor.service, method: contract.method,
      sha256: descriptor.sha256, afterSha256: sha256(after), providers: descriptor.providers.map(item => item.name),
      rewrites: rewrites.map(({ name, nextName }) => ({ from: name, to: nextName }))
    });
  }
  const snapshot = JSON.stringify(inventory);
  return {
    services, providers, edits, permissions,
    verifyProviders(transformed, renames) {
      for (const uri of providers.keys()) {
        const before = sources.find(source => source.uri === uri);
        const nextUri = renames.find(rename => rename.oldUri === uri)?.newUri;
        const after = transformed.find(source => source.uri === nextUri);
        if (!after || providerBody(before.text) !== providerBody(after.text)) {
          throw Error('The Java engine changed a reviewed service provider body or import.');
        }
      }
    },
    validate() {
      if (JSON.stringify(readServiceInventory(project, roots, directoryExists)) !== snapshot) {
        throw Error('Service registration membership or bytes changed after Package Move review.');
      }
    }
  };
}

module.exports = { metadataFile, parseDescriptor, reviewPackageServices };
