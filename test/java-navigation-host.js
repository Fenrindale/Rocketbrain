'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function point(vscode, file, marker, symbol) {
  const uri = vscode.Uri.file(file);
  const document = await vscode.workspace.openTextDocument(uri);
  const offset = document.getText().indexOf(marker);
  assert.notEqual(offset, -1, marker);
  return { uri, position: document.positionAt(offset + marker.indexOf(symbol)) };
}

async function importedSpring(api, folder) {
  const until = Date.now() + 100000;
  while (Date.now() < until) {
    const snapshot = await api.java.workbench.refresh();
    const root = snapshot.projects.find(project => !path.relative(project.root, folder));
    if (root?.sourceRoots.length) return root;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw Error('JDT did not import the expected Spring workspace.');
}

function findDirection(report, rootName, key) {
  const root = report.roots.find(item => named(item.symbol, rootName));
  assert.ok(root, JSON.stringify(report.roots.map(item => item.symbol)));
  const relation = root.directions.find(item => item.kind === key);
  assert.ok(relation);
  return relation;
}

function named(symbol, name) {
  return symbol.name === name || symbol.name.startsWith(name + '(');
}

async function probeSpringDatabase() {
  if (!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) return null;
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(config.dbEngine, process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE);
  const response = await fetch(config.baseUrl + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
  assert.equal(response.ok, true);
  const observed = await response.json();
  assert.deepEqual(observed, { people: 2, departments: 1, rolledBackNames: 0 });
  return observed;
}

async function runJavaNavigationChecks(api, vscode, checks) {
  assert.ok(api.javaNavigation);
  const folder = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const root = path.join(folder, 'src/main/java/fixture/boot');
  await importedSpring(api, folder);
  const find = async (source, marker, name, kind) => api.javaNavigation.inspectHierarchy({
    kind, ...await point(vscode, path.join(root, source), marker, name)
  });
  const controller = await find('ProbeController.java', 'public Map<String,Object> probe()', 'probe', 'call');
  const service = await find('ProbeService.java', 'public Map<String,Object> probe()', 'probe', 'call');
  const callsOut = findDirection(controller, 'probe', 'outgoing');
  const callsIn = findDirection(service, 'probe', 'incoming');
  const outgoing = callsOut.related.find(item => item.symbol.uri.endsWith('/ProbeService.java') && named(item.symbol, 'probe'));
  const incoming = callsIn.related.find(item => item.symbol.uri.endsWith('/ProbeController.java') && named(item.symbol, 'probe'));
  assert.ok(outgoing?.callSites.length, JSON.stringify(callsOut));
  assert.ok(incoming?.callSites.length, JSON.stringify(callsIn));
  const incomingSite = incoming.callSites[0], outgoingSite = outgoing.callSites[0];
  // JDT's inbound span covers the invoked method, while the outbound span
  // can include the receiver; both link to the same source statement.
  assert.equal(incomingSite.uri, outgoingSite.uri);
  assert.ok(incomingSite.uri.endsWith('/ProbeController.java'));
  assert.equal(incomingSite.range.start.line, outgoingSite.range.start.line);
  assert.equal(incomingSite.range.end.line, outgoingSite.range.end.line);
  assert.ok(incomingSite.range.start.character >= outgoingSite.range.start.character);
  await api.javaNavigation.openSource(incomingSite);
  assert.equal(vscode.window.activeTextEditor.selection.start.line, incomingSite.range.start.line);
  const sourceDoc = vscode.window.activeTextEditor.document;
  const callSite = incoming.callSites[0].range;
  assert.match(sourceDoc.getText(new vscode.Range(callSite.start.line, callSite.start.character,
    callSite.end.line, callSite.end.character)), /probe/);
  const base = await find('PaymentBase.java', 'abstract class PaymentBase', 'PaymentBase', 'type');
  const cash = await find('CashPayment.java', 'class CashPayment extends', 'CashPayment', 'type');
  const subclasses = findDirection(base, 'PaymentBase', 'subtypes');
  const superclasses = findDirection(cash, 'CashPayment', 'supertypes');
  assert.ok(subclasses.related.some(item => item.symbol.name === 'CashPayment' && item.symbol.uri.endsWith('/CashPayment.java')));
  assert.ok(superclasses.related.some(item => item.symbol.name === 'PaymentBase' && item.symbol.uri.endsWith('/PaymentBase.java')));
  await api.javaNavigation.showHierarchyTree('call', controller.roots[0].symbol);
  await api.javaNavigation.showHierarchyTree('type', cash.roots[0].symbol);
  const prefixes = ['rbnav_alpha', 'rbnav_beta'];
  const packageNames = prefixes.map(value => 'fixture.boot.' + value);
  const created = [], directories = [];
  try {
    for (let i = 0; i < prefixes.length; i++) {
      const directory = path.join(root, prefixes[i]);
      await fs.mkdir(directory);
      directories.push(directory);
      const name = i ? 'RbNavBeta' : 'RbNavAlpha';
      const peer = i ? 'RbNavAlpha' : 'RbNavBeta';
      const file = path.join(directory, name + '.java');
      created.push(file);
      const source = 'package ' + packageNames[i] + ';\nimport ' + packageNames[1 - i] + '.' + peer +
        ';\npublic final class ' + name + (i ? '' : ' implements RbNavRole') + ' {\n'
        + '    public ' + peer + ' peer;\n'
        + (i ? '    public int call() { return peer.value(2); }\n' :
          '    public int value(int n) { return n; }\n    public int value(String n) { return n.length(); }\n')
        + '}\n';
      await fs.writeFile(file, source, { flag: 'wx' });
      await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    }
    const role = path.join(directories[0], 'RbNavRole.java');
    await fs.writeFile(role, 'package ' + packageNames[0] + ';\npublic interface RbNavRole { int value(int n); }\n', { flag: 'wx' });
    created.push(role);
    await vscode.workspace.openTextDocument(vscode.Uri.file(role));
    const result = await api.java.buildWorkspace();
    assert.ok(result === 1 || result === 0 || result?.status === 'succeed', 'JDT build status ' + JSON.stringify(result));
    const interfaceChildren = findDirection(await find(path.join(prefixes[0], 'RbNavRole.java'),
      'interface RbNavRole', 'RbNavRole', 'type'), 'RbNavRole', 'subtypes');
    const implementationParents = findDirection(await find(path.join(prefixes[0], 'RbNavAlpha.java'),
      'class RbNavAlpha', 'RbNavAlpha', 'type'), 'RbNavAlpha', 'supertypes');
    assert.ok(interfaceChildren.related.some(item => item.symbol.name === 'RbNavAlpha'));
    assert.ok(implementationParents.related.some(item => item.symbol.name === 'RbNavRole'));
    const numeric = await find(path.join(prefixes[0], 'RbNavAlpha.java'), 'value(int n)', 'value', 'call');
    const textual = await find(path.join(prefixes[0], 'RbNavAlpha.java'), 'value(String n)', 'value', 'call');
    assert.ok(numeric.roots.some(item => /value\(int\)/.test(item.symbol.name)));
    assert.ok(textual.roots.some(item => /value\(String\)/.test(item.symbol.name)));
    const betaCall = direction => direction.related.some(item =>
      item.symbol.uri.endsWith('/RbNavBeta.java') && named(item.symbol, 'call'));
    assert.equal(betaCall(findDirection(numeric, 'value', 'incoming')), true);
    assert.equal(betaCall(findDirection(textual, 'value', 'incoming')), false);
    const report = await api.javaNavigation.analyzeDependencies({ includeCompiled: true });
    const cycle = name => {
      const layer = report.layers.find(layer => layer.name === name);
      const lookup = new Map(layer.nodes.map(node => [node.id, node.label]));
      const group = layer.cycles.find(candidate => candidate.members.map(id => lookup.get(id)).sort().join(' ') === packageNames.join(' '));
      assert.equal(group?.witness.length, 2, JSON.stringify({
        layer: name, issues: report.issues, outputs: report.compiledOutputs, nodes: layer.nodes.map(node => node.label)
      }));
      assert.ok(group.witness.every(edge => edge.evidence.uri.endsWith('.java') && edge.evidence.range.start.line > 0));
      return group.witness.length;
    };
    const sourceWitness = cycle('Declared package imports');
    const compiledWitness = cycle('Compiled package references');
    const jdbc = await probeSpringDatabase();
    checks.push('The Java call hierarchy resolves both directions of a real Spring method call and opens its source range. Type hierarchy resolves the real JPA parent and child. The graph preserves reciprocal import and independently compiled package references with separate cycle witnesses.');
    if (jdbc) checks.push('The same Spring project returned live database counts through its JDBC-backed HTTP fixture.');
    return { callers: callsIn.total, callees: callsOut.total, supertypes: superclasses.total, subtypes: subclasses.total,
      matchedCallSites: incoming.callSites.length, sourceWitness, compiledWitness,
      interfaceTypes: true, overloadBinding: true, nativeHierarchyCommands: true,
      sourceFiles: report.sourceFiles, compiledOutputs: report.compiledOutputs.length, jdbc };
  } finally {
    for (const file of created.reverse()) {
      try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const directory of directories.reverse()) await fs.rmdir(directory);
  }
}

module.exports = { runJavaNavigationChecks };
