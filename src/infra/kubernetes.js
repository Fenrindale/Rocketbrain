'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');

const maxConfigBytes = 512 * 1024;
const maxListBytes = 1024 * 1024;
const maxRows = 200;
const logBytes = 64 * 1024;
const logLines = 200;
const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reference = /^[A-Za-z0-9_][A-Za-z0-9_.:@/-]{0,199}$/;
const encoded = /^[A-Za-z0-9+/]+={0,2}$/;
const resourceKinds = { deployments: 'Deployment', services: 'Service', pods: 'Pod' };
const allowedContext = new Set(['cluster', 'namespace', 'user', 'extensions']);
const allowedCluster = new Set(['server', 'tls-server-name', 'certificate-authority-data', 'insecure-skip-tls-verify', 'extensions']);
const allowedUser = new Set(['token', 'client-certificate-data', 'client-key-data', 'extensions']);

function podName(value) {
  return typeof value === 'string' && value.length <= 253 && value.split('.').every(name => label.test(name));
}

function namespaceName(value) {
  return typeof value === 'string' && label.test(value);
}

function boundedText(value, length) {
  if (typeof value !== 'string') return '';
  return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, length);
}

async function executable(name, configured) {
  const base = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(path.delimiter)
    .filter(path.isAbsolute).map(folder => path.join(folder, base));
  for (const file of candidates) {
    if (path.isAbsolute(file) && path.basename(file).toLowerCase() === base) {
      const resolved = await fs.realpath(file).catch(() => null);
      if (resolved && (await fs.stat(resolved).catch(() => null))?.isFile()) return resolved;
    }
  }
  if (configured || name === 'kubectl') throw Error('Choose an absolute local ' + base + ' executable or add it to PATH.');
  return undefined;
}

function processEnv(folder) {
  const keys = new Set(['path', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'userprofile', 'home', 'lang', 'lc_all']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.has(key.toLowerCase()))),
    HELM_DRIVER: 'secret', HELM_CONFIG_HOME: path.join(folder, 'helm-config'), HELM_CACHE_HOME: path.join(folder, 'helm-cache'),
    HELM_DATA_HOME: path.join(folder, 'helm-data'), HELM_PLUGINS: path.join(folder, 'helm-plugins') };
}

function commandFailure(operation, stderr) {
  const reason = /\bForbidden\b/i.test(stderr) ? 'The selected account lacks permission.' :
    /\bUnauthorized\b|provide credentials/i.test(stderr) ? 'The selected credential was rejected.' :
    /certificate|\btls\b/i.test(stderr) ? 'TLS verification failed.' :
    /connection refused|no such host|timed out|deadline exceeded/i.test(stderr) ? 'The selected cluster could not be reached.' :
    'Check the selected context, namespace, and local tool versions.';
  return Error(operation + ' failed. ' + reason);
}

function runCli(binary, args, { folder, operation, limit = maxListBytes, signal }) {
  if (signal?.aborted) return Promise.reject(Error('Kubernetes request was cancelled.'));
  const child = spawn(binary, args, { cwd: folder, stdio: ['ignore', 'pipe', 'pipe'], env: processEnv(folder), windowsHide: true, shell: false });
  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    let outBytes = 0, errBytes = 0, finished = false, interrupted;
    const timer = setTimeout(() => stop(' exceeded its time budget.'), 15000);
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(Buffer.concat(stdout).toString('utf8'));
    }
    function stop(message) {
      if (interrupted) return;
      interrupted = Error(operation + message);
      child.kill();
    }
    const abort = () => stop(' was cancelled.');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', chunk => {
      outBytes += chunk.length;
      if (outBytes > limit) stop(' exceeded its output limit.');
      else stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      const retained = Math.min(8192 - errBytes, chunk.length);
      if (retained > 0) { stderr.push(chunk.subarray(0, retained)); errBytes += retained; }
    });
    child.once('error', () => finish(Error(operation + ' could not start the local CLI.')));
    child.once('close', code => finish(interrupted || (code === 0 ? null : commandFailure(operation, Buffer.concat(stderr).toString('utf8')))));
    if (signal?.aborted) abort();
  });
}

function parseJson(raw, operation) {
  try { return JSON.parse(raw); }
  catch { throw Error(operation + ' returned invalid JSON.'); }
}

function byReference(rows) {
  if (!Array.isArray(rows) || rows.length > 100) throw Error('Use a kubeconfig with at most 100 entries per context section.');
  const map = new Map();
  for (const item of rows) {
    if (typeof item?.name !== 'string' || !reference.test(item.name) || map.has(item.name)) {
      throw Error('Kubeconfig includes an unsupported or duplicate entry name.');
    }
    map.set(item.name, item);
  }
  return map;
}

