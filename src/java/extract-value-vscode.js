'use strict';

const path = require('node:path');
const { ACTIONS,selectedExtraction } = require('./extraction-actions');
const { linkedExtraction } = require('./extract-constant');
const { NamedSelectionError,alignDraftLineEndings,reviewDraft,validateName,namedDraft,verifyNamedDraft,singleEdit } = require('./extract-value');
const { rangeAt } = require('../spring/java');

function createValueExtraction(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const inspections = new WeakMap();
  const normalize = text => text.replace(/\r\n/g,'\n');

  async function inspect({kind,document,range,cancellation} = {}) {
    assertReady(cancellation);
    if (!['local','field'].includes(kind) || !document || document.languageId !== 'java' ||
        document.isClosed || document.isDirty || !range?.start || !range?.end) {
      throw Error('Select a whole return expression or local initializer in a saved Java source.');
    }
    const version = document.version, text = document.getText(), current = await snapshot(document.uri,cancellation);
    if (normalize(current.text) !== normalize(text)) throw Error('Open the exact saved Java source before extraction.');
    const at = document.validateRange(range), from = document.offsetAt(at.start), to = document.offsetAt(at.end);
    const raw = text.slice(from,to), expression = raw.trim();
    if (!expression || expression.length > 4096) throw Error('Select a complete Java expression within 4096 characters.');
    const start = from+raw.indexOf(expression), end = start+expression.length;
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    const sources = await classSources(project,cancellation);
    if (!sources.some(item => item.uri === current.uri && item.sha === current.sha)) {
      throw Error('Select a Java expression in an imported production source root.');
    }
    const originals = new Map(sources.map(source => [source.uri,source.sha]));
    function checkAnchor() {
      const active = java.getState();
      if (active.state !== 'running' || active.runtimeIdentity !== state.runtimeIdentity || document.isClosed || document.isDirty ||
          document.version !== version || document.getText() !== text) {
        throw Error('The selected Java source or runtime changed. Inspect the expression again.');
      }
    }
    checkAnchor();
    const response = await java.valueExtraction(kind,{textDocument:{uri:current.uri},range:rangeAt(text,start,end),context:{diagnostics:[]}},cancellation);
    checkAnchor();
    const linked = alignDraftLineEndings(linkedExtraction(response,{text,version,belongsToSource:value => {
      if (typeof value !== 'string') return false;
      const uri = vscode.Uri.parse(value);
      return uri.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment && !path.relative(document.uri.fsPath,uri.fsPath);
    }}),text);
    async function checkDraft(draft,token) {
      assertReady(token);
      checkAnchor();
      return compile(state,project,sources.map(item => item.uri === current.uri ? {...item,text:draft.text} : item),{
        kind:'extraction',uri:current.uri,extractionKind:kind,offset:draft.offset,name:draft.name
      },token,{errorTitle:'The Java extraction would fail compiler analysis: '});
    }
    const initial = await checkDraft({...linked,text:linked.proposed},cancellation);
    const proof = initial.extraction;
    reviewDraft({before:text,selection:{start,end},linked,proof,kind});
    const report = Object.freeze({kind,type:proof.type,owner:proof.owner,suggestedName:linked.name});
    inspections.set(report,{document,version,text,current,project,sources,originals,linked,initial,proof,checkAnchor,checkDraft});
    return report;
  }

  async function prepare(report,{name=report?.suggestedName,cancellation} = {}) {
    assertReady(cancellation);
    const record = inspections.get(report);
    if (!record) throw Error('Inspect the Java expression before reviewing the extraction.');
    const {document,version,text,current,project,sources,originals,linked,initial,proof,checkAnchor,checkDraft} = record;
    const named = namedDraft(linked,proof,name);
    async function checkSources(token) {
      assertReady(token);
      checkAnchor();
      const live = await classSources(project,token);
      if (live.length !== originals.size || live.some(source => source.sha !== originals.get(source.uri))) {
        throw Error('Java source content or membership changed after extraction analysis.');
      }
      initial.validateClasspath();
    }
    await checkSources(cancellation);
    const verified = name === linked.name ? initial : await checkDraft({...named,name},cancellation);
    if (verified.classpathFingerprint !== initial.classpathFingerprint) throw Error('Java classpath changed after extraction analysis.');
    verifyNamedDraft(proof,verified.extraction,named,name);
    const action = ACTIONS[proof.kind];
    const plan = await java.refactoring.previewWorkspaceEdit({documentChanges:[{
      textDocument:{uri:current.uri,version},edits:[singleEdit(text,named.text)]
    }]},{title:action.title+' · '+name,kind:action.kind,anchorDocument:document,cancellation,
      warnings:proof.kind === 'field' ? [proof.staticField ? 'The current method assigns the value to a private static field.' :
        'The current method assigns the evaluated value to a private instance field.'] : [],
      validate:async token => {
        await checkSources(token);
        const live = await classpaths(project,token);
        if (live.length !== verified.classpathEntries.length || live.some((entry,index) => entry !== verified.classpathEntries[index])) {
          throw Error('The Java classpath changed after extraction review.');
        }
        verified.validateClasspath();
      },
      preApply:() => { checkAnchor(); verified.validateClasspath(); assertUnchangedSourceSnapshots(sources); }
    });
    return {...plan,extraction:{kind:proof.kind,name,type:proof.type,owner:proof.owner,checkedNames:named.names.length,selectedOccurrences:1}};
  }

  async function run(kind,anchor) {
    const selection = await selectedExtraction(vscode,anchor);
    const action = ACTIONS[kind];
    const {document,range} = selection, version = document?.version;
    let report;
    try {
      report = await operation('Inspect '+action.title,cancellation => inspect({kind,...selection,cancellation}));
    } catch (error) {
      if (!(error instanceof NamedSelectionError)) throw error;
      const choice = await vscode.window.showInformationMessage(error.message,'Review JDT Default Edit');
      if (choice !== 'Review JDT Default Edit') return;
      if (document.isClosed || document.isDirty || document.version !== version) throw Error('The selected Java source changed. Select the expression again.');
      return java.refactoring.review(await java.refactoring.preview(document,range,{title:action.defaultTitle,kind:action.kind}));
    }
    const {proof} = inspections.get(report);
    const name = await vscode.window.showInputBox({title:action.title,prompt:`Name the new ${report.type} ${kind === 'local' ? 'local variable' : 'field'}.`,
      value:report.suggestedName,validateInput:value => validateName(value,proof)});
    if (name === undefined) return;
    const plan = await operation('Verify '+action.title,cancellation => prepare(report,{name,cancellation}));
    return java.refactoring.review(plan);
  }

  return {inspect,prepare,run};
}

module.exports = { createValueExtraction };
