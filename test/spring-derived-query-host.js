'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {jdbcReadback} = require('./java-source-analysis-host');
const {derivedFixture} = require('./helpers/spring-derived-query-fixture');

async function runSpringDerivedQueryChecks(api,vscode,checks) {
  const folder = vscode.workspace.workspaceFolders[0];
  const workspace = await fs.realpath(folder.uri.fsPath);
  const suffix = randomBytes(5).toString('hex');
  const fixture = derivedFixture('fixture.boot','RbDerived'+suffix,'rb_derived_'+suffix);
  const own = new Map();
  const represents = (query,files=own.values()) => {
    const uri=vscode.Uri.parse(query.uri);
    return uri.scheme==='file' && [...files].some(file=>!path.relative(file,uri.fsPath));
  };
  async function open(name) { return vscode.workspace.openTextDocument(vscode.Uri.file(own.get(name))); }
  function at(document,method,part) {
    const start = document.getText().indexOf(method), relative = method.indexOf(part);
    assert.ok(start >= 0 && relative >= 0);
    return document.positionAt(start+relative);
  }
  async function hover(document,position) {
    const values = await vscode.commands.executeCommand('vscode.executeHoverProvider',document.uri,position) || [];
    return values.flatMap(value=>value.contents).map(value=>typeof value==='string'?value:value.value).join('\n');
  }
  async function reveals(document,position,target,text) {
    const values = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,position) || [];
    assert.ok(values.some(value=>{
      const destination = value.targetUri || value.uri;
      const selection = value.targetSelectionRange || value.range;
      return destination?.scheme === 'file' && !path.relative(target.uri.fsPath,destination.fsPath) &&
        selection && target.getText(selection) === text;
    }),text);
  }

  let repository;
  try {
    for (const item of fixture.files) {
      const file = path.join(workspace,'src/main/java/fixture/boot',item.name+'.java');
      await fs.writeFile(file,item.text,{flag:'wx'});
      own.set(item.name,file);
    }
    const pattern=new vscode.RelativePattern(folder,'src/main/java/fixture/boot/RbDerived'+suffix+'*.java');
    let discovered=[];
    for (let count=0; count<10; count++) {
      discovered=await vscode.workspace.findFiles(pattern,null,own.size+1);
      if (discovered.length===own.size) break;
      await new Promise(resolve=>setTimeout(resolve,300));
    }
    assert.equal(discovered.length,own.size,'The native source search must find each generated Spring file.');
    repository = await open(fixture.repository);
    await vscode.window.showTextDocument(repository,{preview:false,preserveFocus:true});
    const location = await open(fixture.location), account = await open(fixture.entity), postal = await open(fixture.postal);
    const missing = await open(fixture.missing);
    const {names} = fixture, model = await api.jpa.refresh();
    const byName = name => model.queries.find(query=>query.text===name && represents(query));
    const positive = [names.compound,names.page,names.explicit,names.orderOnly,names.in,names.allCase];
    assert.deepEqual(positive.map(name=>byName(name)?.status),positive.map(()=>'known'),
      JSON.stringify({coverage:model.sourceCoverage,fixtureQueries:model.queries.filter(query=>represents(query))
        .slice(0,12).map(query=>[query.text,query.status,query.source])}));
    assert.equal(byName(names.ambiguous).status,'unknown');
    assert.equal(byName(names.missing).status,'invalid');
    await reveals(repository,at(repository,names.compound,'CityAnd'),location,'city');
    await reveals(repository,at(repository,names.compound,'NameAsc'),account,'name');
    const shown = await hover(repository,at(repository,names.page,'CityAnd'));
    assert.match(shown,/Spring Data source analysis · known/u);
    assert.match(shown,/Static order name ASC/u);
    assert.match(shown,/Bindable arguments 2 declared, 2 expected/u);
    assert.match(shown,/page[^\n]*Pageable/u);
    const ambiguous = await vscode.commands.executeCommand('vscode.executeDefinitionProvider',repository.uri,
      at(repository,names.ambiguous,'PostalCode')) || [];
    assert.ok(!ambiguous.some(value=>[location,account,postal].some(target=>{
      const uri = value.targetUri || value.uri;
      return uri?.scheme==='file' && !path.relative(target.uri.fsPath,uri.fsPath);
    })));
    const diagnostics = vscode.languages.getDiagnostics(missing.uri);
    assert.ok(diagnostics.some(item=>item.code==='jpa.derived.arguments' && /needs 3 .*declares 2/u.test(item.message)));

    const edited = new vscode.WorkspaceEdit();
    const start = at(repository,names.page,'NameAsc');
    edited.replace(repository.uri,new vscode.Range(start,start.translate(0,4)),'Ghost');
    assert.equal(await vscode.workspace.applyEdit(edited),true);
    const changedName = names.page.replace(/NameAsc$/u,'GhostAsc');
    const updated = await api.jpa.snapshot();
    const changed = updated.queries.find(query=>query.text===changedName && represents(query,[repository.uri.fsPath]));
    assert.equal(changed?.status,'unknown');
    assert.match(changed.reason,/Ghost.*unresolved/u);
    const original = new vscode.WorkspaceEdit();
    original.replace(repository.uri,new vscode.Range(start,start.translate(0,5)),'Name');
    assert.equal(await vscode.workspace.applyEdit(original),true);
    assert.equal(repository.getText(),fixture.files.find(item=>item.name===fixture.repository).text);
    const jdbc = await jdbcReadback();
    assert.ok(jdbc);
    checks.push('Native JPA hover, property definitions and bindable argument diagnostics cover compound Spring Data queries and update after an editor change.');
    return {supported:positive.length,crossFileDefinitions:2,arityDiagnostic:true,ambiguousPathRefused:true,
      specialPageable:true,unsavedChangeReanalyzed:true,jdbc};
  } finally {
    if (repository?.isDirty) await repository.save();
    for (const file of own.values()) await fs.unlink(file);
    await api.jpa.refresh();
  }
}

module.exports = {runSpringDerivedQueryChecks};
