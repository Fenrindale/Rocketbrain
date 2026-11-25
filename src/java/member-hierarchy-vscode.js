'use strict';

const { hierarchyCandidates,hierarchyEdits,verifyHierarchyBindings } = require('./member-hierarchy');

const label = direction => direction === 'pull' ? 'Pull Up Java Members' : 'Push Down Java Members';

function createMemberHierarchy(vscode,{
  java,assertReady,projects,findProject,classSources,classpaths,compile,snapshot,assertUnchangedSourceSnapshots,operation
}) {
  const reviews = new WeakMap();

  async function inspect({document,position,direction,cancellation} = {}) {
    assertReady(cancellation);
    if (!document || document.languageId !== 'java' || document.isClosed || !['pull','push'].includes(direction)) {
      throw Error('Open a saved Java class before reviewing its hierarchy members.');
    }
    const version = document.version, current = await snapshot(document.uri,cancellation);
    const state = await projects(cancellation), project = findProject(state.projects,document.uri);
    const sources = await classSources(project,cancellation);
    if (!sources.some(item => item.uri === current.uri && item.sha === current.sha)) {
      throw Error('Choose a saved Java class in the imported production source roots.');
    }
    const at = document.validatePosition(position || new vscode.Position(0,0));
    const params = {uri:current.uri,offset:document.offsetAt(at),direction};
    const proof = await compile(state,project,sources,{kind:'hierarchy'},cancellation);
    if (document.isClosed || document.version !== version) throw Error('The Java class changed while inspecting its member hierarchy.');
    const {source,targets,members} = hierarchyCandidates(proof.hierarchy,params);
    const report = {
      direction,source:{id:source.id,uri:source.uri,name:source.name},
      targets:targets.map(item => ({id:item.id,uri:item.uri,name:item.name})),
      members:members.map(item => ({id:item.key,name:item.name,type:item.type,kind:item.constant === null ? 'method' : 'constant'}))
    };
    reviews.set(report,{state,project,document,version,sources,params,proof});
    return report;
  }

  async function prepare(report,{targetId,memberIds,cancellation} = {}) {
    assertReady(cancellation);
    const saved = reviews.get(report);
    if (!saved) throw Error('Inspect a Java source hierarchy before reviewing a member move.');
    const {state,project,document,version,sources,params,proof} = saved;
    const byUri = new Map(sources.map(item => [item.uri,item.sha]));
    const move = hierarchyEdits(proof.hierarchy,sources,{...params,targetId,memberIds});
    const dependencies = sources.filter(item => !Object.hasOwn(move.changes,item.uri));
    function checkAnchor() {
      const current = java.getState();
      if (document.isClosed || document.version !== version || current.state !== 'running' || current.runtimeIdentity !== state.runtimeIdentity) {
        throw Error('The Java class or its configured runtime changed. Inspect the hierarchy again.');
      }
    }
    async function checkSources(token) {
      checkAnchor();
      const live = await classSources(project,token);
      if (live.length !== byUri.size || live.some(item => item.sha !== byUri.get(item.uri))) {
        throw Error('Java source content or membership changed after inspecting the hierarchy.');
      }
      proof.validateClasspath();
    }
    await checkSources(cancellation);
    const proposed = await compile(state,project,move.updated,{kind:'hierarchy'},cancellation,{
      errorTitle:'The hierarchy move would fail Java compiler analysis: '
    });
    if (proposed.classpathFingerprint !== proof.classpathFingerprint) {
      throw Error('Java classpath changed after inspecting the member hierarchy.');
    }
    const bindings = verifyHierarchyBindings(proof.hierarchy,proposed.hierarchy,move);
    const validate = async token => {
      await checkSources(token);
      const live = await classpaths(project,token);
      if (live.length !== proposed.classpathEntries.length || live.some((entry,index) => entry !== proposed.classpathEntries[index])) {
        throw Error('The Java classpath changed after member move review.');
      }
      proposed.validateClasspath();
    };
    const plan = await java.refactoring.previewWorkspaceEdit({changes:move.changes},{
      kind:params.direction === 'pull' ? 'refactor.move.pullUp' : 'refactor.move.pushDown',
      title:label(params.direction),cancellation,anchorDocument:document,validate,
      preApply:() => { checkAnchor(); proposed.validateClasspath(); assertUnchangedSourceSnapshots(dependencies); },
      warnings:['Javac checked reviewed Java source bindings and compilation. External binaries and reflective uses were outside this check.']
    });
    return { ...plan,direction:params.direction,from:move.source.id,to:move.target.id,
      selectedMembers:move.chosen.map(member => member.name),bindings };
  }

  async function run(direction) {
    const editor = vscode.window.activeTextEditor;
    const report = await operation('Inspect Java Member Hierarchy',cancellation => inspect({
      document:editor?.document,position:editor?.selection.active,direction,cancellation
    }));
    const destination = report.targets.length === 1 ? report.targets[0] :
      await vscode.window.showQuickPick(report.targets.map(item => ({...item,label:item.name,description:item.id})),
        {title:'Destination Java Subclass'});
    if (!destination) return;
    const selected = await vscode.window.showQuickPick(report.members.map(item => ({
      label:item.name,description:item.kind,detail:item.type,id:item.id
    })),{title:label(direction),canPickMany:true,matchOnDetail:true});
    if (!selected?.length) return;
    const plan = await operation('Check Java Hierarchy Changes',cancellation =>
      prepare(report,{targetId:destination.id,memberIds:selected.map(item => item.id),cancellation}));
    return java.refactoring.review(plan);
  }

  return {inspect,prepare,pullUp:() => run('pull'),pushDown:() => run('push')};
}

module.exports = { createMemberHierarchy };
