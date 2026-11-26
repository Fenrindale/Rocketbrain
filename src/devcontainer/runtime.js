'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { observeCompose, assertComposeSources, projectIds, locateProject, validateSavedCompose } = require('./compose');

const cliVersion = '0.91.0';
const sessionLabel = 'rocketbrain.devcontainer.session';
const containerId = /^[a-f0-9]{64}$/;
const sessionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const configNames = ['.devcontainer/devcontainer.json', '.devcontainer.json'];
const lifecycleKeys = ['initializeCommand', 'onCreateCommand', 'updateContentCommand', 'postCreateCommand',
  'postStartCommand', 'postAttachCommand'];
const configLimit = 256 * 1024;
const timeLimit = { inspect: 30000, start: 600000, exec: 120000, stop: 30000 };

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

function localAbsolute(value) {
  return typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) &&
    !/^[\\/]{2}|[\x00-\x1f]/.test(value);
}

function localDirectory(value, message) {
  try {
    if (localAbsolute(value)) {
      const real = fs.realpathSync(value);
      if (localAbsolute(real) && fs.statSync(real).isDirectory()) return real;
    }
  } catch {}
  throw Error(message);
}

function configSnapshot(root) {
  for (const name of configNames) {
    const file = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.size > configLimit || path.relative(root, fs.realpathSync(file)) !== path.normalize(name)) {
      throw Error('Use a regular Dev Container configuration within this workspace, up to 256 KiB.');
    }
    return { file, hash: sha256(fs.readFileSync(file)) };
  }
  throw Error('Add .devcontainer/devcontainer.json or .devcontainer.json to the selected workspace.');
}

function localExecutable(selected, name) {
  const defaultName = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = selected
    ? [selected]
    : (process.env.PATH || '').split(path.delimiter).map(dir => dir.replace(/^"|"$/g, ''))
      .filter(localAbsolute).map(dir => path.join(dir, defaultName));
  for (const candidate of candidates) {
    try {
      if (!localAbsolute(candidate)) continue;
      const file = fs.realpathSync(candidate);
      if (!localAbsolute(file) || !fs.statSync(file).isFile()) continue;
      if (process.platform === 'win32' && path.extname(file).toLowerCase() !== '.exe') continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {}
  }
  throw Error('Configure a local ' + name + ' executable in Rocketbrain Dev Container settings.');
}

function localCli(cliPath) {
  const home = localDirectory(cliPath, 'Set the Dev Container CLI package folder in Rocketbrain settings.');
  const metadataPath = path.join(home, 'package.json');
  const entry = path.join(home, 'devcontainer.js');
  let manifest;
  try {
    if (fs.statSync(metadataPath).size > 128 * 1024 || !fs.statSync(entry).isFile()) throw Error();
    manifest = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  } catch { throw Error('Choose the installed @devcontainers/cli package folder.'); }
  if (manifest.name !== '@devcontainers/cli' || manifest.version !== cliVersion) {
    throw Error('Install @devcontainers/cli ' + cliVersion + ' for this Rocketbrain workflow.');
  }
  return entry;
}

function invoke(executable, argv, { cwd, env, timeout }) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, argv, {
      cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8'
    }, (error, stdout, stderr) => {
      if (error && typeof error.code !== 'number') {
        reject(Error(error.killed ? 'The local Dev Container operation exceeded its time limit.' :
          'The local Dev Container process could not complete within its output limit.'));
      } else {
        resolve({ code: error?.code || 0, stdout, stderr });
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

function commandOutput(result, message) {
  if (result.code !== 0) throw Error(message);
  return result.stdout.trim();
}

function json(result, message) {
  try { return JSON.parse(commandOutput(result, message)); } catch { throw Error(message); }
}

function processEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^NODE_(?:OPTIONS|PATH)$/i.test(key)));
}

function composeEnvironment(target, project) {
  const env = Object.fromEntries(Object.entries(target.env).filter(([key]) =>
    !/^COMPOSE_(?:PROJECT_NAME|FILE|PROFILES|ENV_FILES|DISABLE_ENV_FILE|REMOVE_ORPHANS|IGNORE_ORPHANS|ANSI)$/iu.test(key)));
  return { ...target,env:{...env,COMPOSE_PROJECT_NAME:project,COMPOSE_ANSI:'never'} };
}

const freshComposeProject = () => 'rocketbraindc'+randomUUID().replaceAll('-','');

function localEndpoint(value) {
  return typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/.test(value) &&
    (/^unix:\/\/\/[^/\s]/.test(value) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/i.test(value));
}

