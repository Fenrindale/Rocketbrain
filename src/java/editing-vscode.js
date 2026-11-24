'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { registerJavaLiveTemplates } = require('./live-templates');
const { analyzeJavaSources } = require('./signature-compiler');
const { inside, local } = require('./workbench-model');
const { inspectClass, directMethods, delegateMethods, emitMembers, materializeMembers } = require('./member-generation');

const GENERATE = 'rocketbrain.java.generateMembers';
const LABELS = {
  constructor: 'Constructor',
  accessors: 'Getters and Setters',
  equalsHashCode: 'Equals and HashCode',
  delegate: 'Delegate Method'
};
const simpleType = /^[\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}_$][\p{L}\p{N}_$]*)*$/u;
const hash = value => createHash('sha256').update(value).digest('hex');

function javaRelease(value) {
  const match = /^(?:1\.)?(\d+)$/.exec(String(value ?? ''));
  return match ? Number(match[1]) : 25;
}

function delegateOwner(model, field) {
  if (!field || !simpleType.test(field.type)) throw Error('Select a directly named, non-generic local Java delegate field.');
  if (field.type.includes('.')) {
    const first = field.type.split('.')[0];
    if (model.imports[first]) return model.imports[first] + field.type.slice(first.length);
    return field.type;
  }
  return model.imports[field.type] || [model.packageName,field.type].filter(Boolean).join('.');
}

