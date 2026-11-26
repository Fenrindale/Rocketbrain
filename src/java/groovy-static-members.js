'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { inspectGroovyMembers, findGroovyJavaDeclaration } = require('./groovy-static-analysis');
const { local, workspacePath, fail } = require('./workbench-model');
const { runtimeKey } = require('./groovy-project-model');
const { hash, readExact } = require('./groovy-project-classpath');

const sourcePaths = 'org.eclipse.jdt.ls.core.sourcePaths';
const ttl = 3 * 60 * 1000;
const normalize = text => text.replace(/\r\n?/gu, '\n');

function createGroovyMemberTools(vscode, { roots, configuration, observe, requests, generation, projectGuard }) {
  const plans = new Map();

  function sourceSnapshot(document, position) {
    const uri = document?.uri;
    if (!document || document.isClosed || document.languageId !== 'groovy' || uri?.scheme !== 'file' ||
        uri.authority || uri.query || uri.fragment || !uri.fsPath.endsWith('.groovy')) {
      throw fail('Open a local Groovy source file and place the cursor at the member prefix.');
    }
    const file = workspacePath(uri.fsPath, roots(), { directory: false });
    if (path.relative(file, uri.fsPath)) throw fail('Use an unlinked Groovy file for member inspection.');
    const source = document.getText();
    if (Buffer.byteLength(source) > 64 * 1024 || source.includes('\0')) throw fail('Review a Groovy editor buffer no larger than 64 KiB.');
    if (!Number.isSafeInteger(position?.line) || !Number.isSafeInteger(position?.character) || position.line < 0 || position.character < 0) {
      throw fail('Choose a valid Groovy cursor position.');
    }
    const offset = document.offsetAt(position), exact = document.positionAt(offset);
    if (exact.line !== position.line || exact.character !== position.character) throw fail('Choose a valid Groovy cursor position.');
    return { source, offset, version: document.version, digest: hash(source) };
  }

  function current(record) {
    const now = sourceSnapshot(record.document, record.position);
    if (now.version !== record.version || now.digest !== record.digest || now.offset !== record.offset) {
      throw fail('The Groovy source changed. Inspect the member again.');
    }
  }

  async function inspect({ document, position, projectUri, scope, cancellation } = {}) {
    const ticket = generation(), check = () => projectGuard(ticket, cancellation);
    check();
    const snapshot = sourceSnapshot(document, position);
    const project = await observe(projectUri, scope, check, cancellation);
    const options = configuration(project.project.root);
    const runtime = await runtimeKey(options);
    const result = await inspectGroovyMembers({ source: snapshot.source, position: snapshot.offset, project, options, cancellation, check,
      projectSource: owner => readJavaDeclaration(owner, project, check, cancellation) });
    const id = randomUUID();
    const record = { ticket, version: snapshot.version, digest: snapshot.digest, offset: snapshot.offset, projectUri, scope,
      document, position, result, runtime, projectKey: project.key, expires: Date.now() + ttl };
    current(record);
    await currentJavaSource(result.source);
    check();
    while (plans.size >= 8) plans.delete(plans.keys().next().value);
    plans.set(id, record);
    return { id, project: project.project, scope, prefix: result.token.prefix, members: structuredClone(result.members),
      receiver: { type: result.receiver.type, strategy: result.receiver.strategy, initializer: result.receiver.initializer,
        start: document.positionAt(result.receiver.start), end: document.positionAt(result.receiver.end) } };
  }

  async function fresh(id, key, cancellation) {
    const record = plans.get(id);
    if (!record || record.expires < Date.now()) throw fail('Inspect the current Groovy member again.');
    const check = () => projectGuard(record.ticket, cancellation);
    check();
    const member = record.result.members.find(candidate => candidate.key === key);
    if (!member) throw fail('Choose an attributed Java method from the reviewed Groovy completion.');
    current(record);
    const project = await observe(record.projectUri, record.scope, check, cancellation);
    if (project.key !== record.projectKey) throw fail('The Groovy project classpath changed. Inspect the member again.');
    const options = configuration(project.project.root);
    if (await runtimeKey(options) !== record.runtime) throw fail('The Groovy compiler runtime changed. Inspect the member again.');
    const source = record.result.source;
    if (source) {
      const now = await readJavaDeclaration(member.owner, project, check, cancellation);
      if (now.uri !== source.uri || !now.bytes.equals(source.bytes)) throw changedJavaSource();
      await currentJavaSource(source);
    }
    current(record);
    check();
    return { record, member, project, options, check };
  }

  async function apply({ id, key, editor, cancellation } = {}) {
    const { record, member, check } = await fresh(id, key, cancellation);
    if (editor?.document !== record.document) throw fail('Return to the reviewed Groovy editor before completing this member.');
    const { start, end } = record.result.token;
    const range = new vscode.Range(record.document.positionAt(start), record.document.positionAt(end));
    plans.delete(id);
    current(record);
    check();
    if (!await editor.edit(builder => builder.replace(range, member.name))) throw fail('The Groovy editor rejected this completion.');
    return { name: member.name, key: member.key };
  }

  async function readJavaDeclaration(owner, project, check, cancellation) {
    const settings = await requests(check, cancellation)('java.project.getSettings', [project.project.uri, [sourcePaths]]);
    const directories = settings?.[sourcePaths];
    if (!Array.isArray(directories) || directories.length > 100) throw fail('JDT did not provide bounded Java source roots.');
    const found = [];
    const relative = owner.split('.').join(path.sep) + '.java';
    for (const value of directories) {
      let candidate;
      try {
        const original = local(value);
        const directory = workspacePath(original, [project.project.root]);
        if (path.relative(directory, original)) continue;
        candidate = path.join(directory, relative);
        if (path.relative(candidate, workspacePath(candidate, [directory], { directory: false }))) continue;
      } catch { continue; }
      if (!found.some(file => !path.relative(file, candidate))) found.push(candidate);
    }
    if (found.length !== 1) throw fail('Locate one current workspace Java source file for this receiver.');
    const file = found[0], stat = await fs.lstat(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw fail('Use a bounded local Java declaration source.');
    const bytes = await readExact(file, stat.size);
    return { file, bytes, uri: pathToFileURL(file).href, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }

  const changedJavaSource = () => fail('The Java receiver source changed. Inspect the Groovy member again.');

  async function currentJavaSource(source) {
    if (!source) return;
    const edited = vscode.workspace.textDocuments.some(item => item.uri?.scheme === 'file' &&
      !path.relative(item.uri.fsPath, source.file) && item.isDirty);
    const bytes = !edited && await readExact(source.file, source.bytes.length).catch(() => undefined);
    if (!bytes || !source.bytes.equals(bytes)) throw changedJavaSource();
  }

  async function openDeclaration({ id, key, cancellation } = {}) {
    const { record, member, project, options, check } = await fresh(id, key, cancellation);
    const javaSource = record.result.source || await readJavaDeclaration(member.owner, project, check, cancellation);
    const { file, bytes } = javaSource;
    const location = await findGroovyJavaDeclaration({ member, javaSource, project, options, cancellation, check });
    if (!location || location.uri !== javaSource.uri || javaSource.text.slice(location.start, location.end) !== member.name) {
      throw fail('The current Java source declaration does not match the attributed project member.');
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const coordinates = offset => {
      const before = javaSource.text.slice(0, offset);
      return [before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1];
    };
    const range = new vscode.Range(...coordinates(location.start), ...coordinates(location.end));
    if (document.isDirty || document.isClosed || normalize(document.getText()) !== normalize(javaSource.text) ||
        !bytes.equals(await readExact(file, bytes.length))) {
      throw fail('The Java declaration changed before navigation.');
    }
    const verified = await fresh(id, key, cancellation);
    if (verified.project.key !== project.key || document.isDirty || normalize(document.getText()) !== normalize(javaSource.text)) {
      throw fail('The reviewed Java declaration changed before navigation.');
    }
    check();
    await vscode.window.showTextDocument(document, { selection: range, preview: true });
    return { owner: member.owner, key: member.key, file, range };
  }

  return { inspect, apply, openDeclaration, clear: () => plans.clear() };
}

module.exports = { createGroovyMemberTools };
