'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { nativeTaskRunner } = require('../src/java/workbench-tasks');
const { test } = require('node:test');
const { resolveJavaSourceTarget, settingsKeys } = require('../src/java/source-target');
const { resolveBuildTarget } = require('../src/java/source-target-builds');
const { bindModel } = require('../src/java/gradle-source-model');
const { declaredExecutions, mavenExecutionArgument, namedProfileExecutions, bindMavenProfileRuntime } = require('../src/java/maven-source-execution');
const { registerJavaWorkbench } = require('../src/java/workbench');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { fakeVscode, fixture } = require('./java-workbench-fixture');
const { populateTargets, buildTargets, runTargets, executionCases, runObservedGradleComposite,
  populateMavenSourceExecution, runDeclaredMavenExecution, populateMavenProfileExecution,
  runDeclaredMavenProfileExecution } = require('./helpers/java-source-target-fixture');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const url = file => pathToFileURL(file).href;
const same = (left, right) => path.relative(left, right) === '';
const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SOURCE_TARGET_CLASSPATH;
const mavenHome = process.env.ROCKETBRAIN_TARGET_MAVEN_HOME;
const gradleCache = process.env.ROCKETBRAIN_SOURCE_TARGET_GRADLE_CACHE;
const executeFromSource = process.env.ROCKETBRAIN_SOURCE_TARGET_EXECUTION === '1';
const observeComposite = process.env.ROCKETBRAIN_SOURCE_TARGET_GRADLE_MODEL === '1';
const declareMaven = process.env.ROCKETBRAIN_SOURCE_TARGET_MAVEN_EXECUTION === '1';
const declareMavenProfile = process.env.ROCKETBRAIN_SOURCE_TARGET_MAVEN_PROFILE === '1';
const environments = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_SOURCE_TARGET_' + engine.toUpperCase() + '_CONFIG']]);

async function owned(t) {
  const parent = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(parent, 'rb-source-target-'));
  t.after(async () => {
    assert.equal(await fs.realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    assert.match(path.basename(directory), /^rb-source-target-/u);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  });
  const root = path.join(directory, 'mixed');
  return { directory, root, targets: await populateTargets(root) };
}

function presentation(host) {
  const open = [], displayed = [], documents = new Map();
  const vscode = host.vscode;
  const parse = vscode.Uri.parse;
  vscode.Uri.parse = value => ({ ...parse(value), path: new URL(value).pathname });
  vscode.Range = class {
    constructor(sl, sc, el, ec) { this.start = { line: sl, character: sc }; this.end = { line: el, character: ec }; }
  };
  const original = vscode.workspace.openTextDocument;
  vscode.workspace.registerTextDocumentContentProvider = (scheme, provider) => {
    documents.set(scheme, provider);
    return { dispose: () => documents.delete(scheme) };
  };
  vscode.workspace.openTextDocument = address => {
    open.push(address);
    return address.scheme === 'file' ? original(address) :
      { uri: address, getText: () => documents.get(address.scheme).provideTextDocumentContent(address) };
  };
  vscode.window.showTextDocument = async (document, options) => {
    const result = { document, selection: options.selection };
    displayed.push(result);
    return result;
  };
  return { open, displayed };
}

