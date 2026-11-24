'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { lexJava, parseJavaFile, rangeAt } = require('../spring/java');
const { reviewClosedModule } = require('./package-module');

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
  const parsed = parseJavaFile(source);
  const packageEnd = tokens.findIndex(token => token.text === ';');
  const declaration = packageEnd + 2;
  const body = tokens.slice(declaration + 2).map(token => token.text);
  if (issues.length || parsed.issues.length || parsed.types.length !== 1 || !parsed.packageName || packageEnd < 0 ||
      tokens[0]?.text !== 'package' || tokens[declaration - 1]?.text !== 'public' || tokens[declaration]?.text !== 'interface' ||
      tokens[declaration + 1]?.text !== parsed.types[0].name || body.length !== 7 ||
      body[0] !== '{' || !/^(?:boolean|byte|short|int|long|char|float|double|String)$/.test(body[1]) ||
      !/^[A-Za-z_][\w]*$/.test(body[2]) || body.slice(3).join('') !== '();}') {
    throw Error('A service descriptor needs one public source interface with a single no-argument scalar method.');
  }
  return { type: body[1], method: body[2] };
}

function providerShape(source, model, service, contract) {
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
  const packageEnd = tokens.findIndex(token => token.text === ';');
  return {
    // Resolve the implements clause first. Its text and the matching explicit
    // import may legitimately change when the interface moves.
    imports: tokens.slice(packageEnd + 1, at - 3).map(token => token.text).join(' ').replace(
      'import ' + service.split('.').join(' . ') + ' ;', ''
    ).trim(),
    body: tokens.slice(open).map(token => token.text)
  };
}

function sameProviderBody(before, after) {
  return JSON.stringify(before) === JSON.stringify(after);
}

function factoryShape(source, type, service) {
  const { tokens, issues } = lexJava(source.text);
  const parsed = parseJavaFile(source);
  const start = tokens.findIndex(token => token.start === type.start);
  const words = tokens.map(token => token.text);
  const resolve = name => DOTTED_TYPE.test(name) ? name :
    /^[A-Za-z_][\w]*$/.test(name) ? parsed.imports[name] || parsed.packageName + '.' + name : null;
  const unsupported = () => Error('A module provider factory needs one public static provider() with one exact no-argument source implementation allocation.');
  if (issues.length || parsed.issues.length || parsed.wildcards.length || parsed.types.length !== 1 ||
      type.superTypes.length || words.slice(start - 3, start).join(' ') !== 'public final class' || words[start + 1] !== '{') throw unsupported();
  let body = words.slice(start + 2);
  const emptyConstructor = ['private', type.name, '(', ')', '{', '}'];
  const privateConstructor = body.slice(0, emptyConstructor.length).every((token, index) => token === emptyConstructor[index]);
  if (privateConstructor) body = body.slice(emptyConstructor.length);
  const method = body.indexOf('provider');
  if (body[0] !== 'public' || body[1] !== 'static' || method <= 2 || resolve(body.slice(2, method).join('')) !== service ||
      body.slice(method + 1, method + 6).join(' ') !== '( ) { return new' || body.slice(-5).join(' ') !== '( ) ; } }') throw unsupported();
  const implementation = resolve(body.slice(method + 6, -5).join(''));
  if (!implementation || implementation === type.fqn) throw unsupported();
  const packageEnd = words.indexOf(';');
  let imports = words.slice(packageEnd + 1, start - 3).join(' ');
  for (const name of [service, implementation]) imports = imports.replace('import ' + name.split('.').join(' . ') + ' ;', '');
  if (imports.trim()) throw unsupported();
  return { implementation, privateConstructor };
}

