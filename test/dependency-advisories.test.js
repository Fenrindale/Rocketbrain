'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMavenDependencyTree, auditMavenPackages } = require('../src/java/dependency-advisories');

function packageNode(groupId, artifactId, version, scope, ...children) {
  return { groupId, artifactId, version, scope, ...(children.length && { children }) };
}

const treeJson = JSON.stringify(packageNode('dev.rocketbrain', 'fixture', '1.0', '',
  packageNode('org.sample', 'root', '2.0', 'compile', packageNode('org.sample', 'leaf', '1.0', 'runtime')),
  packageNode('org.example', 'other', '4.0', 'test', packageNode('org.sample', 'leaf', '1.0', 'test'))));

test('resolved Maven tree keeps version, origin paths and both scopes for repeated transitive packages', () => {
  const tree = parseMavenDependencyTree(treeJson);
  const leaf = tree.packages.find(item => item.key === 'org.sample:leaf@1.0');
  assert.equal(leaf.direct, false);
  assert.deepEqual(leaf.scopes, ['runtime', 'test']);
  assert.deepEqual(leaf.paths, [
    ['dev.rocketbrain:fixture@1.0', 'org.sample:root@2.0', leaf.key], ['dev.rocketbrain:fixture@1.0', 'org.example:other@4.0', leaf.key]
  ]);
  assert.throws(() => parseMavenDependencyTree(JSON.stringify(packageNode(['invalid'], 'project', '1', ''))), /invalid Maven/);
});

test('OSV sends selected public query fields and follows only that item’s bounded continuation', async () => {
  const sent = [];
  const fetcher = async (url, request) => {
    assert.equal(url, 'https://api.osv.dev/v1/querybatch');
    assert.equal(request.redirect, 'error');
    sent.push(JSON.parse(request.body));
    return Response.json({ results: sent.length === 1
      ? [{ vulns: [{ id: 'GHSA-example-0001' }], next_page_token: 'next-page' }, {}]
      : [{ vulns: [{ id: 'GHSA-example-0001' }, { id: 'GHSA-example-0002' }] }] });
  };
  const tree = parseMavenDependencyTree(treeJson);
  const report = await auditMavenPackages(tree, ['org.sample:leaf@1.0', 'org.sample:root@2.0'], { fetcher });
  const leaf = { package: { ecosystem: 'Maven', name: 'org.sample:leaf' }, version: '1.0' };
  assert.deepEqual(sent, [{ queries: [leaf, { package: { ecosystem: 'Maven', name: 'org.sample:root' }, version: '2.0' }] },
    { queries: [{ ...leaf, page_token: 'next-page' }] }]);
  assert.deepEqual(report.packages[0].advisories, ['GHSA-example-0001', 'GHSA-example-0002']);
  assert.equal(report.packages[1].advisories.length, 0);
  assert.equal(report.skipped, 1);
});

test('OSV rejects unobserved selections and mismatched result cardinality', async () => {
  const tree = parseMavenDependencyTree(treeJson);
  await assert.rejects(auditMavenPackages(tree, ['private:other@1.0'], { fetcher: () => assert.fail('Unexpected request') }), /observed Maven/);
  await assert.rejects(auditMavenPackages(tree, ['org.sample:leaf@1.0'], {
    fetcher: async () => Response.json({ results: [] })
  }), /different number/);
});
