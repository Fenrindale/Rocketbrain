'use strict';

const path = require('node:path');
const { ACTIONS,conversionAt,reviewConversionEdit,verifyConversion } = require('./java-conversion');

function createJavaConversion(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  async function prepare({document,position,cancellation} = {}) {
    assertReady(cancellation);
    if (!document || document.languageId !== 'java' || document.isClosed || document.isDirty) {
      throw Error('Open a saved Java source before reviewing a conversion.');
    }
    const version = document.version, current = await snapshot(document.uri,cancellation);
    if (document.getText() !== current.text) throw Error('Open the exact saved UTF-8 Java source before conversion.');
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    const sources = await classSources(project,cancellation);
    if (!sources.some(item => item.uri === current.uri && item.sha === current.sha)) {
      throw Error('Choose a saved Java source in the imported production roots.');
    }
    const inspection = {kind:'conversion',uri:current.uri};
    const proof = await compile(state,project,sources,inspection,cancellation);
    const offset = document.offsetAt(document.validatePosition(position || new vscode.Position(0,0)));
    const site = conversionAt(proof.conversions,offset);
    const byUri = new Map(sources.map(item => [item.uri,item.sha]));

    function checkAnchor() {
      const active = java.getState();
      if (document.isClosed || document.isDirty || document.version !== version || document.getText() !== current.text ||
          active.state !== 'running' || active.runtimeIdentity !== state.runtimeIdentity) {
        throw Error('The selected Java source or runtime changed. Review the conversion again.');
      }
    }

    async function checkSources(token) {
      checkAnchor();
      const live = await classSources(project,token);
      if (live.length !== byUri.size || live.some(item => item.sha !== byUri.get(item.uri))) {
        throw Error('Java source content or membership changed after conversion analysis.');
      }
      proof.validateClasspath();
    }

    checkAnchor();
    const actionPosition = document.positionAt(site.actionOffset);
    const action = await java.refactoring.resolveAction(document,new vscode.Range(actionPosition,actionPosition),{
      title:ACTIONS[site.kind].title,kind:'refactor',only:['refactor'],cancellation
    });
    const reviewed = reviewConversionEdit(action,{
      text:current.text,site,version,
      belongsToSource:value => {
        if (typeof value !== 'string') return false;
        const uri = vscode.Uri.parse(value);
        return uri.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment &&
          !path.relative(document.uri.fsPath,uri.fsPath);
      }
    });
    await checkSources(cancellation);
    const proposed = await compile(state,project,sources.map(item =>
      item.uri === current.uri ? {...item,text:reviewed.text} : item),inspection,cancellation,{
      errorTitle:'The Java conversion would fail compiler analysis: '
    });
    if (proposed.classpathFingerprint !== proof.classpathFingerprint) {
      throw Error('Java classpath changed after conversion analysis.');
    }
    const conversion = verifyConversion(site,proposed.conversions,reviewed.replacement.newText.length);
    const validate = async token => {
      await checkSources(token);
      const live = await classpaths(project,token);
      if (live.length !== proposed.classpathEntries.length || live.some((entry,index) => entry !== proposed.classpathEntries[index])) {
        throw Error('The Java classpath changed after conversion review.');
      }
      proposed.validateClasspath();
    };
    const plan = await java.refactoring.previewWorkspaceEdit({changes:{[current.uri]:[reviewed.replacement]}},{
      title:action.title,kind:'refactor.rewrite',anchorDocument:document,cancellation,validate,
      preApply:() => { checkAnchor(); proposed.validateClasspath(); assertUnchangedSourceSnapshots(sources); }
    });
    return {...plan,conversion};
  }

  async function run() {
    const editor = vscode.window.activeTextEditor;
    const plan = await operation('Check Java Conversion',cancellation => prepare({
      document:editor?.document,position:editor?.selection.active,cancellation
    }));
    return java.refactoring.review(plan);
  }

  return {prepare,run};
}

module.exports = { createJavaConversion };
