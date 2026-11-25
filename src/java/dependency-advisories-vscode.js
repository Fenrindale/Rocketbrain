'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { parseMavenDependencyTree, auditMavenPackages, maxTreeBytes, maxSelection } = require('./dependency-advisories');
const { workspacePath, workspaceRoots } = require('./workbench-model');
const { buildSpec, nativeTaskRunner } = require('./workbench-tasks');

const pluginGoal = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:tree';
const scheme = 'rocketbrain-maven-advisories';

function formatReport(report) {
  const { project, checkedAt, skipped, packages } = report;
  const hits = packages.filter(item => item.advisories.length).length;
  return [`Maven dependency advisories · ${project.name}@${project.version}`, `OSV lookup · ${checkedAt}`,
    `${packages.length} checked · ${hits} with reported advisories · ${skipped} unselected`, '',
    ...packages.flatMap(item => [item.key + ' · ' + (item.direct ? 'direct' : 'transitive') + ' · ' + item.scopes.join(', '),
      ...item.paths.map(chain => '  ' + chain.join(' → ')),
      ...(item.advisories.length ? item.advisories.map(id => '  https://osv.dev/vulnerability/' + id) : ['  No advisory IDs in the OSV response']),
      ...(item.complete ? [] : ['  Further results were returned beyond the lookup limit']), ''])].join('\n');
}

function registerDependencyAdvisories(vscode) {
  const tasks = nativeTaskRunner(vscode);
  const documents = new Map();
  const guard = () => {
    if (!vscode.workspace.isTrusted) throw Error('Open a trusted local Maven project.');
  };

  async function resolveTree(projectUri, { allowProjectExecution, cancellation } = {}) {
    guard();
    if (allowProjectExecution !== true || projectUri?.scheme !== 'file') throw Error('Choose a local Maven module and start dependency resolution explicitly.');
    const roots = workspaceRoots(vscode.workspace.workspaceFolders || []);
    const directory = workspacePath(projectUri.toString(), roots);
    workspacePath(path.join(directory, 'pom.xml'), [directory], { directory: false });
    const config = vscode.workspace.getConfiguration('rocketbrain.java', projectUri);
    const spec = buildSpec({ root: directory, uri: projectUri.toString(), tool: 'maven', name: path.basename(directory) },
      { javaHome: config.get('javaHome'), mavenHome: config.get('mavenHome') }, [pluginGoal]);
    const temp = await fs.realpath(os.tmpdir());
    const folder = await fs.mkdtemp(path.join(temp, 'rocketbrain-maven-tree-'));
    const output = path.join(folder, 'tree.json');
    try {
      spec.args.push('--non-recursive', '-DoutputType=json', '-DoutputFile=' + output);
      spec.label = path.basename(directory) + ' · Maven dependency tree';
      const result = await tasks.execute(spec, { cancellation });
      guard();
      if (result.cancelled) throw Error('Maven dependency resolution was cancelled.');
      if (result.code !== 0) throw Error('Maven dependency resolution failed. See the Rocketbrain task terminal.');
      const stat = await fs.lstat(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxTreeBytes) throw Error('Maven did not produce a regular dependency tree within 4 MiB.');
      return parseMavenDependencyTree(await fs.readFile(output, 'utf8'));
    } finally {
      const current = await fs.realpath(folder);
      if (!path.relative(folder, current) && path.dirname(current) === temp) {
        await fs.rm(current, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }

  async function publish(report) {
    guard();
    while (documents.size >= 6) documents.delete(documents.keys().next().value);
    const uri = vscode.Uri.from({ scheme, path: '/' + randomUUID() + '/Maven Dependency Advisories.txt' });
    documents.set(uri.path, formatReport(report));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: false });
    return uri;
  }

  function audit(tree, keys, { allowLookup, signal } = {}) {
    guard();
    if (allowLookup !== true) throw Error('Select the package versions to send to OSV.');
    return auditMavenPackages(tree, keys, { signal });
  }

  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent(uri) { return vscode.workspace.isTrusted ? documents.get(uri.path) || '' : ''; }
  });
  const command = vscode.commands.registerCommand('rocketbrain.java.mavenAdvisories', async () => {
    try {
      guard();
      const editor = vscode.window.activeTextEditor;
      const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) || vscode.workspace.workspaceFolders?.[0];
      const project = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true,
        canSelectMany: false, defaultUri: folder?.uri, title: 'Select Maven Module to Resolve' });
      if (!project?.length) return;
      const tree = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Resolving Maven Dependencies', cancellable: true }, (_, cancellation) =>
        resolveTree(project[0], { allowProjectExecution: true, cancellation }));
      const selected = await vscode.window.showQuickPick(tree.packages.map(item => ({
        label: item.key, description: item.direct ? 'direct' : 'transitive', item
      })), { title: 'Choose Maven Package Names and Versions to Send to OSV', canPickMany: true,
        placeHolder: `Select up to ${maxSelection} package versions` });
      if (!selected?.length) return;
      guard();
      const report = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
        title: 'Looking Up Selected Packages in OSV', cancellable: true }, async (_, cancellation) => {
        const abort = new AbortController();
        const listener = cancellation.onCancellationRequested(() => abort.abort());
        try {
          if (cancellation.isCancellationRequested) abort.abort();
          return await audit(tree, selected.map(choice => choice.item.key), { allowLookup: true, signal: abort.signal });
        } finally { listener.dispose(); }
      });
      return await publish(report);
    } catch (error) {
      void vscode.window.showErrorMessage(error.message);
    }
  });

  return { resolveTree, audit, publish, async dispose() { await tasks.dispose(); documents.clear(); command.dispose(); provider.dispose(); } };
}

module.exports = { registerDependencyAdvisories };
