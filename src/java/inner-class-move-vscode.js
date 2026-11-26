'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {isDeepStrictEqual:equal} = require('node:util');
const {createHash} = require('node:crypto');
const {lexJava,rangeAt} = require('../spring/java');
const {validIdentifier} = require('./file-templates');
const {buildFingerprint,inside} = require('./workbench-model');
const {moveScope,validateScope} = require('./move-scope');
const {projectFiles} = require('./move');
const {reviewedNewTypeFile,localKey} = require('./extract-interface');
const {KIND,checkedMove,compareMove,preserveQualifiedNullCheck} = require('./inner-class-move');

const COMMAND = 'rocketbrain.java.moveInnerClass';

function selection(source,document,position) {
  const {tokens,issues} = lexJava(source.text);
  const sameLine = (start,end) => start.line === position.line && end.line === position.line &&
    position.character >= start.character && position.character <= end.character;
  const chosen = tokens.find((token,index) => index && tokens[index-1].text === 'class' &&
    validIdentifier(token.text) && (() => {
      const {start,end} = rangeAt(source.text,token.start,token.end);
      return sameLine(start,end);
    })());
  const suffix = tokens.findIndex(token => token.text === ';');
  const packageParts = tokens.slice(1,suffix);
  if (issues.length || !chosen || tokens[0]?.text !== 'package' || suffix < 2 ||
      packageParts.some((token,index) => index%2 ? token.text !== '.' : !validIdentifier(token.text))) {
    throw Error('Place the caret on an inner class declaration name in a named Java package.');
  }
  const pkg = packageParts.map(token => token.text).join('');
  const owner = path.basename(document.uri.fsPath,'.java');
  if (!validIdentifier(owner) || packageParts.length%2 !== 1 || chosen.text === owner) {
    throw Error('Choose a member class of the file’s primary Java class.');
  }
  return {name:chosen.text,pkg,owner:pkg+'.'+owner,range:rangeAt(source.text,chosen.start,chosen.end),offset:chosen.start};
}

function contractGuard(vscode,scope,sources,{owner,name}) {
  const key = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const reviewed = new Set(sources.map(source => key(vscode.Uri.parse(source.uri).fsPath)));
  const files = () => [...new Set([...projectFiles(scope.source.root,{includeClassRegistrations:true}),...scope.buildFiles])]
    .filter(file => !reviewed.has(key(file))).sort();
  let bytes = 0;
  const guards = new Map();
  const digest = data => createHash('sha256').update(data).digest('hex');
  const names = [owner + '.' + name, owner + '$' + name];
  for (const file of files()) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024 || (bytes += stat.size) > 16 * 1024 * 1024) {
      throw Error('Review a bounded local Java project without linked class registrations.');
    }
    const data = fs.readFileSync(file);
    const text = new TextDecoder('utf-8',{fatal:true}).decode(data), extension = path.extname(file).toLowerCase();
    if (names.some(candidate => text.includes(candidate) || path.basename(file) === candidate) ||
        (['.java','.kt','.groovy','.scala'].includes(extension) &&
          (extension === '.java' ? lexJava(text).tokens.some(token => token.text === name) :
            text.split(/[^\p{L}\p{N}_$]+/u).includes(name)))) {
      throw Error('A project test, non-Java source or registration refers to this type outside the reviewed Java production scope.');
    }
    guards.set(file,digest(data));
  }
  return () => {
    const live = files(), open = vscode.workspace.textDocuments;
    if (live.length !== guards.size || live.some(file => !guards.has(file) ||
        !fs.lstatSync(file).isFile() || digest(fs.readFileSync(file)) !== guards.get(file) ||
        open.some(document => !document.isClosed && document.uri.scheme === 'file' &&
           key(document.uri.fsPath) === key(file) && document.isDirty))) {
      throw Error('A Java Move dependency, test or resource changed after review.');
    }
  };
}

