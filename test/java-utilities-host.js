'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

async function workbenchProject(api, root) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const snapshot = await api.java.workbench.refresh();
    const project = snapshot.projects.find(project => !path.relative(project.root, root));
    if (project?.sourceRoots.length) return project;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw Error('JDT did not publish the Spring fixture classpath.');
}

async function replaceScratch(vscode, uri, text) {
  const document = await vscode.workspace.openTextDocument(uri);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
  return document;
}

async function runJavaUtilitiesChecks(api, vscode, checks) {
  const config = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const engine = process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE;
  assert.equal(config.dbEngine, engine);
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.ok(api.javaUtilities);
  const root = config.projectPath;
  const sourceRoot = path.join(root, 'src/main/java');
  const packageName = 'fixture.boot';
  const name = 'V28Scratch' + crypto.randomBytes(5).toString('hex');
  const typePath = path.join(sourceRoot, 'fixture', 'boot', name + '.java');
  const sourceUri = vscode.Uri.file(typePath);
  const settings = vscode.workspace.getConfiguration('rocketbrain.java', sourceUri);
  const userTarget = vscode.ConfigurationTarget.Global;
  const oldTemplates = settings.inspect('fileTemplates')?.globalValue;
  const savedScratch = [];
  let created;
  try {
    const project = await workbenchProject(api, root);
    await settings.update('fileTemplates', [{
      name: 'Spring JDBC probe',
      source: 'main',
      template: '${packageDeclaration}import org.springframework.stereotype.Service;\n' +
        '@Service public class ${name} { public static int probe() { return 42; } }\n'
    }], userTarget);
    const request = { sourceRoot, packageName, name, templateName: 'Spring JDBC probe' };
    created = await vscode.commands.executeCommand('rocketbrain.java.newFileFromTemplate', request);
    assert.equal(path.relative(typePath, created.uri.fsPath), '');
    const generatedText = await fs.readFile(typePath, 'utf8');
    assert.match(generatedText, /^package fixture\.boot;[\s\S]*@Service public class/);
    await assert.rejects(api.javaUtilities.createFile(request), /already exists/);
    assert.equal(await fs.readFile(typePath, 'utf8'), generatedText);
    const buildResult = await api.java.buildWorkspace();
    assert.ok(buildResult === 1 || buildResult === 0 || buildResult?.status === 'succeed', 'Actual built Spring fixture status: ' + JSON.stringify(buildResult));
    const scratch = await vscode.commands.executeCommand('rocketbrain.java.openScratch', { name });
    savedScratch.push(scratch.uri);
    await replaceScratch(vscode, scratch.uri, 'import fixture.boot.' + name + ';\n' + name + '.probe();\n');
    const nativeIsolated = await vscode.commands.executeCommand('rocketbrain.java.runScratch', { uri: scratch.uri });
    assert.equal(nativeIsolated.classpathEntries, 0);
    assert.equal(nativeIsolated.state, 'failed');
    assert.match(nativeIsolated.output, /fixture\.boot does not exist|cannot find symbol/);
    const script = 'import fixture.boot.' + name + ';\n'
      + 'import org.springframework.stereotype.Service;\n'
      + 'import java.net.URI;\nimport java.net.http.*;\n'
      + name + '.class.isAnnotationPresent(Service.class);\n' + name + '.probe();\n'
      + 'var response = HttpClient.newHttpClient().send(HttpRequest.newBuilder(URI.create('
      + JSON.stringify(config.baseUrl + '/probe/testing-state')
      + ')).build(), HttpResponse.BodyHandlers.ofString());\n'
      + 'System.out.println("RB " + response.statusCode() + " " + response.body());\n';
    const document = await replaceScratch(vscode, scratch.uri, script);
    assert.equal(document.isDirty, true);
    const classpath = await vscode.commands.executeCommand('rocketbrain.java.runScratch',
      { uri: scratch.uri, projectUri: project.uri });
    assert.equal(classpath.state, 'finished', classpath.output);
    assert.ok(classpath.classpathEntries > 0 && classpath.jdkVersion >= 25);
    assert.match(classpath.output, /(?:^|\n)true\r?\n42\r?\n/);
    const output = classpath.output.split(/\r?\n/).find(line => line.startsWith('RB 200 '));
    const isolation = JSON.parse(output.slice('RB 200 '.length));
    assert.deepEqual(isolation, { people: 2, departments: 1, rolledBackNames: 0 });
    assert.equal(await document.save(), true);
    const reopened = await vscode.commands.executeCommand('rocketbrain.java.openScratch', { name });
    assert.equal(reopened.uri.fsPath, scratch.uri.fsPath);
    assert.equal((await vscode.workspace.openTextDocument(reopened.uri)).getText(), script);
    checks.push('The native file template command creates and opens a packaged Spring service, rejects a conflicting source, and JDT compiles it. Java Scratch requires classpath opt-in, reads unsaved source, uses the generated Spring class and checks the real Spring/JDBC fixture; reopening retains the saved draft.');
    return {
      templateCreated: true, duplicateRejected: true, compiledByJdt: true, isolatedClasspathRefused: true,
      dirtyJshellUsed: true, scratchReopened: true, classpathEntries: classpath.classpathEntries,
      jdkVersion: classpath.jdkVersion, generatedValue: 42, isolation
    };
  } finally {
    for (const uri of savedScratch) {
      const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
      if (document?.isDirty) await document.save();
      await fs.unlink(uri.fsPath);
    }
    if (created) await fs.unlink(typePath);
    await settings.update('fileTemplates', oldTemplates, userTarget);
  }
}

module.exports = { runJavaUtilitiesChecks };
