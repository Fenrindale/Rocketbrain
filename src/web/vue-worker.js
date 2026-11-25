'use strict';

// Executed by an independent Node process with the selected workspace's tools.
async function vueWorker(input) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { createRequire } = require('node:module');
  const { pathToFileURL } = require('node:url');
  const localRequire = createRequire(path.join(input.root, 'package.json'));

  if (input.action === 'serve') {
    const { createServer } = await import(pathToFileURL(localRequire.resolve('vite')).href);
    const server = await createServer({ root: input.root, server: { host: '127.0.0.1', port: 0, open: false, strictPort: true } });
    if (server.config.server.https || !server.httpServer) {
      await server.close();
      throw Error('Use an ordinary HTTP Vite dev server configuration.');
    }
    await server.listen();
    const address = server.httpServer?.address();
    if (address?.address !== '127.0.0.1' || !Number.isInteger(address.port) ||
        !/^\/(?:[A-Za-z0-9_-]+\/)*$/.test(server.config.base)) {
      await server.close();
      throw Error('The Vite server did not expose a supported loopback address.');
    }
    let closing;
    async function close() {
      if (!closing) closing = server.close().finally(() => process.exit(0));
      await closing;
    }
    process.once('disconnect', close);
    process.on('message', message => { if (message?.action === 'stop') void close(); });
    return { ready: true, port: address.port, base: server.config.base };
  }

  const compiler = localRequire('@vue/compiler-sfc');
  const ts = localRequire('typescript');
  const { descriptor, errors } = compiler.parse(input.source, { filename: input.file });
  const script = descriptor.scriptSetup;
  const template = descriptor.template;
  if (errors.length || !script || script.src || !template?.ast || template.src ||
      ![undefined, 'html'].includes(template.lang) || ![undefined, 'js', 'ts'].includes(script.lang)) return null;
  const syntax = ts.createSourceFile('bindings.' + (script.lang || 'js'), script.content, ts.ScriptTarget.Latest, true);
  const bindings = new Map();
  const imported = new Map();
  function store(name, specifier) {
    if (!ts.isIdentifier(name)) return;
    const span = { start: script.loc.start.offset + name.getStart(syntax), end: script.loc.start.offset + name.end };
    bindings.set(name.text, span);
    if (specifier) imported.set(name.text, { span, specifier });
  }
  for (const statement of syntax.statements) {
    if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) {
      const importedAs = statement.importClause?.name;
      if (importedAs && ts.isStringLiteral(statement.moduleSpecifier)) store(importedAs, statement.moduleSpecifier.text);
      const names = statement.importClause?.namedBindings;
      if (names && ts.isNamedImports(names)) for (const item of names.elements) if (!item.isTypeOnly) store(item.name);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) store(declaration.name);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) store(statement.name);
  }

  const point = input.offset;
  const covers = span => span && point >= span.start.offset && point < span.end.offset;
  const kebab = name => name.replace(/\B([A-Z])/g, '-$1').toLowerCase();
  function binding(expression) {
    if (!covers(expression?.loc)) return null;
    const { content, loc } = expression;
    const span = /^[A-Za-z_$][\w$]*$/.test(content) && bindings.get(content);
    return span ? { origin: { start: loc.start.offset, end: loc.end.offset }, span } : null;
  }
  function identify(node, obscured = false) {
    if (!covers(node.loc)) return null;
    if (node.type === 1) {
      const { tag, loc, props, children } = node;
      const start = loc.start.offset + 1;
      if (point >= start && point < start + tag.length) {
        const options = [...imported.keys()].filter(name => name === tag || kebab(name) === tag);
        if (options.length === 1) return { origin: { start, end: start + tag.length }, imported: imported.get(options[0]) };
      }
      const scoped = obscured || props.some(prop => prop.type === 7 && ['for', 'slot'].includes(prop.name));
      if (!scoped) for (const prop of props) {
        if (prop.type !== 7 || !['bind', 'if', 'else-if', 'show'].includes(prop.name)) continue;
        const found = binding(prop.exp);
        if (found) return found;
      }
      for (const child of children) {
        const found = identify(child, scoped);
        if (found) return found;
      }
    } else if (node.type === 5 && !obscured) return binding(node.content);
    return null;
  }
  let found;
  for (const node of template.ast.children) {
    found = identify(node);
    if (found) break;
  }
  if (!found) return null;
  const { imported: component } = found;
  if (component && /^\.{1,2}\/[^\0?#]+\.vue$/i.test(component.specifier)) {
    const file = await fs.realpath(path.resolve(path.dirname(input.file), component.specifier)).catch(() => null);
    if (file) return { file, origin: found.origin, target: { start: 0, end: 0 } };
  }
  return { file: input.file, origin: found.origin, target: component?.span ?? found.span };
}

module.exports = { vueWorker };
