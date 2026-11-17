'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
async function until(action, timeout = 20000) {
  const end = Date.now() + timeout; let last;
  while (Date.now() < end) { try { const value = await action(); if (value) return value; } catch (error) { last = error; } await new Promise(resolve => setTimeout(resolve, 150)); }
  throw last || new Error('JPA editor observation timed out.');
}
function position(document, marker, offset = 0) {
  const index = document.getText().indexOf(marker); assert.ok(index >= 0, `JPA marker missing: ${marker}`); return document.positionAt(index + offset);
}
async function runJpaChecks(api, vscode, checks, supplied) {
  const config = supplied || JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const project = config.projectPath, repository = vscode.Uri.file(path.join(project, 'src/main/java/fixture/boot/PersonRepository.java'));
  const model = await api.jpa.refresh(), person = model.entities.find(entity => entity.name === 'Person');
  assert.ok(person, 'The actual Boot project entity is indexed.');
  assert.equal(person.table.physicalName, 'rb_spring_person');
  assert.ok(person.attributes.some(attribute => attribute.name === 'id' && attribute.id), 'Mapped superclass identity is available.');
  assert.ok(person.attributes.some(attribute => attribute.name === 'department' && attribute.targetFqn?.endsWith('Department')));
  const document = await vscode.workspace.openTextDocument(repository); await vscode.window.showTextDocument(document);
  const completions = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', repository, position(document, 'p.department', 2));
  assert.ok(completions.items.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'displayName'));
  const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', repository, position(document, 'p.department', 4));
  assert.ok(definitions.some(item => (item.uri || item.targetUri)?.path.endsWith('/Person.java')));
  const entityDefinitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', repository, position(document, 'from Person', 7));
  assert.ok(entityDefinitions.some(item => (item.uri || item.targetUri)?.path.endsWith('/Person.java')));
  checks.push('JPA indexes the real Boot entity, inherited identity and association, and supplies JPQL completion/definition in VS Code.');
  const original = document.getText(), start = position(document, 'd.name', 2), end = start.translate(0, 4);
  const change = new vscode.WorkspaceEdit(); change.replace(repository, new vscode.Range(start, end), 'notMapped');
  await vscode.workspace.applyEdit(change);
  try {
    await api.jpa.refresh();
    const issue = await until(() => vscode.languages.getDiagnostics(repository).find(item => item.source === 'Rocketbrain JPA (source model)' && /notMapped/.test(item.message)));
    assert.ok(issue);
    checks.push('An unsaved invalid JPQL path in the real repository produces a source diagnostic without executing the query.');
  } finally {
    const restore = new vscode.WorkspaceEdit(); restore.replace(repository, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), original);
    await vscode.workspace.applyEdit(restore); await api.jpa.refresh();
    // Restore only this original fixture buffer; never save an unrelated user document.
    if (document.isDirty && document.getText() === fs.readFileSync(repository.fsPath, 'utf8')) { await vscode.window.showTextDocument(document); await vscode.commands.executeCommand('workbench.action.files.revert'); }
  }
  const connection = JSON.parse(fs.readFileSync(config.dbConfigPath, 'utf8'));
  await api.connectMysql(connection);
  try {
    const report = await api.jpa.compareCatalog();
    assert.ok(report.matches.length > 0, JSON.stringify(report.summary));
    assert.equal(report.mode, 'explicit-read-only-catalog-comparison');
    const summary = await api.analysis.snapshot(); assert.ok(summary.entities > 0);
    await vscode.commands.executeCommand('workbench.view.extension.rocketbrain');
    checks.push(`JPA compares mappings with the actual ${config.dbEngine} catalog through the extension's read-only metadata path.`);
  } finally { await vscode.commands.executeCommand('rocketbrain.useDemo'); }
  return { entities: model.entities.map(entity => entity.name), database: config.dbEngine };
}
async function restoreFixture(vscode,document,original){
  const edit=new vscode.WorkspaceEdit();edit.replace(document.uri,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),original);await vscode.workspace.applyEdit(edit);
  if(document.isDirty&&document.getText()===fs.readFileSync(document.uri.fsPath,'utf8')){await vscode.window.showTextDocument(document);await vscode.commands.executeCommand('workbench.action.files.revert');}
}
async function runJpaV05Checks(api,vscode,checks,supplied){
  const config=supplied||JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  const sourceUri=vscode.Uri.file(path.join(config.projectPath,'src/main/java/fixture/boot/AdvancedProbeService.java'));
  const xmlUri=vscode.Uri.file(path.join(config.projectPath,'src/main/resources/META-INF/orm.xml'));
  const model=await api.jpa.refresh();assert.equal(model.entities.length,15,JSON.stringify({coverage:model.sourceCoverage,documents:model.mappingDocuments,issues:model.issues,entities:model.entities.map(e=>e.name)}));assert.equal(model.mappingDocuments.length,1);
  const custom=model.entities.find(e=>e.name==='CustomRecord');assert.ok(custom.columnMappings.some(b=>b.column?.physicalName==='home_city'));assert.ok(custom.columnMappings.some(b=>b.storageTable?.physicalName==='rb_v5_record_extra'&&b.column?.physicalName==='secret_note'));
  const source=await vscode.workspace.openTextDocument(sourceUri);await vscode.window.showTextDocument(source);
  const shadowStart=source.getText().indexOf('result.put("shadowedScopes"');assert.ok(shadowStart>=0);
  const inner=source.getText().indexOf('p.name',shadowStart),outer=source.getText().indexOf('p.displayName',shadowStart);assert.ok(inner>shadowStart&&outer>shadowStart);
  const innerDefs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',sourceUri,source.positionAt(inner+3));assert.ok(innerDefs.some(d=>(d.uri||d.targetUri)?.path.endsWith('/Department.java')));
  const outerDefs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',sourceUri,source.positionAt(outer+3));assert.ok(outerDefs.some(d=>(d.uri||d.targetUri)?.path.endsWith('/Person.java')));
  const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',sourceUri,source.positionAt(inner+2));const labels=completion.items.map(i=>typeof i.label==='string'?i.label:i.label.label);assert.ok(labels.includes('name'));
  checks.push('Scoped JPQL providers resolve nested alias shadowing to Department and outer references to Person in the actual Boot service.');
  const original=source.getText(),change=new vscode.WorkspaceEdit();change.replace(sourceUri,new vscode.Range(source.positionAt(inner+2),source.positionAt(inner+6)),'missingEditorNested');await vscode.workspace.applyEdit(change);
  try{await api.jpa.refresh();assert.ok(await until(()=>vscode.languages.getDiagnostics(sourceUri).find(d=>d.source==='Rocketbrain JPA (source model)'&&/missingEditorNested/.test(d.message))));checks.push('An unsaved invalid nested JPQL property produces the correct source diagnostic without executing a query.');}
  finally{await restoreFixture(vscode,source,original);await api.jpa.refresh();}
  const xml=await vscode.workspace.openTextDocument(xmlUri);await vscode.window.showTextDocument(xml);const xmlOriginal=xml.getText();
  const xmlDefs=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',xmlUri,position(xml,'y.label = x.label',3));assert.ok(xmlDefs.some(d=>(d.uri||d.targetUri)?.path.endsWith('/XmlRecord.java')));
  const xmlCompletion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',xmlUri,position(xml,'y.label = x.label',2));assert.ok(xmlCompletion.items.some(i=>(typeof i.label==='string'?i.label:i.label.label)==='label'));
  checks.push('ORM XML-only entities and XML named-query paths supply completion and Java source definitions through native XML editor APIs.');
  await api.connectMysql(JSON.parse(fs.readFileSync(config.dbConfigPath,'utf8')));
  try{
    const compared=await api.jpa.compareCatalog();assert.equal(compared.mismatches.length,0,JSON.stringify(compared.mismatches));assert.ok(compared.matches.length>=69);
    const native=await api.analysis.snapshot();assert.equal(native.mappingDocuments,1);assert.ok(native.physicalMappings>=69);
    checks.push('Custom overrides, composite keys, secondary/join/collection tables, converter metadata and XML mappings produce 69 or more property-to-column matches through the extension read-only metadata path.');
    const start=position(xml,'xml_override_label'),end=start.translate(0,'xml_override_label'.length),edit=new vscode.WorkspaceEdit();edit.replace(xmlUri,new vscode.Range(start,end),'missing_editor_column');await vscode.workspace.applyEdit(edit);
    try{
      await api.jpa.refresh();assert.equal(api.jpa.catalogComparison(),undefined);
      const mismatch=await api.jpa.compareCatalog();assert.ok(mismatch.mismatches.some(i=>i.code==='jpa.catalog.column'&&i.column==='missing_editor_column'));
      const observed=await api.databaseCatalog();assert.ok(observed.tables.find(t=>t.name==='rb_v5_xml_override').columns.some(c=>c.name==='xml_override_label'));assert.equal(observed.tables.find(t=>t.name==='rb_v5_xml_override').columns.some(c=>c.name==='missing_editor_column'),false);
      checks.push('An unsaved XML column override invalidates stale comparison and reports a read-only catalog mismatch while the real schema stays unchanged.');
    }finally{await restoreFixture(vscode,xml,xmlOriginal);await api.jpa.refresh();}
  }finally{await vscode.commands.executeCommand('rocketbrain.useDemo');}
}
async function runJpaV06Checks(api,vscode,checks,supplied){
  const config=supplied||JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  let model=await api.jpa.refresh();
  const uri=vscode.Uri.file(path.join(config.projectPath,'src/main/java/fixture/boot/TypeProbeService.java'));
  const document=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(document);
  const aggregate=model.queries.find(q=>q.uri===uri.toString()&&q.text?.startsWith('select count(p), sum(p.id)'));
  assert.equal(aggregate?.typeAnalysis?.state,'known');assert.deepEqual(aggregate.typeAnalysis.selectionTypes.map(t=>t.javaType),['java.lang.Long','java.lang.Long','java.lang.Double','java.lang.String','java.lang.Long']);
  const hovers=await vscode.commands.executeCommand('vscode.executeHoverProvider',uri,position(document,'select count(p)',9));
  assert.ok(hovers.some(hover=>(hover.contents||[]).some(value=>String(value.value||value).replace(/\\/g,'').replace(/&nbsp;/g,' ').replace(/\u00a0/g,' ').includes('JPQL source types: known'))),JSON.stringify(hovers.map(h=>h.contents)).slice(0,1800));
  const command=await vscode.commands.executeCommand('rocketbrain.jpa.queryTypes');assert.ok(command.summary.checked>0);assert.ok(command.summary.invalid>=9);
  checks.push('Native Java hover and query coverage command expose real aggregate Java result types and distinguish known, invalid and unresolved source queries.');
  const original=document.getText(),numericStart=original.indexOf('select p.id + 1,');assert.ok(numericStart>=0);
  const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(document.positionAt(numericStart+7),document.positionAt(numericStart+11)),'p.displayName');await vscode.workspace.applyEdit(edit);
  try{
    await api.jpa.refresh();const changedLine=document.positionAt(numericStart).line;
    assert.ok(await until(()=>vscode.languages.getDiagnostics(uri).find(d=>d.source==='Rocketbrain JPA (source model)'&&d.code?.toString().startsWith('jpa.type.')&&d.range.start.line===changedLine&&/numeric|arithmetic/i.test(d.message))));
    checks.push('An unsaved String-in-arithmetic change produces a mapped JPQL type diagnostic without executing Java or SQL.');
  }finally{await restoreFixture(vscode,document,original);await api.jpa.refresh();}
  const constantsUri=vscode.Uri.file(path.join(config.projectPath,'src/main/java/fixture/boot/TypeQueryParts.java')),constants=await vscode.workspace.openTextDocument(constantsUri);await vscode.window.showTextDocument(constants);
  const definitions=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',constantsUri,position(constants,'p.displayName',4));assert.ok(definitions.some(d=>(d.uri||d.targetUri)?.path.endsWith('/Person.java')));
  model=await api.jpa.snapshot();const finite=model.queries.filter(q=>q.uri===uri.toString()&&q.dynamicResolution?.state==='finite');assert.equal(finite.length,2);assert.ok(finite.every(q=>q.typeAnalysis.state==='known'));
  checks.push('Cross-file query constants navigate to entity source and both finite Java query branches remain separately typed.');
  const repositoryUri=vscode.Uri.file(path.join(config.projectPath,'src/main/java/fixture/boot/TypedPersonRepository.java')),repository=await vscode.workspace.openTextDocument(repositoryUri);await vscode.window.showTextDocument(repository);
  const repoQueries=model.queries.filter(q=>q.uri===repositoryUri.toString());assert.equal(repoQueries.length,7);assert.ok(repoQueries.every(q=>q.typeAnalysis.state==='known'));
  const repositoryOriginal=repository.getText(),change=new vscode.WorkspaceEdit();change.replace(repositoryUri,new vscode.Range(position(repository,'#filter.name',8),position(repository,'#filter.name',12)),'editorMissingName');await vscode.workspace.applyEdit(change);
  try{await api.jpa.refresh();assert.ok(await until(()=>vscode.languages.getDiagnostics(repositoryUri).find(d=>d.source==='Rocketbrain JPA (source model)'&&/editorMissingName/.test(d.message))));checks.push('Spring Data entityName, typed SpEL arguments and safe String signatures are analyzed; unsaved invalid SpEL properties receive editor diagnostics without expression execution.');}
  finally{await restoreFixture(vscode,repository,repositoryOriginal);await api.jpa.refresh();}
  if(config.naming==='custom'){
    model=await api.jpa.snapshot();const property=model.entities.find(e=>e.name==='PropertyRecord');assert.equal(property.table.physicalName,'v6_rb_spring_property');assert.ok(property.columnMappings.some(b=>b.column?.physicalName==='c_logical_display_alias'));assert.ok(property.columnMappings.some(b=>b.column?.physicalName==='QuotedValue'));
    await api.connectMysql(JSON.parse(fs.readFileSync(config.dbConfigPath,'utf8')));
    try{const comparison=await api.jpa.compareCatalog();assert.equal(comparison.mismatches.length,0,JSON.stringify(comparison.mismatches));assert.ok(comparison.matches.length>=71);checks.push('The packaged extension source-interprets configured physical and implicit naming strategies and matches the actual custom-named database, including quoted identifiers.');}
    finally{await vscode.commands.executeCommand('rocketbrain.useDemo');}
  }
}
module.exports = { runJpaChecks,runJpaV05Checks,runJpaV06Checks };
