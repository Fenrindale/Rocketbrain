'use strict';

const { inspectReactProps } = require('./react-tools');
const { createHash } = require('node:crypto');

const namespace='rocketbrain.react';
const selector={language:'typescriptreact',scheme:'file'};

function registerReactWorkbench(context,vscode) {
  const diagnostics=vscode.languages.createDiagnosticCollection('rocketbrain-react');
  let epoch=0;
  const active=new Set();

  async function inspect({document,position,action},token) {
    const folder=document && vscode.workspace.getWorkspaceFolder(document.uri);
    if (!vscode.workspace.isTrusted || document?.uri.scheme!=='file' || !folder || folder.uri.scheme!=='file' ||
        document.languageId!=='typescriptreact' || token?.isCancellationRequested || active.size>=4) return;
    const settings=vscode.workspace.getConfiguration(namespace,document.uri);
    const version=document.version, started=epoch;
    const control=new AbortController();
    const subscribed=token?.onCancellationRequested(()=>control.abort());
    active.add(control);
    try {
      const result=await inspectReactProps({workspace:folder.uri.fsPath,file:document.uri.fsPath,
        source:document.getText(),offset:position ? document.offsetAt(position) : 0,
        action,nodePath:settings.get('nodePath'),signal:control.signal});
      if (document.version===version && started===epoch && vscode.workspace.isTrusted && !control.signal.aborted) return result;
    } finally {
      active.delete(control);
      subscribed?.dispose();
    }
  }

  function automatic(document) {
    return vscode.workspace.getConfiguration(namespace,document.uri).get('enableProps',false);
  }

  async function locations(document,position,action,token,includeDeclaration=true) {
    if (!automatic(document)) return [];
    const started=epoch;
    const result=await inspect({document,position,action},token).catch(()=>undefined);
    if (!result?.locations?.length) return [];
    const visible=result.locations.filter(location=>includeDeclaration||!location.definition);
    const items=await Promise.all(visible.map(async location=>{
      const target=await vscode.workspace.openTextDocument(vscode.Uri.file(location.file)).then(value=>value,()=>undefined);
      if (!target || !vscode.workspace.getWorkspaceFolder(target.uri)) return;
      const source=target.getText();
      if (location.start<0 || location.end>source.length || createHash('sha256').update(source).digest('hex')!==location.sha256) return;
      return new vscode.Location(target.uri,new vscode.Range(target.positionAt(location.start),target.positionAt(location.end)));
    }));
    return started===epoch && !token?.isCancellationRequested ? items.filter(Boolean) : [];
  }

  context.subscriptions.push(diagnostics,
    vscode.workspace.onDidChangeTextDocument(({document})=>{
      if (document.uri.scheme==='file' && /\.(?:tsx?|json)$/u.test(document.uri.fsPath)) {
        epoch++;
        diagnostics.clear();
      }
    }),
    {dispose(){for (const worker of active) worker.abort();}},
    vscode.languages.registerCompletionItemProvider(selector,{
      async provideCompletionItems(document,position,token) {
        if (!automatic(document)) return [];
        const result=await inspect({document,position,action:'complete'},token).catch(()=>undefined);
        return (result?.props||[]).map(prop=>{
          const item=new vscode.CompletionItem(prop.name,vscode.CompletionItemKind.Property);
          item.detail=result.component+(prop.optional?' optional':'')+' · '+prop.type;
          return item;
        });
      }
    }),
    vscode.languages.registerDefinitionProvider(selector,{
      provideDefinition:(document,position,token)=>locations(document,position,'definition',token)
    }),
    vscode.languages.registerReferenceProvider(selector,{
      provideReferences:(document,position,options,token)=>locations(document,position,'references',token,options.includeDeclaration)
    }),
    vscode.commands.registerCommand('rocketbrain.react.checkProps',async()=>{
      const document=vscode.window.activeTextEditor?.document;
      if (!document) return;
      try {
        const result=await inspect({document,action:'check'});
        if (!result) throw Error('Open a TSX file in a trusted React project with local TypeScript and a JSX tsconfig.');
        const count=result.diagnostics.length;
        diagnostics.set(document.uri,result.diagnostics.map(item=>{
          const finding=new vscode.Diagnostic(new vscode.Range(document.positionAt(item.start),document.positionAt(item.end)),
            item.message,vscode.DiagnosticSeverity.Error);
          finding.source='Rocketbrain React';
          finding.code='TS'+item.code;
          return finding;
        }));
        void vscode.window.showInformationMessage(count+' React prop diagnostics.');
        return result;
      } catch(error) {
        void vscode.window.showErrorMessage(error.message);
      }
    })
  );
  return {inspect};
}

module.exports={registerReactWorkbench};