function reviewPackageServices({ project, roots, directoryExists, sources, moved, oldPackage, newPackage, uriFor }) {
  const inventory = readServiceInventory(project, roots, directoryExists);
  const module = reviewClosedModule(project, sources);
  if (module && inventory.length) throw Error('Module service declarations cannot be mixed with classpath service descriptors.');
  const registrations = module ? [...module.registrations.values()] : inventory;
  const data = new Map();
  if (module || registrations.some(item => inPackage(item.service, oldPackage) || item.providers.some(provider => inPackage(provider.name, oldPackage)))) {
    for (const source of sources.filter(value => value.file.endsWith('.java'))) {
      for (const type of parseJavaFile(source).types) {
        if (data.has(type.fqn)) throw Error('Duplicate source class identity prevents service registration analysis.');
        data.set(type.fqn, { source, type });
      }
    }
  }
  const mainSource = name => path.join(project, 'src/main/java', ...name.split('.')) + '.java';
  const isMainSource = (entry, name) => entry && path.relative(mainSource(name), entry.source.file) === '';
  const nextName = name => newPackage + name.slice(oldPackage.length);
  const hasType = name => [...data.keys()].some(value => value.toLowerCase() === name.toLowerCase());
  const services = new Map();
  const providers = new Map();
  const factories = new Map();
  const checkedProviders = new Map();
  const interfaces = new Map();
  const compilerMethods = [];
  const edits = [];
  const permissions = [];
  const renames = [];
  const moduleReplacements = [];
  if (module) {
    for (const use of module.uses.values()) {
      if (!module.registrations.has(use.name)) throw Error('Module service uses must name a locally reviewed provides registration.');
      if (inPackage(use.name, oldPackage)) moduleReplacements.push({ span: use, replacement: nextName(use.name) });
    }
  }
  function verifyPlainProvider(name, service, nextService, contract, { allowFactory = false } = {}) {
    const provider = data.get(name);
    if (!isMainSource(provider, name) || provider.type.kind !== 'class') {
      throw Error('All registered providers and factory implementations must bind to reviewed top-level main source classes.');
    }
    const changes = inPackage(name, oldPackage);
    if (changes !== moved.has(provider.source.uri)) throw Error('A registered provider does not match the selected Java package tree.');
    const nextOwner = changes ? nextName(name) : name;
    const factory = allowFactory && provider.type.methods.some(method => method.name === 'provider') &&
      lexJava(provider.source.text).tokens.some(token => token.text === 'static');
    const shape = factory ? factoryShape(provider.source, provider.type, service) : providerShape(provider.source, provider.type, service, contract);
    if (changes && hasType(nextOwner)) throw Error('A destination service provider identity already exists.');
    if (checkedProviders.has(provider.source.uri)) throw Error('Provider sharing between service descriptors or factories needs separate analysis.');
    checkedProviders.set(provider.source.uri, { shape, nextService, contract, name: nextOwner, factory });
    if (changes) (factory ? factories : providers).set(provider.source.uri, service);
    if (factory) {
      const impl = verifyPlainProvider(shape.implementation, service, nextService, contract);
      compilerMethods.push({ uri: provider.source.uri, owner: name, nextOwner, method: 'provider', returnType: service,
        nextReturnType: nextService, kind: 'CLASS', implementation: shape.implementation, nextImplementation: impl.nextOwner });
      return { nextOwner, implementation: shape.implementation, nextImplementation: impl.nextOwner };
    }
    compilerMethods.push({ uri: provider.source.uri, owner: name, nextOwner, method: contract.method,
      returnType: contract.type === 'String' ? 'java.lang.String' : contract.type, kind: 'CLASS', service, nextService });
    return { nextOwner };
  }
  for (const descriptor of registrations) {
    const movingService = inPackage(descriptor.service, oldPackage);
    const changing = descriptor.providers.filter(provider => inPackage(provider.name, oldPackage));
    if (!module && !movingService && !changing.length) continue;
    if (descriptor.test || !module && inventory.filter(item => item.service.toLowerCase() === descriptor.service.toLowerCase()).length !== 1) {
      throw Error('Competing service descriptors or test-only service registrations require a separate Package Move review.');
    }
    const spi = data.get(descriptor.service);
    if (movingService && (!isMainSource(spi, descriptor.service) || spi.type.kind !== 'interface' || !moved.has(spi.source.uri))) {
      throw Error('Moving a service interface requires a separate review unless its exact scalar interface belongs to the selected main source package.');
    }
    if (!isMainSource(spi, descriptor.service) || spi.type.kind !== 'interface' || movingService !== moved.has(spi.source.uri)) {
      throw Error('The exact public service interface must remain in the reviewed main source set.');
    }
    const contract = scalarService(spi.source);
    if (!descriptor.providers.length) throw Error('The reviewed service descriptor must name at least one provider.');
    if (module && !module.uses.has(descriptor.service)) throw Error('A reviewed module service must also have its exact uses directive.');
    const nextService = movingService ? nextName(descriptor.service) : descriptor.service;
    if (movingService && (hasType(nextService) || inventory.some(item => item.service.toLowerCase() === nextService.toLowerCase()))) {
      throw Error('A destination service interface or descriptor identity already exists.');
    }
    if (movingService) interfaces.set(spi.source.uri, { nextService, contract });
    const returnType = contract.type === 'String' ? 'java.lang.String' : contract.type;
    compilerMethods.push({ uri: spi.source.uri, owner: descriptor.service, nextOwner: nextService, method: contract.method, returnType, kind: 'INTERFACE' });
    const rewrites = [];
    const providerFactories = [];
    for (const registered of descriptor.providers) {
      if (module) {
        const proof = verifyPlainProvider(registered.name, descriptor.service, nextService, contract, { allowFactory: true });
        if (registered.name !== proof.nextOwner) rewrites.push({ ...registered, nextName: proof.nextOwner });
        if (proof.implementation) providerFactories.push({ provider: registered.name, nextProvider: proof.nextOwner,
          implementation: proof.implementation, nextImplementation: proof.nextImplementation });
        continue;
      }
      const provider = data.get(registered.name);
      if (!isMainSource(provider, registered.name) || provider.type.kind !== 'class') {
        throw Error('All registered providers must bind to reviewed top-level main source classes.');
      }
      const shape = providerShape(provider.source, provider.type, descriptor.service, contract);
      const shouldMove = changing.includes(registered);
      if (shouldMove !== moved.has(provider.source.uri)) throw Error('A registered provider does not match the selected Java package tree.');
      const nextOwner = shouldMove ? nextName(registered.name) : registered.name;
      compilerMethods.push({ uri: provider.source.uri, owner: registered.name, nextOwner, method: contract.method, returnType,
        kind: 'CLASS', service: descriptor.service, nextService });
      if (movingService || shouldMove) {
        if (checkedProviders.has(provider.source.uri)) throw Error('Provider sharing between service descriptors needs separate analysis.');
        checkedProviders.set(provider.source.uri, { shape, nextService, contract, name: nextOwner });
      }
      if (!shouldMove) continue;
      const replacement = nextName(registered.name);
      if (hasType(replacement) || descriptor.providers.some(item => item.name.toLowerCase() === replacement.toLowerCase())) {
        throw Error('A destination service provider identity already exists.');
      }
      providers.set(provider.source.uri, descriptor.service);
      rewrites.push({ ...registered, nextName: replacement });
    }
    if (module) {
      if (movingService) moduleReplacements.push({ span: descriptor.serviceName, replacement: nextService });
      moduleReplacements.push(...rewrites.map(item => ({ span: item, replacement: item.nextName })));
      services.set(descriptor.service, {
        service: descriptor.service, nextService, moduleName: module.name, method: contract.method,
        providers: descriptor.providers.map(item => item.name),
        newProviders: descriptor.providers.map(item => inPackage(item.name, oldPackage) ? nextName(item.name) : item.name),
        rewrites: rewrites.map(({ name, nextName: to }) => ({ from: name, to })), providerFactories
      });
      continue;
    }
    const after = rewrites.reduceRight((text, item) => text.slice(0, item.start) + item.nextName + text.slice(item.end), descriptor.text);
    if (Buffer.byteLength(after) > MAX_BYTES) throw Error('A rewritten service descriptor exceeds its 8 KiB review bound.');
    const uri = uriFor(descriptor.file);
    if (rewrites.length) edits.push({ textDocument: { uri, version: null }, edits: rewrites.map(item => ({
      range: rangeAt(descriptor.text, item.start, item.end), newText: item.nextName
    })) });
    const newFile = movingService ? path.join(path.dirname(descriptor.file), nextService) : descriptor.file;
    const newUri = uriFor(newFile);
    if (movingService) {
      renames.push({ kind: 'rename', oldUri: uri, newUri, options: { overwrite: false, ignoreIfExists: false } });
    }
    permissions.push({ uri, beforeSha256: descriptor.sha256, afterSha256: sha256(after), ...(movingService ? { newUri } : {}) });
    services.set(descriptor.service, {
      service: descriptor.service, nextService, file: descriptor.file, newFile, path: SERVICE_PREFIX + descriptor.service,
      newPath: SERVICE_PREFIX + nextService, method: contract.method,
      sha256: descriptor.sha256, afterSha256: sha256(after), providers: descriptor.providers.map(item => item.name),
      newProviders: descriptor.providers.map(item => inPackage(item.name, oldPackage) ? nextName(item.name) : item.name),
      rewrites: rewrites.map(({ name, nextName: to }) => ({ from: name, to }))
    });
  }
  if (module && !moduleReplacements.length && ![...services.values()].some(value =>
    value.providerFactories.some(factory => factory.implementation !== factory.nextImplementation))) {
    throw Error('Module Package Move requires a reviewed service interface, provider or factory implementation within the moved set.');
  }
  const snapshot = JSON.stringify(inventory);
  return {
    services, providers, factories, interfaces, edits, permissions, renames,
    moduleEntry: module?.makeEntry(moduleReplacements),
    ...(module ? { module: { name: module.name, uri: module.uri, directiveEdits: moduleReplacements.length } } : {}),
    compilerContractCount: compilerMethods.length,
    verifyCompilerBindings(before, after, renames) {
      const relocated = new Map(renames.map(rename => [rename.oldUri, rename.newUri]));
      for (const expected of compilerMethods) {
        const check = (report, uri, owner, service, returns, implementation) => {
          const methodKey = owner + '#' + expected.method + '()';
          const methods = report.methods.filter(method => method.uri === uri && method.key === methodKey &&
            method.ownerKind === expected.kind && method.returnType === returns && method.modifiers.includes('public') &&
            (!service || method.ownerSupertypes.includes(service)) && (!implementation || method.modifiers.includes('static')));
          if (methods.length !== 1) return false;
          if (!implementation) return true;
          const calls = report.calls.filter(call => call.uri === uri && call.enclosingKey === methodKey);
          return calls.length === 1 && calls[0].constructor && calls[0].methodKey === implementation + '#<init>()' &&
            calls[0].resultType === implementation;
        };
        if (!check(before, expected.uri, expected.owner, expected.service, expected.returnType, expected.implementation) ||
            !check(after, relocated.get(expected.uri) || expected.uri, expected.nextOwner, expected.nextService,
                expected.nextReturnType || expected.returnType, expected.nextImplementation)) {
          throw Error('The Java compiler could not prove the reviewed service/interface implementation contract: ' + expected.owner);
        }
      }
    },
    verifyProviders(transformed, renames) {
      for (const [uri, expected] of interfaces) {
        const nextUri = renames.find(rename => rename.oldUri === uri)?.newUri;
        const after = transformed.find(source => source.uri === nextUri);
        if (!after || nextUri !== uriFor(mainSource(expected.nextService)) ||
          parseJavaFile(after).types[0]?.fqn !== expected.nextService ||
          !sameProviderBody(expected.contract, scalarService(after))) {
          throw Error('The Java engine changed a reviewed service interface or its scalar contract.');
        }
      }
      for (const [uri, expected] of checkedProviders) {
        const nextUri = renames.find(rename => rename.oldUri === uri)?.newUri || uri;
        const after = transformed.find(source => source.uri === nextUri);
        const type = after && parseJavaFile(after).types[0];
        if (!type || nextUri !== uriFor(mainSource(expected.name)) || type.fqn !== expected.name ||
          !sameProviderBody(expected.factory ? { ...expected.shape, implementation: inPackage(expected.shape.implementation, oldPackage)
            ? nextName(expected.shape.implementation) : expected.shape.implementation } : expected.shape,
          expected.factory ? factoryShape(after, type, expected.nextService) : providerShape(after, type, expected.nextService, expected.contract))) {
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