test('read-only scoped target refuses a parent guess and stale or dirty declarations', async t => {
  const { directory, root, targets } = await owned(t);
  const parent = path.join(root, 'maven'), component = path.join(parent, 'service');
  const source = path.join(component, 'src/main/java');
  const calls = [];
  let returned = component, imported = true, sourceRoots = [source];
  const request = async (command, args) => {
    calls.push([command, args]);
    if (command === 'java.project.getAll') return [url(root), url(parent), ...(imported ? [url(component)] : [])];
    if (command === 'java.project.getClasspaths') return { projectRoot: url(returned), classpaths: [], modulepaths: [] };
    if (command === 'java.project.getSettings') return { [settingsKeys[0]]: sourceRoots, [settingsKeys[3]]: ['org.eclipse.m2e.core.maven2Nature'] };
    throw Error('Unexpected metadata request: ' + command);
  };
  const inputs = { sourceUri: targets.maven, folders: [root], request };
  const found = await resolveJavaSourceTarget(inputs);
  assert.equal(found.projectRoot, component);
  assert.equal(found.declaredBuild.reactorProject, 'service');
  assert.equal(found.provider, 'maven');
  assert.equal(found.executedProjectCode, false);
  assert.ok(calls.filter(([command]) => command !== 'java.project.getAll').every(([, args]) => args[0] === targets.maven));
  returned = parent;
  await assert.rejects(resolveJavaSourceTarget(inputs), /exact imported Java component/u);
  imported = false;
  await assert.rejects(resolveJavaSourceTarget(inputs), /Import the nested Java component/u);
  imported = true;
  returned = component;
  sourceRoots = [path.join(component, 'src/test/java')];
  await assert.rejects(resolveJavaSourceTarget(inputs), /outside the imported component source roots/u);
  sourceRoots = [source];

  const host = fakeVscode({ parent: directory, root, uri: url(root) });
  host.java.requestWorkspaceCommand = request;
  const ui = presentation(host);
  host.vscode.ProgressLocation = { Notification: 15 };
  host.vscode.window.withProgress = async (_options, run) => run({}, undefined);
  host.vscode.window.activeTextEditor = { document: { uri: host.vscode.Uri.parse(targets.maven) } };
  const workbench = registerJavaWorkbench(host.context, host.vscode, host.java, host.output, { runner: host.runner });
  try {
    const checked = await workbench.sourceTarget.inspect({ sourceUri: targets.maven });
    const view = await workbench.sourceTarget.show(checked.id);
    assert.match(view.document.getText(), /Reactor module: service/u);
    const command = await host.commands.get('rocketbrain.java.workbench.sourceTarget')();
    assert.match(command.document.getText(), /Reactor module: service/u);
    const module = await workbench.sourceTarget.openBuild(checked.id, 0);
    assert.ok(same(fileURLToPath(module.uri), path.join(parent, 'pom.xml')));
    assert.equal(ui.displayed.at(-1).selection.start.line, 4);
    const file = path.join(component, 'pom.xml');
    host.vscode.workspace.textDocuments.push({ uri: host.vscode.Uri.parse(url(file)), isDirty: true });
    await assert.rejects(workbench.sourceTarget.inspect({ sourceUri: targets.maven }), /Save the Java build descriptor/u);
    host.vscode.workspace.textDocuments.length = 0;
    await fs.appendFile(file, '<!-- changed -->\n');
    await assert.rejects(workbench.sourceTarget.openBuild(checked.id), /Refresh the Java source target/u);
    assert.equal(host.specs.length, 0);
    assert.ok(ui.open.every(address => address.scheme === 'rocketbrain-java-source-target' ||
      same(address.fsPath, path.join(parent, 'pom.xml'))));
  } finally { await workbench.dispose(); }
});

test('Windows editor drive casing still resolves the exact imported Java source component', {
  skip: process.platform !== 'win32'
}, async t => {
  const { root, targets } = await owned(t);
  const parent = path.join(root, 'maven'), component = path.join(parent, 'service');
  const jdtUri = file => url(file).replace(/^file:\/\/\/([a-z]):/iu, (_, drive) => 'file:///' + drive.toUpperCase() + ':');
  const editorUri = targets.maven.replace(/^file:\/\/\/([a-z]):/iu, (_, drive) => 'file:///' + drive.toLowerCase() + '%3A');
  assert.match(editorUri, /^file:\/\/\/[a-z]%3A/u);
  assert.match(jdtUri(component), /^file:\/\/\/[A-Z]:/u);
  let imported = true;
  const calls = [];
  const request = async command => {
    calls.push(command);
    if (command === 'java.project.getAll') return [jdtUri(parent), ...(imported ? [jdtUri(component)] : [])];
    if (command === 'java.project.getClasspaths') return { projectRoot: jdtUri(component), classpaths: [], modulepaths: [] };
    if (command === 'java.project.getSettings') return {
      [settingsKeys[0]]: [path.join(component, 'src/main/java')],
      [settingsKeys[3]]: ['org.eclipse.m2e.core.maven2Nature']
    };
    throw Error('Unexpected metadata request: ' + command);
  };
  const input = { sourceUri: editorUri, folders: [root], request };
  const target = await resolveJavaSourceTarget(input);
  assert.ok(same(target.projectRoot, component));
  assert.equal(target.declaredBuild.reactorProject, 'service');
  imported = false;
  calls.length = 0;
  await assert.rejects(resolveJavaSourceTarget(input), /Import the nested Java component/u);
  assert.deepEqual(calls, ['java.project.getAll']);
});

