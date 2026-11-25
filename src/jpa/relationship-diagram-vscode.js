'use strict';

const { randomUUID } = require('node:crypto');
const { observedScopes, sourceScope, chooseScope, buildDiagram, readLayout, layoutFor, editLayout } = require('./relationship-diagram');
const { diagramHtml } = require('./relationship-diagram-view');

const COMMAND = 'rocketbrain.jpa.relationshipDiagram';
const VIEW = 'rocketbrain.jpa.relationshipDiagram';
const TITLE = 'JPA Relationships';
const STORE = 'rocketbrain.jpa.relationshipDiagram.layouts.v1';
const observerKey = data => JSON.stringify([data.state,data.baseUrl,data.fetchedAt,data.processId]);

function registerRelationshipDiagram(vscode, context, { source, revision, getObserver, refreshObserver, onChange }) {
  let panel, frame, serial=Promise.resolve(), request=0, disposed=false;
  const transient = new Map();
  const hasWorkspace = () => Boolean(vscode.workspace.workspaceFile || vscode.workspace.workspaceFolders?.length);
  function trusted() {
    if (disposed || !vscode.workspace.isTrusted) throw Error('Use a trusted workspace to open JPA relationships.');
  }
  const status = (text, stale=false) => void panel?.webview.postMessage({ type:'status', text, stale });
  function close() {
    request++;
    const previous=panel;
    panel=undefined; frame=undefined;
    previous?.dispose();
  }
  function current(token) {
    trusted();
    if (!frame || frame.token!==token || frame.revision!==revision() || (frame.diagram.mode==='observed' && frame.observed!==observerKey(getObserver())))
      throw Error('The mapping changed. Refresh the diagram before using its actions.');
    return frame;
  }
  function publish() {
    if (!frame || !panel) return;
    const { token, diagram, saved }=frame;
    const { nodes, edges, ...rest }=diagram;
    void panel.webview.postMessage({ type:'diagram', token, diagram:{ ...rest,
      nodes:nodes.map(({source,...node})=>({...node,hasSource:!!source})), edges:edges.map(({source,...edge})=>({...edge,hasSource:!!source})) },
      layout:layoutFor(diagram,saved) });
  }
  function maintained(diagram) {
    if (diagram.storage==='session' || !hasWorkspace()) return readLayout(transient.get(diagram.identity));
    return readLayout(context.workspaceState.get(STORE)?.[diagram.identity]);
  }

  async function choose(options, model, scopes) {
    if (options.scope && options.scope!=='auto' && options.scope!=='pick') {
      const selected=[sourceScope,...scopes].find(scope=>scope.key===options.scope);
      if (!selected) throw Error('The selected Hibernate factory is unavailable. Connect to its observer or choose the source scope.');
      return selected;
    }
    const automatic=options.scope==='pick'?null:chooseScope(scopes,model,vscode.window.activeTextEditor?.document.uri.toString());
    if (automatic) return automatic;
    const picked=await vscode.window.showQuickPick([sourceScope,...scopes].map(scope=>({label:scope.label,
      description:scope.factory?scope.key+' · '+scope.entities.length+' managed entities':'Indexed declarations',scope})),
    {title:'Choose a JPA relationship scope',matchOnDescription:true});
    return picked?.scope;
  }
  async function open(options={}) {
    trusted();
    const epoch=++request;
    await serial;
    const model=await source(), sourceRevision=revision(), snapshot=getObserver();
    const scope=await choose(options,model,observedScopes(snapshot));
    if (!scope) return;
    let focus=options.focus;
    if (options.pickFocus) {
      const names=scope.factory?scope.entities:[...new Set(model.entities.map(item=>item.fqn))].sort();
      const item=await vscode.window.showQuickPick([{label:'All entities',name:undefined},...names.map(name=>({label:name,name}))],
        {title:'Show all managed entities or one entity and its immediate relationships'});
      if (!item) return;
      focus=item.name;
    }
    trusted();
    if (epoch!==request || sourceRevision!==revision() || (scope.factory && observerKey(snapshot)!==observerKey(getObserver())))
      throw Error('The source or Hibernate observation changed while opening the diagram. Try again.');
    const diagram=buildDiagram(model,scope,focus);
    frame={ token:randomUUID(), revision:sourceRevision, observed:observerKey(snapshot), diagram, saved:maintained(diagram) };
    if (!panel) {
      const view=vscode.window.createWebviewPanel(VIEW,TITLE,vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[],enableCommandUris:false});
      panel=view;
      const incoming=view.webview.onDidReceiveMessage(message=>{
        if (view!==panel) return;
        void receive(message).catch(error=>status(error.message));
      });
      view.onDidDispose(()=>{
        incoming.dispose();
        if (panel===view) {panel=undefined;close();}
      });
      view.webview.html=diagramHtml();
    } else { panel.reveal(); publish(); }
    return { token:frame.token, diagram:structuredClone(diagram), layout:layoutFor(diagram,frame.saved) };
  }

  function changeLayout(token, action) {
    const task=serial.then(async()=>{
      const target=current(token), diagram=target.diagram;
      const layout=editLayout(diagram,target.saved,action);
      if (diagram.storage==='session' || !hasWorkspace()) {
        if (!transient.has(diagram.identity) && transient.size>=16) transient.delete(transient.keys().next().value);
        transient.set(diagram.identity,layout);
      } else {
        const entries=Object.entries(context.workspaceState.get(STORE)||{}).filter(([id])=>id!==diagram.identity).slice(-15);
        if (Object.keys(layout).length) entries.push([diagram.identity,layout]);
        await context.workspaceState.update(STORE,Object.fromEntries(entries));
      }
      if (frame===target) { target.saved=layout;publish();status(diagram.storage==='session'?'Layout saved for this session':'Layout saved'); }
      return layoutFor(diagram,layout);
    });
    serial=task.catch(()=>{});
    return task;
  }

  async function openSource(token,id) {
    const { diagram }=current(token);
    const target=diagram.nodes.find(node=>node.id===id) || diagram.edges.find(edge=>edge.id===id);
    if (!target?.source) throw Error('There is no matching local declaration for this mapping.');
    const { uri:address,range }=target.source, uri=vscode.Uri.parse(address);
    if (uri.scheme!=='file' || !vscode.workspace.getWorkspaceFolder(uri)) throw Error('The declaration is outside the current workspace.');
    const document=await vscode.workspace.openTextDocument(uri);
    current(token);
    await vscode.window.showTextDocument(document,{selection:new vscode.Range(range.start.line,range.start.character,range.end.line,range.end.character)});
    return { uri:address,range };
  }

  async function receive(message) {
    if (message?.type==='ready') { publish(); return; }
    if (!frame || message?.token!==frame.token) return;
    if (message.type==='rendered') {frame.rendered=true;return;}
    if (message.type==='refresh') {
      const previous=frame, epoch=request;
      if (previous.diagram.mode==='observed') await refreshObserver();
      if (frame!==previous || epoch!==request) return;
      return open({scope:previous.diagram.scope,focus:previous.diagram.focus??undefined});
    }
    if (message.type==='scope') return open({scope:'pick'});
    if (message.type==='focus') return open({scope:frame.diagram.scope,pickFocus:true});
    if (message.type==='openSource') return openSource(message.token,message.id);
    return changeLayout(message.token,message);
  }
  const changes=onChange(()=>{
    if (!frame) return;
    if (!vscode.workspace.isTrusted || (frame.diagram.mode==='observed' && getObserver().state!=='observed')) {close();return;}
    if (frame.revision!==revision() || (frame.diagram.mode==='observed' && frame.observed!==observerKey(getObserver())))
      status('Mappings changed. Refresh the diagram.',true);
  });
  const command=vscode.commands.registerCommand(COMMAND,async options=>{
    try { return await open(options); }
    catch (error) { await vscode.window.showErrorMessage('Rocketbrain JPA: '+error.message); }
  });
  return { open,openSource,changeLayout,close,isRendered:token=>frame?.token===token&&frame.rendered===true,
    dispose(){disposed=true;close();transient.clear();changes.dispose();command.dispose();} };
}

module.exports={ registerRelationshipDiagram,COMMAND,VIEW,TITLE };
