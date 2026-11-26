'use strict';

const { createDockerWorkbench } = require('./workbench');

function registerDockerWorkbench(vscode) {
  const workbench = createDockerWorkbench({trusted:()=>vscode.workspace.isTrusted,workspaceRoots:()=>
    (vscode.workspace.workspaceFolders||[]).filter(folder=>folder.uri.scheme==='file'&&!folder.uri.authority).map(folder=>folder.uri.fsPath)});
  const changed = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('Rocketbrain Docker');
  const subscriptions = [changed, output];
  const groups = [{ kind: 'containers', label: 'Containers' }, { kind: 'images', label: 'Images' }, { kind: 'compose', label: 'Compose' }];
  let snapshot, busy = false;

  function containerNode(entry) {
    return { ...entry, kind: 'container', label: entry.name || entry.id.slice(0, 12), description: entry.state };
  }

  const tree = vscode.window.createTreeView('rocketbrain.docker', { treeDataProvider: {
    onDidChangeTreeData: changed.event,
    getChildren(node) {
      if (!snapshot) return [];
      if (!node) return groups;
      if (node.kind === 'containers') return snapshot.containers.map(containerNode);
      if (node.kind === 'images') return snapshot.images.map(item => ({ kind: 'image', label: `${item.repository}:${item.tag}`,
        description: item.size, detail: item.digest || item.id }));
      if (node.kind === 'compose') return (snapshot.compose || []).map(item => ({ ...item, kind: 'project', label: item.name, description: item.status }));
      return [];
    },
    getTreeItem(node) {
      const expandable = groups.includes(node);
      const item = new vscode.TreeItem(node.label, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'rocketbrain.docker.' + node.kind;
      item.description = node.kind === 'compose' && snapshot?.composeError ? 'Unavailable' : node.description;
      item.tooltip = node.detail || node.image || (node.kind === 'compose' ? snapshot?.composeError : undefined);
      if (node.kind === 'container') item.command = { command: 'rocketbrain.docker.logs', title: 'Show Docker Logs', arguments: [node] };
      if (node.kind === 'project') item.command = { command: 'rocketbrain.docker.compose', title: 'Inspect Compose Project', arguments: [node] };
      return item;
    }
  } });
  tree.message = 'Select a Docker context.';
  subscriptions.push(tree);

  async function refresh(signal) {
    snapshot = await workbench.inventory({ signal });
    tree.message = undefined;
    tree.description = snapshot.context.name;
    changed.fire(undefined);
  }

  function register(command, title, handler) {
    subscriptions.push(vscode.commands.registerCommand(command, async argument => {
      if (busy) return;
      busy = true;
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_, token) => {
          const pending = new AbortController();
          const subscription = token.onCancellationRequested(() => pending.abort());
          try { if (!token.isCancellationRequested) await handler(argument, pending.signal); }
          finally { subscription.dispose(); }
        });
      } catch (error) { void vscode.window.showErrorMessage(error.message); }
      finally { busy = false; }
    }));
  }

  async function selectContainer(node) {
    const selected = node?.kind === 'container' && snapshot?.containers.find(item => item.id === node.id);
    if (selected) return containerNode(selected);
    return vscode.window.showQuickPick(snapshot?.containers.map(containerNode) || [], { title: 'Select Docker Container' });
  }

  register('rocketbrain.docker.select', 'Select Docker Context', async (_, signal) => {
    const entries = await workbench.contexts({ signal });
    const name = await vscode.window.showQuickPick(entries.map(item => item.name), { title: 'Select Docker Context' });
    if (!name) return;
    const selected = await workbench.inspectContext(name, { signal });
    const approved = await vscode.window.showInformationMessage(`Connect to Docker context ${name}?`,
      { modal: true, detail: selected.endpoint + (selected.skipTlsVerify ? '\nTLS peer verification is disabled in this context.' : '') }, 'Connect');
    if (approved !== 'Connect') return;
    await workbench.selectContext(selected, { signal });
    snapshot = undefined;
    tree.description = name;
    tree.message = 'Refresh Docker inventory.';
    changed.fire(undefined);
    await refresh(signal);
  });

  register('rocketbrain.docker.refresh', 'Refresh Docker Inventory', (_, signal) => refresh(signal));
  register('rocketbrain.docker.logs', 'Read Docker Logs', async (node, signal) => {
    const choice = await selectContainer(node);
    if (!choice) return;
    const { stdout, stderr } = await workbench.logs(choice.id, { signal });
    output.clear();
    output.appendLine(`${snapshot.context.name} / ${choice.label} / last 200 lines`);
    const visible = text => text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
    if (stdout) output.append(visible(stdout));
    if (stderr) output.append(visible(stderr));
    output.show();
  });

  register('rocketbrain.docker.lifecycle', 'Manage Docker Container', async (node, signal) => {
    const choice = await selectContainer(node);
    if (!choice) return;
    const actions = choice.state === 'running' ? ['stop', 'restart'] : ['created', 'exited'].includes(choice.state) ? ['start'] : [];
    if (!actions.length) throw Error('The current container state does not support a lifecycle action.');
    const action = await vscode.window.showQuickPick(actions, { title: `${choice.label} on ${snapshot.context.name}` });
    if (!action) return;
    const review = await workbench.review(choice.id, action, { signal });
    const approved = await vscode.window.showWarningMessage(`${action} Docker container ${review.name || review.id.slice(0, 12)}?`,
      { modal: true, detail: `${review.context.name} · ${review.context.endpoint}\n${review.id}` }, 'Run Action');
    if (approved !== 'Run Action') return;
    try { await workbench.apply(review.token, { approved: true, signal }); }
    finally {
      snapshot = undefined;
      tree.message = 'Refresh Docker inventory.';
      changed.fire(undefined);
    }
    await refresh(signal);
  });

  register('rocketbrain.docker.compose', 'Inspect Compose Project', async (node, signal) => {
    const choice = node?.kind === 'project' ? node : await vscode.window.showQuickPick(
      (snapshot?.compose || []).map(item => ({ ...item, label: item.name })), { title: 'Select Compose Project' });
    if (!choice) return;
    const containers = await workbench.composeContainers(choice.name, { signal });
    const document = await vscode.workspace.openTextDocument({ language: 'json',
      content: JSON.stringify({ context: snapshot.context.name, project: choice.name, containers }, null, 2) });
    await vscode.window.showTextDocument(document, { preview: false });
  });

  register('rocketbrain.docker.manifest', 'Inspect Registry Manifest', async (_, signal) => {
    if (!snapshot) throw Error('Select a Docker context before inspecting a registry manifest.');
    const reference = await vscode.window.showInputBox({ title: 'Inspect Registry Manifest', placeHolder: 'docker.io/library/alpine:3.22' });
    if (!reference) return;
    const approved = await vscode.window.showInformationMessage('Request the image manifest from this registry?',
      { modal: true, detail: reference }, 'Inspect');
    if (approved !== 'Inspect') return;
    const result = await workbench.manifest(reference, { approved: true, signal });
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(result, null, 2) });
    await vscode.window.showTextDocument(document, { preview: false });
  });

  async function prepareImageReport(review,signal) {
    let result;
    try { result=await workbench.applyImage(review.token,{approved:true,signal}); }
    finally {
      snapshot=undefined;
      tree.message='Refresh Docker inventory.';
      changed.fire(undefined);
    }
    const document=await vscode.workspace.openTextDocument({language:'json',content:JSON.stringify(result,null,2)});
    await vscode.window.showTextDocument(document,{preview:false});
    return result;
  }

  register('rocketbrain.docker.buildImage','Build Docker Image',async (_,signal)=>{
    const [directory]=await vscode.window.showOpenDialog({canSelectFiles:false,canSelectFolders:true,canSelectMany:false,
      openLabel:'Choose Build Context'})||[];
    if(!directory)return;
    if(directory.scheme!=='file'||directory.authority)throw Error('Choose a local Docker build directory.');
    const reference=await vscode.window.showInputBox({title:'Tag Docker Image',placeHolder:'sample/app:dev'});
    if(!reference)return;
    const review=await workbench.reviewImageBuild(directory.fsPath,reference,{signal});
    const detail=[review.context.name+' · '+review.context.endpoint,review.root,review.reference,
      review.files+' files · '+review.bytes+' bytes','sha256:'+review.fingerprint,
      review.before?'Replace existing image tag '+review.before:undefined].filter(Boolean).join('\n');
    const choice=await vscode.window.showWarningMessage('Build the reviewed Docker image?',{modal:true,detail},'Build Image');
    if(choice==='Build Image')return prepareImageReport(review,signal);
  });

  register('rocketbrain.docker.pushImage','Push Docker Image',async (node,signal)=>{
    const reference=node?.kind==='image' ? node.label : await vscode.window.showInputBox({title:'Push Docker Image',
      placeHolder:'registry.example.com/sample/app:dev'});
    if(!reference)return;
    const review=await workbench.reviewImagePush(reference,{signal});
    const detail=[review.context.name+' · '+review.context.endpoint,review.reference,review.before].join('\n');
    const choice=await vscode.window.showWarningMessage('Push this exact image to the named registry?',{modal:true,detail},'Push Image');
    if(choice==='Push Image')return prepareImageReport(review,signal);
  });

  return { ...workbench, dispose() { workbench.dispose(); subscriptions.forEach(item => item.dispose()); } };
}

module.exports = { registerDockerWorkbench };
