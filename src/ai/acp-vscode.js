'use strict';

const { agentProgram, runAgent } = require('./acp-process');

function registerAcpReview(context,vscode) {
  let active;
  let lastReview;

  async function review({ profiles, folder, text, cancellation, onUpdate, approveProgram } = {}) {
    if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before starting ACP agents.');
    if (approveProgram !== true) throw Error('Review the configured executables before starting ACP agents.');
    if (active) throw Error('Finish the active agent comparison first.');
    const cwd = folder?.scheme === 'file' && vscode.workspace.getWorkspaceFolder(folder)?.uri.fsPath;
    if (!cwd) throw Error('Choose an open local workspace folder.');
    if (!Array.isArray(profiles) || profiles.length < 2 || profiles.length > 3 ||
        new Set(profiles.map(config => config?.label)).size !== profiles.length) {
      throw Error('Choose two or three distinct configured agent profiles.');
    }
    const controller = new AbortController();
    active = controller;
    lastReview = undefined;
    const stop = () => controller.abort();
    const subscription = cancellation?.onCancellationRequested?.(stop);
    cancellation?.addEventListener?.('abort',stop,{ once:true });
    if (cancellation?.isCancellationRequested || cancellation?.aborted) stop();
    try {
      const agents = await Promise.all(profiles.map(agentProgram));
      const outcomes = await Promise.allSettled(agents.map(agent =>
        runAgent(agent,{ cwd,text,signal:controller.signal,onUpdate:bytes=>onUpdate?.(agent.label,bytes) })));
      lastReview = outcomes.map((result,index) => result.status === 'fulfilled'
        ? { ...result.value,state:'complete' }
        : { label:agents[index].label,state:result.reason?.code==='ACP_CANCELLED'?'cancelled':'failed',
          error:result.reason?.message||'The agent session failed.' });
      return structuredClone(lastReview);
    } finally {
      active = undefined;
      subscription?.dispose();
      cancellation?.removeEventListener?.('abort',stop);
    }
  }
  function candidates() {
    if (!lastReview) throw Error('Run a comparison of local ACP agents first.');
    return lastReview.map(result => ({
      label:result.label,description:result.state,detail:result.error||result.stopReason,result
    }));
  }
  async function openResult(result) {
    return vscode.workspace.openTextDocument({ language:'plaintext',
      content:result.output ?? (result.error||result.state) });
  }
  async function showResults() {
    const choices = await vscode.window.showQuickPick(candidates(),{ title:'Review Local Agent Replies',canPickMany:true });
    if (!choices?.length) return;
    const [first,second] = await Promise.all(choices.slice(0,2).map(choice => openResult(choice.result)));
    if (!second) return vscode.window.showTextDocument(first,{ preview:true });
    return vscode.commands.executeCommand('vscode.diff',first.uri,second.uri,
      choices[0].label+' ↔ '+choices[1].label);
  }
  function command(id, handler) {
    return vscode.commands.registerCommand('rocketbrain.acp.'+id,async () => {
      try { return await handler(); }
      catch (error) { vscode.window.showErrorMessage('Rocketbrain ACP: '+error.message); }
    });
  }
  context.subscriptions.push(
    { dispose() { active?.abort();lastReview=undefined; } },
    command('compare',async () => {
      if (!vscode.workspace.isTrusted) throw Error('Trust this workspace before starting ACP agents.');
      const configured = vscode.workspace.getConfiguration('rocketbrain.acp').get('agents',[]);
      const profiles = await Promise.all(configured.slice(0,20).map(agentProgram));
      if (profiles.length<2) throw Error('Configure at least two local agents in rocketbrain.acp.agents.');
      const selected = await vscode.window.showQuickPick(profiles.map(profile=>({label:profile.label,profile})),
        { title:'Compare Two or Three Local ACP Profiles',canPickMany:true });
      if (!selected?.length) return;
      if (selected.length<2 || selected.length>3) throw Error('Choose two or three local agents.');
      const workspace = (vscode.workspace.workspaceFolders||[]).filter(folder=>folder.uri.scheme==='file');
      const choice=workspace.length===1?workspace[0]:await vscode.window.showWorkspaceFolderPick({ placeHolder:'Choose the local ACP working folder' });
      if (!choice?.uri || choice.uri.scheme!=='file') return;
      const text=await vscode.window.showInputBox({title:'Enter the Request to Compare Across Agents',
        validateInput:value=>Buffer.byteLength(value)>16384?'Keep the request within 16 KiB.':undefined });
      if (!text?.trim()) return;
      const approval=await vscode.window.showInformationMessage('Start the selected local ACP executables?',
        { modal:true,detail:[choice.uri.fsPath,...selected.map(item=>item.profile.executable)].join('\n') },'Start Agents');
      if (approval!=='Start Agents') return;
      await vscode.window.withProgress({title:'Waiting for Local ACP Replies',location:vscode.ProgressLocation.Notification,cancellable:true},
        (_progress,cancellation)=>review({ profiles:selected.map(item=>item.profile),folder:choice.uri,text,cancellation,approveProgram:true }));
      return showResults();
    }),
    command('review',showResults)
  );
  return { review, results:() => structuredClone(lastReview||[]) };
}

module.exports = { registerAcpReview };
