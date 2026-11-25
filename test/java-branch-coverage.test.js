'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('../src/java/testing');
const { execute } = require('../src/java/testing/provision');
const { branchFixture, verifyBranchReports } = require('./helpers/java-branch-coverage-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const testingConfig = process.env.ROCKETBRAIN_COVERAGE_TEST_RUNTIME;

test('real JUnit and TestNG coverage report opposite if/else ranges for independent test intervals',
  { skip: !javaConfig || !testingConfig, timeout: 180000 }, async () => {
    const { javaHome } = JSON.parse(await fs.readFile(javaConfig, 'utf8'));
    const runtime = JSON.parse(await fs.readFile(testingConfig, 'utf8'));
    const folder = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-coverage-branches-'));
    const paths = Object.fromEntries(['source', 'test', 'classes', 'testclasses', 'runs'].map(name => [name, path.join(folder, name)]));
    try {
      await Promise.all(Object.values(paths).map(value => fs.mkdir(value)));
      await fs.mkdir(path.join(paths.source, 'sample'));
      await fs.mkdir(path.join(paths.test, 'sample'));
      const names = { main: 'BranchChoice', junit: 'JUnitChoiceTests', testng: 'TestNGChoiceTests' };
      const fixture = branchFixture('sample', names);
      const materialize = async (root, name, source) => {
        const file = path.join(root, 'sample', name + '.java');
        await fs.writeFile(file, source, { flag: 'wx' });
        return file;
      };
      const source = await materialize(paths.source, names.main, fixture.main);
      const tests = await Promise.all(['junit', 'testng'].map(name => materialize(paths.test, names[name], fixture[name])));
      const ecj = process.env.ROCKETBRAIN_COVERAGE_ECJ;
      const compiler = path.join(javaHome, 'bin', (ecj ? 'java' : 'javac') + (process.platform === 'win32' ? '.exe' : ''));
      const flags = [...(ecj ? ['-jar', ecj, '-25'] : []), '-g', '-encoding', 'UTF-8'];
      let compiled = await execute(compiler, [...flags, '-d', paths.classes, source], { cwd: folder });
      assert.equal(compiled.code, 0, compiled.output);
      compiled = await execute(compiler, [...flags, '-cp',
        [runtime.junitJar, runtime.testngJar, paths.classes].join(path.delimiter), '-d', paths.testclasses, ...tests], { cwd: folder });
      assert.equal(compiled.code, 0, compiled.output);
      const config = { workspace: folder, javaHome, runtime, classPath: [paths.classes, paths.testclasses], testClassPaths: [paths.testclasses],
        sourceRoots: [paths.source], classDirectories: [paths.classes], outputRoot: paths.runs };
      const receipts = {};
      for (const framework of ['junit', 'testng']) {
        const result = await runTests({ ...config, framework }, {
          selectors: [{ kind: 'class', value: 'sample.' + names[framework] }], perTestCoverage: true
        });
        assert.equal(result.summary.testsSucceeded, 3);
        receipts[framework] = verifyBranchReports(result, 'sample/BranchChoice.java');
      }
      const newer = new Date(Date.now() + 10000);
      await fs.utimes(source, newer, newer);
      const stale = await runTests(config, { selectors: [{ kind: 'class', value: 'sample.' + names.junit }], coverage: true });
      assert.ok(stale.coverage.files.some(file => file.branches.total > 0));
      assert.equal(stale.coverage.mappedBranchDecisions, undefined);
      if (process.env.ROCKETBRAIN_COVERAGE_BRANCH_RECEIPT) {
        await fs.writeFile(process.env.ROCKETBRAIN_COVERAGE_BRANCH_RECEIPT, JSON.stringify({ compiler: ecj ? 'eclipse-ecj' : 'jdk-javac', ...receipts, staleRangesWithheld: true }) + '\n');
      }
    } finally {
      assert.equal(path.dirname(await fs.realpath(folder)), await fs.realpath(os.tmpdir()));
      assert.match(path.basename(folder), /^rb-coverage-branches-/);
      await fs.rm(folder, { recursive: true, maxRetries: 3 });
    }
  });
