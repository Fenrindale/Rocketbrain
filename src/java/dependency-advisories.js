'use strict';

const maxTreeBytes = 4 * 1024 * 1024;
const maxSelection = 150;
const osvEndpoint = 'https://api.osv.dev/v1/querybatch';
const coordinatePart = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;
const packageVersion = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,120}$/;
const advisoryId = /^[A-Za-z0-9][A-Za-z0-9.-]{2,100}$/;

function coordinate(node) {
  if (!node || typeof node.groupId !== 'string' || typeof node.artifactId !== 'string' ||
      typeof node.version !== 'string' || !coordinatePart.test(node.groupId) ||
      !coordinatePart.test(node.artifactId) || !packageVersion.test(node.version)) {
    throw Error('The dependency tree includes an invalid Maven coordinate.');
  }
  return { name: node.groupId + ':' + node.artifactId, version: node.version };
}

function parseMavenDependencyTree(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > maxTreeBytes) throw Error('Use a Maven dependency tree up to 4 MiB.');
  let root;
  try { root = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw Error('The Maven dependency tree is not valid JSON.'); }
  const project = coordinate(root);
  const packages = new Map();
  const pending = [{ node: root, ancestors: [] }];
  let count = 0;
  while (pending.length) {
    const { node, ancestors } = pending.pop();
    if (++count > 5000 || ancestors.length > 48) throw Error('The Maven dependency tree exceeds its node or depth limit.');
    const account = coordinate(node);
    const key = account.name + '@' + account.version;
    const next = [...ancestors, key];
    if (ancestors.length) {
      if (!packages.has(key)) packages.set(key, { ...account, key, direct: false, scopes: [], paths: [] });
      const item = packages.get(key);
      const scope = ['compile', 'runtime', 'test', 'provided', 'system', 'import'].includes(node.scope) ? node.scope : 'unknown';
      if (!item.scopes.includes(scope)) item.scopes.push(scope);
      if (ancestors.length === 1) item.direct = true;
      if (item.paths.length < 4) item.paths.push(next);
    }
    if (node.children === undefined) continue;
    if (!Array.isArray(node.children) || pending.length + node.children.length > 5000) {
      throw Error('The Maven dependency tree has an invalid children list.');
    }
    for (const child of [...node.children].reverse()) pending.push({ node: child, ancestors: next });
  }
  return { project, packages: [...packages.values()].sort((a, b) => a.key.localeCompare(b.key)) };
}

async function readPage(fetcher, queries, signal) {
  const response = await fetcher(osvEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries }), redirect: 'error', signal });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error('OSV dependency lookup failed (HTTP ' + response.status + ').');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body || []) {
    length += chunk.byteLength;
    if (length > 2 * 1024 * 1024) throw Error('The OSV lookup response exceeds 2 MiB.');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')).results; }
  catch { throw Error('OSV returned invalid JSON for the batch.'); }
  if (!Array.isArray(result) || result.length !== queries.length) throw Error('OSV returned a different number of package results.');
  return result;
}

async function auditMavenPackages(tree, keys, { fetcher = fetch, signal } = {}) {
  if (!Array.isArray(keys) || !keys.length || keys.length > maxSelection || new Set(keys).size !== keys.length) {
    throw Error('Select between 1 and ' + maxSelection + ' distinct packages to send to OSV.');
  }
  const packages = new Map(tree.packages.map(item => [item.key, item]));
  const report = keys.map(key => {
    if (!packages.has(key)) throw Error('Choose package versions from the observed Maven tree.');
    return { ...packages.get(key), advisories: [], complete: true };
  });
  const deadline = AbortSignal.timeout(30000);
  const cancellation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let index = 0; index < report.length; index += 25) {
    let requests = report.slice(index, index + 25).map(item => ({ item }));
    for (let page = 0; requests.length && page < 5; page++) {
      cancellation.throwIfAborted();
      const queries = requests.map(({ item, token }) => ({
        package: { ecosystem: 'Maven', name: item.name }, version: item.version, ...(token ? { page_token: token } : {})
      }));
      const response = await readPage(fetcher, queries, cancellation);
      const continuation = [];
      for (const [i, { item, token }] of requests.entries()) {
        const result = response[i];
        const vulnerabilities = result?.vulns ?? [];
        if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(vulnerabilities) || vulnerabilities.length > 300 ||
            vulnerabilities.some(value => !advisoryId.test(value?.id || ''))) {
          throw Error('OSV returned an invalid list of advisory identifiers.');
        }
        item.advisories = [...new Set([...item.advisories, ...vulnerabilities.map(value => value.id)])].sort();
        if (item.advisories.length > 300) {
          item.advisories = item.advisories.slice(0, 300);
          item.complete = false;
          continue;
        }
        if (result.next_page_token) {
          const next = result.next_page_token;
          if (typeof next !== 'string' || next.length > 2048 || next === token) throw Error('OSV returned an invalid page token.');
          if (page === 4) item.complete = false;
          else continuation.push({ item, token: next });
        }
      }
      requests = continuation;
    }
  }
  return { project: tree.project, provider: 'OSV', checkedAt: new Date().toISOString(),
    skipped: tree.packages.length - report.length, packages: report };
}

module.exports = { parseMavenDependencyTree, auditMavenPackages, maxTreeBytes, maxSelection };
