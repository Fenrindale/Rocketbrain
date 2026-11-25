'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { importedSpring,jdbcReadback } = require('./java-source-analysis-host');

async function runJavaMemberHierarchyChecks(api,vscode,checks) {
  const service = api.javaSourceAnalysis;
  assert.ok(service?.inspectMemberHierarchy && service?.prepareMemberHierarchyMove);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.java.pullUpMembers') && commands.includes('rocketbrain.java.pushDownMembers'));
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await importedSpring(api,workspace);
  const root = path.join(workspace,'src/main/java/fixture/boot'), suffix = randomBytes(5).toString('hex');
  const prefix = 'RbHierarchy'+suffix;
  const type = name => prefix+name;
  const raw = {
    Base:'class '+type('Base')+' { protected int inherited = 3; }',
    Child:'class '+type('Child')+' extends '+type('Base')+' {\n' +
      '    static final int rate = 2;\n' +
      '    /** Keeps the original declaration documentation. */\n' +
      '    int price(int value) { return inherited + value * rate; }\n}',
    Sibling:'class '+type('Sibling')+' extends '+type('Base')+' {}',
    Caller:'class '+type('Caller')+' { int call() { return new '+type('Child')+'().price(5) + '+type('Child')+'.rate; } }'
  };
  const files = new Map(), docs = new Map();
  const build = async () => {
    const result = await api.java.buildWorkspace();
    assert.ok(result === 0 || result === 1 || result?.status === 'succeed','JDT build result '+JSON.stringify(result));
  };
  const stable = async action => {
    for (let attempt=0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 2 || [...docs.values()].some(document => document.isDirty) ||
            !/Compiler classpath file membership changed|A compiler runtime or classpath changed|Java classpath changed/.test(error.message)) throw error;
        await build();
        await new Promise(resolve => setTimeout(resolve,400));
      }
    }
  };
  const request = async (direction,source,destination) => {
    const report = await service.inspectMemberHierarchy({document:docs.get(source),direction});
    if (direction === 'push') assert.ok(report.targets.some(item => item.name === type('Sibling')));
    const target = report.targets.find(item => item.name === type(destination));
    const members = report.members.filter(item => ['price','rate'].includes(item.name));
    assert.ok(target);
    assert.deepEqual(new Set(members.map(item => item.kind)),new Set(['method','constant']));
    return service.prepareMemberHierarchyMove(report,{targetId:target.id,memberIds:members.map(item => item.id)});
  };
  try {
    for (const [name,body] of Object.entries(raw)) {
      const filename = path.join(root,type(name)+'.java');
      const text = 'package fixture.boot;\n'+body+'\n';
      await fs.writeFile(filename,text,{flag:'wx'});
      files.set(name,{filename,text});
      docs.set(name,await vscode.workspace.openTextDocument(vscode.Uri.file(filename)));
    }
    await build();
    const stale = await stable(() => request('pull','Child','Base'));
    const dependent = files.get('Caller');
    await fs.appendFile(dependent.filename,'// changed after review\n');
    await assert.rejects(api.java.refactoring.apply(stale.id),/source content or membership changed|Save each Java source/);
    assert.ok([...docs.values()].every(document => !document.isDirty));
    await fs.writeFile(dependent.filename,dependent.text);
    await build();
    async function apply(direction,source,target) {
      return stable(async () => {
        const plan = await request(direction,source,target);
        assert.equal(plan.documents.length,2);
        assert.ok(plan.bindings.movedReferences > 0 && plan.bindings.otherReferences > 0);
        assert.deepEqual(new Set(plan.selectedMembers),new Set(['price','rate']));
        const donor = plan.documents.find(item => item.uri === docs.get(source).uri.toString());
        const destination = plan.documents.find(item => item.uri === docs.get(target).uri.toString());
        assert.doesNotMatch(donor.after,/int price\(|static final int rate/);
        assert.match(destination.after,/int price\(int value\)/);
        assert.match(destination.after,/static final int rate = 2;/);
        assert.match(destination.after,/Keeps the original declaration documentation/);
        const documents = await Promise.all(plan.documents.map((_,index) => vscode.workspace.openTextDocument(vscode.Uri.parse(
          'rocketbrain-java-refactor:/'+plan.id+'/'+index+'/after.java'))));
        assert.deepEqual(documents.map(document => document.getText()),plan.documents.map(item => item.after));
        const before = await Promise.all([source,target].map(name => fs.readFile(files.get(name).filename,'utf8')));
        const result = await api.java.refactoring.apply(plan.id);
        assert.equal(result.state,'applied');
        assert.equal(result.savedToDisk,false);
        assert.deepEqual(await Promise.all([source,target].map(name => fs.readFile(files.get(name).filename,'utf8'))),before);
        assert.ok([source,target].every(name => docs.get(name).isDirty));
        assert.ok((await Promise.all([source,target].map(name => docs.get(name).save()))).every(Boolean));
        return plan.bindings;
      });
    }
    const pulled = await apply('pull','Child','Base');
    await build();
    const pushed = await apply('push','Base','Child');
    await build();
    assert.equal(await fs.readFile(dependent.filename,'utf8'),dependent.text);
    assert.equal(await fs.readFile(files.get('Sibling').filename,'utf8'),files.get('Sibling').text);
    const jdbc = await jdbcReadback();
    checks.push('Member Pull Up and Push Down moved one instance method and one constant through two reviewed Java classes in the actual Spring project.');
    checks.push('Prospective Javac preserved existing caller bindings and Javadoc. Native apply refused changed dependency source and kept both buffers unsaved.');
    return {pulledMembers:2,pushedMembers:2,pullBindings:pulled,pushBindings:pushed,callerUnchanged:true,
      siblingUnchanged:true,staleSourceRejected:true,javadocPreserved:true,diskUntouchedUntilSave:true,springBuild:true,jdbc};
  } finally {
    for (const document of docs.values()) if (document.isDirty) await document.save();
    for (const {filename} of files.values()) await fs.unlink(filename);
  }
}

module.exports = { runJavaMemberHierarchyChecks };
