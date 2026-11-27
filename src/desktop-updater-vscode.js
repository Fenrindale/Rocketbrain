'use strict';

const { execFile, spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { makeUpdater, parseVersion, verifyFile } = require('./desktop-updater');

const runFile = promisify(execFile);
const checkCommand = 'rocketbrain.desktop.checkForUpdates';

async function installedDesktop(context, vscode) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || vscode.env.remoteName || !vscode.env.appRoot) return;
  if (context.globalStorageUri?.scheme !== 'file') return;
  try {
    const root = await fsp.realpath(vscode.env.appRoot);
    const resources = path.dirname(root);
    if (path.basename(root).toLowerCase() !== 'app' || path.basename(resources).toLowerCase() !== 'resources') return;
    const directory = path.dirname(resources);
    const manifest = JSON.parse(await fsp.readFile(path.join(root, 'product.json'), 'utf8'));
    const desktop = manifest.rocketbrainDesktop;
    if (manifest.applicationName !== 'rocketbrain-desktop' || manifest.target !== 'user' ||
        manifest.win32MutexName !== 'rocketbrain-desktop' || desktop?.platform !== 'win32-x64' ||
        !parseVersion(desktop.version)) return;
    const [bundledPath, loadedPath, executable] = await Promise.all([
      fsp.realpath(path.join(root, 'extensions', 'rocketbrain')),
      fsp.realpath(context.extensionPath),
      fsp.realpath(process.execPath),
    ]);
    if (bundledPath.toLowerCase() !== loadedPath.toLowerCase() ||
        executable.toLowerCase() !== path.join(directory, 'Rocketbrain.exe').toLowerCase()) return;
    return { version: desktop.version, directory };
  } catch {
    return undefined;
  }
}

function progress(vscode, title, operation) {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: true,
  }, async (progressUi, token) => {
    const controller = new AbortController();
    const onCancellation = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try {
      return await operation(controller.signal, progressUi);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      onCancellation.dispose();
    }
  });
}

async function verifyPublisher(file, expectedStatus) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
    '(Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:ROCKETBRAIN_INSTALLER_PATH).Status.ToString()',
  ].join('\n');
  let status;
  try {
    ({ stdout: status } = await runFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      env: {
        SystemRoot: systemRoot,
        PATH: path.join(systemRoot, 'System32'),
        ROCKETBRAIN_INSTALLER_PATH: file,
      },
      windowsHide: true,
      timeout: 20_000,
      maxBuffer: 16 * 1024,
    }));
  } catch {
    throw new Error('Windows could not verify the installer publisher.');
  }
  if (status.trim() !== (expectedStatus === 'signed' ? 'Valid' : 'NotSigned')) {
    throw new Error('The installer’s Windows signature did not match its release receipt.');
  }
}

async function startInstaller(file, directory, onExit) {
  const args = [`/DIR=${directory}`];
  const isolated = await fsp.lstat(path.join(directory, '.rocketbrain-isolated')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (isolated) args.push('/RB_ISOLATED=1');
  const installer = spawn(file, args, { cwd: path.dirname(file), detached: true, stdio: 'ignore' });
  installer.once('exit', onExit);
  await new Promise((resolve, reject) => {
    installer.once('spawn', resolve);
    installer.once('error', reject);
  });
  installer.unref();
}

async function registerDesktopUpdater(context, vscode) {
  const installed = await installedDesktop(context, vscode);
  if (!installed) return;
  const { version } = installed;

  const updater = makeUpdater();
  const directory = path.join(context.globalStorageUri.fsPath, 'desktop-updates');
  let running = false;
  context.subscriptions.push(vscode.commands.registerCommand(checkCommand, async () => {
    if (running) {
      void vscode.window.showInformationMessage('A Rocketbrain Desktop update check is already open.');
      return;
    }
    running = true;
    let download;
    let launched = false;
    try {
      let finished = false;
      const candidate = await progress(vscode, 'Checking GitHub for Rocketbrain Desktop updates', async signal => {
        const update = await updater.check(version, signal);
        signal.throwIfAborted();
        finished = true;
        return update;
      });
      if (!finished) return;
      if (!candidate) {
        void vscode.window.showInformationMessage(`Rocketbrain Desktop ${version} is up to date on its release channel.`);
        return;
      }
      const size = Math.ceil(candidate.installer.bytes / (1024 * 1024));
      const details = `Rocketbrain Desktop ${candidate.version} is available on GitHub. Installed version ${version}. Download size ${size} MB.`;
      const answer = await vscode.window.showInformationMessage(details, 'Download Update', 'View Release');
      if (answer === 'View Release') {
        await vscode.env.openExternal(vscode.Uri.parse(candidate.releaseUrl));
        return;
      }
      if (answer !== 'Download Update') return;

      download = await progress(vscode, `Downloading Rocketbrain Desktop ${candidate.version}`, async (signal, ui) => {
        let displayed = 0;
        const staged = await updater.stage(candidate, directory, signal, received => {
          const percentage = Math.floor(received * 100 / candidate.installer.bytes);
          if (percentage > displayed) {
            ui.report({ increment: percentage - displayed });
            displayed = percentage;
          }
        });
        if (signal.aborted) await staged.cleanup();
        signal.throwIfAborted();
        return staged;
      });
      if (!download) return;

      const unsigned = candidate.installer.authenticode === 'unsigned-preview';
      const publisher = unsigned
        ? 'This preview installer is unsigned. Windows may show a publisher warning.'
        : 'Windows will verify the installer’s publisher signature before launch.';
      const confirmation = await vscode.window.showWarningMessage(
        `Quit Rocketbrain to install version ${candidate.version}?`,
        { modal: true, detail: `The downloaded installer passed its SHA-256 check. ${publisher}\n\nSave any work you want to keep. The installer will wait until Rocketbrain closes.` },
        'Quit & Install',
      );
      if (confirmation !== 'Quit & Install') return;
      await verifyPublisher(download.file, candidate.installer.authenticode);
      await verifyFile(download.file, candidate.installer);
      await startInstaller(download.file, installed.directory, download.cleanup);
      launched = true;
      await vscode.commands.executeCommand('workbench.action.quit');
    } catch (error) {
      void vscode.window.showErrorMessage(`Rocketbrain Desktop update could not continue. ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (download && !launched) await download.cleanup();
      running = false;
    }
  }));
  await vscode.commands.executeCommand('setContext', 'rocketbrain.desktopUpdaterAvailable', true);
}

module.exports = { registerDesktopUpdater, verifyPublisher };