function createInnerClassMove(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  async function prepare({document,position,cancellation}={}) {
    assertReady(cancellation);
    if (document?.languageId !== 'java' || document.isClosed || !position) {
      throw Error('Open and save the Java source containing the inner class to move.');
    }
    const version = document.version;
    const source = await snapshot(document.uri,cancellation);
    const selected = selection(source,document,position);
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    if (!project.sourceRoots.some(root => !root.unavailable && inside(root.path,document.uri.fsPath))) {
      throw Error('Select a Java declaration from an imported project source root.');
    }
    const samples = await classSources(project,cancellation);
    const original = new Map(samples.map(record => [record.uri,record]));
    const parseUri = uri => vscode.Uri.parse(uri);
    const anchorKey = localKey(document.uri);
    const anchor = samples.find(record => localKey(parseUri(record.uri)) === anchorKey);
    if (!anchor || anchor.sha !== source.sha) throw Error('The selected Java source is outside the reviewed production scope or changed.');
    const name = selected.name + '.java', parent = path.dirname(document.uri.fsPath);
    const created = vscode.Uri.file(path.join(parent,name));
    const build = buildFingerprint(project.root);
    const request = (_method,params,token) => java.requestWorkspaceCommand(params.command,params.arguments,token);
    const scope = await moveScope(vscode,request,document.uri,document.uri,cancellation);
    if (path.relative(scope.source.root,project.root)) throw Error('Java project identity differs between project and move analysis.');
    const checkContracts = contractGuard(vscode,scope,samples,selected);

    function checkState() {
      assertReady();
      const live = java.getState();
      if (live.state !== 'running' || live.runtimeIdentity !== state.runtimeIdentity ||
          document.isClosed || document.isDirty || document.version !== version || buildFingerprint(project.root) !== build) {
        throw Error('The Java source, build or runtime changed after review.');
      }
      const physical = fs.realpathSync(parent);
      if (path.relative(parent,physical) || fs.readdirSync(physical).some(file => file.toLowerCase() === name.toLowerCase())) {
        throw Error('The new Java file destination changed or already exists.');
      }
    }

    checkState();
    checkContracts();
    const beforeCompilation = await compile(state,project,samples,{
      kind:'innerMove',fqn:selected.owner+'.'+selected.name,other:selected.owner
    },cancellation);
    const before = checkedMove(beforeCompilation.innerMove,true);
    if (localKey(parseUri(before.uri)) !== anchorKey || selected.offset <= before.start || selected.offset >= before.end) {
      throw Error('The selected declaration is outside the attributed owner class.');
    }
    const raw = await java.innerClassMoveEdit({
      moveKind:'moveTypeToNewFile',params:{textDocument:{uri:anchor.uri},range:selected.range,context:{diagnostics:[]}},
      updateReferences:true
    },cancellation);
    assertReady(cancellation);
    checkState();
    let proposal = reviewedNewTypeFile(raw,{
      owner:document.uri,created,sources:samples,replaceUsages:true,parseUri,artifact:'top-level class'
    });
    async function inspectProspective() {
      const report = await compile(state,project,proposal.updated,{
        kind:'innerMove',fqn:selected.pkg+'.'+selected.name,other:selected.owner
      },cancellation,{newSources:[proposal.createJavaFile],errorTitle:'The inner-class move would fail Java compiler analysis: '});
      const move = checkedMove(report.innerMove,false);
      if (localKey(parseUri(move.uri)) !== localKey(created)) {
        throw Error('Java analysis resolved the new type outside the approved destination file.');
      }
      return {report,move};
    }
    let {report,move} = await inspectProspective();
    const {fixes,qualified} = compareMove({before,after:move,original,updated:proposal.updated,nullChecks:false});
    if (fixes.size) {
      proposal = preserveQualifiedNullCheck(proposal,original,fixes);
      ({report,move}=await inspectProspective());
      compareMove({before,after:move,original,updated:proposal.updated,nullChecks:true});
    }
    if (!equal(report.classpathEntries,beforeCompilation.classpathEntries) ||
        report.classpathFingerprint !== beforeCompilation.classpathFingerprint) throw Error('The Java classpath changed during review.');
    checkState();
    assertUnchangedSourceSnapshots(samples);
    checkContracts();

    async function validate(token) {
      assertReady(token);
      checkState();
      checkContracts();
      await validateScope(scope,vscode,request,document.uri,document.uri,token);
      const live = await classSources(project,token);
      if (live.length !== original.size || live.some(record => original.get(record.uri)?.sha !== record.sha)) {
        throw Error('Java source content or membership changed after the inner-class move review.');
      }
      if (!equal(await classpaths(project,token),report.classpathEntries)) throw Error('The Java classpath changed after review.');
      report.validateClasspath();
    }
    const plan = await java.refactoring.previewWorkspaceEdit(proposal.edit,{
      title:'Move Java Inner Class to New File',kind:KIND,cancellation,anchorDocument:document,
      createJavaFile:proposal.createJavaFile,validate,
      preApply:() => {
        checkState();
        assertUnchangedSourceSnapshots(samples);
        checkContracts();
        report.validateClasspath();
      },
      warnings:[
        'The moved type now has a top-level binary name. Review consumers outside this imported Java project.',
        'The constructor retains its enclosing instance. Qualified callers still check it before evaluating the remaining arguments.'
      ]
    });
    return {...plan,newUri:proposal.createJavaFile.uri,qualifiedCallers:qualified,constructorCallers:before.calls.length};
  }

  async function run() {
    const editor = vscode.window.activeTextEditor;
    const plan = await operation('Check Java Inner Class Move',cancellation => prepare({
      document:editor?.document,position:editor?.selection.active,cancellation
    }));
    const result = await java.refactoring.review(plan);
    if (result.state === 'applied') await vscode.window.showTextDocument(vscode.Uri.parse(plan.newUri),{preview:false});
    return result;
  }
  return {prepare,run};
}

module.exports = {COMMAND,createInnerClassMove};