test('literal Gradle aliases retain source ranges and computed membership omits an unproven path', async t => {
  const { root } = await owned(t), component = path.join(root, 'gradle/vendor/service');
  const inspect = () => resolveBuildTarget(component, root, () => false).build;
  const initial = inspect();
  assert.equal(initial.kind, 'gradle');
  assert.equal(initial.projectPath, ':service');
  assert.equal(initial.buildTreePath, ':linked-tools:service');
  assert.equal(initial.declarations[1].range.start.line, 2);
  await fs.appendFile(path.join(root, 'gradle/vendor/settings.gradle.kts'), 'project(":service").projectDir = file("custom")\n');
  const computed = inspect();
  assert.equal(computed.kind, 'gradle');
  assert.equal(computed.projectPath, undefined);
  assert.equal(computed.buildTreePath, undefined);
  assert.deepEqual(computed.declarations, []);
});

test('source build review preserves exact argv, requires approval and invalidates used or stale tickets', async t => {
  const { directory, root, targets } = await owned(t);
  const tool = fixture(t);
  const host = fakeVscode({ ...tool, parent: directory, root, uri: url(root) });
  const module = path.join(root, 'maven/service'), reactor = path.join(root, 'maven');
  host.java.requestWorkspaceCommand = async name => {
    if (name === 'java.project.getAll') return [url(reactor), url(module)];
    if (name === 'java.project.getClasspaths') return { projectRoot: url(module), classpaths: [], modulepaths: [] };
    if (name === 'java.project.getSettings') return { [settingsKeys[0]]: [path.join(module, 'src/main/java')],
      [settingsKeys[3]]: ['org.eclipse.m2e.core.maven2Nature'], [settingsKeys[5]]: tool.javaHome };
    throw Error('Unexpected metadata command: ' + name);
  };
  const workbench = registerJavaWorkbench(host.context, host.vscode, host.java, host.output, { runner: host.runner });
  try {
    const actor = workbench.sourceTarget;
    const inspection = await actor.inspect({ sourceUri: targets.maven });
    const review = await actor.reviewBuild(inspection.id);
    assert.equal(host.specs.length, 0);
    assert.deepEqual(review.args.slice(-6), ['compile', '--file', path.join(reactor, 'pom.xml'), '--projects', 'service', '--also-make']);
    await assert.rejects(actor.runBuild(review.id), /Approve.*explicitly/u);
    assert.equal(host.specs.length, 0);
    const expected = [...review.args];
    review.args.push('install');
    const launched = await Promise.allSettled([
      actor.runBuild(review.id, { allowProjectExecution: true }), actor.runBuild(review.id, { allowProjectExecution: true })
    ]);
    assert.equal(launched[0].value.state, 'succeeded');
    assert.match(launched[1].reason.message, /expired or was already used/u);
    assert.deepEqual(host.specs[0].args, expected);
    assert.equal(host.specs[0].cwd, reactor);
    const staleSibling = await actor.reviewBuild(inspection.id);
    const dependency = path.join(reactor, 'core/pom.xml'), preserved = await fs.readFile(dependency);
    await fs.appendFile(dependency, '<!-- sibling build input changed -->\n');
    try { await assert.rejects(actor.runBuild(staleSibling.id, { allowProjectExecution: true }), /command or inputs changed/u); }
    finally { await fs.writeFile(dependency, preserved); }
    const stopped = await actor.reviewBuild(inspection.id);
    const command = host.java.requestWorkspaceCommand;
    let entered, resume;
    const waiting = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    host.java.requestWorkspaceCommand = async (name, args) => {
      if (name === 'java.project.getAll') { entered(); await gate; }
      return command(name, args);
    };
    const refused = assert.rejects(actor.runBuild(stopped.id, { allowProjectExecution: true }), /stopped before launch/u);
    await waiting;
    try { await workbench.stop(); }
    finally { resume(); host.java.requestWorkspaceCommand = command; }
    await refused;
    const mavenConfig = path.join(reactor, '.mvn/maven.config'), original = await fs.readFile(mavenConfig);
    await fs.appendFile(mavenConfig, '--projects\ncore\n');
    try { await assert.rejects(actor.reviewBuild(inspection.id), /options that can alter the reviewed reactor command/u); }
    finally { await fs.writeFile(mavenConfig, original); }
    assert.equal(host.specs.length, 1);

    host.vscode.ProgressLocation = { Notification: 15 };
    host.vscode.window.withProgress = async (_options, run) => run({}, undefined);
    host.vscode.window.showQuickPick = async items => items.find(item => item.label === 'Review Compile for This Source');
    let approved = false;
    host.vscode.window.showWarningMessage = async (_name, option, answer) => {
      assert.equal(option.modal, true);
      assert.match(option.detail, /"--projects",\n  "service"/u);
      return approved ? answer : undefined;
    };
    const open = () => host.commands.get('rocketbrain.java.workbench.sourceTarget')(host.vscode.Uri.parse(targets.maven));
    assert.equal(await open(), undefined);
    assert.equal(host.specs.length, 1);
    approved = true;
    assert.equal((await open()).state, 'succeeded');
    assert.equal(host.specs.length, 2);
    assert.deepEqual(host.specs[1].args, expected);
  } finally { await workbench.dispose(); }
});

