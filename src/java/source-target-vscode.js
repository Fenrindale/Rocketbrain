'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { cancelled, fail } = require('./workbench-model');
const { resolveJavaSourceTarget } = require('./source-target');
const { prepareSourceExecution, route } = require('./source-target-execution');

const scheme = 'rocketbrain-java-source-target';
const until = 5 * 60 * 1000;
const reviewLifetime = 2 * 60 * 1000;

function render(target) {
  const build = target.declaredBuild;
  const sections = [
    'Java source build target', target.projectRoot, '',
    'Selected source: ' + target.sourceUri,
    'Source root: ' + target.sourceRoot,
    'Source layout: ' + target.sourceRole + ' · ' + target.layoutSource,
    'Classpath scope: ' + target.scope,
    'Observed project provider: ' + target.provider,
    ...(target.outputPath ? ['Source output: ' + target.outputPath] : []),
    ...(target.compliance ? ['Java level: ' + target.compliance] : []),
    'Build descriptor: ' + build.kind,
    ...(build.coordinates ? ['Maven coordinates: ' + build.coordinates] : []),
    ...(build.reactorProject ? ['Declared Maven reactor: ' + build.reactorRoot, 'Reactor module: ' + build.reactorProject] : []),
    ...(build.projectPath ? ['Declared Gradle root: ' + build.buildRoot, 'Gradle project path: ' + build.projectPath] : []),
    ...(build.buildTreePath ? ['Declared Gradle composite: ' + build.compositeRoot, 'Build tree project path: ' + build.buildTreePath] : []),
    '', 'Classpath (' + target.classpath.length + ')', ...target.classpath,
    '', 'Module path (' + target.modulepath.length + ')', ...target.modulepath
  ];
  return sections.join('\n') + '\n';
}

