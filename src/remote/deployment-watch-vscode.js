'use strict';

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createDeploymentWatch } = require('./deployment-watch');
const { directoryPath } = require('./directory-snapshot');

const scheme = 'rocketbrain-deployment-changes';
const protocols = [{ key: 'sftp', label: 'SFTP' }, { key: 'ftps', label: 'FTPS' }, { key: 'webdav', label: 'WebDAV' }];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function registerDeploymentWatch(vscode, services) {
  const updates = new vscode.EventEmitter(), previews = new Map();
  let last, activeProtocol, starting = false;
  const uri = id => vscode.Uri.from({ scheme, path: '/' + id + '/Deployment Changes.txt' });
  const core = createDeploymentWatch({
    webdav: services.webdav,
    isTrusted: () => vscode.workspace.isTrusted,
    onChange(view) { last = view; updates.fire(uri(view.id)); },
  });

  function chosenFolder(localFolder) {
    const folder = localFolder?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(localFolder);
    if (folder?.uri.scheme !== 'file') throw Error('Choose a directory inside an open local workspace.');
    const relative = path.relative(folder.uri.fsPath, localFolder.fsPath).split(path.sep).join('/');
    return { folder, relative: directoryPath(relative) };
  }

  function route(protocol, label, folder) {
    if (protocol === 'webdav') return services.webdav.monitorProfile(folder).profile;
    if (!['sftp','ftps'].includes(protocol)) throw Error('Choose a configured remote deployment protocol.');
    return services[protocol].route(label);
  }

  async function start({ protocol, label, localFolder, credential, remoteDirectory = '', poll = false, expected }) {
    if (starting) throw Error('A deployment change review is already starting.');
    const { folder, relative } = chosenFolder(localFolder);
    const profile = route(protocol, label, folder);
    if (expected && !same(expected, profile)) throw Error('The configured deployment route changed. Open a fresh review.');
    stop();
    activeProtocol = protocol;
    starting = true;
    try {
      const view = await core.start({ protocol, profile, label: label ?? profile.url, localDirectory: relative,
        workspaceRoot: folder.uri.fsPath, credential, remoteDirectory, poll });
      return { ...view, uri: uri(view.id) };
    } catch (error) {
      activeProtocol = undefined;
      throw error;
    } finally { starting = false; }
  }

  function stop() {
    core.stop();
    activeProtocol = undefined;
    if (last) { last = { ...last, status: 'stopped', failure: undefined }; updates.fire(uri(last.id)); }
  }

  const summaries = {
    'aligned': 'Aligned',
    'baseline-difference': 'Different at baseline',
    'local': 'Local change',
    'remote': 'Remote change',
    'conflict': 'Both sides changed',
    'type-conflict': 'A side has a non-file entry',
  };

  function text(view) {
    const format = side => side ? side.bytes + ' bytes · SHA-256 ' + side.sha256 : 'Absent';
    return [
      'Deployment Changes', '', view.route,
      'Local directory  ' + (view.localDirectory || 'Workspace root'),
      'Remote directory  ' + (view.remoteDirectory || 'Configured root'),
      'Baseline  ' + view.baselineTime,
      'Observed  ' + view.observedAt,
      'Status  ' + view.status,
      ...(view.failure ? [view.failure] : []), '',
      ...view.rows.flatMap(row => [
        row.name + ' · ' + summaries[row.direction],
        '  Local ' + row.localChange + ' · ' + format(row.local),
        '  Remote ' + row.remoteChange + ' · ' + format(row.remote),
      ]),
      ...['local','remote'].flatMap(side => view.skipped[side].length
        ? ['', 'Outside the file comparison on the ' + side + ' side', ...view.skipped[side].map(item => '  ' + item.name + ' · ' + item.kind)] : []),
      '', 'Run Compare Deployment Change for a read-only file diff.',
      'Run Review Deployment Change for Upload to open a fresh protocol review.', '',
    ].join('\n');
  }

  async function openDiff(id, revision, filename) {
    const diff = core.diff(id, revision, filename);
    const token = randomUUID();
    while (previews.size >= 8) previews.delete(previews.keys().next().value);
    previews.set(token, diff);
    const side = value => vscode.Uri.from({ scheme, path: '/' + token + '/diff/' + value + '/' + diff.row.name });
    const remote = side('remote'), local = side('local');
    await vscode.commands.executeCommand('vscode.diff', remote, local, diff.row.name + ' · Observed Deployment Change');
    return { remote, local };
  }

  async function openUploadReview(id, revision, filename) {
    const { selection, route: input, observedLocalRoot } = core.uploadInput(id, revision, filename);
    const source = vscode.Uri.file(path.join(observedLocalRoot, selection.name));
    const { folder } = chosenFolder(vscode.Uri.file(observedLocalRoot));
    const profile = route(input.protocol, input.label, folder);
    if (!same(profile, input.profile)) throw Error('The configured deployment route changed. Open a fresh review.');
    const fileKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
    if (vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' &&
        fileKey(document.uri.fsPath) === fileKey(source.fsPath) && document.isDirty)) {
      throw Error('Save the local source before reviewing the upload.');
    }
    const service = services[input.protocol];
    const observedRemote = selection.remote?.sha256 ?? null;
    const observedLocal = selection.local.sha256;
    if (input.protocol === 'webdav') {
      const remoteDirectory = [profile.remoteDirectory, input.remoteDirectory].filter(Boolean).join('/');
      const result = await service.prepare({ ...profile, remoteDirectory, password: input.credential,
        root: observedLocalRoot, workspaceRoot: folder.uri.fsPath, files: [selection.name] });
      const row = result.files[0];
      if (row?.local !== observedLocal || row?.remote !== observedRemote) throw Error('The deployment file changed. Refresh both sides.');
      core.uploadInput(id, revision, filename);
      return service.publish(result);
    }
    const remote = [input.remoteDirectory, selection.name].filter(Boolean).join('/');
    const result = await service.prepare({ label: input.label, expected: profile, remote, source, action: 'upload', credential: input.credential });
    if (result.localHash !== observedLocal || result.remoteHash !== observedRemote) throw Error('The deployment file changed. Refresh both sides.');
    core.uploadInput(id, revision, filename);
    await service.showReview(result);
    return result.uri;
  }

  const subscriptions = [updates,
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      onDidChange: updates.event,
      provideTextDocumentContent(document) {
        if (!vscode.workspace.isTrusted) return '';
        const [, id, action, side] = document.path.split('/');
        if (action === 'diff' && ['remote','local'].includes(side)) return previews.get(id)?.[side] ?? '';
        return last?.id === id ? text(last) : '';
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(stop),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (activeProtocol && event.affectsConfiguration('rocketbrain.deploy.' + activeProtocol)) stop();
    }),
  ];

  function command(name, action) {
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.deploy.' + name, async () => {
      try {
        if (!vscode.workspace.isTrusted) throw Error('Open a trusted workspace to review deployment changes.');
        return await action();
      } catch (error) { await vscode.window.showErrorMessage(error.message); }
    }));
  }

  function active() {
    const selected = vscode.window.activeTextEditor?.document.uri;
    const id = selected?.path.split('/')[1];
    if (selected?.scheme !== scheme || last?.id !== id) throw Error('Open a deployment changes document.');
    return core.view(id);
  }

  command('watchChanges', async () => {
    const choice = await vscode.window.showQuickPick(protocols, { title: 'Choose a Deployment Protocol' });
    if (!choice) return;
    const destinations = await vscode.window.showOpenDialog({ title: 'Choose a Local Deployment Folder', canSelectFiles: false, canSelectFolders: true });
    if (!destinations?.length) return;
    const [localFolder] = destinations;
    const { folder } = chosenFolder(localFolder);
    const protocol = choice.key, service = services[protocol];
    let label;
    if (protocol !== 'webdav') {
      const routes = service.routes();
      if (!routes.length) throw Error('Configure profiles for ' + choice.label + ' in VS Code User Settings.');
      label = await vscode.window.showQuickPick(routes.map(profile => profile.label), { title: 'Choose a Deployment Route' });
      if (!label) return;
    }
    const expected = route(protocol, label, folder);
    const remoteDirectory = await vscode.window.showInputBox({ title: 'Remote Folder Under the Configured Root', value: '',
      validateInput(value) { try { directoryPath(value); } catch (error) { return error.message; } },
    });
    if (remoteDirectory === undefined) return;
    const mode = await vscode.window.showQuickPick(['Review Manually','Monitor Both Sides for 10 Minutes'], { title: 'Deployment Change Review Mode' });
    if (!mode) return;
    const credential = protocol === 'webdav' ? await service.monitorCredential(folder) : await service.promptCredential(expected);
    if (credential === undefined) return;
    const view = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Reading Both Deployment Folders',
      cancellable: true }, async (_, token) => {
      const cancel = token.onCancellationRequested(stop);
      try {
        if (token.isCancellationRequested) return undefined;
        return await start({ protocol, label, localFolder, credential, remoteDirectory, poll: mode !== 'Review Manually', expected });
      } finally { cancel.dispose(); }
    });
    if (!view) return;
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(view.uri), { preview: false });
  });
  command('refreshChanges', () => core.refresh(active().id));
  command('resetChanges', async () => {
    const { id } = active();
    const answer = await vscode.window.showInformationMessage('Use the latest observation as the new deployment baseline?', { modal: true }, 'Set Baseline');
    if (answer === 'Set Baseline') return core.reset(id);
  });
  command('compareChange', async () => {
    const snapshot = active();
    const choice = await vscode.window.showQuickPick(snapshot.rows.map(row => ({ label: row.name, description: summaries[row.direction] })),
      { title: 'Choose an Observed Deployment File' });
    if (choice) return openDiff(snapshot.id, snapshot.revision, choice.label);
  });
  command('reviewChangeUpload', async () => {
    const snapshot = active();
    const candidates = snapshot.rows.filter(row => row.canReviewUpload);
    if (!candidates.length) throw Error('There is no observed change eligible for an upload review.');
    const name = await vscode.window.showQuickPick(candidates.map(row => row.name), { title: 'Choose a File for a Fresh Upload Review' });
    if (name) return openUploadReview(snapshot.id, snapshot.revision, name);
  });
  command('stopWatchingChanges', () => stop());

  return { start, refresh: core.refresh, reset: core.reset, view: core.view, compare: core.diff, openDiff, openUploadReview, stop, dispose() {
    core.dispose();
    previews.clear();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { registerDeploymentWatch };