test('the observed Gradle composite rejects outside, duplicate and guessed source ownership', async t => {
  const { root, directory } = await owned(t);
  const composite = path.join(root, 'gradle'), included = path.join(composite, 'vendor');
  const component = path.join(included, 'service'), workbench = path.join(composite, 'workbench');
  const context = { project: { root: composite }, component, files: [
    path.join(composite, 'settings.gradle'), path.join(included, 'settings.gradle.kts'),
    path.join(component, 'build.gradle.kts'), path.join(workbench, 'build.gradle')
  ].map(file => [file, 'digest']) };
  const rootRecord = { kind: 'B', buildRoot: composite, parent: '' };
  const includeRecord = { kind: 'B', buildRoot: included, parent: composite };
  const project = { kind: 'P', buildRoot: included, component, projectPath: ':service', treePath: ':observed:service' };
  const rootRecords = [rootRecord, { kind: 'P', buildRoot: composite, component: composite, projectPath: ':', treePath: ':' }];
  const records = [...rootRecords, includeRecord, project];
  const model = bindModel(records, context);
  assert.equal(model.selected.treePath, ':observed:service');
  assert.match(model.membershipSha256, /^[0-9a-f]{64}$/u);
  assert.throws(() => bindModel([...records, project], context), /ambiguous/u);
  assert.throws(() => bindModel([...rootRecords, { ...includeRecord, buildRoot: directory }], context), /workspace/u);
  assert.throws(() => bindModel([...rootRecords, { ...includeRecord, parent: included }, project], context), /disconnected/u);
  assert.throws(() => bindModel(records, { ...context, component: workbench }), /does not belong/u);
});

test('Maven source execution catalog rejects ambiguous names and excludes unresolved or inherited-only declarations', () => {
  const one = '<execution><id>exact-name</id><goals><goal>compile</goal></goals></execution>';
  const plugin = (version, values) => '<plugin><artifactId>maven-compiler-plugin</artifactId><version>' + version +
    '</version><executions>' + values + '</executions></plugin>';
  const make = (body, managed = '') => ({ digest: 'model-sha', uri: 'file:///pom.xml',
    text: '<project xmlns="http://maven.apache.org/POM/4.0.0"><build><plugins>' + body + '</plugins>' +
      '<pluginManagement><plugins>' + managed + '</plugins></pluginManagement></build></project>' });
  const [review] = declaredExecutions(make(plugin('3.15.0', one)));
  assert.equal(review.task, 'org.apache.maven.plugins:maven-compiler-plugin:3.15.0:compile@exact-name');
  assert.equal(mavenExecutionArgument(review.task), true);
  assert.equal(mavenExecutionArgument(review.task + ' --projects sibling'), false);
  assert.equal(mavenExecutionArgument(review.task + '@alternate'), false);
  assert.throws(() => declaredExecutions(make(plugin('3.15.0', one + one))), /duplicate Maven execution IDs/u);
  assert.throws(() => declaredExecutions(make(plugin('3.15.0', one) + plugin('3.16.0', one))), /duplicate Maven plugin/u);
  assert.deepEqual(declaredExecutions(make(plugin('3.15.0-SNAPSHOT', one))), []);
  assert.deepEqual(declaredExecutions(make(plugin('LATEST', one))), []);
  assert.deepEqual(declaredExecutions(make('', plugin('3.15.0', one))), []);
  assert.deepEqual(declaredExecutions(make(plugin('3.15.0', one.replace('exact-name', '')))), []);
});

