'use strict';

const path = require('node:path');
const { KIND,constantPlacement,validateConstantName,constantChange,confirmConstant } = require('./extract-constant');
const { rangeAt } = require('../spring/java');

function createConstantExtraction(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const inspections = new WeakMap();
  const normalize = text => text.replace(/\r\n/g,'\n');

  async function inspect({document,range,cancellation} = {}) {
    assertReady(cancellation);
    if (!document || document.languageId !== 'java' || document.isClosed || document.isDirty || !range?.start || !range?.end) {
      throw Error('Select one expression in a saved Java source.');
    }
    const version = document.version, text = document.getText(), current = await snapshot(document.uri,cancellation);
    if (normalize(current.text) !== normalize(text)) throw Error('Open the exact saved Java source before extracting a constant.');
    const validated = document.validateRange(range);
    const from = document.offsetAt(validated.start), to = document.offsetAt(validated.end);
    const raw = text.slice(from,to), expression = raw.trim();
    if (!expression || expression.length > 4096) throw Error('Select a complete Java expression within 4096 characters.');
    const start = from + raw.indexOf(expression), end = start + expression.length;
    const selection = { start,end };
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    const saved = await classSources(project,cancellation);
    if (!saved.some(item => item.uri === current.uri && item.sha === current.sha)) {
      throw Error('Select a Java expression in an imported production source root.');
    }
    const sources = saved.map(source => source.uri === current.uri ? {...source,text} : source);
    const baseline = await compile(state,project,sources,{kind:'constant',uri:current.uri,...selection},cancellation);
    if (baseline.constant?.error) throw Error(baseline.constant.error);
    const proof = baseline.constant;
    if (!proof || !Array.isArray(proof.occupiedNames) || !Array.isArray(proof.bindings)) throw Error('Javac did not resolve the selected Java expression.');

    function checkAnchor() {
      const active = java.getState();
      if (document.isClosed || document.isDirty || document.version !== version || document.getText() !== text ||
          active.state !== 'running' || active.runtimeIdentity !== state.runtimeIdentity) {
        throw Error('The selected Java source or runtime changed. Inspect the constant again.');
      }
    }
    checkAnchor();
    const response = await java.constantRefactoring({textDocument:{uri:current.uri},range:rangeAt(text,start,end),context:{diagnostics:[]}},cancellation);
    assertReady(cancellation);
    checkAnchor();
    baseline.validateClasspath();
    const placement = constantPlacement(response,{text,selection,version,type:proof.type,belongsToSource:value => {
      if (typeof value !== 'string') return false;
      const uri = vscode.Uri.parse(value);
      return uri.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment && !path.relative(document.uri.fsPath,uri.fsPath);
    }});
    if (placement.insertionOffset <= proof.classStart) throw Error('JDT proposed a declaration outside the selected Java class.');
    const report = Object.freeze({ type:proof.type,owner:proof.owner,suggestedName:placement.suggestedName });
    inspections.set(report,{ document,version,text,current,state,project,saved,sources,selection,baseline,proof,placement,checkAnchor });
    return report;
  }

  async function prepare(report,{name = report?.suggestedName,cancellation} = {}) {
    assertReady(cancellation);
    const record = inspections.get(report);
    if (!record) throw Error('Inspect the Java expression before reviewing a constant extraction.');
    const { document,version,text,current,state,project,saved,sources,selection,baseline,proof,placement,checkAnchor } = record;
    const originals = new Map(saved.map(source => [source.uri,source.sha]));
    async function checkSources(token) {
      assertReady(token);
      checkAnchor();
      const live = await classSources(project,token);
      if (live.length !== originals.size || live.some(item => item.sha !== originals.get(item.uri))) {
        throw Error('Java source content or membership changed after constant analysis.');
      }
      baseline.validateClasspath();
    }
    const change = constantChange({text,selection,placement,proof,name});
    await checkSources(cancellation);
    const inspection = {kind:'constant',uri:current.uri,name,start:change.checkedStart,end:change.checkedEnd};
    const verified = await compile(state,project,sources.map(item => item.uri === current.uri ? {...item,text:change.after} : item),inspection,cancellation,{
      errorTitle:'The constant extraction would fail Java compiler analysis: '
    });
    if (verified.classpathFingerprint !== baseline.classpathFingerprint) throw Error('Java classpath changed after constant analysis.');
    confirmConstant(proof,verified.constant,placement,change);
    const plan = await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:current.uri,version},edits:change.edits
    }]},{title:'Extract Java Constant · '+name,kind:KIND,anchorDocument:document,cancellation,
      validate:async token => {
        await checkSources(token);
        const live = await classpaths(project,token);
        if (live.length !== verified.classpathEntries.length || live.some((entry,index) => entry !== verified.classpathEntries[index])) {
          throw Error('Java classpath changed after constant extraction review.');
        }
        verified.validateClasspath();
      },
      preApply:() => { checkAnchor(); verified.validateClasspath(); assertUnchangedSourceSnapshots(saved); }
    });
    return { ...plan,constant:{name,owner:proof.owner,type:proof.type,checkedBindings:proof.bindings.length,selectedOccurrences:1} };
  }

  async function run(anchor) {
    const editor = vscode.window.activeTextEditor;
    const uri = anchor && vscode.Uri.parse(anchor.uri);
    if (uri && (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !vscode.workspace.getWorkspaceFolder(uri))) {
      throw Error('Select an open local Java workspace source.');
    }
    const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
    const range = anchor ? new vscode.Range(anchor.range.start.line,anchor.range.start.character,anchor.range.end.line,anchor.range.end.character) : editor?.selection;
    if (anchor && document?.version !== anchor.version) throw Error('The source changed after listing Java code actions. Select the expression again.');
    const report = await operation('Inspect Java Constant Selection',cancellation => inspect({
      document,range,cancellation
    }));
    const record = inspections.get(report);
    const name = await vscode.window.showInputBox({title:'Extract Java Constant',prompt:`Name the ${report.type} constant in ${report.owner}.`,
      value:report.suggestedName,validateInput:value => validateConstantName(value,record.proof.occupiedNames)});
    if (name === undefined) return;
    const plan = await operation('Verify Java Constant Extraction',cancellation => prepare(report,{name,cancellation}));
    return java.refactoring.review(plan);
  }

  return {inspect,prepare,run};
}

module.exports = { createConstantExtraction };
