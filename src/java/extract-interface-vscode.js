'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { validIdentifier } = require('./file-templates');
const { inside } = require('./workbench-model');
const { EXTRACT_INTERFACE_KIND,interfaceMembers,interfaceEdit,localKey } = require('./extract-interface');

function createInterfaceExtraction(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const reviewed = new WeakMap();
  const parseUri = value => vscode.Uri.parse(value);
  const sourceSetting = () => vscode.workspace.getConfiguration('rocketbrain.java').get('extractInterface.replaceUsages',false) === true;

  async function destinations(reply,sourceRoot,owner,cancellation) {
    const items = reply.destinationResponse?.destinations;
    if (!Array.isArray(items) || items.length > 1200) throw Error('JDT did not return a bounded list of interface packages.');
    const found = new Map();
    for (const node of items) {
      assertReady(cancellation);
      if (typeof node?.uri !== 'string') continue;
      const uri = parseUri(node.uri);
      if (uri.scheme !== 'file' || uri.authority || uri.fragment || uri.query || !inside(sourceRoot.path,uri.fsPath)) continue;
      const key = localKey(uri), stat = await fs.lstat(uri.fsPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (!stat?.isDirectory() || stat.isSymbolicLink() || path.relative(uri.fsPath,await fs.realpath(uri.fsPath))) continue;
      found.set(key,{uri:uri.toString(),path:uri.fsPath,node,label:path.relative(sourceRoot.path,uri.fsPath).split(path.sep).join('.') || '(default package)'});
    }
    const current = localKey(vscode.Uri.file(path.dirname(owner.fsPath)));
    return [...found.values()].sort((a,b) => Number(localKey(parseUri(b.uri)) === current) - Number(localKey(parseUri(a.uri)) === current) ||
      a.label.localeCompare(b.label));
  }

  async function inspect({document,range,cancellation} = {}) {
    assertReady(cancellation);
    if (!document || document.languageId !== 'java' || document.isClosed) throw Error('Open the Java class to extract an interface from.');
    const version = document.version, owner = await snapshot(document.uri,cancellation);
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    const root = project.sourceRoots.find(item => !item.unavailable && inside(item.path,document.uri.fsPath) &&
      !/(?:^|[\\/])src[\\/](?:test|testFixtures|integrationTest)[\\/]/i.test(item.path));
    if (!root) throw Error('Choose a saved Java class in an imported production source root.');
    const at = document.validateRange(range || new vscode.Range(0,0,0,0));
    const context = {textDocument:{uri:owner.uri},range:{start:{line:at.start.line,character:at.start.character},
      end:{line:at.end.line,character:at.end.character}},context:{diagnostics:[]}};
    const reply = await java.interfaceRefactoring.members(context,cancellation);
    const members = interfaceMembers(reply);
    const packages = await destinations(reply,root,document.uri,cancellation);
    const current = await snapshot(document.uri,cancellation);
    if (current.sha !== owner.sha || document.version !== version || document.isClosed) {
      throw Error('The Java class changed while discovering extractable members.');
    }
    if (!packages.length) throw Error('Choose an existing physical package in the same production source root.');
    if (state.extractInterfaceReplaceUsages !== sourceSetting()) throw Error('Wait for Java support to reload the interface usage preference.');
    const report = {owner:reply.subTypeName,project:project.name,members,
      packages:packages.map(({uri,label}) => ({uri,label})),replaceUsages:state.extractInterfaceReplaceUsages};
    reviewed.set(report,{state,project,document,version,owner,context,members:new Set(members.map(member => member.id)),packages});
    return report;
  }

  async function prepare(report,{memberIds,name,packageUri,cancellation} = {}) {
    assertReady(cancellation);
    const stored = reviewed.get(report);
    if (!stored) throw Error('Review the Java class before extracting an interface.');
    const {state,project,document,version,owner,context,members,packages} = stored;
    if (!Array.isArray(memberIds) || !memberIds.length || new Set(memberIds).size !== memberIds.length ||
        memberIds.some(id => !members.has(id))) throw Error('Select distinct members from this Java class.');
    if (!validIdentifier(name) || name === path.basename(document.uri.fsPath,'.java')) throw Error('Choose a valid new Java interface name.');
    const destination = packageUri === undefined ? packages[0] : packages.find(item => item.uri === packageUri);
    if (!destination) throw Error('Choose an observed destination package for the new interface.');
    const created = vscode.Uri.joinPath(parseUri(destination.uri),name + '.java');
    async function checkDestination() {
      const parent = path.dirname(created.fsPath), real = await fs.realpath(parent);
      if (path.relative(parent,real) || (await fs.readdir(real)).some(entry => entry.toLowerCase() === (name + '.java').toLowerCase())) {
        throw Error('The new interface file destination changed or already exists.');
      }
    }
    function checkState() {
      const live = java.getState();
      if (live.state !== 'running' || state.runtimeIdentity !== live.runtimeIdentity ||
          state.extractInterfaceReplaceUsages !== live.extractInterfaceReplaceUsages ||
          state.extractInterfaceReplaceUsages !== sourceSetting() || document.isClosed || document.version !== version) {
        throw Error('The Java class or interface extraction settings changed. Review the members again.');
      }
    }
    checkState();
    await checkDestination();
    const sources = await classSources(project,cancellation), original = new Map(sources.map(source => [source.uri,source.sha]));
    if (original.get(owner.uri) !== owner.sha) throw Error('The saved Java class changed. Review the members again.');
    const response = await java.interfaceRefactoring.edit({
      command:'extractInterface',context,options:{tabSize:4,insertSpaces:true},
      commandArguments:[memberIds,name,destination.node]
    },cancellation);
    assertReady(cancellation);
    checkState();
    const normalized = interfaceEdit(response,{owner:document.uri,created,sources,
      replaceUsages:state.extractInterfaceReplaceUsages,parseUri});
    const edited = new Set(normalized.edit.documentChanges.map(change => change.textDocument.uri));
    const dependencies = sources.filter(source => !edited.has(source.uri));
    const verified = await compile(state,project,normalized.updated,{kind:'check'},cancellation,{
      newSources:[normalized.createJavaFile],
      errorTitle:'The interface extraction would fail Java compiler analysis: '
    });
    async function validate(token) {
      assertReady(token);
      checkState();
      await checkDestination();
      const files = await classSources(project,token);
      if (files.length !== original.size || files.some(source => original.get(source.uri) !== source.sha)) {
        throw Error('Java source content or membership changed since interface extraction.');
      }
      const classpath = await classpaths(project,token);
      if (classpath.length !== verified.classpathEntries.length || classpath.some((entry,index) => entry !== verified.classpathEntries[index])) {
        throw Error('The Java classpath changed since interface extraction.');
      }
      verified.validateClasspath();
    }
    const plan = await java.refactoring.previewWorkspaceEdit(normalized.edit,{
      title:'Extract Java Interface',kind:EXTRACT_INTERFACE_KIND,cancellation,anchorDocument:document,
      createJavaFile:normalized.createJavaFile,validate,
      preApply:() => { checkState(); verified.validateClasspath(); assertUnchangedSourceSnapshots(dependencies); },
      warnings:[state.extractInterfaceReplaceUsages ?
        'JDT proposed compatible source usage changes. Review any framework and external contracts in the diff.' :
        'The configured Java preference preserves existing usage types.']
    });
    return { ...plan,newUri:normalized.createJavaFile.uri,callerFiles:normalized.callerFiles,
      selectedMembers:memberIds.length,replaceUsages:state.extractInterfaceReplaceUsages };
  }

  async function run() {
    const editor = vscode.window.activeTextEditor;
    const report = await operation('Find Extractable Java Members',cancellation => inspect({
      document:editor?.document,range:editor?.selection,cancellation
    }));
    const members = await vscode.window.showQuickPick(report.members.map(member => ({
      label:member.parameters ? member.name + '(' + member.parameters.join(', ') + ')' : member.name,
      description:member.type,id:member.id
    })),{title:'Extract Interface from ' + report.owner,canPickMany:true,matchOnDescription:true});
    if (!members?.length) return;
    const name = await vscode.window.showInputBox({title:'New Interface Name',prompt:'Choose a name different from the concrete class.',
      validateInput:value => validIdentifier(value.trim()) && value.trim() !== report.owner ? undefined : 'Enter a valid new interface name.'});
    if (!name) return;
    const target = report.packages.length === 1 ? report.packages[0] :
      await vscode.window.showQuickPick(report.packages,{title:'Destination Java Package'});
    if (!target) return;
    const plan = await operation('Check Java Interface Extraction',cancellation => prepare(report,{
      memberIds:members.map(member => member.id),name:name.trim(),packageUri:target.uri,cancellation
    }));
    const result = await java.refactoring.review(plan);
    if (result.state === 'applied') await vscode.window.showTextDocument(parseUri(plan.newUri),{preview:false});
    return result;
  }

  return { inspect,prepare,run };
}

module.exports = { createInterfaceExtraction };
