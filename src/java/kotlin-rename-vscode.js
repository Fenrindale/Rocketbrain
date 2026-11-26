'use strict';

const path = require('node:path');
const {inside,fail} = require('./workbench-model');
const {kotlinProtocolUri} = require('./kotlin-editor-runtime');
const {inventory,reconcileRename,referenceParameters,verifyName,sourceKey,canonicalText} = require('./kotlin-rename');
const {classCandidate,reviewContracts,kotlinTypeReferences,reviewedClasspath,mixedTypeEdits} = require('./kotlin-mixed-type-rename');

function registerKotlinRename(vscode,{begin,refactoring,output}) {
  function assertBuffers(root,sources) {
    for (const document of vscode.workspace.textDocuments) {
      if (document.isClosed || document.uri.scheme !== 'file' || !inside(root,document.uri.fsPath)) continue;
      const source = sources.get(sourceKey(document.uri.toString()));
      if (source && (document.isDirty || canonicalText(document.getText()) !== canonicalText(source.text))) {
        throw fail('Save the Kotlin project source buffers before reviewing a symbol rename.');
      }
    }
  }

  async function prepare({document,position,newName,cancellation} = {}) {
    verifyName(newName);
    if (!document || document.isClosed || document.isDirty || document.languageId !== 'kotlin') {
      throw fail('Open a saved Kotlin source before reviewing a symbol rename.');
    }
    const before = document.getText(), version = document.version;
    const session = await begin(document,cancellation);
    const at = document.validatePosition(position || new vscode.Position(0,0));
    const uri = kotlinProtocolUri(document.uri.fsPath), mainSources = inventory(session.root);
    const mixedClass = classCandidate(mainSources,uri,at,session.root);
    const sources = mixedClass ? inventory(session.root,{resources:true}) : mainSources;
    const anchor = sources.get(sourceKey(uri));
    if (!anchor || canonicalText(anchor.text) !== canonicalText(before) || anchor.sha!==mainSources.get(sourceKey(uri))?.sha) {
      throw fail('Choose a saved source in the selected Kotlin Gradle project.');
    }
    const params = {textDocument:{uri},position:{line:at.line,character:at.character}};
    const check = () => {
      session.check();
      if (document.isClosed || document.isDirty || document.version !== version || document.getText() !== before) {
        throw fail('The selected Kotlin text buffer changed. Preview the rename again.');
      }
      const live = inventory(session.root,{resources:Boolean(mixedClass)});
      if (live.size !== sources.size || [...sources].some(([id,source])=>source.sha!==live.get(id)?.sha)) {
        throw fail('The Kotlin Gradle project source or membership changed. Preview the rename again.');
      }
      assertBuffers(session.root,sources);
    };
    check();
    if(mixedClass)reviewContracts(session.root,sources,mixedClass,newName);
    const prepared = await session.request('textDocument/prepareRename',params,cancellation);
    if (!prepared) throw fail('The Kotlin compiler could not prepare a rename for this selection.');
    const definitions = await session.request('textDocument/definition',params,cancellation);
    const declarationSearch = referenceParameters(params,definitions,sources);
    let references = await session.request('textDocument/references',declarationSearch,cancellation);
    if(mixedClass)references=await kotlinTypeReferences({root:session.root,sources,selection:mixedClass,
      references,request:session.request,cancellation});
    const edit = await session.request('textDocument/rename',{...params,newName},cancellation);
    check();
    const evidence={files:sources,uri,position:params.position,prepared,definitions,references,edit,newName,mixedClass};
    let reviewed;
    try { reviewed=reconcileRename(evidence); }
    catch(error) {
      if(mixedClass||!error.referenceDisagreement || declarationSearch.textDocument.uri===uri &&
        declarationSearch.position.line===params.position.line && declarationSearch.position.character===params.position.character) throw error;
      // After an editor refresh the provider's declaration lookup can lag the
      // selection lookup. Every edit still has to match independently found spans.
      const selection = await session.request('textDocument/references',{...params,context:{includeDeclaration:true}},cancellation);
      check();
      if(!Array.isArray(selection)) throw error;
      reviewed=reconcileRename({...evidence,references:[...references,...selection]});
    }
    let mixed, classpath;
    if(mixedClass){
      classpath=reviewedClasspath(session.root,await session.classpath(cancellation));
      mixed=await mixedTypeEdits({root:session.root,sources,selection:mixedClass,newName,kotlin:reviewed,
        compiler:session.compiler,classpath,cancellation,check});
    }
    const changes = mixed ? Object.fromEntries([...mixed.changes].map(([file,edits])=>[vscode.Uri.file(file).toString(),edits]))
      : Object.fromEntries([...reviewed.changed.values()].map(({file,edits})=>[vscode.Uri.file(file.file).toString(),edits]));
    const preApply=()=>{check();mixed?.validateRuntime();};
    const validate=mixed ? async token=>{
      const fresh=reviewedClasspath(session.root,await session.classpath(token||cancellation));
      if(JSON.stringify(fresh)!==JSON.stringify(classpath))throw fail('The mixed JVM compile classpath changed. Preview the rename again.');
      preApply();
    } : check;
    const plan = await refactoring.previewWorkspaceEdit({changes},{
      title:'Rename Kotlin '+(mixed?'JVM class ':'symbol ')+reviewed.oldName+' to '+newName,
      kind:mixed?'refactor.rename.kotlin.mixed.type':'refactor.rename.kotlin',
      anchorDocument:document,cancellation,validate,preApply,
      warnings:mixed?['Verified main Java and Kotlin source callers in this Gradle project. Reflection and external compiled callers require a separate review.']:
        reviewed.scope==='kotlin-project' ? ['Reviewed references cover the selected local Gradle project. External compiled callers and reflection require separate review.'] : []
    });
    return {...plan,rename:{oldName:reviewed.oldName,newName,scope:reviewed.scope,referenceCount:reviewed.referenceCount,
      declaration:vscode.Uri.file(reviewed.declaration.file.file).toString(),
      ...(mixed?{javaReferences:mixed.javaReferences,sourceFiles:mixed.sourceFiles,kotlinAndJavacVerified:true}:{})}};
  }

  const command = vscode.commands.registerCommand('rocketbrain.kotlinEditor.previewRename',async()=>{
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'kotlin') return;
    const {document,selection} = editor;
    const newName = await vscode.window.showInputBox({title:'Review Kotlin Symbol Rename',prompt:'Enter the new Kotlin identifier',
      validateInput:value=>{try{verifyName(value);return undefined;}catch(error){return error.message;}}});
    if (newName === undefined) return;
    try {
      const plan = await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Check Kotlin Symbol Rename',
        cancellable:true},(_progress,cancellation)=>prepare({document,position:selection.active,newName,cancellation}));
      return await refactoring.review(plan);
    } catch (error) {
      output.appendLine(error.message);
      void vscode.window.showErrorMessage('Rocketbrain Kotlin: '+error.message);
    }
  });
  return {prepare,dispose:()=>command.dispose()};
}

module.exports = {registerKotlinRename};