function onlyFields(record, keys) {
  return record && typeof record === 'object' && !Array.isArray(record) && Object.keys(record).every(key => keys.has(key));
}

function validCredential(auth) {
  if (!onlyFields(auth, allowedUser)) return null;
  const certificate = auth['client-certificate-data'], key = auth['client-key-data'], token = auth.token;
  const pair = typeof certificate === 'string' && typeof key === 'string' && encoded.test(certificate) && encoded.test(key);
  if (pair && token === undefined) return { 'client-certificate-data': certificate, 'client-key-data': key };
  if (certificate === undefined && key === undefined && typeof token === 'string' && /^[!-~]{1,16384}$/.test(token)) return { token };
  return null;
}

function validCluster(config) {
  if (!onlyFields(config, allowedCluster) || config['insecure-skip-tls-verify'] === true || typeof config.server !== 'string') return null;
  let url;
  try { url = new URL(config.server); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  const ca = config['certificate-authority-data'], tlsName = config['tls-server-name'];
  if (ca !== undefined && (typeof ca !== 'string' || !encoded.test(ca))) return null;
  if (tlsName !== undefined && (typeof tlsName !== 'string' || !podName(tlsName.toLowerCase()))) return null;
  return { server: url.origin, ...(ca && { 'certificate-authority-data': ca }), ...(tlsName && { 'tls-server-name': tlsName }) };
}

function approvedContexts(configuration) {
  const contexts = byReference(configuration?.contexts ?? []);
  const clusters = byReference(configuration?.clusters ?? []);
  const users = byReference(configuration?.users ?? []);
  const approved = new Map();
  for (const [name, { context }] of contexts) {
    if (!onlyFields(context, allowedContext)) continue;
    const { cluster, user, namespace = 'default' } = context;
    if (!namespaceName(namespace)) continue;
    const route = validCluster(clusters.get(cluster)?.cluster);
    const auth = validCredential(users.get(user)?.user);
    if (!route || !auth) continue;
    approved.set(name, { display: { name, cluster, user, namespace, server: route.server, tlsServerName: route['tls-server-name'] },
      config: { apiVersion: 'v1', kind: 'Config', 'current-context': name,
        clusters: [{ name: cluster, cluster: route }], users: [{ name: user, user: auth }],
        contexts: [{ name, context: { cluster, user, namespace } }] } });
  }
  return approved;
}

async function readKubeconfig(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file)) throw Error('Choose an absolute local kubeconfig file.');
  const real = await fs.realpath(file);
  const info = await fs.stat(real);
  if (!info.isFile() || info.size > maxConfigBytes) throw Error('Choose an ordinary kubeconfig file of at most 512 KiB.');
  const descriptor = await fs.open(real, 'r');
  try {
    const bytes = Buffer.alloc(maxConfigBytes + 1);
    const { bytesRead } = await descriptor.read(bytes);
    if (bytesRead > maxConfigBytes) throw Error('Kubeconfig exceeds 512 KiB.');
    return bytes.subarray(0, bytesRead);
  } finally { await descriptor.close(); }
}

function listRows(data) {
  if (!Array.isArray(data?.items)) throw Error('Kubernetes returned an invalid resource list.');
  return data.items;
}

function resourceName(item, kind, namespace) {
  const meta = item?.metadata;
  if (item?.kind !== kind || !meta || meta.namespace !== namespace || !podName(meta.name)) return null;
  return meta.name;
}

function containers(item) {
  const groups = [item.spec?.containers, item.spec?.initContainers];
  return [...new Set(groups.flatMap(rows => Array.isArray(rows) ? rows.map(row => row?.name).filter(namespaceName) : []))].slice(0, 64);
}

function describe(item, kind, namespace) {
  const name = resourceName(item, kind, namespace);
  if (!name) return null;
  if (kind === 'Pod') return { name, uid: /^[A-Za-z0-9-]{1,128}$/.test(item.metadata.uid ?? '') ? item.metadata.uid : undefined,
    phase: boundedText(item.status?.phase, 40), containers: containers(item) };
  if (kind === 'Deployment') return { name, ready: Number.isSafeInteger(item.status?.readyReplicas) ? item.status.readyReplicas : 0,
    desired: Number.isSafeInteger(item.spec?.replicas) ? item.spec.replicas : null };
  return { name, type: boundedText(item.spec?.type, 40), ports: Array.isArray(item.spec?.ports) ?
    item.spec.ports.filter(port => Number.isInteger(port?.port) && port.port > 0 && port.port <= 65535)
      .slice(0, 16).map(port => ({ port: port.port, protocol: boundedText(port.protocol, 8) })) : [] };
}

function listProjection(rows, project) {
  const visible = rows.slice(0, maxRows).map(project).filter(Boolean);
  return { rows: visible, omitted: Math.max(0, rows.length - visible.length) };
}

