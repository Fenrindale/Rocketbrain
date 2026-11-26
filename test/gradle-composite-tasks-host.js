'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { BuildTasks } = require('../src/java/workbench-tasks');
const { buildFingerprint, id } = require('../src/java/workbench-model');
const { execute } = require('../src/java/testing/provision');
const { importedSpring, jdbcReadback } = require('./java-source-analysis-host');

async function write(root, name, text) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx' });
}

async function fixture(root) {
  const included = await fs.mkdtemp(path.join(root, 'rb-task-catalog-'));
  const member = path.basename(included), buildName = 'rb-library-' + randomBytes(4).toString('hex');
  const settings = path.join(root, 'settings.gradle');
  const original = await fs.readFile(settings);
  const modified = Buffer.concat([original, Buffer.from("\nincludeBuild('" + member + "') { name = '" + buildName + "' }\n")]);
  const script = 'plugins { `java-library` }\n' +
    'tasks.register("rbCompositeProof") {\n' +
    '    group = "verification"\n    description = "Compile the exact included project"\n    dependsOn(tasks.classes)\n}\n';
  await write(included, 'settings.gradle.kts', 'rootProject.name = "physical-library"\ninclude(":service")\n');
  await write(included, 'service/build.gradle.kts', script);
  await write(included, 'service/src/main/java/rb/composite/Verified.java',
    'package rb.composite; public final class Verified { public static int value() { return 17; } }\n');
  await fs.writeFile(settings, modified);
  return {
    settings, original, modified, included, buildName, script,
    selected: ':' + buildName + ':service:rbCompositeProof',
    file: path.join(included, 'service/build.gradle.kts'),
    output: path.join(included, 'service/build/classes/java/main/rb/composite/Verified.class'),
    async restore() {
      assert.deepEqual(await fs.readFile(settings), modified);
      await fs.writeFile(settings, original);
    }
  };
}

async function verify(root, operations) {
  const input = await fixture(root);
  try {
    const options = { projectUri: pathToFileURL(root).href, allowProjectExecution: true };
    await assert.rejects(operations.discover({ ...options, allowProjectExecution: false }), /explicitly|trusted/i);
    const list = await operations.discover(options);
    assert.ok(list.some(item => item.name === ':classes' && !item.buildName));
    const exact = list.find(item => item.name === input.selected);
    assert.ok(exact, JSON.stringify(list.map(item => item.name)));
    assert.equal(exact.buildName, input.buildName);
    assert.equal(exact.provenance, 'gradle-included-build-task');
    assert.equal(exact.description, 'Compile the exact included project');
    assert.equal(list.some(item => item.name === ':service:rbCompositeProof'), false);
    const shown = await operations.checkTree?.(exact);
    await assert.rejects(fs.access(input.output), { code: 'ENOENT' });

    await fs.appendFile(input.file, '\n// Changed after the exact task review.\n');
    try {
      await assert.rejects(
        operations.run({ ...options, taskId: exact.id }),
        /build inputs changed after task discovery/i
      );
      await assert.rejects(fs.access(input.output), { code: 'ENOENT' });
    } finally {
      await fs.writeFile(input.file, input.script);
    }

    const result = await operations.run({ ...options, taskId: exact.id });
    assert.equal(result.state, 'succeeded');
    assert.equal(result.task, exact.name);
    const klass = await fs.readFile(input.output);
    assert.equal(klass.readUInt32BE(0), 0xcafebabe);
    return {
      qualifiedIncludedTask: true, rootTaskVisible: true, exactNamedBuild: true,
      kotlinDsl: true, staleIncludedBuildRefused: true, javaCompiled: true,
      taskCount: list.length, javaClassMajor: klass.readUInt16BE(6), ...(shown && { nativeTaskAndTree: true }),
      jdbc: await jdbcReadback()
    };
  } finally {
    await input.restore();
  }
}

async function runGradleCompositeTaskChecks(api, vscode, checks) {
  const root = await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath);
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.java.workbench.tasks'));
  const workbench = api.java.workbench;
  await importedSpring(api, root);
  const evidence = await verify(root, {
    async discover(options) {
      if (options.allowProjectExecution) await importedSpring(api, root);
      return workbench.discoverTasks(options);
    },
    run: options => workbench.runTask(options),
    checkTree(exact) {
      const project = workbench.getTreeChildren().find(item => item.id === exact.projectId);
      const taskTree = workbench.getTreeChildren(project.id + ':tasks');
      assert.equal(taskTree.find(item => item.id === exact.id).buildName, exact.buildName);
      return true;
    }
  });
  checks.push('The installed Gradle task browser and terminal distinguished a renamed included build, refused a stale Kotlin script and compiled the exact project while Spring JDBC remained live.');
  return evidence;
}

module.exports = { runGradleCompositeTaskChecks };
if (require.main === module) (async () => {
  const tools = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
  const output = path.resolve(__dirname, '../test-output');
  await fs.mkdir(output, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(output, 'rb-composite-tasks-')));
  await write(root, 'settings.gradle', "rootProject.name = 'test-composite-main'\n");
  await write(root, 'build.gradle', "plugins { id 'java' }\n");
  const tasks = new BuildTasks({
    storagePath: path.join(root, 'task-models'),
    tools: () => tools,
    runner: {
      async execute(spec, { cancellation }) {
        const result = await execute(spec.command, [...spec.args, '--offline'], {
          cwd: spec.cwd, env: spec.env, cancellation, timeoutMs: 150000
        });
        if (result.code !== 0) throw Error(result.output.slice(-4000));
        return result;
      }
    }
  });
  const project = () => ({
    root, name: 'Gradle composite', uri: pathToFileURL(root).href, id: id('project', root),
    tool: 'gradle', buildFingerprint: buildFingerprint(root)
  });
  const result = await verify(root, {
    discover: options => tasks.discover(project(), options),
    run: options => tasks.run(project(), options.taskId, options)
  });
  console.log(JSON.stringify({ ...result, engine: process.env.ROCKETBRAIN_TEST_MYSQL_ENGINE }));
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
