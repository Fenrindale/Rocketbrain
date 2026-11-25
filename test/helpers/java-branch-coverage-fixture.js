'use strict';

const assert = require('node:assert/strict');

function branchFixture(packageName, names) {
  return {
    main: 'package ' + packageName + ';\npublic class ' + names.main + ' {\n' +
      '  public static int choose(int value) {\n    if (value < 4) {\n      return 10;\n    } else {\n      return 20;\n    }\n  }\n' +
      '  public static int compound(int value) {\n    if (value < 4 || value == 9) {\n      return 30;\n    } else {\n      return 40;\n    }\n  }\n}\n',
    junit: 'package ' + packageName + ';\npublic class ' + names.junit + ' {\n' +
      '  @org.junit.jupiter.api.Test public void positive() { org.junit.jupiter.api.Assertions.assertEquals(10, ' + names.main + '.choose(3)); }\n' +
      '  @org.junit.jupiter.api.Test public void negative() { org.junit.jupiter.api.Assertions.assertEquals(20, ' + names.main + '.choose(7)); }\n' +
      '  @org.junit.jupiter.api.Test public void compound() { org.junit.jupiter.api.Assertions.assertEquals(30, ' + names.main + '.compound(9)); }\n}\n',
    testng: 'package ' + packageName + ';\npublic class ' + names.testng + ' {\n' +
      '  @org.testng.annotations.Test public void positive() { org.testng.Assert.assertEquals(' + names.main + '.choose(3), 10); }\n' +
      '  @org.testng.annotations.Test public void negative() { org.testng.Assert.assertEquals(' + names.main + '.choose(7), 20); }\n' +
      '  @org.testng.annotations.Test public void compound() { org.testng.Assert.assertEquals(' + names.main + '.compound(9), 30); }\n}\n'
  };
}

function verifyBranchReports(result, relativePath) {
  assert.equal(result.coverage.state, 'available', JSON.stringify(result.coverage.warnings));
  assert.equal(result.perTestCoverage.state, 'available', JSON.stringify(result.perTestCoverage.warnings));
  const fileFor = coverage => coverage.files.find(file => file.relativePath === relativePath);
  const locate = coverage => fileFor(coverage).details.find(line => line.line === 3);
  const run = locate(result.coverage);
  assert.deepEqual(run.branches, { covered: 2, total: 2 });
  assert.deepEqual(run.branchSource, {
    condition: { start: { line: 3, character: 4 }, end: { line: 3, character: 18 } },
    arms: [
      { label: 'then', covered: true, range: { start: { line: 4, character: 6 }, end: { line: 4, character: 16 } } },
      { label: 'else', covered: true, range: { start: { line: 6, character: 6 }, end: { line: 6, character: 16 } } }
    ]
  });
  const check = (name, states) => {
    const testNgMethod = '[method:' + Buffer.from(name + '()').toString('base64url') + ']';
    const report = result.perTestCoverage.tests.find(test => test.testId.includes('[method:' + name + '()]') || test.testId.includes(testNgMethod));
    assert.ok(report, JSON.stringify(result.perTestCoverage.tests.map(test => test.testId)));
    const detail = locate(report.coverage);
    assert.deepEqual(detail.branchSource.arms.map(arm => arm.covered), states);
  };
  check('positive', [true, false]);
  check('negative', [false, true]);
  const unsupported = fileFor(result.coverage).details.find(line => line.line === 10);
  assert.ok(unsupported?.branches?.total > 2);
  assert.equal(unsupported?.branchSource, undefined);
  return { aggregateArms: run.branchSource.arms, condition: run.branchSource.condition, perTestOppositeArms: true,
    compoundRemainsLineOnly: true, classSourceSha256: fileFor(result.coverage).branchSourceSha256 };
}

module.exports = { branchFixture, verifyBranchReports };
