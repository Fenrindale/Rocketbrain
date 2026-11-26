'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createDevContainers } = require('./runtime');
const { registerContainerJava } = require('./java-vscode');
const { createManagedJavaAttach } = require('./java-attach');

function registerDevContainers(context, vscode, localJava) {
  const settingsByRoot = root => vscode.workspace.getConfiguration('rocketbrain.devcontainer', vscode.Uri.file(root));
  const sessionKey = key => 'rocketbrain.devcontainer.session.' + key;
  let containerJava;
  const service = createDevContainers({
    trusted: () => vscode.workspace.isTrusted,
    workspaceOpen: root => vscode.workspace.workspaceFolders?.some(folder => {
      if (folder.uri.scheme !== 'file') return false;
      try { return !path.relative(fs.realpathSync(folder.uri.fsPath), root); } catch { return false; }
    }),
    settings: root => {
      const config = settingsByRoot(root);
      return { cliPath: config.get('cliPath'), nodePath: config.get('nodePath'), dockerPath: config.get('dockerPath') };
    },
    readSession: key => context.workspaceState.get(sessionKey(key)),
    writeSession: (key, value) => context.workspaceState.update(sessionKey(key), value),
    onJavaDiagnostics: (...args) => containerJava?.publish(...args),
    onJavaClosed: root => containerJava?.closed(root)
  });
  const output = vscode.window.createOutputChannel('Rocketbrain Dev Container');
  const registrations = [service, output];

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
    for (const forward of result.forwards || []) output.appendLine(forwardAddress(forward));
    output.show(true);
    return result;
  });
  register('stop', async root => {
    const result = await progress('Stopping the workspace Dev Container', () => service.stop(root));
    output.appendLine('Dev Container: ' + result.state + (result.id ? ' (' + result.id.slice(0, 12) + ')' : ''));
    output.show(true);
    return result;
  });

  function forwardAddress(forward) {
    return forward.host + ':' + forward.localPort + ' → container loopback TCP ' + forward.containerPort;
  }

  async function portInput(title, allowAutomatic) {
    const value = await vscode.window.showInputBox({
      title,
      prompt: allowAutomatic ? 'Enter 0 to choose an unused IPv4 loopback port automatically' : 'Enter the TCP port listening on container loopback',
      value: allowAutomatic ? '0' : '',
      validateInput: input => {
        const port = Number(input);
        return /^\d{1,5}$/.test(input) && (allowAutomatic && port === 0 || port >= (allowAutomatic ? 1024 : 1) && port <= 65535)
          ? undefined : 'Enter a valid TCP port number.';
      }
    });
    return value === undefined ? undefined : Number(value);
  }

  register('forwardPort', async root => {
    const containerPort = await portInput('Container TCP Port', false);
    if (containerPort === undefined) return;
    const localPort = await portInput('Local TCP Port', true);
    if (localPort === undefined) return;
    const review = await progress('Checking the exact managed Dev Container',
      () => service.inspectPort(root, { containerPort, localPort }));
    const source = review.localPort === 0 ? 'an available 127.0.0.1 port' : review.host + ':' + review.localPort;
    const approved = await vscode.window.showWarningMessage('Forward a port from this Dev Container?', {
      modal: true,
      detail: 'Forward ' + source + ' to 127.0.0.1:' + review.containerPort + ' in container ' + review.containerId.slice(0, 12) +
        '. Other local processes can connect. The listener closes when this VS Code window or the verified container stops.'
    }, 'Forward Port');
    if (!approved) return;
    const result = await progress('Opening local Dev Container port',
      () => service.forwardPort(root, { token: review.token, allowLoopbackAccess: true }));
    output.appendLine(forwardAddress(result));
    output.show(true);
    return result;
  });
  register('closePort', async root => {
    const active = await service.forwardedPorts(root);
    if (!active.length) {
      void vscode.window.showInformationMessage('This workspace has no active Dev Container port forwards.');
      return;
    }
    const choice = await vscode.window.showQuickPick(active.map(forward => ({ label: forwardAddress(forward), id: forward.id })),
      { placeHolder: 'Choose the local port to close' });
    if (choice) await service.closePort(root, choice.id);
  });
  containerJava = registerContainerJava(vscode, service, localJava, register, progress, output);
  registrations.push(containerJava);
  const javaAttach = createManagedJavaAttach({
    debug: vscode.debug, openForward: service.forwardPort, closeForward: service.closePort,
    async ready() {
      if (!localJava) throw Error('Start the local Rocketbrain Java Debug engine first.');
      const state = await localJava.start();
      if (state.state === 'container') throw Error('Stop the container Java editor engine before opening a managed JVM attach.');
      if (state.state !== 'running' || !state.debugBundlePath) {
        throw Error('Configure the independent local JDK, Eclipse JDT LS and Java debug bundle.');
      }
    }
  });
  registrations.push(javaAttach);

  register('javaAttach', async root => {
    const port = await portInput('Container JVM Debug Port', false);
    if (port === undefined) return;
    const containerRoot = await vscode.window.showInputBox({ title: 'Mounted Workspace in Container',
      value: '/workspaces/' + path.basename(root) });
    if (!containerRoot) return;
    const sourceDirectory = await vscode.window.showInputBox({ title: 'Java Source Directory in This Workspace',
      prompt: 'Use a relative directory, or . for the workspace root', value: 'src/main/java' });
    if (!sourceDirectory) return;
    const review = await progress('Checking the exact JVM attach route', () => service.inspectJavaAttach(root,
      { port, containerRoot, sourceDirectory }));
    const approved = await vscode.window.showWarningMessage('Attach to this managed container JVM?', {
      modal: true,
      detail: 'Container ' + review.containerId.slice(0, 12) + ' will forward JDWP port ' + review.containerPort +
        ' to an assigned IPv4 loopback port. Local processes can connect while the debugger is attached. Sources use ' +
        (path.relative(root, review.sourceRoot) || '.') + ' in this workspace.'
    }, 'Attach Debugger');
    if (!approved) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root));
    return progress('Starting the managed JVM attach', () => javaAttach.start(root, folder,
      { token: review.token, allowContainerDebugging: true }));
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
    inspectPort: (root, requested) => service.inspectPort(openRoot(root), requested),
    forwardPort: (root, confirmation) => service.forwardPort(openRoot(root), confirmation),
    forwardedPorts: root => service.forwardedPorts(openRoot(root)),
    closePort: (root, id) => service.closePort(openRoot(root), id),
    inspectJava: (root, requested) => service.inspectJava(openRoot(root), requested),
    startJava: (root, confirmation) => containerJava.start(openRoot(root), confirmation),
    stopJava: root => service.stopJava(openRoot(root)),
    javaStatus: root => service.javaStatus(openRoot(root)),
    javaDefinition: (root, document, position) => service.javaDefinition(openRoot(root), document, position),
    javaHover: (root, document, position) => service.javaHover(openRoot(root), document, position),
    javaFormat: (root, document, options) => service.javaFormat(openRoot(root), document, options),
    inspectJavaAttach: (root, requested) => service.inspectJavaAttach(openRoot(root), requested),
    startJavaAttach: (root, confirmation) => {
      const exact = openRoot(root);
      return javaAttach.start(exact, vscode.workspace.getWorkspaceFolder(vscode.Uri.file(exact)), confirmation);
    },
    dispose() { for (const subscription of registrations) subscription.dispose(); }
  };
}

module.exports = { registerDevContainers };
