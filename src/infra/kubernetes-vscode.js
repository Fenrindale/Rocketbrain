'use strict';

const { randomUUID } = require('node:crypto');
const { executable, namespaceName, prepareKubernetesConfig } = require('./kubernetes');

const prefix = 'rocketbrain.kubernetes';
const viewId = 'rocketbrain.kubernetes';
const logScheme = 'rocketbrain-kube-log';
const groups = { deployments: 'Deployments', services: 'Services', pods: 'Pods', releases: 'Helm Releases' };

function registerKubernetesExplorer(context, vscode) {
  const changed = new vscode.EventEmitter();
  const logsChanged = new vscode.EventEmitter();
  const logDocs = new Map();
  let current, opening, activeLog, disposed = false;
  let revision = 0;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust this workspace before connecting a Kubernetes context.');
  }

  function remount() { changed.fire(undefined); }
  function discardLogs() {
    activeLog?.abort();
    for (const [key, item] of logDocs) { logDocs.delete(key); logsChanged.fire(item.uri); }
  }

  async function disconnect() {
    opening?.abort();
    const old = current;
    current = undefined;
    discardLogs();
    remount();
    await old?.session.close();
  }

  const documents = vscode.workspace.registerTextDocumentContentProvider(logScheme, {
    onDidChange: logsChanged.event,
    provideTextDocumentContent(uri) { return logDocs.get(uri.toString())?.text ?? 'This Kubernetes log snapshot has expired.'; }
  });

  function status(result) {
    return result?.error || (result?.omitted ? result.rows.length + ' displayed · ' + result.omitted + ' omitted' :
      result ? String(result.rows.length) : 'Loading…');
  }

  function nodes(parent) {
    const cluster = current;
    if (!cluster) return parent ? [] : [{ type: 'disconnected', label: 'Choose a Kubernetes Context' }];
    if (!parent) return [{ type: 'scope', label: cluster.session.scope.name, description: cluster.session.scope.server, revision: cluster.revision }];
    if (parent.revision !== cluster.revision) return [];
    if (parent.type === 'scope') {
      return [{ type: 'namespace', label: 'Namespace', description: cluster.namespace, revision: cluster.revision },
        ...Object.entries(groups).map(([key, label]) => ({ type: 'group', key, label, revision: cluster.revision,
          description: status(cluster.results?.[key]) }))];
    }
    if (parent.type !== 'group') return [];
    const result = cluster.results?.[parent.key];
    if (!result || result.error || !result.rows.length) return [{ type: 'info', label: result?.error || (result ? 'No items' : 'Loading…') }];
    return result.rows.map(row => {
      const summary = {
        deployments: () => [row.ready, row.desired ?? '?'].join('/') + ' ready',
        services: () => [row.type, row.ports.map(port => port.port + '/' + port.protocol).join(', ')].filter(Boolean).join(' · '),
        pods: () => [row.phase, row.containers.length + ' containers'].filter(Boolean).join(' · '),
        releases: () => [row.status, row.chart, row.revision && 'revision ' + row.revision].filter(Boolean).join(' · ')
      };
      return { type: parent.key, label: row.name, description: summary[parent.key]().replace(/[\r\n\t]/g, ' '),
        revision: cluster.revision };
    });
  }

  const tree = {
    onDidChangeTreeData: changed.event,
    getChildren: nodes,
    getTreeItem(node) {
      const visible = new vscode.TreeItem(node.label, node.type === 'scope' ? vscode.TreeItemCollapsibleState.Expanded :
        node.type === 'group' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      visible.description = node.description;
      if (node.type === 'disconnected') visible.command = { command: prefix + '.connect', title: 'Choose Kubernetes Context' };
      if (node.type === 'namespace') visible.command = { command: prefix + '.namespace', title: 'Choose Namespace' };
      if (node.type === 'pods') {
        visible.contextValue = 'rocketbrain-kube-pod';
        visible.command = { command: prefix + '.podLogs', title: 'Open Pod Logs', arguments: [node] };
      }
      if (node.type === 'scope') visible.iconPath = new vscode.ThemeIcon('cloud');
      return visible;
    }
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider(viewId, tree));

  async function refresh() {
    trusted();
    const cluster = current;
    if (!cluster) return;
    cluster.refresh?.abort();
    const signal = new AbortController();
    cluster.refresh = signal;
    cluster.revision = ++revision;
    discardLogs();
    cluster.results = undefined;
    remount();
    const calls = [cluster.session.namespaces(signal.signal),
      ...Object.keys(groups).map(key => key === 'releases' ? cluster.session.releases(cluster.namespace, signal.signal) :
        cluster.session.resources(key, cluster.namespace, signal.signal))];
    const values = await Promise.allSettled(calls);
    if (current !== cluster || signal.signal.aborted) return;
    const names = ['namespaces', ...Object.keys(groups)];
    cluster.results = Object.fromEntries(values.map((result, index) => [names[index],
      result.status === 'fulfilled' ? result.value : { error: result.reason.message }]));
    remount();
  }

  async function connect() {
    trusted();
    if (opening) return;
    const controller = new AbortController();
    opening = controller;
    let staged, retained = false;
    try {
      const files = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false,
        openLabel: 'Inspect Kubeconfig' });
      const file = files?.[0];
      if (!file || file.scheme !== 'file' || controller.signal.aborted) return;
      const config = vscode.workspace.getConfiguration(prefix);
      const [kubectl, helm] = await Promise.all([executable('kubectl', config.get('kubectlPath')), executable('helm', config.get('helmPath'))]);
      trusted();
      staged = await prepareKubernetesConfig({ file: file.fsPath, kubectl, helm, signal: controller.signal });
      const choice = await vscode.window.showQuickPick(staged.choices().map(scope => ({ label: scope.name, description: scope.server, scope })),
        { title: 'Choose an Eligible Kubernetes Context', ignoreFocusOut: true });
      if (!choice || controller.signal.aborted) return;
      const { scope } = choice;
      const approval = await vscode.window.showInformationMessage('Connect this Kubernetes explorer?',
        { modal: true, detail: [file.fsPath, scope.name, scope.server, 'Namespace ' + scope.namespace, 'Account ' + scope.user,
          scope.tlsServerName && 'TLS name ' + scope.tlsServerName].filter(Boolean).join('\n') }, 'Open Explorer');
      if (approval !== 'Open Explorer' || controller.signal.aborted) return;
      trusted();
      const session = await staged.select(scope.name);
      if (controller.signal.aborted) return;
      const old = current;
      retained = true;
      current = { session, namespace: session.scope.namespace };
      await old?.session.close();
      await refresh();
      return publicSnapshot();
    } finally {
      opening = undefined;
      if (!retained) await staged?.close();
    }
  }

  async function changeNamespace() {
    trusted();
    const cluster = current;
    if (!cluster) throw Error('Choose a Kubernetes context first.');
    const names = (cluster.results?.namespaces?.rows ?? []).map(row => ({ label: row.name, description: row.phase }));
    const manual = { label: 'Enter namespace…' };
    const choice = await vscode.window.showQuickPick([...names, manual], { title: 'Choose Kubernetes Namespace' });
    if (!choice) return;
    const namespace = choice.label === manual.label ? await vscode.window.showInputBox({ title: 'Kubernetes Namespace',
      value: cluster.namespace, validateInput: value => namespaceName(value) ? undefined : 'Enter a DNS-style namespace name.' }) : choice.label;
    if (namespace && namespaceName(namespace) && current === cluster && cluster.namespace !== namespace) {
      cluster.namespace = namespace;
      await refresh();
    }
  }

  async function showPodLogs(node) {
    trusted();
    const cluster = current;
    if (!cluster || activeLog) return;
    const pods = (cluster.results?.pods?.rows ?? []).filter(row => row.uid && row.containers.length);
    const version = cluster.revision;
    let pod;
    if (node) {
      if (node.type !== 'pods' || node.revision !== version) throw Error('Refresh the Kubernetes pod list before opening logs.');
      pod = pods.find(row => row.name === node.label);
    } else {
      pod = (await vscode.window.showQuickPick(pods.map(row => ({ label: row.name, pod: row })), { title: 'Choose Pod for Logs' }))?.pod;
    }
    if (!pod) return;
    const container = pod.containers.length === 1 ? pod.containers[0] :
      await vscode.window.showQuickPick(pod.containers, { title: 'Choose Pod Container', ignoreFocusOut: true });
    trusted();
    if (!container || cluster !== current || version !== cluster.revision || activeLog) return;
    const operation = new AbortController();
    activeLog = operation;
    try {
      const result = await vscode.window.withProgress({ title: 'Opening Kubernetes Pod Logs', location: vscode.ProgressLocation.Notification,
        cancellable: true }, async (_progress, token) => {
        const sub = token.onCancellationRequested(() => operation.abort());
        if (token.isCancellationRequested) operation.abort();
        try { return await cluster.session.podLogs(cluster.namespace, pod, container, operation.signal); }
        finally { sub.dispose(); }
      });
      if (operation.signal.aborted || cluster !== current || version !== cluster.revision) return;
      const uri = vscode.Uri.from({ scheme: logScheme, path: '/' + [result.pod, result.container, 'log'].join('.'), query: randomUUID() });
      logDocs.set(uri.toString(), { uri, text: `Kubernetes · ${cluster.session.scope.name} · ${result.namespace}/${result.pod} · ${result.container}\n` +
        `Snapshot · up to ${result.maxLines} lines / ${result.maxBytes / 1024} KiB\n\n${result.text}` });
      if (logDocs.size > 3) {
        const [key, oldest] = logDocs.entries().next().value;
        logDocs.delete(key);
        logsChanged.fire(oldest.uri);
      }
      const document = await vscode.workspace.openTextDocument(uri);
      if (!operation.signal.aborted && cluster === current && version === cluster.revision) {
        await vscode.window.showTextDocument(document, { preview: true });
      }
    } catch (error) {
      if (!operation.signal.aborted) throw error;
    } finally { if (activeLog === operation) activeLog = undefined; }
  }

  function publicSnapshot() {
    return current ? structuredClone({ scope: current.session.scope, namespace: current.namespace, results: current.results ?? null }) : null;
  }

  function command(name, action) {
    return vscode.commands.registerCommand(prefix + '.' + name, async node => {
      try { return await action(node); }
      catch (error) { void vscode.window.showErrorMessage('Rocketbrain Kubernetes: ' + error.message); }
    });
  }

  context.subscriptions.push(documents, changed, logsChanged,
    command('connect', connect), command('disconnect', disconnect), command('refresh', refresh),
    command('namespace', changeNamespace), command('podLogs', showPodLogs),
    { dispose() {
      disposed = true;
      opening?.abort();
      activeLog?.abort();
      const old = current;
      current = undefined;
      logDocs.clear();
      void old?.session.close().catch(() => {});
    } });
  return { snapshot: publicSnapshot };
}

module.exports = { registerKubernetesExplorer, viewId };
