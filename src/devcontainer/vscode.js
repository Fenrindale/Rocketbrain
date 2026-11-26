'use strict';

const path = require('node:path');
const { createDevContainers } = require('./runtime');

function registerDevContainers(context, vscode) {
  const settingsByRoot = root => vscode.workspace.getConfiguration('rocketbrain.devcontainer', vscode.Uri.file(root));
  const sessionKey = key => 'rocketbrain.devcontainer.session.' + key;
  const service = createDevContainers({
    trusted: () => vscode.workspace.isTrusted,
    settings: root => {
      const config = settingsByRoot(root);
      return { cliPath: config.get('cliPath'), nodePath: config.get('nodePath'), dockerPath: config.get('dockerPath') };
    },
    readSession: key => context.workspaceState.get(sessionKey(key)),
    writeSession: (key, value) => context.workspaceState.update(sessionKey(key), value)
  });
  const output = vscode.window.createOutputChannel('Rocketbrain Dev Container');
  const registrations = [output];

  async function pickWorkspace() {
    const candidates = (vscode.workspace.workspaceFolders || []).filter(folder => folder.uri.scheme === 'file');
    if (!candidates.length) throw Error('Open a local workspace folder with a Dev Container configuration.');
    if (candidates.length === 1) return candidates[0].uri.fsPath;
    const choice = await vscode.window.showQuickPick(candidates.map(folder => ({
      label: folder.name, description: folder.uri.fsPath
    })), { placeHolder: 'Choose the Dev Container workspace' });
    return choice?.description;
  }

  function describe(root, plan) {
    const lines = [
      'Workspace: ' + root,
      'Configuration: ' + path.relative(root, plan.file),
      'Dev Container CLI: ' + plan.cliVersion,
      'Type: ' + ({ compose: 'Docker Compose', image: 'Image', dockerfile: 'Dockerfile' }[plan.kind] || 'Unknown'),
      plan.name && 'Name: ' + plan.name,
      plan.image && 'Image: ' + plan.image,
      plan.dockerfile && 'Dockerfile: ' + plan.dockerfile,
      ...(plan.compose ? [
        'Compose workspace service  ' + plan.compose.service,
        'Compose files  ' + plan.compose.files.join(', '),
        'Reviewed services  ' + plan.compose.services.join(', '),
      ] : []),
      plan.workspaceFolder && 'Container workspace: ' + plan.workspaceFolder,
      plan.workspaceMount && 'Workspace mount: ' + plan.workspaceMount,
      plan.remoteUser && 'Container user: ' + plan.remoteUser,
      plan.features?.length && 'Features: ' + plan.features.join(', '),
      plan.lifecycleHooks.length && 'Lifecycle: ' + plan.lifecycleHooks.join(', ')
    ];
    output.appendLine(lines.filter(Boolean).join('\n') + '\n');
    output.show(true);
  }

  function register(name, task) {
    registrations.push(vscode.commands.registerCommand('rocketbrain.devcontainer.' + name, async () => {
      try {
        if (!vscode.workspace.isTrusted) throw Error('Trust the selected local workspace to use Dev Containers.');
        const root = await pickWorkspace();
        if (root) return await task(root);
      } catch (error) {
        void vscode.window.showErrorMessage(error.message);
      }
    }));
  }

  function progress(title, task) {
    return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, task);
  }

  register('inspect', async root => {
    const plan = await progress('Reading Dev Container configuration', () => service.inspect(root));
    describe(root, plan);
    return plan;
  });
  register('start', async root => {
    const plan = await progress('Reading Dev Container configuration', () => service.inspect(root));
    describe(root, plan);
    if (!['image','dockerfile','compose'].includes(plan.kind)) throw Error('Choose an image, Dockerfile, or explicit Compose Dev Container configuration.');
    const approved = await vscode.window.showWarningMessage('Start the Dev Container for ' + path.basename(root) + '?', {
      modal: true,
      detail: 'The Dev Container CLI applies project image, build, workspace mounts and lifecycle commands. The initializeCommand can run on this computer.'
    }, 'Start Dev Container');
    if (!approved) return;
    const result = await progress('Starting the workspace Dev Container',
      () => service.start(root, { file: plan.file, fingerprint: plan.fingerprint, allowProjectExecution: true }));
    output.appendLine('Started ' + result.id.slice(0, 12) + (result.workspaceFolder ? ' in ' + result.workspaceFolder : ''));
    if(result.services)output.appendLine('Compose services  '+result.services.map(row=>row.service+' '+row.id.slice(0,12)).join(', '));
    return result;
  });
  register('exec', async root => {
    const input = await vscode.window.showInputBox({
      title: 'Run in Managed Dev Container',
      prompt: 'Enter the executable and arguments as a JSON array of strings',
      placeHolder: '["java", "-version"]'
    });
    if (!input) return;
    let command;
    try { command = JSON.parse(input); } catch { throw Error('Enter a JSON array of strings.'); }
    const result = await progress('Running in the managed Dev Container', () => service.execute(root, command));
    output.appendLine('Container ' + result.id.slice(0, 12) + ' exited with code ' + result.code + '\n');
    if (result.stdout) output.appendLine(result.stdout);
    if (result.stderr) output.appendLine(result.stderr);
    output.show(true);
    return result;
  });
  register('status', async root => {
    const result = await progress('Checking the workspace Dev Container', () => service.status(root));
    output.appendLine('Dev Container: ' + result.state + (result.id ? ' (' + result.id.slice(0, 12) + ')' : ''));
    if(result.services)for(const row of result.services)output.appendLine(row.service+' · '+row.id.slice(0,12)+' · '+(row.running?'running':'stopped'));
    output.show(true);
    return result;
  });
  register('stop', async root => {
    const result = await progress('Stopping the workspace Dev Container', () => service.stop(root));
    output.appendLine('Dev Container: ' + result.state + (result.id ? ' (' + result.id.slice(0, 12) + ')' : ''));
    output.show(true);
    return result;
  });

  function openRoot(input) {
    const fsPath = input?.fsPath || input;
    if (input?.scheme && input.scheme !== 'file' || typeof fsPath !== 'string' || !path.isAbsolute(fsPath)) {
      throw Error('Choose an exact local workspace folder.');
    }
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (folder?.uri.scheme !== 'file' || path.relative(folder.uri.fsPath, fsPath)) throw Error('Choose an exact open local workspace folder.');
    return folder.uri.fsPath;
  }

  return {
    inspect: root => service.inspect(openRoot(root)),
    start: (root, review) => service.start(openRoot(root), review),
    execute: (root, argv) => service.execute(openRoot(root), argv),
    status: root => service.status(openRoot(root)),
    stop: root => service.stop(openRoot(root)),
    dispose() { for (const subscription of registrations) subscription.dispose(); }
  };
}

module.exports = { registerDevContainers };
