'use strict';

const path = require('node:path');
const assert = require('node:assert/strict');

function smartStepFixture(base) {
  const mainClass = base + '.SmartStepFixture';
  const source = [
    'package ' + base + ';',
    'import ' + base + '.vendor.PackageLibrary;',
    'import ' + base + '.shared.ExactLibrary;',
    'import ' + base + '.shared.VisibleLibrary;',
    'public final class SmartStepFixture {',
    '    static int choose(int value) {',
    '        return value + 3; // INTEGER_METHOD',
    '    }',
    '    static int choose(String value) {',
    '        return value.length() + 20; // STRING_METHOD',
    '    }',
    '    static int sum(int first, int second) { return first + second; }',
    '    public static void main(String[] args) {',
    '        int selected = sum(choose(4), choose("abc")); // TARGET_GATE',
    '        int pkg = PackageLibrary.read(); // PACKAGE_GATE',
    '        int afterPackage = pkg + 1; // AFTER_PACKAGE',
    '        int exact = ExactLibrary.read(); // EXACT_GATE',
    '        int afterExact = exact + 1; // AFTER_EXACT',
    '        int visible = VisibleLibrary.read(); // VISIBLE_GATE',
    '        System.out.println(selected + afterPackage + afterExact + visible);',
    '    }',
    '}',
    ''
  ].join('\n');
  const helper = (pkg, name, n) => [
    'package ' + base + '.' + pkg + ';',
    'public final class ' + name + ' {',
    '    public static int read() {',
    '        return ' + n + ';',
    '    }',
    '}',
    ''
  ].join('\n');
  const fileFor = (pkg, simple) => path.join(...(pkg ? (base + '.' + pkg) : base).split('.'), simple + '.java');
  const mainFile = fileFor('', 'SmartStepFixture');
  return {
    mainClass, mainFile, source,
    paths: [
      [mainFile, source],
      [fileFor('vendor', 'PackageLibrary'), helper('vendor', 'PackageLibrary', 11)],
      [fileFor('shared', 'ExactLibrary'), helper('shared', 'ExactLibrary', 13)],
      [fileFor('shared', 'VisibleLibrary'), helper('shared', 'VisibleLibrary', 17)]
    ],
    gates: ['TARGET_GATE', 'PACKAGE_GATE', 'EXACT_GATE', 'VISIBLE_GATE'],
    filters: { skipClasses: [base + '.vendor.*', base + '.shared.ExactLibrary'] },
    line: marker => source.split('\n').findIndex(line => line.includes(marker)) + 1
  };
}

async function exerciseSmartStep({ fixture, service, session, first, proceed, frame }) {
  assert.equal((await frame(first)).line, fixture.line('TARGET_GATE'));
  const selection = await service.inspect(session);
  const integer = selection.targets.find(item => item.label === 'choose(4)');
  const string = selection.targets.find(item => item.label === 'choose("abc")');
  assert.ok(integer && string, JSON.stringify(selection.targets));
  assert.notEqual(integer.id, string.id);
  assert.ok(integer.column < string.column);
  await assert.rejects(service.step({ ...selection }, string.id), /current Java step list/);
  let stopped = await proceed(() => service.step(selection, string.id));
  let actual = await frame(stopped);
  assert.match(actual.name, /\.choose\(String\)$/);
  assert.equal(actual.line, fixture.line('STRING_METHOD'));
  await assert.rejects(service.step(selection, integer.id), /current Java step list/);
  const selected = { label: string.label, frame: actual.name.split('.').at(-1), line: actual.line };

  const skipped = {};
  for (const [name, marker, afterMarker] of [['package', 'PACKAGE_GATE', 'AFTER_PACKAGE'], ['class', 'EXACT_GATE', 'AFTER_EXACT']]) {
    stopped = await proceed(() => session.customRequest('continue', { threadId: stopped.threadId }));
    assert.equal((await frame(stopped)).line, fixture.line(marker));
    stopped = await proceed(() => session.customRequest('stepIn', { threadId: stopped.threadId }));
    assert.equal(stopped.reason, 'step');
    actual = await frame(stopped);
    assert.match(actual.name, /\.main\(String\[\]\)$/);
    assert.equal(actual.line, fixture.line(afterMarker));
    skipped[name] = actual.line;
  }
  stopped = await proceed(() => session.customRequest('continue', { threadId: stopped.threadId }));
  assert.equal((await frame(stopped)).line, fixture.line('VISIBLE_GATE'));
  stopped = await proceed(() => session.customRequest('stepIn', { threadId: stopped.threadId }));
  assert.equal(stopped.reason, 'step');
  actual = await frame(stopped);
  assert.match(actual.name, /VisibleLibrary\.read\(\)$/);
  return { stopped, proof: { targetCount: selection.targets.length, selected, skipped, visibleFrame: 'VisibleLibrary.read' } };
}

module.exports = { smartStepFixture, exerciseSmartStep };