function registerSourceTarget(vscode, { trusted, request, generation, runGeneration, getTools, executePrepared }) {
  const records = new Map(), reviews = new Map();
  const provider = vscode.workspace.registerTextDocumentContentProvider?.(scheme, {
    provideTextDocumentContent: uri => {
      const entry = records.get(uri.path.split('/')[1]);
      return entry && Date.now() <= entry.expiry ? entry.text : 'Inspect the current Java source target to refresh this report.';
    }
  });
  const dirty = file => vscode.workspace.textDocuments.some(doc => doc.uri.scheme === 'file' && !doc.isClosed &&
    doc.isDirty && !path.relative(file, doc.uri.fsPath));

  function context(value) {
    const address = typeof value === 'string' ? vscode.Uri.parse(value) : value;
    if (!address || address.scheme !== 'file' || address.authority || address.query || address.fragment) {
      throw fail('Select a saved local Java source file.');
    }
    return address.toString();
  }

  async function observe(sourceUri, cancellation, ticket) {
    trusted();
    const target = await resolveJavaSourceTarget({ sourceUri, folders: vscode.workspace.workspaceFolders || [],
      request, dirty, cancellation });
    trusted();
    if (generation() !== ticket) throw fail('The workspace changed during Java source target inspection.');
    return target;
  }

  async function inspect({ sourceUri, cancellation } = {}) {
    const input = context(sourceUri), ticket = generation();
    const { fingerprint, validateInputs, ...target } = await observe(input, cancellation, ticket);
    const id = randomUUID(), report = { ...target, id };
    while (records.size >= 8) records.delete(records.keys().next().value);
    records.set(id, { source: input, ticket, fingerprint, validateInputs, expiry: Date.now() + until, report, text: render(report) });
    return structuredClone(report);
  }

  async function fresh(id, cancellation) {
    trusted();
    const entry = records.get(id);
    if (!entry || Date.now() > entry.expiry || entry.ticket !== generation()) throw fail('Inspect the current Java source target again.');
    try {
      const target = await observe(entry.source, cancellation, entry.ticket);
      if (target.fingerprint !== entry.fingerprint) throw fail('The reviewed Java source target changed.');
    } catch (error) {
      records.delete(id);
      throw fail('Refresh the Java source target before opening it. ' + error.message);
    }
    return entry;
  }

  async function show(id, cancellation) {
    await fresh(id, cancellation);
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(
      vscode.Uri.parse(scheme + ':/' + id + '/build-target.txt')), { preview: true });
  }

  async function openBuild(id, index, cancellation) {
    const { report } = await fresh(id, cancellation);
    const build = report.declaredBuild;
    const detail = index === undefined ? build.buildFile : build.declarations[index];
    if (!detail) throw fail('Choose a currently reviewed Java build declaration.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(detail.uri));
    await fresh(id, cancellation);
    let selection;
    if (detail.range) {
      const { start, end } = detail.range;
      selection = new vscode.Range(start.line, start.character, end.line, end.character);
    }
    await vscode.window.showTextDocument(document, { preview: true, ...(selection && { selection }) });
    return structuredClone(detail);
  }

  function prepare(entry) {
    trusted();
    if (entry.ticket !== generation()) throw fail('The workspace changed after the Java source target review.');
    entry.validateInputs();
    return prepareSourceExecution(entry.report, vscode.workspace.workspaceFolders || [], getTools(entry.report), dirty);
  }

  async function reviewBuild(id, { cancellation } = {}) {
    const entry = await fresh(id, cancellation);
    const result = prepare(entry), reviewId = randomUUID();
    while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
    reviews.set(reviewId, { targetId: id, key: result.key, expiry: Date.now() + reviewLifetime });
    return structuredClone({ ...result.review, id: reviewId, expiresAt: reviews.get(reviewId).expiry });
  }

  async function runBuild(id, { allowProjectExecution, cancellation } = {}) {
    trusted();
    if (allowProjectExecution !== true) throw fail('Approve the reviewed Java source build explicitly.');
    if (cancelled(cancellation)) throw fail('The reviewed Java build was cancelled before launch.');
    const review = reviews.get(id);
    reviews.delete(id);
    if (!review || Date.now() > review.expiry) throw fail('The Java source build review expired or was already used.');
    const operation = runGeneration();
    const entry = await fresh(review.targetId, cancellation);
    return executePrepared(() => {
      if (runGeneration() !== operation) throw fail('The reviewed Java build was stopped before launch.');
      if (Date.now() > review.expiry) throw fail('The Java source build review expired.');
      const result = prepare(entry);
      if (result.key !== review.key) throw fail('The reviewed Java build command or inputs changed. Review it again.');
      return { spec: result.spec, task: result.review.task, projectId: result.projectId };
    }, { allowProjectExecution, cancellation });
  }

  async function chooseBuild(id) {
    const review = await reviewBuild(id);
    const label = 'Run Reviewed Build';
    const selected = await vscode.window.showWarningMessage('Compile the selected Java component?', {
      modal: true,
      detail: 'Target: ' + review.selector + '\n' + (review.reactorDependenciesIncluded ?
        'Required Maven reactor dependencies can also build.\n' : 'Required Gradle task dependencies can also run.\n') +
        'Working directory: ' + review.cwd + '\n' + JSON.stringify([review.command, ...review.args], null, 2)
    }, label);
    if (selected !== label) { reviews.delete(review.id); return; }
    return runBuild(review.id, { allowProjectExecution: true });
  }

  async function command(value) {
    const source = value?.scheme === 'file' ? value : vscode.window.activeTextEditor?.document?.uri;
    const report = await vscode.window.withProgress({ title: 'Inspect Java Source Build Target',
      location: vscode.ProgressLocation.Notification, cancellable: true }, (_progress, cancellation) =>
      inspect({ sourceUri: source, cancellation }));
    const choices = [{ label: 'Inspect Classpath and Source Layout', open: () => show(report.id) }];
    if (report.declaredBuild.buildFile) {
      choices.push({ label: 'Open Component Build File', open: () => openBuild(report.id) });
    }
    report.declaredBuild.declarations.forEach((item, index) => choices.push({
      label: 'Open Build Declaration', description: item.label, open: () => openBuild(report.id, index)
    }));
    if (route(report)) choices.push({ label: 'Review Compile for This Source', open: () => chooseBuild(report.id) });
    const selected = await vscode.window.showQuickPick(choices, {
      title: 'Java Source Build Target · ' + path.basename(report.projectRoot), matchOnDescription: true
    });
    return selected?.open();
  }

  const clear = () => { records.clear(); reviews.clear(); };
  return { inspect, show, openBuild, command, reviewBuild, runBuild, clear, dispose() { clear(); provider?.dispose(); } };
}

module.exports = { registerSourceTarget, render };
