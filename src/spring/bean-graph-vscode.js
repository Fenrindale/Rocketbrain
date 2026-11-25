'use strict';

const { beanDependencyGraph,layoutBeanGraph } = require('./bean-graph');
const { beanGraphHtml } = require('./bean-graph-view');

const COMMAND = 'rocketbrain.spring.beanGraph';

function registerBeanGraph(vscode,{analyze,refresh,revision,matchesSource,enabled}) {
  const reports = new WeakMap(), panels = new Set();
  let disposed = false;

  function assertReady() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Trust the workspace to open Spring Bean Dependencies.');
    if (!enabled()) throw Error('Enable Rocketbrain Spring source analysis to open the bean graph.');
  }

  async function capture({refreshModel = false} = {}) {
    assertReady();
    let model = await (refreshModel ? refresh() : analyze());
    for (let attempt=0; attempt<2 && model?.revision !== revision(); attempt++) model = await analyze();
    assertReady();
    if (!model || model.revision !== revision()) throw Error('Spring source analysis is changing. Refresh the graph again.');
    const graph = beanDependencyGraph(model);
    const response = structuredClone(graph);
    reports.set(response,{graph,model,locations:{
      bean:new Map(graph.nodes.filter(item => item.source).map(item => [item.id,item.source])),
      site:new Map(graph.sites.filter(item => item.source).map(item => [item.id,item.source]))
    }});
    return response;
  }

  function reviewed(report) {
    assertReady();
    const record = reports.get(report);
    if (!record) throw Error('Open a captured Spring source graph before exploring it.');
    return record;
  }

  async function reveal(report,{kind,id} = {}) {
    const record = reviewed(report);
    const current = () => {
      assertReady();
      if (record.model.revision !== revision()) throw Error('Spring source changed. Refresh the bean graph first.');
    };
    current();
    const item = (kind === 'bean' || kind === 'site') && record.locations[kind].get(id);
    if (!item) throw Error('Choose a modeled Spring declaration or injection site.');
    const uri = vscode.Uri.parse(item.uri);
    if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri)) {
      throw Error('The selected Spring source is outside the local workspace.');
    }
    const document = await vscode.workspace.openTextDocument(uri);
    current();
    const { start,end } = item.range;
    const selection = new vscode.Range(start.line,start.character,end.line,end.character);
    if (!matchesSource(record.model,item.uri,document.getText()) || !document.validateRange(selection).isEqual(selection)) {
      throw Error('Spring source changed. Refresh the bean graph first.');
    }
    return vscode.window.showTextDocument(document,{selection,preview:true});
  }

  function show(initial) {
    const record = reviewed(initial);
    let report = initial, closing = false, loading = false;
    const panel = vscode.window.createWebviewPanel('rocketbrainSpringBeanDependencies','Spring Bean Dependencies',
      vscode.ViewColumn.Beside,{enableScripts:true,localResourceRoots:[]});
    panel.webview.html = beanGraphHtml(record.graph);
    panels.add(panel);
    const messages = panel.webview.onDidReceiveMessage(async message => {
      if (closing || disposed || !message || !['reveal','refresh'].includes(message.type)) return;
      try {
        if (message.type === 'reveal') {
          await reveal(report,{kind:message.kind,id:message.id});
        } else if (!loading) {
          loading = true;
          try {
            const next = await capture({refreshModel:true});
            if (!closing) { report = next; panel.webview.html = beanGraphHtml(reviewed(report).graph); }
          } finally { loading = false; }
        }
      } catch (error) {
        if (!closing && !disposed) await panel.webview.postMessage({type:'error',message:error.message});
      }
    });
    panel.onDidDispose(() => { closing = true; messages.dispose(); panels.delete(panel); });
    return panel;
  }

  const command = vscode.commands.registerCommand(COMMAND,async () => {
    try { return show(await capture()); }
    catch (error) { if (!disposed) await vscode.window.showErrorMessage(error.message); return null; }
  });
  return {capture,show,reveal,layout:(report,options) => layoutBeanGraph(reviewed(report).graph,options),
    dispose() {
      disposed = true;
      command.dispose();
      for (const panel of panels) panel.dispose();
      panels.clear();
    }
  };
}

module.exports = { registerBeanGraph, COMMAND };