function argvFor(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64 ||
      input.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !input[0] || input[0].startsWith('-') ||
      Buffer.byteLength(input.join('\0')) > 8192) {
    throw Error('Enter a command and up to 63 arguments as a JSON array of strings, up to 8 KiB.');
  }
  return [...input];
}

function summarize(result, file) {
  const config = result?.configuration;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw Error('The Dev Container CLI returned an invalid configuration.');
  }
  const build = config.build?.dockerfile || config.dockerFile;
  const kind = Object.hasOwn(config, 'dockerComposeFile') ? 'compose' : typeof build === 'string' && build
    ? 'dockerfile' : typeof config.image === 'string' && config.image ? 'image' : 'unknown';
  return {
    file, kind, name: typeof config.name === 'string' ? config.name : '',
    image: kind === 'image' ? config.image : undefined,
    dockerfile: kind === 'dockerfile' ? build : undefined,
    workspaceFolder: result.workspace?.workspaceFolder,
    workspaceMount: result.workspace?.workspaceMount,
    remoteUser: typeof config.remoteUser === 'string' ? config.remoteUser : undefined,
    features: Object.keys(config.features || {}),
    lifecycleHooks: lifecycleKeys.filter(key => Object.hasOwn(config, key)),
    cliVersion
  };
}

function createDevContainers({ trusted, settings, run = invoke, readSession, writeSession } = {}) {
  const memory = new Map();
  const load = readSession || (key => memory.get(key));
  const save = writeSession || ((key, value) => value ? memory.set(key, value) : memory.delete(key));
  const busy = new Set(), offers = new Map();

  function rootFor(workspace) {
    if (!trusted?.()) throw Error('Trust the selected local workspace to use Dev Containers.');
    return localDirectory(workspace, 'Choose an open local workspace for Dev Containers.');
  }

  async function exclusive(workspace, work) {
    const root = rootFor(workspace);
    const key = sha256(process.platform === 'win32' ? root.toLowerCase() : root);
    if (busy.has(key)) throw Error('A Dev Container operation is already running for this workspace.');
    busy.add(key);
    try { return await work(root, key); } finally { busy.delete(key); }
  }

  async function dockerEnvironment(root, options) {
    const docker = localExecutable(options.dockerPath, 'docker');
    const env = processEnv();
    const override = env.DOCKER_CONTEXT ? '' : env.DOCKER_HOST;
    const host = override || commandOutput(await run(docker, ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      cwd: root, env, timeout: timeLimit.inspect
    }), 'Select an active local Docker context.');
    if (!localEndpoint(host)) throw Error('Select a Docker context using a local Unix socket or Windows named pipe.');
    for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH']) delete env[key];
    return { root, docker, host, env };
  }

  function docker(target, args, timeout = timeLimit.inspect) {
    return run(target.docker, ['--host=' + target.host, ...args], { cwd: target.root, env: target.env, timeout });
  }

  function cli(root, options) {
    return { root, entry: localCli(options.cliPath), node: localExecutable(options.nodePath, 'node') };
  }

  function devcontainer(cliTarget, dockerTarget, config, command, args, timeout) {
    return run(cliTarget.node, [cliTarget.entry, command, '--workspace-folder', cliTarget.root, '--config', config,
      '--docker-path', dockerTarget.docker, '--docker-arg=--host=' + dockerTarget.host,
      '--mount-workspace-git-root=false', '--oci-auth-hardening=true', ...args],
    { cwd: cliTarget.root, env: dockerTarget.env, timeout });
  }

  async function inspectWith(root, cliTarget, dockerTarget, project) {
    const snapshot = configSnapshot(root);
    // Use a fresh label so inspection reads the workspace file without adopting an existing container.
    const target=project?composeEnvironment(dockerTarget,project):dockerTarget;
    const response = await devcontainer(cliTarget, target, snapshot.file, 'read-configuration',
      ['--id-label', sessionLabel + '=' + randomUUID()], timeLimit.inspect);
    const result=json(response,'The CLI could not read the Dev Container configuration. Verify the file and local Docker service.');
    const plan={...summarize(result,snapshot.file),fingerprint:snapshot.hash};
    const current = configSnapshot(root);
    if (snapshot.file !== current.file || snapshot.hash !== current.hash) throw Error('The Dev Container configuration changed during inspection.');
    if(plan.kind!=='compose')return plan;
    if(!project)return inspectWith(root,cliTarget,dockerTarget,freshComposeProject());
    const compose=await observeCompose({root,configFile:snapshot.file,configuration:result.configuration,project,
      docker:args=>docker(target,args)});
    const final=configSnapshot(root);
    if(final.file!==snapshot.file||final.hash!==snapshot.hash)throw Error('The Dev Container configuration changed during Compose inspection.');
    return {...plan,compose};
  }

  function checkedSession(key) {
    const saved = load(key);
    if (!saved) return undefined;
    if (!sessionId.test(saved.session) || !localEndpoint(saved.host) || saved.id && !containerId.test(saved.id)) {
      throw Error('The saved Dev Container session is invalid.');
    }
    if(saved.compose) {
      validateSavedCompose(saved.compose);
      if(saved.id&&saved.compose.ids?.[saved.compose.service]!==saved.id)throw Error('The saved Compose workspace identity is invalid.');
    }
    return saved;
  }

  async function verifyContainer(target, session, id) {
    if (!containerId.test(id)) throw Error('The local Docker service did not return an exact container ID.');
    const actual = json(await docker(target, ['container', 'inspect', '--format', '{{json .}}', id]),
      'The exact Dev Container could not be found on the local Docker service.');
    if (actual?.Id !== id || actual.Config?.Labels?.[sessionLabel] !== session.session || typeof actual.State?.Running !== 'boolean') {
      throw Error('Container ownership could not be verified for this workspace session.');
    }
    return { id, running: actual.State.Running };
  }

  async function locate(target, session) {
    if (session.host !== target.host) throw Error('Switch back to the local Docker context used for this session.');
    const ids = commandOutput(await docker(target, ['container', 'ls', '--all', '--no-trunc', '--quiet',
      '--filter', 'label=' + sessionLabel + '=' + session.session]),
    'The local Docker service could not check this Dev Container session.').split(/\r?\n/).filter(Boolean);
    if (!ids.length) return undefined;
    if (ids.length !== 1 || session.id && session.id !== ids[0]) {
      throw Error('The exact container for this workspace session could not be identified.');
    }
    return verifyContainer(target, session, ids[0]);
  }

  async function locateCompose(target,session) {
    if(session.host!==target.host)throw Error('Switch back to the local Docker context used for this session.');
    return locateProject(session,args=>docker(target,args));
  }

  function publicCompose(plan,token) {
    const {project,files,service,services}=plan.compose;
    return {file:plan.file,kind:plan.kind,cliVersion:plan.cliVersion,lifecycleHooks:plan.lifecycleHooks,
      compose:{project,files,service,services},fingerprint:token};
  }

  function retainComposeOffer(root,host,plan) {
    const now=Date.now();
    for(const [key,offer] of offers)if(offer.expires<=now)offers.delete(key);
    while(offers.size>=8)offers.delete(offers.keys().next().value);
    const token=randomUUID();
    offers.set(token,{root,host,plan,expires:now+120000});
    return publicCompose(plan,token);
  }

  function matchingCompose(actual,review) {
    return actual.kind==='compose'&&actual.file===review.file&&actual.fingerprint===review.fingerprint&&
      actual.compose?.signature===review.compose.signature&&actual.compose.project===review.compose.project;
  }

  function currentConfig(root,session) {
    const current=configSnapshot(root);
    if(current.file!==session.file||current.hash!==session.fingerprint)throw Error('The Dev Container configuration changed. Inspect it again.');
  }

  function rememberObserved(key,session,observed) {
    if(session.compose.ids||!observed.length)return;
    return save(key,{...session,compose:{...session.compose,observedIds:{
      ...session.compose.observedIds,...Object.fromEntries(observed.map(row=>[row.service,row.id])),
    }}});
  }

  async function startCompose(root,key,cliTarget,target,review,offer) {
    if(offer.expires<=Date.now()||offer.root!==root||offer.host!==target.host||offer.plan.file!==review.file) {
      throw Error('Open a current Compose review for this workspace and local Docker context.');
    }
    const approved=offer.plan,project=approved.compose.project;
    const live=await inspectWith(root,cliTarget,target,project);
    if(!matchingCompose(live,approved))throw Error('The Compose files or resolved configuration changed. Inspect again before starting.');
    if((await projectIds(project,args=>docker(target,args))).length) {
      throw Error('The isolated Compose project already has containers. Inspect again for a fresh project.');
    }
    const {service,services,signature}=live.compose;
    const session={session:randomUUID(),host:target.host,file:live.file,fingerprint:live.fingerprint,compose:{project,service,services,signature}};
    currentConfig(root,session);
    assertComposeSources(root,live.compose);
    if(!trusted?.())throw Error('Trust the selected local workspace before running Compose lifecycle commands.');
    await save(key,session);
    offers.delete(review.fingerprint);
    try {
      currentConfig(root,session);
      assertComposeSources(root,live.compose);
      if(!trusted?.())throw Error('Trust the selected local workspace before running Compose lifecycle commands.');
    } catch(error) { await save(key,undefined); throw error; }
    let result, observed;
    try {
      result=json(await devcontainer(cliTarget,composeEnvironment(target,project),session.file,'up',
        ['--id-label',sessionLabel+'='+session.session,'--skip-post-attach'],timeLimit.start),
      'The CLI could not start this Compose Dev Container. Check its saved status or stop its verified services.');
      if(result?.outcome!=='success'||!containerId.test(result.containerId??'')) {
        throw Error('The CLI did not confirm this Compose start. Check its saved status or stop its verified services.');
      }
      observed=await locateCompose(target,session);
      if(observed.length!==services.length||!observed.every(row=>row.running)||observed[0]?.id!==result.containerId) {
        throw Error('The Compose start did not verify the exact workspace and dependency containers. Check its saved status.');
      }
    } catch (error) {
      try { await rememberObserved(key,session,observed??await locateCompose(target,session)); }
      catch { /* Preserve the pending session for a later ownership check. */ }
      throw error;
    }
    const ids=Object.fromEntries(observed.map(row=>[row.service,row.id]));
    await save(key,{...session,id:result.containerId,compose:{...session.compose,ids}});
    return {state:'running',id:result.containerId,kind:'compose',project,services:observed,
      workspaceFolder:result.remoteWorkspaceFolder,remoteUser:result.remoteUser};
  }

  async function executeCompose(root,options,target,session,args) {
    const cliTarget=cli(root,options),project=session.compose.project;
    const observed=await locateCompose(target,session);
    if(observed.length!==session.compose.services.length||!observed.every(row=>row.running)||observed[0]?.id!==session.id) {
      throw Error('The managed Compose workspace and dependency services are not all running.');
    }
    const plan=await inspectWith(root,cliTarget,target,project);
    if(plan.kind!=='compose'||plan.compose.signature!==session.compose.signature||
        plan.fingerprint!==session.fingerprint||plan.file!==session.file) {
      throw Error('The Compose files or resolved configuration changed. Stop, inspect and start again.');
    }
    const current=await locateCompose(target,session);
    if(current.length!==observed.length||!current.every(row=>row.running)||current[0]?.id!==session.id) {
      throw Error('The managed Compose service identities changed before execution.');
    }
    currentConfig(root,session);
    assertComposeSources(root,plan.compose);
    if(!trusted?.())throw Error('Trust the selected local workspace before running a container command.');
    const result=await devcontainer(cliTarget,composeEnvironment(target,project),session.file,'exec',
      ['--container-id',session.id,'--id-label',sessionLabel+'='+session.session,...args],timeLimit.exec);
    return { id:session.id,code:result.code,stdout:result.stdout,stderr:result.stderr };
  }

  async function statusCompose(target,session,key) {
    const services=await locateCompose(target,session),app=services.find(row=>row.service===session.compose.service);
    await rememberObserved(key,session,services);
    const state=!services.length?(session.id?'missing':'unconfirmed'):
      !session.id||services.length!==session.compose.services.length?'partial':
      services.every(row=>row.running)?'running':services.every(row=>!row.running)?'stopped':'partial';
    return {state,kind:'compose',project:session.compose.project,...(app&&{id:app.id}),services};
  }

  async function stopCompose(target,session) {
    const observed=await locateCompose(target,session);
    const ids=observed.filter(row=>row.running).map(row=>row.id);
    if(ids.length)commandOutput(await docker(target,['container','stop','--time','10',...ids],timeLimit.stop),
      'The exact managed Compose containers did not stop.');
    const after=await locateCompose(target,session);
    const reviewedIds=new Set(observed.map(row=>row.id));
    if(after.some(row=>row.running||!reviewedIds.has(row.id)))throw Error('The managed Compose inventory changed while stopping.');
    const app=observed.find(row=>row.service===session.compose.service);
    return {state:observed.length?'stopped':'missing',kind:'compose',project:session.compose.project,...(app&&{id:app.id}),services:after};
  }

  return {
    inspect(workspace) {
      return exclusive(workspace, async root => {
        const options = settings(root);
        const target=await dockerEnvironment(root,options);
        const plan=await inspectWith(root,cli(root,options),target);
        return plan.compose?retainComposeOffer(root,target.host,plan):plan;
      });
    },
    start(workspace, review) {
      return exclusive(workspace, async (root, key) => {
        if (review?.allowProjectExecution !== true) throw Error('Review the Dev Container configuration before starting it.');
        if (checkedSession(key)) throw Error('Stop or clear the existing managed Dev Container session before starting another.');
        const options = settings(root);
        const cliTarget = cli(root, options);
        const target = await dockerEnvironment(root, options);
        const offer=offers.get(review.fingerprint);
        if(offer)return startCompose(root,key,cliTarget,target,review,offer);
        const plan = await inspectWith(root, cliTarget, target);
        if(plan.kind==='compose')throw Error('Inspect a fresh Compose configuration and approve its specific project review.');
        if (plan.fingerprint !== review.fingerprint || plan.file !== review.file) {
          throw Error('The Dev Container configuration changed. Inspect it again before starting.');
        }
        if (!['image', 'dockerfile'].includes(plan.kind)) {
          throw Error('Choose a single-image or Dockerfile Dev Container configuration.');
        }
        const session = { session: randomUUID(), host: target.host, file: plan.file, fingerprint: plan.fingerprint };
        await save(key, session);
        const current = configSnapshot(root);
        if (current.file !== plan.file || current.hash !== plan.fingerprint) {
          await save(key, undefined);
          throw Error('The Dev Container configuration changed. Inspect it again before starting.');
        }
        if (!trusted?.()) {
          await save(key, undefined);
          throw Error('Trust the selected local workspace before running Dev Container lifecycle commands.');
        }
        const result = json(await devcontainer(cliTarget, target, plan.file, 'up',
          ['--id-label', sessionLabel + '=' + session.session, '--skip-post-attach'], timeLimit.start),
        'The CLI could not start this Dev Container. Check the saved session with Dev Container Status or Stop.');
        if (result?.outcome !== 'success') throw Error('The CLI did not report a successful Dev Container start.');
        const actual = await verifyContainer(target, session, result.containerId);
        if (!actual.running) throw Error('The new workspace Dev Container is no longer running.');
        await save(key, { ...session, id: actual.id });
        return { state: 'running', id: actual.id, workspaceFolder: result.remoteWorkspaceFolder, remoteUser: result.remoteUser };
      });
    },
    execute(workspace, argv) {
      return exclusive(workspace, async (root, key) => {
        const args = argvFor(argv);
        const session = checkedSession(key);
        if (!session?.id) throw Error('Start the managed Dev Container before running commands.');
        const snapshot = configSnapshot(root);
        if (snapshot.file !== session.file || snapshot.hash !== session.fingerprint) {
          throw Error('The Dev Container configuration changed. Stop, inspect and start it again.');
        }
        const options = settings(root);
        const target = await dockerEnvironment(root, options);
        if(session.compose)return executeCompose(root,options,target,session,args);
        const actual = await locate(target, session);
        if (!actual?.running) throw Error('The managed Dev Container is no longer running.');
        const current = configSnapshot(root);
        if (snapshot.file !== current.file || snapshot.hash !== current.hash) throw Error('The Dev Container configuration changed before execution.');
        if (!trusted?.()) throw Error('Trust the selected local workspace before running a container command.');
        const result = await devcontainer(cli(root, options), target, snapshot.file, 'exec', [
          '--container-id', actual.id, '--id-label', sessionLabel + '=' + session.session, ...args
        ], timeLimit.exec);
        return { id: actual.id, code: result.code, stdout: result.stdout, stderr: result.stderr };
      });
    },
    status(workspace) {
      return exclusive(workspace, async (root, key) => {
        const session = checkedSession(key);
        if (!session) return { state: 'none' };
        const target=await dockerEnvironment(root,settings(root));
        if(session.compose)return statusCompose(target,session,key);
        const actual = await locate(target, session);
        if (!actual) return { state: session.id ? 'missing' : 'unconfirmed' };
        return { state: actual.running ? 'running' : 'stopped', id: actual.id };
      });
    },
    stop(workspace) {
      return exclusive(workspace, async (root, key) => {
        const session = checkedSession(key);
        if (!session) return { state: 'none' };
        const target = await dockerEnvironment(root, settings(root));
        if(session.compose) {
          const outcome=await stopCompose(target,session);
          await save(key,undefined);
          return outcome;
        }
        const actual = await locate(target, session);
        if (actual?.running) {
          commandOutput(await docker(target, ['container', 'stop', '--time', '10', actual.id], timeLimit.stop),
            'The exact workspace Dev Container did not stop.');
          if ((await verifyContainer(target, session, actual.id)).running) throw Error('The workspace Dev Container is still running.');
        }
        await save(key, undefined);
        return actual ? { state: 'stopped', id: actual.id } : { state: 'missing' };
      });
    }
  };
}

module.exports = { createDevContainers, cliVersion, sessionLabel };