test('named Maven profiles bind a distinct execution and exclude automatic or competing declarations', () => {
  const named = (name, body) => '<profile><id>' + name + '</id>' + body + '</profile>';
  const build = '<build><plugins><plugin><artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version>' +
    '<executions><execution><id>exact</id><goals><goal>compile</goal></goals></execution></executions></plugin></plugins></build>';
  const file = (profiles, other = '') => ({ digest: 'model-sha', uri: 'file:///pom.xml',
    text: '<project>' + other + '<profiles>' + profiles + '</profiles></project>' });
  const selected = named('manual', build);
  const other = named('other', '<activation><activeByDefault>true</activeByDefault></activation>' + build);
  const choices = namedProfileExecutions(file(selected + other + named('second', build)), []);
  assert.deepEqual(choices.map(item => item.profile.name), ['manual', 'second']);
  assert.deepEqual(choices[0].profile.inactive, ['other', 'second']);
  assert.notEqual(choices[0].id, choices[1].id);
  assert.equal(choices[0].task, choices[1].task);
  assert.throws(() => namedProfileExecutions(file(selected + selected), []), /uniquely and literally/u);
  assert.throws(() => namedProfileExecutions(file(selected + named('bad,name', build)), []), /uniquely and literally/u);
  assert.throws(() => namedProfileExecutions(file(selected + named('modules', '<modules><module>unknown</module></modules>')), []),
    /change reactor membership/u);
  assert.throws(() => namedProfileExecutions(file(selected, build), []), /ID also appears outside/u);
  assert.throws(() => namedProfileExecutions(file(selected), [{ text: '<project>' + build + '</project>' }]), /ID also appears outside/u);
  assert.throws(() => namedProfileExecutions(file(selected), [{ text: '<project>' + build.replace('maven-compiler-plugin', '${compiler}') +
    '</project>' }]), /computed Maven execution identities/u);
  assert.throws(() => namedProfileExecutions(file(selected.replace('<id>manual', '<id xml:space="preserve"> manual')), []),
    /whitespace rules/u);
  assert.throws(() => namedProfileExecutions(file(selected), [], [
    { text: '<project><profiles xmlns="urn:unobserved">' + other + '</profiles></project>' }
  ]), /conventional XML namespace/u);
});

test('named Maven runtime isolates default configuration and binds released plugin artifacts', () => {
  const root = path.resolve('test-output', 'owned-default-maven-model');
  const repository = path.join(root, 'repository'), home = path.join(root, 'dist');
  const settings = path.join(home, 'conf', 'settings.xml'), toolchains = path.join(home, 'conf', 'toolchains.xml');
  const plugin = path.join(repository, 'org', 'apache', 'maven', 'plugins', 'maven-compiler-plugin', '3.15.0', 'maven-compiler-plugin-3.15.0');
  const execution = { group: 'org.apache.maven.plugins', artifact: 'maven-compiler-plugin', version: '3.15.0',
    profile: { name: 'one', inactive: ['implicit'] } };
  const inputs = new Map([
    [settings, { text: '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"><profiles><!-- example --></profiles></settings>' }],
    [toolchains, { text: '<toolchains/>' }], [plugin + '.pom', { digest: 'pom-digest' }], [plugin + '.jar', { digest: 'jar-digest' }]
  ]);
  const review = () => bindMavenProfileRuntime(home, execution, file => inputs.get(file), repository);
  assert.deepEqual(review(), { args: ['--activate-profiles=one,!implicit', '--settings', settings, '--global-settings', settings,
    '--toolchains', toolchains, '--global-toolchains', toolchains, '-Dmaven.repo.local=' + repository],
    artifacts: { pomSha256: 'pom-digest', jarSha256: 'jar-digest' } });
  inputs.set(plugin + '.jar', { digest: 'changed-jar' });
  assert.equal(review().artifacts.jarSha256, 'changed-jar');
  inputs.set(settings, { text: '<settings><activeProfiles><activeProfile>implicit</activeProfile></activeProfiles></settings>' });
  assert.throws(review, /profile-free Maven settings/u);
  inputs.set(settings, { text: '<settings/>' });
  inputs.set(toolchains, { text: '<toolchains><toolchain><type>jdk</type></toolchain></toolchains>' });
  assert.throws(review, /empty toolchains catalog/u);
  inputs.set(toolchains, { text: '<toolchains/>' });
  inputs.delete(plugin + '.jar');
  assert.throws(review, /Cache the exact released Maven plugin/u);
});

