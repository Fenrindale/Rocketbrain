'use strict';

const path = require('node:path');
const { lexJava, rangeAt } = require('../spring/java');

const MAIN_JAVA = path.join('src', 'main', 'java');
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;

function reviewClosedModule(project, sources, { allowVisibility = false, qualifiedPeer, requirePeer = false, serviceOwner } = {}) {
  const descriptors = sources.filter(source => path.basename(source.file).toLowerCase() === 'module-info.java');
  if (!descriptors.length) return null;
  const [source] = descriptors;
  const root = path.join(project, MAIN_JAVA);
  if (descriptors.length !== 1 || path.relative(path.join(root, 'module-info.java'), source.file) !== '' ||
      sources.some(item => item.file.endsWith('.java') && (path.relative(root, item.file).split(path.sep)[0] === '..' ||
        path.isAbsolute(path.relative(root, item.file))))) {
    throw Error('Module service declarations require one standard main source set in a single named module.');
  }
  if (Buffer.byteLength(source.text) > 8192 || /\\u/i.test(source.text)) {
    throw Error('Module service declarations require a bounded literal module descriptor without Unicode escapes.');
  }
  const { tokens, issues } = lexJava(source.text);
  let cursor = 0;
  const invalid = () => Error(serviceOwner
    ? 'Service Package Move requires closed named modules with literal service directives and exact owned dependencies.'
    : qualifiedPeer
    ? 'Qualified Package Rename requires a closed named module with only its reviewed peer, java.base and literal visibility directives.'
    : allowVisibility
    ? 'Package Rename requires a closed named module with java.base, literal uses/provides and unqualified exports/opens.'
    : 'Module service declarations require a closed named module with only java.base and literal uses/provides directives.');
  const match = word => tokens[cursor]?.text === word;
  function consume(word) {
    if (!match(word)) throw invalid();
    cursor++;
  }
  function name({ qualified = true } = {}) {
    const start = tokens[cursor]?.start;
    const parts = [];
    do {
      if (parts.length) consume('.');
      const item = tokens[cursor++];
      if (item?.kind !== 'id' || !identifier.test(item.text) || parts.length === 24) throw invalid();
      parts.push(item.text);
    } while (match('.'));
    if (qualified && parts.length < 2) throw invalid();
    const end = tokens[cursor - 1].end;
    // Restrict the exact replaced span to names and spacing. Comments inside
    // a qualified name would otherwise be lost by the identifier rewrite.
    if (!/^[A-Za-z0-9_. \t]+$/.test(source.text.slice(start, end))) throw invalid();
    return { name: parts.join('.'), start, end };
  }

  if (issues.length) throw invalid();
  consume('module');
  const moduleName = name({ qualified: false }).name;
  consume('{');
  const uses = new Map();
  const registrations = new Map();
  const declarations = [];
  const visibility = new Set();
  function directive(role, options) {
    const value = name(options);
    declarations.push({ ...value, role });
    return value;
  }
  const dependencies = new Set();
  const qualified = [];
  while (!match('}')) {
    if (match('requires')) {
      consume('requires');
      const value = directive('requires',{qualified:false}).name;
      const permittedPeer = serviceOwner && moduleName !== serviceOwner ? serviceOwner : requirePeer ? qualifiedPeer : undefined;
      if (dependencies.has(value) || value !== 'java.base' && value !== permittedPeer) throw invalid();
      dependencies.add(value);
    } else if (allowVisibility && (match('exports') || match('opens'))) {
      const role = tokens[cursor++].text;
      const item = directive(role, { qualified: false });
      const key = role + ':' + item.name;
      if (visibility.has(key) || visibility.size === 32) throw invalid();
      visibility.add(key);
      if (match('to')) {
        consume('to');
        const target = directive(role+'To',{qualified:false});
        if (!qualifiedPeer || target.name !== qualifiedPeer) throw invalid();
        qualified.push({role,packageName:item.name,target:target.name});
      }
    } else if (!qualifiedPeer && match('uses')) {
      consume('uses');
      const service = directive('uses');
      if (uses.has(service.name) || uses.size === 24) throw invalid();
      uses.set(service.name, service);
    } else if (!qualifiedPeer && match('provides')) {
      consume('provides');
      const service = directive('provides');
      if (registrations.has(service.name) || registrations.size === 24) throw invalid();
      consume('with');
      const providers = [directive('with')];
      while (match(',')) {
        if (providers.length === 16) throw invalid();
        consume(',');
        providers.push(directive('with'));
      }
      if (new Set(providers.map(provider => provider.name)).size !== providers.length) throw invalid();
      registrations.set(service.name, { service: service.name, serviceName: service, providers, moduleName });
    } else throw invalid();
    consume(';');
  }
  consume('}');
  if (cursor !== tokens.length || requirePeer && !dependencies.has(qualifiedPeer) ||
      serviceOwner && moduleName !== serviceOwner && !dependencies.has(serviceOwner)) throw invalid();

  return {
    name: moduleName, uri: source.uri, file: source.file, uses, registrations, declarations,
    ...(qualifiedPeer && {qualified, peer:qualifiedPeer}),
    makeEntry(replacements) {
      if (!replacements.length) return null;
      return { textDocument: { uri: source.uri, version: source.version ?? null },
        edits: replacements.map(({ span, replacement }) => ({
          range: rangeAt(source.text, span.start, span.end), newText: replacement
        })) };
    }
  };
}

module.exports = { reviewClosedModule };
