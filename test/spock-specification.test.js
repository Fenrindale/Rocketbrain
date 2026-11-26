'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { registerGroovyWorkbench, COMMANDS } = require('../src/java/groovy-vscode');
const { execute } = require('../src/java/testing/provision');
const { collectProjects } = require('../src/java/workbench-model');
const { populateSpockSpring, assertSpockSpring, failureLine } = require('./helpers/spock-specification-fixture');
const { scripts } = require('./helpers/groovy-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SPOCK_SPRING_CLASSPATH;
const gradleCache = process.env.ROCKETBRAIN_SPOCK_GRADLE_USER_HOME;
const databases = ['mysql', 'mariadb'].map(engine => [
  engine, process.env['ROCKETBRAIN_SPOCK_' + engine.toUpperCase() + '_CONFIG']
]);
const uri = file => ({ fsPath: file, scheme: 'file', toString: () => pathToFileURL(file).href });

async function source(file) {
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split(/\r?\n/u);
  return { uri: uri(file), languageId: 'groovy', version: 1, lineCount: lines.length, isDirty: false,
    getText: () => text, lineAt: line => ({ text: lines[line] }) };
}

function host(projects, workbench, runtime, runner, document) {
  const commands = new Map(), shown = new Map(), lines = [];
  const dispose = () => ({ dispose() {} });
  const vscode = {
    Uri: { file: uri },
    Range: class { constructor(line, character, endLine, endCharacter) {
      this.start = { line, character }; this.end = { line: endLine, character: endCharacter };
    } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0 },
    ProgressLocation: { Notification: 15 },
    workspace: {
      isTrusted: true, workspaceFolders: projects.map(project => ({ uri: uri(project.root) })), textDocuments: [document],
      getConfiguration: () => ({ get: key => runtime[key] }),
      onDidChangeTextDocument: dispose, onDidChangeWorkspaceFolders: dispose, registerTextDocumentContentProvider: dispose
    },
    languages: { createDiagnosticCollection: () => ({
      dispose() {}, delete() {}, set: (file, diagnostics) => shown.set(file.toString(), diagnostics)
    }) },
    commands: { registerCommand(id, action) { commands.set(id, action); return dispose(); } },
    window: {
      activeTextEditor: { document },
      createOutputChannel: () => ({ dispose() {}, appendLine: text => lines.push(text), show() {} }),
      withProgress: (_settings, action) => action({}, {}),
      showErrorMessage: async () => undefined
    }
  };
  const java = { getState: () => ({ javaHome: runtime.javaHome }), workbench };
  return { api: registerGroovyWorkbench(vscode, java, { specificationRunner: runner }), commands, shown, lines };
}

test('run one actual Spock specification with independent Spring JDBC pass, failure, and skip on both databases', {
  skip: !runtimeFile || !classpathFile || !gradleCache || !databases.every(([, file]) => file),
  timeout: 400000
}, async t => {
  const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
  const parent = await fs.realpath(os.tmpdir());
  const owned = await fs.mkdtemp(path.join(parent, 'rb-spock-actual-'));
  const digest = [], projectPaths = [];
  t.after(async () => {
    assert.equal(await fs.realpath(owned), owned);
    assert.equal(path.dirname(owned), parent);
    assert.match(path.basename(owned), /^rb-spock-actual-/u);
    await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  });
  for (const [engine, configFile] of databases) {
    const fixture = await populateSpockSpring(owned, { classpathFile, configFile, engine, gradleHome: runtime.gradleHome });
    const address = uri(fixture.root).toString();
    projectPaths.push(fixture.root);
    const snapshot = () => collectProjects({ folders: [address], request: async command =>
      command === 'java.project.getAll' ? [address] : command === 'java.project.getSettings' ?
        { 'org.eclipse.jdt.ls.core.sourcePaths': [] } : { classpaths: [], modulepaths: [] } });
    let model = await snapshot();
    const workbench = { getSnapshot: () => model };
    const document = await source(fixture.fixtureSource);
    let attempts = 0, lastOutput;
    const runner = {
      async execute(spec, options) {
        attempts++;
        assert.equal(spec.cwd, fixture.root);
        assert.equal(spec.args.at(-1), ':test');
        const observed = await execute(spec.command, [...spec.args.slice(0, -1), '--offline', ':test'], {
          ...options, cwd: spec.cwd, env: { ...spec.env, GRADLE_USER_HOME: gradleCache }
        });
        lastOutput = observed.output;
        return observed;
      }
    };
    const { api, commands, shown, lines } = host(model.projects, workbench, runtime, runner, document);
    try {
      await assert.rejects(api.runSpecification({ document }), /before executing Gradle/u);
      document.isDirty = true;
      await assert.rejects(api.runSpecification({ document, allowProjectExecution: true }), /saved local Groovy/u);
      document.isDirty = false;
      await assert.rejects(api.runSpecification({ document, projectUri: uri(owned).toString(), allowProjectExecution: true }),
        /in its imported Gradle project/u);
      assert.equal(attempts, 0);
      const selected = await commands.get(COMMANDS.specification)();
      assert.ok(selected, lastOutput || lines.join('\n'));
      assert.equal(selected.source, document.uri.toString());
      const exact = await assertSpockSpring(selected, fixture, engine);
      assert.deepEqual(shown.get(selected.source).map(item => [item.source, item.range.start.line]), [['Spock', failureLine - 1]]);
      assert.ok(lines.includes('groovyfixture.SpringScoreSpec · 1 passed, 1 failed, 1 skipped'));
      const badge = await source(path.join(fixture.root, 'src', 'test', 'groovy', 'groovyfixture', 'BadgeSpec.groovy'));
      const passing = await api.runSpecification({ document: badge, allowProjectExecution: true });
      assert.equal(passing.state, 'succeeded', lastOutput);
      assert.equal(passing.specification, 'groovyfixture.BadgeSpec');
      assert.ok(passing.cases.length === 3 && passing.cases.every(item => item.state === 'SUCCESS'));
      assert.match(passing.cases[0].displayName, /NEO:6/u);
      assert.match(passing.cases[1].displayName, /TRACY:10/u);
      assert.equal(attempts, 2);
      assert.equal(await fs.stat(path.join(fixture.root, scripts.tests)).then(() => true, () => false), false);
      await fs.appendFile(fixture.build, '\n// changed after Java workbench observation\n');
      await assert.rejects(api.runSpecification({ document, allowProjectExecution: true }), /Refresh the imported Gradle project/u);
      assert.equal(attempts, 2);
      let shadowedClassRefused = false;
      if (engine === 'mysql') {
        const binary = path.join('groovyfixture', 'SpringScoreSpec.class');
        const duplicate = path.join(fixture.root, 'shadow', binary);
        await fs.mkdir(path.dirname(duplicate), { recursive: true });
        await fs.copyFile(path.join(fixture.root, 'build', 'classes', 'groovy', 'test', binary), duplicate);
        await fs.appendFile(fixture.build, "\ntest { classpath = files('shadow') + classpath }\n");
        model = await snapshot();
        await assert.rejects(api.runSpecification({ document, allowProjectExecution: true }), /did not run the selected Spock/u);
        assert.match(lastOutput, /test runtime classpath shadows the selected Spock specification/u);
        assert.equal(attempts, 3);
        await assertSpockSpring(selected, fixture, engine);
        shadowedClassRefused = true;
      }
      digest.push({ engine, ...exact, passingSpecificationCases: passing.cases.length, freshnessAndApprovalRefused: true,
        ...(shadowedClassRefused && { shadowedClassRefused }) });
    } finally { await api.dispose(); }
  }
  assert.equal(new Set(projectPaths).size, 2);
  const report = { gradle: '9.1.0', groovy: '4.0.28', spock: '2.4-groovy-4.0', engines: digest };
  if (process.env.ROCKETBRAIN_SPOCK_RECEIPT) {
    await fs.writeFile(process.env.ROCKETBRAIN_SPOCK_RECEIPT, JSON.stringify(report, null, 2) + '\n');
  }
});