function registerJavaEditing(context, vscode, { java }) {
  let disposed = false;
  const templates = registerJavaLiveTemplates(vscode);
  const storagePath = path.join((context.storageUri || context.globalStorageUri).fsPath, 'java-member-generation');

  function trusted(cancellation) {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace before preparing Java member edits.');
    if (cancellation?.isCancellationRequested) throw Error('Java member generation cancelled.');
  }

  function snapshot(document) {
    const uri = document?.uri;
    if (document?.languageId !== 'java' || uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
        !vscode.workspace.getWorkspaceFolder(uri)) throw Error('Select a local Java source file in the workspace.');
    const file = uri.fsPath, stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 512 * 1024 || path.relative(file, fs.realpathSync(file))) {
      throw Error('Select a bounded physical Java source path.');
    }
    const bytes = fs.readFileSync(file);
    const text = document.getText();
    if (Buffer.byteLength(text) > 512 * 1024 || bytes.length > 512 * 1024) throw Error('Java generation requires source files below 512 KiB.');
    const disk = hash(bytes), version = document.version;
    return {
      document, uri: uri.toString(), text, version,
      verify() {
        if (document.isClosed || document.version !== version || document.getText() !== text ||
            path.relative(file, fs.realpathSync(file)) || hash(fs.readFileSync(file)) !== disk ||
            !vscode.workspace.getWorkspaceFolder(uri)) throw Error('A Java source changed since preparation. Generate again.');
      }
    };
  }

  async function projectFor(document, cancellation) {
    const runtime = await java.start();
    trusted(cancellation);
    if (runtime.state !== 'running' || !runtime.javaHome || !java.workbench) {
      throw Error('Start the independent Java engine for compiler-validated member generation.');
    }
    const select = projects => projects.filter(project => project.sourceRoots.some(root =>
      !root.unavailable && inside(root.path, document.uri.fsPath))).sort((a,b) => b.root.length - a.root.length)[0];
    let project = select(java.workbench.getSnapshot().projects);
    if (!project) project = select((await java.workbench.refresh({ cancellation })).projects);
    if (!project) throw Error('Refresh Java Projects after importing the source project.');
    const release = javaRelease(project.compliance);
    const getClasspath = async token => {
      const result = await java.requestWorkspaceCommand('java.project.getClasspaths', [project.uri, { scope: 'runtime' }], token);
      trusted(token);
      if (!Array.isArray(result?.classpaths) || !Array.isArray(result?.modulepaths) || result.modulepaths.length) {
        throw Error('Scoped Java member generation requires a reviewed classpath project.');
      }
      return [...new Set(result.classpaths.map(local).filter(file => fs.existsSync(file)))];
    };
    const classpath = await getClasspath(cancellation);
    return { javaHome: runtime.javaHome, classpath, release, storagePath, project, getClasspath };
  }

  async function locateDelegate(model, field, project, original, cancellation) {
    const owner = delegateOwner(model, field);
    if (owner === model.owner) throw Error('Delegate to a separate local Java type to avoid a forwarding recursion.');
    const simple = owner.split('.').at(-1);
    const uris = await vscode.workspace.findFiles('**/' + simple + '.java',
      '**/{.git,node_modules,target,build,bin,dist}/**', 25, cancellation);
    if (uris.length >= 25) throw Error('Several files have the delegate type name. Narrow the Java workspace.');
    const choices = [];
    for (const uri of uris) {
      if (uri.scheme !== 'file' || !project.sourceRoots.some(root => !root.unavailable && inside(root.path, uri.fsPath)) ||
          !path.relative(uri.fsPath, original.document.uri.fsPath)) continue;
      const document = await vscode.workspace.openTextDocument(uri);
      choices.push(snapshot(document));
      trusted(cancellation);
    }
    if (choices.length !== 1) throw Error('Select a delegate type with one saved source file in the same Java project.');
    return { owner, source: choices[0] };
  }

  async function compilerState({ document, position, kind, fields, cancellation }) {
    trusted(cancellation);
    const original = snapshot(document);
    const model = inspectClass(original.text, document.offsetAt(position));
    const runtime = await projectFor(document, cancellation);
    const target = kind === 'delegate' ? await locateDelegate(model, model.fields.find(field => field.name === fields?.[0]),
      runtime.project, original, cancellation) : null;
    const sources = [original, ...(target ? [target.source] : [])];
    const { javaHome, classpath, storagePath, release } = runtime;
    // Hibernate's OSGi export manifest is larger than the usual compiler cap.
    const options = { javaHome, classpath, storagePath, release, cancellation, manifestLimit: 256 * 1024 };
    const asSources = values => values.map(({ uri, text }) => ({ uri, text }));
    const before = await analyzeJavaSources({ ...options, sources: asSources(sources) });
    const existing = before.errors.filter(error => !(kind === 'constructor' && error.uri === original.uri &&
      error.code === 'compiler.err.var.not.initialized.in.default.constructor' &&
      error.start >= model.start && error.start < model.closing));
    if (existing.length) throw Error('Resolve existing Java errors before generating members: ' + existing[0].message);
    trusted(cancellation);
    for (const source of sources) source.verify();
    return { original, model, runtime, sources, options, before, target, asSources };
  }

  async function readDelegates(options) {
    const data = await compilerState({ ...options, kind: 'delegate', fields: [options.field] });
    return delegateMethods(data.before, data.target.owner).map(method => ({
      key: method.key, name: method.name, returnType: method.returnType,
      signature: method.name + '(' + method.parameters.map(parameter => parameter.type).join(', ') + ')'
    }));
  }

  async function prepareGeneration(options) {
    const { document, position, kind, fields, accessor, methodKey, cancellation, indent = '    ' } = options;
    if (!LABELS[kind] || !/^(?: {1,8}|\t)$/.test(indent)) throw Error('Select a supported Java member generation.');
    const { original, model, runtime, sources, options: compiler, before, target, asSources } =
      await compilerState({ document, position, kind, fields, cancellation });
    const delegate = target && delegateMethods(before, target.owner).find(method => method.key === methodKey);
    const members = emitMembers(model, { kind, fields, accessor, delegate }, directMethods(before, model.owner));
    const edit = materializeMembers(original.text, model, members, indent);
    const transformed = [{ ...original, text: edit.text }, ...sources.slice(1)];
    const after = await analyzeJavaSources({ ...compiler, sources: asSources(transformed) });
    if (after.errors.length) throw Error('Generated Java members would introduce a compile error: ' + after.errors[0].message);
    if (before.classpathFingerprint !== after.classpathFingerprint) throw Error('The Java classpath changed during generation.');
    const newMethods = directMethods(after, model.owner).filter(method => method.start >= edit.generatedStart && method.end <= edit.generatedEnd);
    if (newMethods.length !== members.length || members.some(member => !newMethods.some(method =>
      method.name === member.name && method.parameters.length === member.params))) throw Error('The compiler did not confirm the generated Java declarations.');
    if (delegate && !after.calls.some(call => call.enclosingKey === newMethods[0].key && call.methodKey === delegate.key)) {
      throw Error('The generated call does not bind to the selected delegate method.');
    }
    trusted(cancellation);
    for (const source of sources) source.verify();
    const at = document.positionAt(edit.offset);
    const point = { line: at.line, character: at.character };
    const plan = await java.refactoring.previewWorkspaceEdit({
      documentChanges: [{ textDocument: { uri: original.uri, version: original.version },
        edits: [{ range: { start: point, end: point }, newText: edit.insertion }] }]
    }, {
      title: 'Generate Java ' + LABELS[kind], kind: 'refactor.generate.' + kind, anchorDocument: document,
      guards: sources.slice(1).map(source => ({ uri: source.uri })), cancellation,
      validate: async token => {
        const active = await runtime.getClasspath(token);
        if (JSON.stringify(active) !== JSON.stringify(runtime.classpath)) throw Error('The observed Java classpath changed. Generate again.');
      },
      preApply: token => {
        trusted(token);
        for (const source of sources) source.verify();
        after.validateClasspath();
      },
      warnings: model.excluded ? ['Combined or unsupported field declarations were excluded from field selection.'] : []
    });
    return { ...plan, generation: { kind, owner: model.owner, fields: [...fields], members: newMethods.map(method => method.key),
      ...(delegate ? { delegate: delegate.key } : {}), compileErrors: 0 } };
  }

  function stableClasspath(operation) {
    return async options => {
      trusted(options.cancellation);
      const original = snapshot(options.document);
      for (let attempt = 0;; attempt++) {
        try { return await operation(options); }
        catch (error) {
          const changed = /Compiler classpath file membership changed|compiler runtime or classpath changed|classpath changed during generation/.test(error.message);
          if (!changed || attempt >= 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
          trusted(options.cancellation);
          original.verify();
        }
      }
    };
  }
  const previewGeneration = stableClasspath(prepareGeneration);
  const listDelegates = stableClasspath(readDelegates);

  function progress(title, action) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true, title },
      (_value, token) => action(token));
  }

  async function generateInteractive() {
    trusted();
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw Error('Open a Java class before generating members.');
    const { document } = editor, position = editor.selection.active;
    const original = snapshot(document);
    const model = inspectClass(original.text, document.offsetAt(position));
    const choice = await vscode.window.showQuickPick(Object.entries(LABELS).map(([kind, label]) => ({ kind, label })),
      { title: 'Generate Java Members · ' + model.name });
    if (!choice) return;
    const eligible = model.fields.filter(field => choice.kind !== 'constructor' || !field.final || !field.initialized);
    if (!eligible.length) throw Error('The selected Java class has no eligible instance fields.');
    const choices = eligible.map(field => ({
      label: field.name, description: field.type, detail: field.final ? 'final' : undefined,
      picked: choice.kind === 'constructor' && field.final
    }));
    let fields, accessor, methodKey;
    if (choice.kind === 'delegate') {
      const field = await vscode.window.showQuickPick(choices, { title: 'Delegate Field' });
      if (!field) return;
      fields = [field.label];
      original.verify();
      const methods = await progress('Inspect Delegate Methods', cancellation =>
        listDelegates({ document, position, field: field.label, cancellation }));
      if (!methods.length) throw Error('The delegate class has no reviewed public instance methods.');
      const method = await vscode.window.showQuickPick(methods.map(method => ({
        label: method.signature, description: method.returnType, methodKey: method.key
      })), { title: 'Delegate Method' });
      if (!method) return;
      methodKey = method.methodKey;
    } else {
      const selected = await vscode.window.showQuickPick(choices, { title: 'Select Java Fields', canPickMany: true });
      if (!selected?.length) return;
      fields = selected.map(field => field.label);
      if (choice.kind === 'accessors') {
        const mode = await vscode.window.showQuickPick([
          { label: 'Getters and Setters', accessor: 'both' },
          { label: 'Getters', accessor: 'get' },
          { label: 'Setters', accessor: 'set' }
        ], { title: 'Generate Accessors' });
        if (!mode) return;
        accessor = mode.accessor;
      }
    }
    original.verify();
    const indent = editor.options.insertSpaces === false ? '\t' : ' '.repeat(Math.min(8, Number(editor.options.tabSize) || 4));
    const plan = await progress('Check Generated Java Members', cancellation =>
      previewGeneration({ document, position, kind: choice.kind, fields, accessor, methodKey, cancellation, indent }));
    return java.refactoring.review(plan);
  }

  const command = vscode.commands.registerCommand(GENERATE, async () => {
    try { return await generateInteractive(); }
    catch (error) { if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return null; }
  });
  return {
    templates, previewGeneration, listDelegates,
    dispose() { if (!disposed) { disposed = true; command.dispose(); templates.dispose(); } }
  };
}

module.exports = { registerJavaEditing, GENERATE };
