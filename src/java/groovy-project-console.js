'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { startGroovyConsole, verifiedGroovyJar, GROOVY_SHA256 } = require('./groovy-console');
const { createGroovyMemberTools } = require('./groovy-static-members');
const { listGroovyProjects, observeGroovyClasspath, runtimeKey } = require('./groovy-project-model');
const { hash } = require('./groovy-project-classpath');
const { workspaceRoots, workspacePath, cancelled, fail } = require('./workbench-model');

const scheme = 'rocketbrain-groovy-project';
const expiry = 5 * 60 * 1000;
const normalize = text => text.replace(/\r\n?/gu, '\n');
const maxScriptBytes = 64 * 1024;

function createGroovyProjectConsole(vscode, java, { trusted, configuration, readSavedScript }) {
  const plans = new Map();
  let generation = 0, active;
  const roots = () => workspaceRoots(vscode.workspace.workspaceFolders || []);

  function projectGuard(ticket, cancellation) {
    trusted();
    if (generation !== ticket || cancelled(cancellation)) throw fail('The Groovy project console context changed or was cancelled.');
    if (java.getState().state !== 'running') throw fail('Start Java support and import the project before reviewing its Groovy classpath.');
  }

  function requests(check, cancellation) {
    return async (command, args) => {
      check();
      const result = await java.requestWorkspaceCommand(command, args, cancellation);
      check();
      return result;
    };
  }

  async function list({ cancellation } = {}) {
    const ticket = generation, check = () => projectGuard(ticket, cancellation);
    return listGroovyProjects(requests(check, cancellation), roots(), check);
  }

  async function snapshot(document, range) {
    if (!document || document.isClosed || document.isDirty || document.languageId !== 'groovy' ||
        document.uri?.scheme !== 'file' || document.uri.authority || document.uri.query || document.uri.fragment ||
        !document.uri.fsPath.endsWith('.groovy') || !range?.start || !range?.end) {
      throw fail('Select code in a saved local Groovy source file.');
    }
    const positions = [range.start, range.end].map(position => [position.line, position.character]);
    if (positions.flat().some(value => !Number.isSafeInteger(value) || value < 0)) {
      throw fail('Select a valid Groovy source range.');
    }
    const selected = [document.offsetAt(range.start), document.offsetAt(range.end)];
    const exact = selected.map(offset => document.positionAt(offset)).map(position => [position.line, position.character]);
    if (selected[0] >= selected[1] || JSON.stringify(positions) !== JSON.stringify(exact)) {
      throw fail('Select a nonempty exact Groovy source range.');
    }
    const file = workspacePath(document.uri.fsPath, roots(), { directory: false });
    if (path.relative(file, document.uri.fsPath)) throw fail('Use an unlinked Groovy source file.');
    const version = document.version, text = document.getText(), code = text.slice(...selected);
    if (!code.trim() || code.includes('\0') || Buffer.byteLength(code) > maxScriptBytes) {
      throw fail('Select nonempty Groovy source no larger than 64 KiB.');
    }
    const bytes = await readSavedScript(file);
    if (normalize(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) !== normalize(text) ||
        document.isDirty || document.isClosed || document.version !== version) {
      throw fail('Save the exact Groovy document before reviewing its selection.');
    }
    return { file, version, code, positions, digest: hash(bytes) };
  }

  async function observe(selected, scope, check, cancellation) {
    return observeGroovyClasspath({ request: requests(check, cancellation), roots: roots(), selected, scope,
      groovyHash: GROOVY_SHA256, check });
  }

  function sourceKey(source) { return hash(JSON.stringify(source)); }

  async function checkSelection(record) {
    try {
      const current = await snapshot(record.document, record.range);
      if (sourceKey(current) === record.sourceKey) return;
    } catch (error) {
      if (!error || typeof error.message !== 'string') throw error;
    }
    throw fail('The Groovy source selection changed after review.');
  }

  async function review({ document, range, projectUri, scope, cancellation } = {}) {
    const ticket = generation, check = () => projectGuard(ticket, cancellation);
    check();
    const source = await snapshot(document, range);
    const project = await observe(projectUri, scope, check, cancellation);
    const options = configuration(project.project.root);
    await verifiedGroovyJar(options);
    const runner = await runtimeKey(options);
    const id = randomUUID();
    const publicPlan = {
      id, project: project.project, scope, file: source.file, range: source.positions, source: source.code,
      javaHome: options.javaHome, classpath: project.classpath.entries.map(({ file, kind, items, digest }) => ({
        file, kind, ...(items && { files: items.length }), ...(digest && { sha256: digest })
      })), files: project.classpath.files, bytes: project.classpath.bytes, classpathDigest: project.classpath.digest
    };
    const record = { ticket, projectKey: project.key, runner, code: source.code, sourceKey: sourceKey(source),
      document, range, expiry: Date.now() + expiry, summary: publicPlan };
    await checkSelection(record);
    check();
    while (plans.size >= 6) plans.delete(plans.keys().next().value);
    plans.set(id, record);
    return structuredClone(publicPlan);
  }

  function receiptText(record) {
    if (!record || Date.now() > record.expiry) return 'Review the Groovy project selection again.';
    const summary = record.summary;
    return [
      'Groovy project evaluation', summary.project.root, 'Classpath scope: ' + summary.scope,
      'Java runtime: ' + summary.javaHome, 'Source: ' + summary.file,
      'Selection: ' + summary.range.map(([line, column]) => (line + 1) + ':' + (column + 1)).join(' – '),
      '', 'Selected code', summary.source, '', 'JDT classpath in loading order',
      ...summary.classpath.map(item => item.kind + '   ' + item.file),
      '', 'Classpath SHA-256: ' + summary.classpathDigest, ''
    ].join('\n');
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider?.(scheme, {
    provideTextDocumentContent: uri => receiptText(plans.get(uri.path.split('/')[1]))
  });

  async function show(id) {
    trusted();
    const record = plans.get(id);
    if (!record || record.ticket !== generation || Date.now() > record.expiry) throw fail('Review the Groovy project selection again.');
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.parse(scheme + ':/' + id + '/review.txt')),
      { preview: true });
  }

  async function run({ id, allowExecution, cancellation } = {}) {
    trusted();
    if (allowExecution !== true) throw fail('Explicitly approve the reviewed Groovy project code before running it.');
    if (active) throw fail('Wait for the current Groovy project code to finish.');
    const record = plans.get(id);
    if (!record || Date.now() > record.expiry) throw fail('Review the Groovy project selection again.');
    plans.delete(id);
    const job = { stopped: false };
    active = job;
    const check = () => {
      projectGuard(record.ticket, cancellation);
      if (job.stopped) throw fail('The reviewed Groovy project evaluation was stopped.');
    };
    try {
      check();
      await checkSelection(record);
      const model = await observe(record.summary.project.uri, record.summary.scope, check, cancellation);
      if (model.key !== record.projectKey) throw fail('The Groovy project classpath or descriptor changed after review.');
      const options = configuration(model.project.root);
      if (await runtimeKey(options) !== record.runner) throw fail('The Groovy Java runtime changed after review.');
      job.worker = await startGroovyConsole({ ...options, projectClasspath: model.classpath, check,
        beforeStart: async () => {
          await checkSelection(record);
          if (await runtimeKey(configuration(model.project.root)) !== record.runner) {
            throw fail('The Groovy Java runtime changed after review.');
          }
        } });
      check();
      const receipt = await job.worker.evaluate(record.code, path.basename(record.summary.file), { cancellation });
      check();
      return { ...receipt, project: model.project.uri, scope: model.scope, classpathDigest: model.classpath.digest };
    } catch (error) {
      if (job.stopped) throw fail('The reviewed Groovy project evaluation was stopped.');
      throw error;
    } finally {
      try { await job.worker?.dispose(); }
      finally { if (active === job) active = undefined; }
    }
  }

  async function stop() {
    const job = active;
    if (!job) return false;
    job.stopped = true;
    await job.worker?.dispose();
    return true;
  }

  const members = createGroovyMemberTools(vscode, { roots, configuration, observe, requests, generation: () => generation, projectGuard });
  function invalidate() { generation++; plans.clear(); members.clear(); return stop(); }
  return { list, review, show, run, stop, members, invalidate, dispose() { provider?.dispose(); return invalidate(); } };
}

module.exports = { createGroovyProjectConsole };
