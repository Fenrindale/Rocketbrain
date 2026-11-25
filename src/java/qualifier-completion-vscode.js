'use strict';

const path = require('node:path');
const { qualifierHole,qualifierDraft,qualifierCandidates,insertion } = require('../spring/qualifier-completion');

function registerQualifierCompletion(vscode,{java,projects,findProject,classSources,compile,assertUnchangedSourceSnapshots,managed}) {
  const pending=new Map();
  let disposed=false;

  async function suggest(document,position,cancellation) {
    if (disposed||cancellation?.isCancellationRequested||!vscode.workspace.isTrusted||document.languageId!=='java'||
        document.isClosed||document.uri.scheme!=='file'||!vscode.workspace.getWorkspaceFolder(document.uri)||
        java.getState().state!=='running'||!vscode.workspace.getConfiguration('rocketbrain.spring').get('enabled',true)) return [];
    const {version,uri}=document, text=document.getText();
    const hole=qualifierHole(text,document.offsetAt(position));
    if (!hole) return [];
    const uriId=uri.toString(), previous=pending.get(uriId);
    if (previous) previous.cancel();
    if (!previous&&pending.size>=4) return [];
    const token=new vscode.CancellationTokenSource();
    const cancelled=cancellation?.onCancellationRequested(()=>token.cancel());
    pending.set(uriId,token);
    try {
      const state=await projects(token.token), project=findProject(state.projects,uri);
      const input=await java.spring.qualifierInputs(project.uri);
      if (!input||token.token.isCancellationRequested||document.version!==version) return [];
      const sources=await classSources(project,token.token,uri);
      const anchor=sources.find(source=>!path.relative(vscode.Uri.parse(source.uri).fsPath,uri.fsPath));
      if (!anchor) return [];
      const draft=qualifierDraft(text,hole), repaired=sources.map(source=>source===anchor?{...source,text:draft.text}:source);
      const report=await compile(state,project,repaired,{kind:'springQualifier',uri:anchor.uri,start:draft.start,end:draft.end},
        token.token,{draftUri:uri});
      const runtime=vscode.workspace.workspaceFolders.length===1?java.spring.runtime.snapshot():null;
      const suggestions=qualifierCandidates({ ...input,sources:repaired,uri:anchor.uri,text:draft.text,
        attributed:report.springQualifier,hole,runtime });
      const current=java.getState();
      if (disposed||token.token.isCancellationRequested||document.isClosed||document.version!==version||!input.valid()||
          current.state!=='running'||current.runtimeIdentity!==state.runtimeIdentity) return [];
      assertUnchangedSourceSnapshots(sources,uri);
      report.validateClasspath();
      return suggestions.map((suggestion,index)=>{
        const item = new vscode.CompletionItem(suggestion.value,vscode.CompletionItemKind.Value);
        item.insertText=insertion(hole,suggestion.value);
        item.range=new vscode.Range(document.positionAt(hole.start),document.positionAt(hole.end));
        item.sortText='0'+String(index).padStart(3,'0');
        item.detail='Rocketbrain Spring · '+suggestion.selector+' · '+suggestion.type;
        const environment=suggestion.profiles.join(', ')||'default';
        item.documentation=(suggestion.evidence==='declared'?'Declared candidate for profiles ':'Observed candidate for profiles ')+environment+
          (suggestion.observed?' · name and type observed in the connected runtime.':'')+'\n'+
          vscode.workspace.asRelativePath(vscode.Uri.parse(suggestion.uri));
        return item;
      });
    } catch {
      // Incomplete enclosing code and transient build inputs may leave other providers available.
      return [];
    } finally {
      if (pending.get(uriId)===token) pending.delete(uriId);
      cancelled?.dispose();
      token.dispose();
    }
  }

  const provider=vscode.languages.registerCompletionItemProvider({scheme:'file',language:'java'},{
    provideCompletionItems:(document,position,cancellation)=>managed(()=>suggest(document,position,cancellation))
  },'"');
  return { dispose() {
    disposed=true;provider.dispose();
    for (const token of pending.values()) token.cancel();
  } };
}

module.exports = { registerQualifierCompletion };