function scaleIdentity(data, namespace, name) {
  const metadata = data?.metadata;
  const replicas = data?.spec?.replicas;
  if (data?.apiVersion !== 'apps/v1' || resourceName(data, 'Deployment', namespace) !== name ||
      typeof metadata.uid !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(metadata.uid) ||
      typeof metadata.resourceVersion !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(metadata.resourceVersion) ||
      !Number.isSafeInteger(replicas) || replicas < 0) throw Error('The selected Deployment has an incomplete scale identity.');
  return { uid: metadata.uid, resourceVersion: metadata.resourceVersion, replicas };
}

async function prepareKubernetesConfig({ file, kubectl, helm, signal }, run = runCli) {
  const source = await readKubeconfig(file);
  const temporary = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(temporary, 'rocketbrain-kubernetes-'));
  const stageFile = path.join(folder, 'source.kubeconfig');
  const configFile = path.join(folder, 'approved.kubeconfig');
  const active = new Set();
  const stop = new AbortController();
  let closing, contexts, selected, disposed = false;
  function close() {
    if (!closing) {
      disposed = true;
      contexts?.clear();
      stop.abort();
      closing = (async () => {
        await Promise.allSettled([...active]);
        const actual = await fs.realpath(folder);
        if (path.dirname(actual) !== temporary || !/^rocketbrain-kubernetes-[A-Za-z0-9]{6}$/.test(path.basename(actual))) {
          throw Error('The owned Kubernetes snapshot directory identity changed.');
        }
        await fs.rm(actual, { recursive: true, force: true });
      })();
    }
    return closing;
  }
  function call(binary, args, operation, limit, externalSignal) {
    if (disposed) throw Error('The Kubernetes explorer session is closed.');
    const signals = [stop.signal, externalSignal].filter(Boolean);
    const task = run(binary, args, { folder, operation, limit, signal: AbortSignal.any(signals) });
    active.add(task);
    return task.finally(() => active.delete(task));
  }
  const kubectlOptions = ['--cache-dir=' + path.join(folder, 'kube-cache'), '--request-timeout=8s'];
  try {
    await fs.writeFile(stageFile, source, { flag: 'wx', mode: 0o600 });
    const raw = await call(kubectl, ['--kubeconfig=' + stageFile, ...kubectlOptions, 'config', 'view', '--raw', '-o=json'],
      'Kubeconfig inspection', maxConfigBytes, signal);
    contexts = approvedContexts(parseJson(raw, 'Kubeconfig inspection'));
    await fs.unlink(stageFile);
    if (!contexts.size) throw Error('No supported TLS context with an embedded token or client certificate was found.');
  } catch (error) {
    await close();
    throw error;
  }

  function configured(namespace, args, operation, limit, externalSignal) {
    const options = ['--kubeconfig=' + configFile, '--context=' + selected.name, ...kubectlOptions];
    if (namespace !== undefined) options.push('--namespace=' + namespace);
    return call(kubectl, [...options, ...args], operation, limit, externalSignal);
  }
  async function fetchJson(namespace, args, operation, externalSignal) {
    return parseJson(await configured(namespace, args, operation, maxListBytes, externalSignal), operation);
  }

  return {
    choices: () => [...contexts.values()].map(item => ({ ...item.display })),
    close,
    async select(name) {
      if (disposed || selected) throw Error('Choose one context for this Kubernetes session.');
      const entry = contexts.get(name);
      if (!entry) throw Error('Choose an eligible context from the reviewed kubeconfig.');
      selected = entry.display;
      contexts.clear();
      const written = fs.writeFile(configFile, JSON.stringify(entry.config), { flag: 'wx', mode: 0o600 });
      active.add(written);
      try { await written; }
      finally { active.delete(written); }
      if (disposed) throw Error('The Kubernetes explorer session is closed.');
      const scaleReviews = new WeakMap();
      const readScale = async (namespace, name, externalSignal) => scaleIdentity(
        await fetchJson(namespace, ['get', 'deployment', name, '-o=json'], 'Deployment scale identity check', externalSignal),
        namespace, name);
      const scaleArgs = (name, replicas, previous) => ['scale', 'deployment', name, '--replicas=' + replicas,
        '--current-replicas=' + previous.replicas, '--resource-version=' + previous.resourceVersion, '-o=name'];
      const scale = async (namespace, name, replicas, previous, dryRun, externalSignal) => {
        const response = await configured(namespace, [...scaleArgs(name, replicas, previous), ...(dryRun ? ['--dry-run=server'] : [])],
          dryRun ? 'Deployment scale preview' : 'Deployment scale', 4096, externalSignal);
        if (response.trim() !== 'deployment.apps/' + name) throw Error('Could not confirm the scale result. Refresh the Deployment before retrying.');
      };
      return {
        scope: { ...selected },
        close,
        async namespaces(externalSignal) {
          const data = await fetchJson(undefined, ['get', 'namespaces', '-o=json', '--chunk-size=100'], 'Namespace listing', externalSignal);
          return listProjection(listRows(data), item => item?.kind === 'Namespace' && namespaceName(item.metadata?.name) ?
            { name: item.metadata.name, phase: boundedText(item.status?.phase, 40) } : null);
        },
        async resources(kind, namespace, externalSignal) {
          if (!Object.hasOwn(resourceKinds, kind) || !namespaceName(namespace)) throw Error('Choose a supported resource kind and namespace.');
          const operation = resourceKinds[kind] + ' listing';
          const data = await fetchJson(namespace, ['get', kind, '-o=json', '--chunk-size=100'], operation, externalSignal);
          return listProjection(listRows(data), item => describe(item, resourceKinds[kind], namespace));
        },
        async reviewDeploymentScale(namespace, name, replicas, externalSignal) {
          if (!namespaceName(namespace) || !podName(name) || !Number.isSafeInteger(replicas) || replicas < 0 || replicas > 1000) {
            throw Error('Choose a listed Deployment and a replica count from 0 to 1000.');
          }
          const previous = await readScale(namespace, name, externalSignal);
          if (previous.replicas === replicas) throw Error('The Deployment already has this replica count.');
          await scale(namespace, name, replicas, previous, true, externalSignal);
          const review = Object.freeze({ namespace, name, before: previous.replicas, after: replicas, uid: previous.uid,
            resourceVersion: previous.resourceVersion, expires: Date.now() + 120000 });
          scaleReviews.set(review, previous);
          return review;
        },
        async applyDeploymentScale(review, { approved, signal: externalSignal } = {}) {
          const previous = scaleReviews.get(review);
          if (!previous || Date.now() >= review.expires || approved !== true) throw Error('Approve a current Deployment scale review.');
          scaleReviews.delete(review);
          const { namespace, name, after: replicas } = review;
          const observed = await readScale(namespace, name, externalSignal);
          if (observed.uid !== previous.uid || observed.resourceVersion !== previous.resourceVersion ||
              observed.replicas !== previous.replicas) throw Error('The Deployment changed. Refresh and review the new replica count.');
          await scale(namespace, name, replicas, previous, false, externalSignal);
          const applied = await readScale(namespace, name, externalSignal);
          return { namespace, name, desired: replicas, observed: applied.uid === review.uid ? applied.replicas : null };
        },
        async releases(namespace, externalSignal) {
          if (!namespaceName(namespace)) throw Error('Choose a Kubernetes namespace.');
          if (!helm) throw Error('Install Helm or set its executable to list releases.');
          const raw = await call(helm, ['list', '--kubeconfig=' + configFile, '--kube-context=' + selected.name,
            '--namespace=' + namespace, '--output=json', '--max=' + (maxRows + 1)], 'Helm release listing', maxListBytes, externalSignal);
          const data = raw.trim() ? parseJson(raw, 'Helm release listing') : [];
          if (!Array.isArray(data)) throw Error('Helm returned an invalid release list.');
          return { ...listProjection(data, item => item?.namespace === namespace && namespaceName(item?.name) ?
            { name: item.name, status: boundedText(item.status, 40), revision: boundedText(String(item.revision ?? ''), 8),
              chart: boundedText(item.chart, 100), appVersion: boundedText(item.app_version, 60) } : null),
          limitReached: data.length > maxRows };
        },
        async podLogs(namespace, pod, container, externalSignal) {
          if (!namespaceName(namespace) || !podName(pod?.name) || typeof pod?.uid !== 'string' ||
              !/^[A-Za-z0-9-]{1,128}$/.test(pod.uid) || !namespaceName(container)) throw Error('Select a listed pod and container.');
          const verify = async () => {
            const data = await fetchJson(namespace, ['get', 'pod', pod.name, '-o=json'], 'Pod identity check', externalSignal);
            const current = describe(data, 'Pod', namespace);
            if (current?.name !== pod.name || current.uid !== pod.uid || !current.containers.includes(container)) {
              throw Error('The pod or container changed. Refresh the resource list.');
            }
          };
          await verify();
          const text = await configured(namespace, ['logs', pod.name, '--container=' + container, '--timestamps=true',
            '--tail=' + logLines, '--limit-bytes=' + logBytes, '--pod-running-timeout=3s'], 'Pod log snapshot', logBytes, externalSignal);
          await verify();
          return { text: boundedText(text, logBytes), namespace, pod: pod.name, container, maxLines: logLines, maxBytes: logBytes };
        }
      };
    }
  };
}

module.exports = { executable, prepareKubernetesConfig, approvedContexts, namespaceName };
