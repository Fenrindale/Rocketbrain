'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cacheDirectory, observeSnapshotCache } = require('../src/java/maven-snapshot-cache');

const version = '2-SNAPSHOT', resolved = '2-20261126.042521-1';
const aliasName = 'sample-2-SNAPSHOT.jar', timedName = 'sample-' + resolved + '.jar';
const coordinate = 'fixture.example:sample:jar:2-SNAPSHOT:runtime';
const selection = () => ({ id: 1, state: 'selected', group: 'fixture.example', artifact: 'sample',
  type: 'jar', classifier: '', version, scope: 'runtime' });

async function fixture(t) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-mvn-snapshot-unit-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(path.relative(root, resolved), '');
    assert.equal(path.dirname(resolved), parent);
    assert.match(path.basename(resolved), /^rb-mvn-snapshot-unit-/u);
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const directory = path.join(root, 'fixture', 'example', 'sample', version);
  await fs.mkdir(directory, { recursive: true });
  const alias = path.join(directory, aliasName), timed = path.join(directory, timedName);
  const tracking = path.join(directory, '_remote.repositories');
  const metadata = path.join(directory, 'maven-metadata-central.xml');
  const xml = '<metadata><groupId>fixture.example</groupId><artifactId>sample</artifactId><version>' + version +
    '</version><versioning><snapshotVersions><snapshotVersion><extension>jar</extension><value>' + resolved +
    '</value></snapshotVersion></snapshotVersions></versioning></metadata>';
  await Promise.all([fs.writeFile(alias, 'verified archive bytes'), fs.writeFile(timed, 'verified archive bytes'),
    fs.writeFile(tracking, timedName + '>central=\n'), fs.writeFile(metadata, xml)]);
  const selected = await cacheDirectory(root);
  const line = '   ' + coordinate + ':';
  const observe = async (paths = [alias]) => {
    const node = selection();
    return { node, ...await observeSnapshotCache([node], paths.map(file => line + file).join('\n'), selected) };
  };
  return { root, alias, timed, metadata, tracking, xml, observe };
}

test('snapshot cache requires the same alias bytes, metadata and recorded origin on revalidation', async t => {
  const { timed, metadata, xml, observe } = await fixture(t);
  const report = await observe();
  assert.equal(report.node.snapshotCache.origin, 'timestamped-cache-match');
  assert.equal(report.node.snapshotCache.resolvedVersion, resolved);
  assert.deepEqual(await report.validate(1), report.node.snapshotCache);
  await fs.writeFile(metadata, xml + '\n');
  await assert.rejects(report.validate(1), /snapshot cache evidence changed/u);
  await fs.writeFile(timed, 'different bytes');
  const unmatched = await observe();
  assert.equal(unmatched.node.snapshotCache.state, 'selected-cache-file');
  assert.equal(unmatched.node.snapshotCache.origin, 'unavailable');
});

test('snapshot cache distinguishes local install markers and rejects unbound artifact paths', async t => {
  const { root, metadata, tracking, alias, xml, observe } = await fixture(t);
  const outsideLayout = path.join(root, aliasName);
  await fs.writeFile(outsideLayout, 'not the Maven file');
  assert.equal((await observe([outsideLayout])).node.snapshotCache.state, 'unavailable');
  assert.equal((await observe([alias, alias])).node.snapshotCache.state, 'unavailable');
  await fs.writeFile(metadata, '<!DOCTYPE metadata []>' + xml);
  assert.equal((await observe()).node.snapshotCache.origin, 'unavailable');
  await fs.appendFile(tracking, aliasName + '>=\n');
  assert.equal((await observe()).node.snapshotCache.origin, 'local-marker');
});
