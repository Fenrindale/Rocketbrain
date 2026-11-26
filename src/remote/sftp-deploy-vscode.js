'use strict';

const path = require('node:path');
const { createSftpDeployment } = require('./sftp-deploy');
const { profileFor, relativePath } = require('./sftp-channel');

const scheme = 'rocketbrain-sftp-review';
const setting = 'rocketbrain.deploy.sftp.profiles';
const fileKey = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;

function registerSftpDeployment(context, vscode) {
  const core = createSftpDeployment();
  const reviews = new Map();
  const changes = new vscode.EventEmitter();
  let disposed = false;

  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Open a trusted local workspace before using SFTP deployment.');
  }

  function route(label, expected) {
    trusted();
    const profiles = vscode.workspace.getConfiguration('rocketbrain.deploy.sftp').get('profiles', []);
    if (!Array.isArray(profiles) || profiles.length > 32) throw Error('Set up to 32 SFTP profiles in Rocketbrain user settings.');
    const matches = profiles.filter(value => value?.label?.trim?.() === label);
    if (matches.length !== 1) throw Error('Choose a unique SFTP profile label from Rocketbrain user settings.');
    const profile = profileFor(matches[0]);
    if (expected && JSON.stringify(profile) !== JSON.stringify(expected)) throw Error('The configured SFTP profile changed. Start a new review.');
    return profile;
  }

  function savedSource(uri) {
    if (uri?.scheme !== 'file') throw Error('Choose one saved file in a local workspace.');
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.scheme !== 'file') throw Error('Choose one saved file in a local workspace.');
    const relative = relativePath(path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/'));
    const dirty = vscode.workspace.textDocuments.some(document => document.uri.scheme === 'file' &&
      fileKey(document.uri.fsPath) === fileKey(uri.fsPath) && document.isDirty);
    if (dirty) throw Error('Save the local source and make a new deployment review.');
    return { localRoot: folder.uri.fsPath, local: relative };
  }

  const uriFor = (review, side) => vscode.Uri.from({ scheme, path: side
    ? '/' + review.id + '/' + side + '/' + path.posix.basename(review.remote)
    : '/' + review.id + '/SFTP Deployment Review.txt' });

  function reviewFor(id) {
    trusted();
    const record = reviews.get(id);
    if (!record) throw Error('Open a current SFTP deployment review.');
    return record;
  }

  async function browse({ label, expected, remote = '', credential, signal }) {
    return core.browse({ profile: route(label, expected), remote, credential, signal });
  }

  async function prepare({ label, expected, remote, action, source, credential, signal }) {
    const profile = route(label, expected);
    const local = action === 'upload' ? savedSource(source) : {};
    const review = await core.prepare({ profile, remote, action, ...local, credential, signal });
    trusted();
    while (reviews.size >= 8) reviews.delete(reviews.keys().next().value);
    reviews.set(review.id, { review, source, local, profile });
    return { ...review, uri: uriFor(review) };
  }

  async function apply(id, approval) {
    const record = reviewFor(id);
    function guard() {
      const current = route(record.profile.label);
      if (JSON.stringify(current) !== JSON.stringify(record.profile) ||
          record.source && JSON.stringify(savedSource(record.source)) !== JSON.stringify(record.local)) {
        throw Error('The scoped deployment profile or local workspace changed. Start a new review.');
      }
    }
    const receipt = await core.apply(id, { ...approval, guard });
    record.receipt = receipt;
    changes.fire(uriFor(record.review));
    return receipt;
  }

  async function openDiff(id) {
    const { review } = reviewFor(id);
    if (review.action !== 'upload' || review.localText === undefined ||
        review.remoteHash !== null && review.remoteText === undefined) {
      throw Error('A text comparison is available for UTF-8 files of at most 64 KiB. The review shows the byte counts and hashes.');
    }
    const remote = uriFor(review, 'remote'), local = uriFor(review, 'local');
    await vscode.commands.executeCommand('vscode.diff', remote, local, path.posix.basename(review.remote) + ' · SFTP Deployment Review');
    return { remote, local };
  }

  function reviewText(record) {
    const { review, receipt } = record;
    const destination = ('/' + [review.root, review.remote].map(value => value.replace(/^\//u, '')).filter(Boolean).join('/'));
    return [
      'SFTP Deployment Review', '', review.profile, review.user + '@' + review.host + ':' + review.port, review.hostFingerprint, destination, '',
      ...(review.action === 'mkdir' ? ['Create a remote folder'] : [
        'Local file  ' + review.local,
        'Proposed change  ' + review.disposition,
        'Local  ' + review.localBytes + ' bytes · SHA-256 ' + review.localHash,
        review.remoteHash === null ? 'Remote file is absent.' : 'Remote  ' + review.remoteBytes + ' bytes · SHA-256 ' + review.remoteHash,
        ...(review.disposition === 'replace' && !review.atomicReplace ? ['The server did not advertise POSIX replacement.'] : []),
        'Run Compare SFTP Deployment File to inspect the text.',
      ]),
      ...(review.canApply && !receipt ? ['', 'Run Publish Reviewed SFTP Change to approve this exact review.'] : []),
      ...(receipt ? ['', 'Publication verified  ' + receipt.remote] : []), '',
    ].join('\n');
  }

  function invalidate() { core.invalidate(); reviews.clear(); }
  const subscriptions = [
    changes,
    vscode.workspace.onDidChangeWorkspaceFolders(invalidate),
    vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration(setting)) invalidate(); }),
    vscode.workspace.registerTextDocumentContentProvider(scheme, {
      onDidChange: changes.event,
      provideTextDocumentContent(uri) {
        if (disposed || !vscode.workspace.isTrusted) return '';
        const [, id, side] = uri.path.split('/');
        const record = reviews.get(id);
        if (!record) return '';
        if (side === 'remote') return record.review.remoteText ?? '';
        if (side === 'local') return record.review.localText ?? '';
        return reviewText(record);
      },
    }),
  ];

  function progress(title, action) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
      const controller = new AbortController();
      const listener = token.onCancellationRequested(() => controller.abort(Error('SFTP operation canceled.')));
      if (token.isCancellationRequested) controller.abort(Error('SFTP operation canceled.'));
      try { return await action(controller.signal); }
      finally { listener.dispose(); }
    });
  }

  function command(name, action) {
    subscriptions.push(vscode.commands.registerCommand('rocketbrain.deploy.' + name, async () => {
      try { trusted(); return await action(); }
      catch (error) {
        const detail = error.stagedPath ? ' Staging path  ' + error.stagedPath : '';
        await vscode.window.showErrorMessage(error.message + detail);
      }
    }));
  }
  const credentialPrompt = profile => vscode.window.showInputBox({ password: true, ignoreFocusOut: true,
    title: profile.authentication === 'password' ? 'SFTP Password' : 'SFTP Key Passphrase',
    prompt: profile.user + '@' + profile.host + ':' + profile.port + ' · ' + profile.hostFingerprint });

  async function selectRemote(profile, credential) {
    let remote = '';
    for (;;) {
      const result = await progress('Reading the SFTP directory', signal => browse({ label: profile.label, expected: profile, remote, credential, signal }));
      const selection = await vscode.window.showQuickPick([
        ...(remote ? [{ label: '..', parent: true }] : []),
        ...result.entries.map(entry => ({ label: entry.name, description: entry.kind, entry })),
      ], { title: 'SFTP · ' + result.root + (remote ? (result.root.endsWith('/') ? '' : '/') + remote : '') });
      if (!selection) return;
      if (selection.parent) { remote = remote.split('/').slice(0, -1).join('/'); continue; }
      const selected = [remote, selection.entry.name].filter(Boolean).join('/');
      if (selection.entry.kind === 'directory') { remote = selected; continue; }
      if (selection.entry.kind === 'file') return selected;
    }
  }

  function activeReview() {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (uri?.scheme !== scheme) throw Error('Open a current SFTP deployment review.');
    return reviewFor(uri.path.split('/')[1]);
  }

  command('reviewSftp', async () => {
    const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.scheme === 'file');
    if (!folder) throw Error('Open a local workspace folder.');
    const configured = vscode.workspace.getConfiguration('rocketbrain.deploy.sftp').get('profiles', []);
    if (!configured.length) throw Error('Add an SFTP profile under Rocketbrain user settings.');
    const label = await vscode.window.showQuickPick(configured.map(profile => profileFor(profile).label), { title: 'Choose an SFTP Profile' });
    if (!label) return;
    const profile = route(label);
    const selected = await vscode.window.showQuickPick([
      { label: 'Review a local file for upload', action: 'upload' },
      { label: 'Browse remote files and choose a file to compare', action: 'browse' },
      { label: 'Review creation of one remote folder', action: 'mkdir' },
    ], { title: 'SFTP Project Deployment' });
    if (!selected) return;
    const credential = await credentialPrompt(profile);
    if (credential === undefined) return;
    let source, remote;
    if (selected.action === 'browse') {
      remote = await selectRemote(profile, credential);
      if (!remote) return;
    }
    if (selected.action !== 'mkdir') {
      const active = vscode.window.activeTextEditor?.document.uri;
      const choice = await vscode.window.showOpenDialog({ title: 'Choose a Saved Local Workspace File', canSelectMany: false,
        defaultUri: active?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(active) ? active : folder.uri });
      if (!choice?.length) return;
      [source] = choice;
    }
    if (!remote) remote = await vscode.window.showInputBox({ title: 'SFTP Path Below ' + profile.root,
      value: source && savedSource(source).local, validateInput: value => { try { relativePath(value); } catch (error) { return error.message; } } });
    if (remote === undefined) return;
    const result = await progress('Preparing the SFTP deployment review', signal => prepare({
      label, expected: profile, remote, action: selected.action === 'mkdir' ? 'mkdir' : 'upload', source, credential, signal,
    }));
    return vscode.window.showTextDocument(await vscode.workspace.openTextDocument(result.uri), { preview: false });
  });

  command('compareSftp', () => openDiff(activeReview().review.id));
  command('applySftp', async () => {
    const { review, profile } = activeReview();
    if (!review.canApply) throw Error('This SFTP review does not have an eligible change.');
    const answer = await vscode.window.showWarningMessage('Publish ' + review.remote + ' to ' + review.profile + '?',
      { modal: true, detail: profile.user + '@' + profile.host + ':' + profile.port + ' · ' + profile.root }, 'Publish');
    if (answer !== 'Publish') return;
    const credential = await credentialPrompt(profile);
    if (credential === undefined) return;
    return progress('Publishing the reviewed SFTP change', signal => apply(review.id, { confirmed: true, hash: review.hash, credential, signal }));
  });

  return { browse, prepare, apply, openDiff, dispose() {
    disposed = true;
    reviews.clear();
    core.dispose();
    for (const subscription of subscriptions) subscription.dispose();
  } };
}

module.exports = { registerSftpDeployment };
