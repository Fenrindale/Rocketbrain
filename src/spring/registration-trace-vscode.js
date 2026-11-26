'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { readRegistrationTrace } = require('./registration-trace');
const { openJavaFrame } = require('../java/jvm-diagnostics-vscode');
const { workspaceRoots, workspacePath } = require('../java/workbench-model');

function local(uri) {
  if (uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment) throw Error('Choose a local folder or trace file.');
  return uri.fsPath;
}

function registerSpringRegistrationTrace(context, vscode) {
  let disposed = false;
  const subscriptions = [];
  const trusted = () => {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the local workspace before inspecting Spring registrations.');
  };

  async function helperFolder(uri) {
    trusted();
    let folder = workspacePath(local(uri), workspaceRoots(vscode.workspace.workspaceFolders || []));
    for (const name of ['rocketbrain', 'spring']) {
      folder = path.join(folder, name);
      await fs.mkdir(folder).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(folder, await fs.realpath(folder))) {
        throw Error('Choose a physical Java source folder inside the workspace.');
      }
    }
    return folder;
  }

  async function copyHelper(uri) {
    const folder = await helperFolder(uri);
    trusted();
    const destination = path.join(folder, 'RegistrationTrace.java');
    await fs.copyFile(context.asAbsolutePath('dist/spring-registration/RegistrationTrace.java'),
      destination, constants.COPYFILE_EXCL).catch(error => {
      if (error.code === 'EEXIST') throw Error('RegistrationTrace.java already exists in this source root.');
      throw error;
    });
    return vscode.Uri.file(destination);
  }

  async function copyBootHelpers(uri) {
    const folder = await helperFolder(uri);
    const entries = await Promise.all(['RegistrationTrace.java','BootServletRegistrationTrace.java'].map(async name => ({
      file:path.join(folder,name),bytes:await fs.readFile(context.asAbsolutePath('dist/spring-registration/'+name))
    })));
    function incompatible() {
      return Error('Review the existing Spring trace helper before copying these sources.');
    }
    const [shared,servlet]=entries;
    async function exists({file,bytes},allowExact) {
      const saved=await fs.lstat(file).catch(error => {
        if (error.code!=='ENOENT') throw error;
      });
      if (!saved) return false;
      if (!allowExact || !saved.isFile() || saved.isSymbolicLink() || saved.size!==bytes.length ||
          !(await fs.readFile(file)).equals(bytes)) throw incompatible();
      return true;
    }
    async function stage(entry,created) {
      trusted();
      const handle=await fs.open(entry.file,'wx');
      try {
        const identity=await handle.stat({bigint:true});
        created.push({...entry,identity});
        await handle.writeFile(entry.bytes);
      } finally {await handle.close();}
    }
    const created=[];
    try {
      const sharedExists=await exists(shared,true);
      await exists(servlet,false);
      // Claim the unique servlet helper first. A racing copy cannot borrow a shared file from a failed install.
      await stage(servlet,created);
      if (!sharedExists && !await exists(shared,true)) await stage(shared,created);
    } catch (error) {
      for (const {file,bytes,identity} of created.reverse()) {
        const current=await fs.lstat(file,{bigint:true}).catch(()=>null);
        if (current?.isFile() && current.dev===identity.dev && current.ino===identity.ino && current.size<=BigInt(bytes.length)) {
          const written=await fs.readFile(file);
          if (written.equals(bytes.subarray(0,written.length))) await fs.unlink(file);
        }
      }
      throw error;
    }
    return entries.map(({file}) => vscode.Uri.file(file));
  }

  async function inspect(uri) {
    trusted();
    const report = await readRegistrationTrace(local(uri));
    trusted();
    return report;
  }

  const command = (id, action) => subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try {
      trusted();
      return await action();
    } catch (error) {
      if (!disposed) await vscode.window.showErrorMessage('Rocketbrain Spring: ' + error.message);
    }
  }));

  command('rocketbrain.spring.copyRegistrationTraceHelper', async () => {
    const [directory] = await vscode.window.showOpenDialog({
      title: 'Choose a Java Source Root', canSelectFiles: false, canSelectFolders: true, canSelectMany: false
    }) || [];
    if (!directory) return;
    const copied = await copyHelper(directory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(copied), { preview: true });
    return copied;
  });

  command('rocketbrain.spring.copyBootServletRegistrationTrace',async () => {
    const [directory]=await vscode.window.showOpenDialog({
      title:'Choose a Java Source Root for Boot Servlet Tracing',canSelectFiles:false,canSelectFolders:true,canSelectMany:false
    }) || [];
    if (!directory) return;
    const copied=await copyBootHelpers(directory);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(copied[1]),{preview:true});
    return copied;
  });

  command('rocketbrain.spring.inspectRegistrationTrace', async () => {
    const [trace] = await vscode.window.showOpenDialog({
      title: 'Open a Spring Registration Trace', filters: { 'Spring Registration Trace': ['jsonl'] }, canSelectMany: false
    }) || [];
    if (!trace) return;
    const report = await inspect(trace);
    const entries = report.scopes.flatMap(scope => [{
      label: scope.label + ' · ' + scope.outcome, kind: vscode.QuickPickItemKind.Separator
    }, ...report.mutations.filter(event => event.scope === scope.id).map(event => {
      const frame=event.provider || event.origin;
      return {
        label:event.operation + ' ' + event.name + (event.alias ? ' → ' + event.alias : ''),
        description:event.provider ? 'Callback · ' + frame.type : frame?.type,
        detail:frame?.line > 0 ? frame.file + ':' + frame.line : undefined,origin:frame
      };
    })]);
    if (!report.mutations.length) {
      await vscode.window.showInformationMessage('The selected trace does not contain any recorded registry mutations.');
      return report;
    }
    const selected = await vscode.window.showQuickPick(entries, {
      title: report.truncated || report.pendingLine || report.scopes.some(scope => scope.outcome === 'open') ?
        'Spring Registration Trace (Incomplete)' : 'Spring Registration Trace', matchOnDescription: true
    });
    trusted();
    if (selected?.origin?.file && selected.origin.line > 0) await openJavaFrame(vscode, selected.origin);
    return report;
  });

  const api = { copyHelper, copyBootHelpers, inspect, dispose() {
    if (disposed) return;
    disposed = true;
    for (const subscription of subscriptions) subscription.dispose();
  } };
  context.subscriptions.push(api);
  return api;
}

module.exports = { registerSpringRegistrationTrace };
