'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { registerJavaChangeSignature } = require('../src/java/change-signature');
const { registerJavaRefactoring } = require('../src/java/refactoring');
const { resolveLaunch, serverSettings } = require('../src/java/runtime');
const { StdioLsp, until } = require('./helpers/stdio-lsp');
const { uri, headlessHost } = require('./helpers/java-signature-jdt-host');
const { selection } = require('./helpers/java-signature-references-fixture');
const { owner, sources, marker, change, legacyDescriptor, expandedDescriptor, populateCompatibility,
  compileCompatibility, compileLegacyClient, checkLegacyClient, runCompatibilitySpring, assertCompatibilityPlan } =
  require('./helpers/java-signature-compatibility-fixture');

const runtimeFile = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_SIGNATURE_COMPAT_CLASSPATH;
const engines = ['mysql', 'mariadb'].map(engine => [engine,
  process.env['ROCKETBRAIN_SIGNATURE_COMPAT_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

test('Change Signature retains a live JVM descriptor for a previously compiled client, while both local callers and Spring use the new overload',
  { skip: !runtimeFile || !classpathFile || !engines.every(([, file]) => file), timeout: 400000 }, async t => {
    const parent = await fs.realpath(os.tmpdir());
    const owned = await fs.mkdtemp(path.join(parent, 'rb-compat-signature-'));
    const root = path.join(owned, 'project'), runtime = await read(runtimeFile), javaHome = runtime.javaHome;
    let lsp, service, refactoring;
    t.after(async () => {
      await service?.dispose();
      await refactoring?.dispose();
      await lsp?.close();
      assert.equal(await fs.realpath(owned), owned);
      assert.equal(path.dirname(owned), parent);
      assert.match(path.basename(owned), /^rb-compat-signature-/u);
      await fs.rm(owned, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
    });
    await populateCompatibility(root, classpathFile, 'mysql');
    const original = await compileCompatibility({ javaHome, root, scratch: path.join(owned, 'original') });
    assert.ok(original.descriptors.includes(legacyDescriptor) && !original.descriptors.includes(expandedDescriptor));
    assert.equal(original.oldCallerSites, 2);
    assert.equal(original.newCallerSites, 0);
    const client = await compileLegacyClient(javaHome, original.archive, path.join(owned, 'legacy-client'));
    const beforeLegacy = await checkLegacyClient(javaHome, original.archive, client);
    const fixtures = await Promise.all(engines.map(async ([engine, config]) => [engine, await read(config)]));
    const run = (stage, artifact) => Promise.all(fixtures.map(async ([engine, database]) => runCompatibilitySpring({
      javaHome, archive: artifact.archive, scratch: path.join(owned, stage, engine), classpathFile, database, engine
    })));
    const before = await run('db-before', original);

    const settings = serverSettings([{ name: 'JavaSE-25', path: javaHome, default: true }]);
    settings.java.autobuild.enabled = false;
    settings.java.import.gradle.enabled = false;
    const rootUri = uri(root).toString();
    lsp = new StdioLsp(resolveLaunch({ ...runtime, storagePath: path.join(owned, 'jdt') }));
    await lsp.request('initialize', { processId: process.pid, rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'signature-compatibility' }],
      capabilities: { workspace: { configuration: true, workspaceFolders: true, applyEdit: false, workspaceEdit: { documentChanges: true } },
        textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
      initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings } }, 90000);
    lsp.notify('initialized', {});
    const { workspace, vscode, save, submitted } = headlessHost(root, lsp);
    for (const unit of sources.keys()) await workspace.openTextDocument(uri(path.join(root, unit)));
    const declaration = await workspace.openTextDocument(uri(path.join(root, owner)));
    let omitCaller = false;
    const request = async (method, args) => {
      const response = await lsp.request(method, args, 30000);
      return omitCaller && method === 'textDocument/references' ? response.slice(0, -1) : response;
    };
    await until(async () => {
      const model = await request('workspace/executeCommand', { command: 'java.project.getClasspaths',
        arguments: [declaration.uri.toString(), { scope: 'test' }] });
      return model?.projectRoot && model.classpaths.some(file => file.endsWith('spring-jdbc-7.0.10.jar'));
    });
    const context = { globalStorageUri: uri(path.join(owned, 'compiler')) };
    refactoring = registerJavaRefactoring(context, vscode, { request });
    service = registerJavaChangeSignature(context, vscode, { request, refactoring, getJavaHome: () => javaHome });
    const inspect = at => service.info(declaration, selection(declaration.getText(), at));
    const info = await inspect(marker);
    await assert.rejects(service.preview(info.id, { compatibility: { ...change, defaultValue: 'parseInt("7")' } }), /compatible literal/u);
    await assert.rejects(service.preview(info.id, { compatibility: { ...change, name: 'label' } }), /conflicts/u);
    const exceptions = await inspect('checkedInvoice(String');
    assert.equal(exceptions.compatibility, undefined);
    await assert.rejects(service.preview(exceptions.id, { compatibility: change }), /plain public static/u);
    const overloaded = await inspect('overloadedInvoice(int');
    assert.equal(overloaded.compatibility, undefined);
    const plan = await service.preview(info.id, { compatibility: change });
    assertCompatibilityPlan(info, plan);
    const changed = path.join(root, 'application-compat-test.properties');
    await fs.writeFile(changed, 'fixture=changed\n', { flag: 'wx' });
    try { await assert.rejects(refactoring.apply(plan.id), /membership changed|after review/u); }
    finally { await fs.rm(changed); }
    omitCaller = true;
    try { await assert.rejects(refactoring.apply(plan.id), /direct Java caller coverage changed/u); }
    finally { omitCaller = false; }
    assert.equal(submitted.length, 0);
    assert.equal((await refactoring.apply(plan.id)).state, 'applied');
    assert.equal(submitted.length, 1);
    await save();

    const rebuilt = await compileCompatibility({ javaHome, root, scratch: path.join(owned, 'rebuilt') });
    assert.ok(rebuilt.descriptors.includes(legacyDescriptor) && rebuilt.descriptors.includes(expandedDescriptor));
    assert.equal(rebuilt.oldCallerSites, 0);
    assert.equal(rebuilt.newCallerSites, 2);
    const afterLegacy = await checkLegacyClient(javaHome, rebuilt.archive, client);
    assert.deepEqual(afterLegacy, beforeLegacy);
    const sourceClient = await compileLegacyClient(javaHome, rebuilt.archive, path.join(owned, 'new-client'));
    assert.equal((await checkLegacyClient(javaHome, rebuilt.archive, sourceClient)).result, beforeLegacy.result);
    const after = await run('db-after', rebuilt);
    assert.deepEqual(after, before);
    const receipt = { ...plan.signature.compatibility, precompiledClient: beforeLegacy, newLegacySourceCompiles: true,
      descriptorCountAfter: 2, updatedInvokeStaticSites: rebuilt.newCallerSites, oneWorkspaceEdit: true,
      staleResourceRefused: true, missingJdtCallerRefused: true, literalAndNameConflictRefused: true,
      checkedThrowsIneligible: true, overloadedIneligible: true, before, after };
    if (process.env.ROCKETBRAIN_SIGNATURE_COMPAT_RECEIPT) {
      await fs.writeFile(process.env.ROCKETBRAIN_SIGNATURE_COMPAT_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
    }
  });
