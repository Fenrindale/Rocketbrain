'use strict';

const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { createHash } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { agentProgram, runAgent } = require('./acp-process');
const { normalizeLocalChatTarget } = require('./local-chat');
const { startStructuredBridge } = require('./acp-structured-bridge');

async function executableDigest(executable) {
  if ((await fs.stat(executable)).size > 256 * 1024 * 1024) throw Error('Select a standalone ACP executable of at most 256 MiB.');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  return hash.digest('hex');
}

async function prepareIsolatedAgent(input, localModel) {
  const adapter = input?.adapter ?? 'stdio';
  if (!['stdio', 'opencode-local'].includes(adapter)) throw Error('Select a stable ACP v1 stdio agent adapter.');
  const profile = await agentProgram(input);
  if (adapter === 'opencode-local' && (!/^opencode(?:\.exe)?$/i.test(path.basename(profile.executable)) || profile.args.length)) {
    throw Error('Provide the OpenCode executable without custom arguments for the local OpenCode adapter.');
  }
  if (adapter === 'opencode-local') profile.args = ['acp', '--pure'];
  return { ...profile, adapter, sha256: await executableDigest(profile.executable),
    ...(adapter === 'opencode-local' && { localModel: normalizeLocalChatTarget(localModel?.endpoint, localModel?.model) }) };
}

function isolatedEnvironment(folder) {
  const system = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(Path|SystemRoot|ComSpec|windir|PATHEXT|LANG|LC_ALL)$/i.test(key)));
  // A peer inherits bootstrap paths only, plus its own temporary profile directories.
  return { ...system, HOME: folder, USERPROFILE: folder, LOCALAPPDATA: folder, APPDATA: folder, TEMP: folder, TMP: folder,
    XDG_CONFIG_HOME: folder, XDG_STATE_HOME: folder, XDG_DATA_HOME: folder, XDG_CACHE_HOME: folder };
}

async function runIsolatedAgent(agent, { text, schema, schemaName, signal, onUpdate } = {}) {
  signal?.throwIfAborted();
  if (await executableDigest(agent.executable) !== agent.sha256) throw Error('The reviewed ACP executable changed. Review it again.');
  signal?.throwIfAborted();
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rocketbrain-db-acp-'));
  let bridge;
  try {
    const env = isolatedEnvironment(folder);
    if (agent.adapter === 'opencode-local') {
      const { model } = agent.localModel;
      bridge = await startStructuredBridge(agent.localModel, { prompt: text, schema, name: schemaName, signal });
      const config = { model: 'rocketbrain/' + model, enabled_providers: ['rocketbrain'], autoupdate: false, snapshot: false,
        default_agent: 'rocketbrain-review', agent: { 'rocketbrain-review': { mode: 'primary', temperature: 0, top_p: 1,
          prompt: 'Follow the latest reviewed request literally. Return exactly the requested JSON object. Use no tools.' } },
        permission: 'deny', provider: { rocketbrain: { name: 'Approved loopback model', npm: '@ai-sdk/openai-compatible',
          options: { baseURL: bridge.baseURL, apiKey: bridge.key },
          models: { [model]: { name: model, tool_call: false, limit: { context: 4096, output: 1024 } } } } } };
      const filename = path.join(folder, 'opencode.json');
      await fs.writeFile(filename, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
      Object.assign(env, { OPENCODE_CONFIG: filename, OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1' });
    }
    return await runAgent(agent, { cwd: folder, env, text, signal, onUpdate });
  } finally {
    await bridge?.close();
    const current = await fs.realpath(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (current && (current !== folder || path.dirname(current) !== parent || !path.basename(current).startsWith('rocketbrain-db-acp-'))) {
      throw Error('The isolated ACP directory changed before cleanup.');
    }
    if (current) await fs.rm(current, { recursive: true, maxRetries: 6, retryDelay: 150 });
  }
}

module.exports = { prepareIsolatedAgent, runIsolatedAgent };