test('reviewed builds launch the exact process and stop without registering a replayable VS Code task', { timeout: 20000 }, async () => {
  const output = [];
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const runner = nativeTaskRunner({ workspace: { isTrusted: true } }, {
    output: { append(value) { output.push(value); if (output.join('').includes('ready')) ready(); } }
  });
  const spec = { reviewedSourceTarget: true, command: process.execPath, cwd: __dirname, env: process.env,
    args: ['-e', 'console.log(process.argv[1]);setTimeout(()=>{},30000);', 'ready'],
    label: 'Owned reviewed child process' };
  try {
    const operation = runner.execute(spec, { timeoutMs: 30000 });
    await Promise.race([started, operation.then(result => assert.fail('Reviewed process exited before output: ' + result.code))]);
    await runner.stop();
    assert.equal((await operation).cancelled, true);
    assert.match(output.join(''), /^ready\r?\n/u);
  } finally { await runner.dispose(); }
});

test('actual JDT selects Maven reactor and Gradle composite sources inside one workspace on both Spring DBs', {
  skip: !runtimeFile || !classpathFile || !mavenHome || !gradleCache || !environments.every(([, file]) => file), timeout: 650000
}, async t => {
  const { directory, root, targets } = await owned(t);
  const mavenExecutionSource = declareMaven ? await populateMavenSourceExecution(root) : undefined;
  const mavenProfileSource = declareMavenProfile ? await populateMavenProfileExecution(root) : undefined;
  const runtime = await read(runtimeFile), tools = { javaHome: runtime.javaHome, mavenHome, gradleHome: runtime.gradleHome };
  assert.ok(tools.gradleHome);
  if (!executeFromSource) await buildTargets(root, tools, gradleCache);
  const configs = await Promise.all(environments.map(async ([engine, file]) => [engine, await read(file)]));
  const launch = resolveLaunch({ ...runtime, storagePath: path.join(directory, 'jdt') });
  launch.options.env.GRADLE_USER_HOME = gradleCache;
  const lsp = new StdioLsp(launch);
  const settings = serverSettings([{ name: 'JavaSE-25', path: tools.javaHome, default: true }],
    { gradleHome: tools.gradleHome, gradleJavaHome: tools.javaHome });
  settings.java.import.gradle.wrapper.enabled = false;
  settings.java.autobuild.enabled = false;
  try {
    await lsp.request('initialize', { processId: process.pid, rootUri: url(root), workspaceFolders: [{ uri: url(root), name: 'combined-targets' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true }, textDocument: {} },
      initializationOptions: { bundles: [], workspaceFolders: [url(root)], settings } }, 90000);
    lsp.notify('initialized', {});
    const commands = [];
    const request = async (command, args) => {
      commands.push({ command, args });
      return lsp.request('workspace/executeCommand', { command, arguments: args }, 90000);
    };
    const componentPaths = ['maven/service', 'gradle/workbench', 'gradle/vendor/service'].map(relative => path.join(root, relative));
    if (declareMaven) componentPaths.push(path.join(root, 'maven/execution-worker'));
    if (declareMavenProfile) componentPaths.push(path.join(root, 'maven-profile/worker'));
    await until(async () => {
      const found = await request('java.project.getAll', []);
      return componentPaths.every(project => found.some(entry => {
        try { return same(project, fileURLToPath(entry)); } catch { return false; }
      }));
    }, 160000);
    const host = fakeVscode({ parent: directory, root, uri: url(root), ...tools });
    host.java.requestWorkspaceCommand = request;
    const ui = presentation(host), executed = [];
    const actual = nativeTaskRunner(host.vscode, { output: host.output });
    const runner = executeFromSource || observeComposite || declareMaven || declareMavenProfile ? { ...actual, async execute(spec, options) {
      executed.push({ args: [...spec.args], cwd: spec.cwd });
      const result = await actual.execute(spec, options);
      assert.equal(result.code, 0, result.output);
      return result;
    } } : host.runner;
    const workbench = registerJavaWorkbench(host.context, host.vscode, host.java, host.output, { runner });
    try {
      const observations = {};
      for (const [name, sourceUri] of Object.entries(targets)) {
        const result = await workbench.sourceTarget.inspect({ sourceUri });
        observations[name] = result;
        assert.equal(result.executedProjectCode, false);
        const nameWanted = name.startsWith('maven') ? 'maven/service' : name.startsWith('included') ? 'gradle/vendor/service' : 'gradle/workbench';
        assert.ok(same(result.projectRoot, path.join(root, nameWanted)));
        const expectedTest = name.endsWith('Test');
        assert.equal(result.sourceRole, expectedTest ? 'test' : 'main');
        assert.equal(result.scope, expectedTest ? 'test' : 'runtime');
        assert.equal(result.classpath.some(file => file.endsWith('junit-jupiter-api-6.1.3.jar')), expectedTest);
        assert.equal(result.provider, name.startsWith('maven') ? 'maven' : 'gradle');
      }
      assert.equal(observations.maven.declaredBuild.coordinates, 'fixture.targets:reactor-service:1');
      assert.equal(observations.maven.declaredBuild.reactorProject, 'service');
      assert.equal(observations.gradle.declaredBuild.projectPath, ':workbench');
      assert.equal(observations.included.declaredBuild.buildTreePath, ':linked-tools:service');
      const opened = await workbench.sourceTarget.openBuild(observations.includedTest.id, 1);
      assert.ok(same(fileURLToPath(opened.uri), path.join(root, 'gradle/settings.gradle')));
      assert.equal(opened.range.start.line, 2);
      assert.equal(ui.displayed.length, 1);
      assert.equal(host.specs.length, 0);
      assert.equal(executed.length, 0);
      const builds = [];
      if (executeFromSource) {
        assert.equal(process.env.GRADLE_USER_HOME, gradleCache);
        for (const [name, folder, selector, task, output] of executionCases) {
          const file = path.join(root, output);
          await assert.rejects(fs.access(file), { code: 'ENOENT' });
          const source = await workbench.sourceTarget.inspect({ sourceUri: targets[name] });
          const review = await workbench.sourceTarget.reviewBuild(source.id);
          assert.equal(review.cwd, path.join(root, folder));
          assert.equal(review.selector, selector);
          assert.equal(review.task, task);
          assert.equal(executed.length, builds.length);
          await assert.rejects(workbench.sourceTarget.runBuild(review.id), /Approve.*explicitly/u);
          const result = await workbench.sourceTarget.runBuild(review.id, { allowProjectExecution: true });
          assert.equal(result.state, 'succeeded');
          assert.deepEqual(executed.at(-1), { cwd: review.cwd, args: review.args });
          assert.equal((await fs.readFile(file)).readUInt32BE(0), 0xcafebabe);
          await assert.rejects(workbench.sourceTarget.runBuild(review.id, { allowProjectExecution: true }), /already used/u);
          builds.push({ selector, task, compiledClass: output, argvVerified: true });
        }
      }
      const observedComposite = observeComposite ? await runObservedGradleComposite(workbench.sourceTarget, root, targets) : undefined;
      const mavenExecution = declareMaven ? await runDeclaredMavenExecution(workbench.sourceTarget, root, mavenExecutionSource) : undefined;
      const mavenProfile = declareMavenProfile ? await runDeclaredMavenProfileExecution(workbench.sourceTarget, root, mavenProfileSource) : undefined;
      const db = (await Promise.all(configs.map(([engine, database]) =>
        runTargets(root, tools, classpathFile, database, engine, { declareMavenProfile })))).flat();
      assert.ok(commands.every(item => ['java.project.getAll', 'java.project.getSettings', 'java.project.getClasspaths'].includes(item.command)));
      const proof = { selected: Object.fromEntries(Object.entries(observations).map(([key, value]) => [key, {
        project: path.relative(root, value.projectRoot).split(path.sep).join('/'), provider: value.provider, scope: value.scope,
        buildPath: value.declaredBuild.buildTreePath || value.declaredBuild.projectPath || value.declaredBuild.reactorProject,
        testClasspath: value.classpath.some(file => file.endsWith('junit-jupiter-api-6.1.3.jar'))
      }])), jdbc: db, builds, readOnlyMetadata: true, openedGradleSourceDeclaration: true,
        ...(observedComposite && { observedComposite }), ...(mavenExecution && { mavenExecution }), ...(mavenProfile && { mavenProfile }) };
      if (process.env.ROCKETBRAIN_SOURCE_TARGET_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SOURCE_TARGET_RECEIPT,
        JSON.stringify(proof, null, 2) + '\n');
    } finally { await workbench.dispose(); }
  } finally { await lsp.close(); }
});
