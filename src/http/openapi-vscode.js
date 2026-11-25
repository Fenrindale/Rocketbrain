'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {isDeepStrictEqual}=require('node:util');
const { analyzeOpenApi,requestTemplate } = require('./openapi');

const fileLimit=1024*1024;
const formatFor=file=>/\.ya?ml$/i.test(file)?'yaml':/\.json$/i.test(file)?'json':undefined;

function inside(root,file) {
  const relative=path.relative(root,file);
  return relative&&!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
}

function workspaceReferences(vscode,document,format) {
  if (document.uri.scheme!=='file'||!vscode.workspace.isTrusted) return {};
  const folder=vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder?.uri.scheme!=='file') return {};
  let root,entry;
  try {
    root=fs.realpathSync(folder.uri.fsPath);
    entry=fs.realpathSync(document.uri.fsPath);
  } catch { return {}; }
  if (!inside(root,entry)) return {};
  const sources=new Map([[entry,{id:entry,text:document.getText(),format}]]);
  return {sourceId:entry,loadReference(reference,source) {
    let relative;
    try { relative=decodeURIComponent(reference); }
    catch { throw Error('Use a valid relative OpenAPI file path.'); }
    if (!relative||relative.startsWith('/')||/[\\:\x00-\x1f\x7f?#]/.test(relative)||!formatFor(relative)) {
      throw Error('Use a relative JSON or YAML reference inside the same trusted workspace.');
    }
    let file;
    try { file=fs.realpathSync(path.resolve(path.dirname(source),relative)); }
    catch { throw Error('The referenced OpenAPI file is missing.'); }
    if (!inside(root,file)) throw Error('Use a relative JSON or YAML reference inside the same trusted workspace.');
    if (sources.has(file)) return sources.get(file);
    if (vscode.workspace.textDocuments.some(open=>open.isDirty&&open.uri.scheme==='file'&&
      path.relative(open.uri.fsPath,file)==='')) throw Error('Save the referenced OpenAPI file before previewing it.');
    if (!formatFor(file)) throw Error('Use a JSON or YAML reference file.');
    let descriptor;
    try {
      descriptor=fs.openSync(file,'r');
      const before=fs.fstatSync(descriptor);
      if (!before.isFile()||before.size>fileLimit) throw Error();
      const bytes=Buffer.alloc(before.size+1);
      const size=fs.readSync(descriptor,bytes,0,bytes.length,0);
      const after=fs.fstatSync(descriptor);
      if (size!==before.size||before.mtimeMs!==after.mtimeMs||before.size!==after.size) throw Error();
      const loaded={id:file,text:new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,size)),format:formatFor(file)};
      sources.set(file,loaded);
      return loaded;
    } catch { throw Error('Open a stable UTF-8 JSON or YAML reference file up to 1 MiB.'); }
    finally { if (descriptor!==undefined) fs.closeSync(descriptor); }
  }};
}

function registerOpenApiTools(context,vscode) {
  const collection=vscode.languages.createDiagnosticCollection('rocketbrain-openapi');
  let disposed=false;
  function analyze(document) {
    if (disposed||!document||document.isClosed||!['json','jsonc','yaml','yml'].includes(document.languageId)) {
      throw Error('Open an OpenAPI JSON or YAML document.');
    }
    const source=document.getText();
    const format=['yaml','yml'].includes(document.languageId)?'yaml':'json';
    let report;
    try { report=analyzeOpenApi(source,{format,...workspaceReferences(vscode,document,format)}); }
    catch (error) {
      collection.set(document.uri,[new vscode.Diagnostic(new vscode.Range(0,0,0,1),error.message,vscode.DiagnosticSeverity.Error)]);
      throw error;
    }
    collection.set(document.uri,report.diagnostics.slice(0,300).map(issue=>{
      const spelling=JSON.stringify(issue.path), offset=source.indexOf(spelling);
      const start=issue.range?.start??Math.max(0,offset);
      const end=issue.range?.end??Math.min(source.length,start+Math.max(1,spelling.length));
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
    const operation=analyze(document).operations.find(item=>item.key===selection.operation.key);
    if (!isDeepStrictEqual(operation,selection.operation)) throw Error('A referenced OpenAPI operation changed. Reopen its operation list.');
    return operation;
  }
  async function preview() {
    const operation=await choose();
    if (!operation)return;
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
    const operation=await choose();
    if (!operation)return;
    const content=requestTemplate(operation);
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
