'use strict';

const { analyzeOpenApi,requestTemplate } = require('./openapi');

function registerOpenApiTools(context,vscode) {
  const collection=vscode.languages.createDiagnosticCollection('rocketbrain-openapi');
  let disposed=false;
  function analyze(document) {
    if (disposed||!document||document.isClosed||!['json','jsonc'].includes(document.languageId)) {
      throw Error('Open an OpenAPI JSON document.');
    }
    const source=document.getText();
    let report;
    try { report=analyzeOpenApi(source); }
    catch (error) {
      collection.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,1),error.message,vscode.DiagnosticSeverity.Error)]);
      throw error;
    }
    collection.set(document.uri,report.diagnostics.slice(0,300).map(issue=>{
      const spelling=JSON.stringify(issue.path), offset=source.indexOf(spelling);
      const start=Math.max(0,offset),end=Math.min(source.length,start+Math.max(1,spelling.length));
      const diagnostic=new vscode.Diagnostic(new vscode.Range(document.positionAt(start),document.positionAt(end)),
        issue.message,vscode.DiagnosticSeverity.Error);
      diagnostic.source='Rocketbrain OpenAPI';
      return diagnostic;
    }));
    return report;
  }
  function createRequest(document,key) {
    const operation=analyze(document).operations.find(item=>item.key===key);
    if (!operation) throw Error('Choose an observed OpenAPI operation.');
    return requestTemplate(operation);
  }
  async function choose() {
    const document=vscode.window.activeTextEditor?.document;
    const report=analyze(document),version=document.version;
    const options=report.operations.map(operation=>({
      label:operation.key, description:operation.id||undefined, detail:operation.summary||undefined,operation
    }));
    const selection=await vscode.window.showQuickPick(options,{title:report.title+' · OpenAPI Operations',matchOnDescription:true,matchOnDetail:true});
    if (!selection) return;
    if (document.isClosed||document.version!==version) throw Error('The OpenAPI document changed. Reopen its operation list.');
    return {document,operation:selection.operation};
  }
  async function preview() {
    const selected=await choose();
    if (!selected)return;
    const {operation}=selected;
    const details=[
      operation.key,
      ...(operation.summary?['',operation.summary]:[]),
      '',
      'Declared responses  '+operation.statuses.join(', '),
      'Security requirement  '+(operation.security?'declared':'none observed'),
      ...operation.servers.map(server=>'Server  '+server),
      '',
      ...operation.parameters.map(item=>[item.in,item.name,item.type,item.required?'required':'optional'].join('  '))
    ].join('\n');
    const document=await vscode.workspace.openTextDocument({language:'plaintext',content:details+'\n'});
    await vscode.window.showTextDocument(document,{preview:true});
    return operation;
  }
  async function create() {
    const selected=await choose();
    if (!selected)return;
    const content=createRequest(selected.document,selected.operation.key);
    const document=await vscode.workspace.openTextDocument({language:'rocketbrain-http',content});
    await vscode.window.showTextDocument(document,{preview:false});
    return document;
  }
  const register=(id,action)=>vscode.commands.registerCommand(id,async()=>{
    try { return await action(); }
    catch (error) { if(!disposed)await vscode.window.showErrorMessage('Rocketbrain OpenAPI: '+error.message); }
  });
  const subscriptions=[
    register('rocketbrain.openapi.inspect',preview),
    register('rocketbrain.openapi.createRequest',create),
    vscode.workspace.onDidCloseTextDocument(document=>collection.delete(document.uri)),
    vscode.workspace.onDidChangeTextDocument(event=>collection.delete(event.document.uri))
  ];
  return {analyze,createRequest,dispose(){
    if(disposed)return;
    disposed=true;
    for(const subscription of subscriptions)subscription.dispose();
    collection.dispose();
  }};
}

module.exports={registerOpenApiTools};
