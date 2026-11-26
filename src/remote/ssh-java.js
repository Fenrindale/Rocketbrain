'use strict';

const { createSshJavaMapping } = require('./ssh-java-mapping');
const { createContainerJavaLsp } = require('../devcontainer/java-lsp');
const { maxSourceBytes } = require('../devcontainer/java-mapping');
const { serverSettings } = require('../java/runtime');

const canonicalText = text => text.replace(/\r\n/gu, '\n');

async function createSshJava({ client, approval, protocol, onDiagnostics, onExit }) {
  const mapping = createSshJavaMapping(client.root);
  const child = await client.openProcess('java', approval);
  child.stderr.resume();
  const settings = serverSettings();
  settings.java.import.gradle.enabled = false;
  settings.java.import.maven.enabled = false;
  const insensitive = /^[A-Za-z]:/u.test(client.root);
  const lsp = createContainerJavaLsp({ child, protocol, mapping, settings, onDiagnostics, onExit,
    clientName: 'Rocketbrain SSH Java', workspaceName: 'Reviewed SSH Java workspace',
    sameFile: (first, second) => insensitive ? first.toLowerCase() === second.toLowerCase() : first === second });
  try { await lsp.initialize(); } catch (error) { lsp.dispose(); throw error; }

  async function current(document) {
    mapping.toRemote(document?.file);
    const source = await client.read(document.file);
    if (source.data.length > maxSourceBytes || source.data.includes(0)) throw Error('Choose a UTF-8 SSH Java source up to 256 KiB.');
    const exact = new TextDecoder('utf-8', { fatal: true }).decode(source.data);
    if (typeof document.text !== 'string' || canonicalText(exact) !== canonicalText(document.text)) {
      throw Error('The SSH Java source changed. Reopen its remote editor before requesting Java information.');
    }
    return { source: { ...document, text: exact }, sha256: source.sha256 };
  }

  async function checked(document, request) {
    const before = await current(document);
    const result = await request(before.source);
    if ((await client.read(document.file)).sha256 !== before.sha256) throw Error('The SSH Java source changed during inspection.');
    return result;
  }

  return {
    synchronize: document => checked(document, source => lsp.synchronize(source)),
    hover: (document, position, cancellation) => checked(document, source => lsp.hover(source, position, cancellation)),
    async definition(document, position, cancellation) {
      const found = await checked(document, source => lsp.definition(source, position, cancellation));
      const checkedTargets = await Promise.all(found.slice(0, 8).map(async location => {
        try { return (await client.stat(location.file)).kind === 'file' ? location : undefined; } catch { return undefined; }
      }));
      return checkedTargets.filter(Boolean);
    },
    closeDocument: file => lsp.close(file),
    stop: lsp.stop,
    dispose: lsp.dispose
  };
}

module.exports = { createSshJava };
