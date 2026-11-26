'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { parseDocument } = require('yaml');

const projectName = /^rocketbraindc[a-f0-9]{32}$/u;
const serviceName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/u;
const idPattern = /^[a-f0-9]{64}$/u;
const projectLabel = 'com.docker.compose.project';
const serviceLabel = 'com.docker.compose.service';
const ownLabel = 'rocketbrain.devcontainer.session';
const maxServices = 8;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function contained(root, file) {
  const relative = path.relative(root,file);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function sourceFile(root, file, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
      !contained(root,file) || path.relative(file,fs.realpathSync(file))) {
    throw Error('Use bounded physical Compose files inside the selected workspace.');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length > 256 * 1024) throw Error('A reviewed Compose input exceeded 256 KiB.');
  return { file, sha256: hash(bytes), bytes };
}

function composeFiles(root, configFile, configuration) {
  const declared = typeof configuration.dockerComposeFile === 'string' ? [configuration.dockerComposeFile] : configuration.dockerComposeFile;
  if (!Array.isArray(declared) || !declared.length || declared.length > 4 || declared.some(name => typeof name !== 'string' ||
      !name || name.length > 1024 || path.isAbsolute(name) || /[\x00-\x1f]/u.test(name) || !/\.ya?ml$/iu.test(name))) {
    throw Error('Choose one to four explicit local Compose YAML files in the Dev Container configuration.');
  }
  const received = new Set();
  const files = declared.map(relative => {
    const file = path.resolve(path.dirname(configFile),relative);
    const key = process.platform === 'win32' ? file.toLowerCase() : file;
    if (received.has(key)) throw Error('The Dev Container repeats a Compose file.');
    received.add(key);
    const entry = sourceFile(root,file);
    const parsed = parseDocument(entry.bytes.toString('utf8'),{ logLevel:'silent' });
    if (parsed.errors.length) throw Error('A reviewed Compose file is not valid YAML.');
    const data = parsed.toJS({ maxAliasCount:32 });
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.include ||
        Object.values(data.services ?? {}).some(service => service?.extends?.file || service?.profiles?.length)) {
      throw Error('Use explicit Compose files without indirect includes, external extensions, or service profiles.');
    }
    return entry;
  });
  const candidates = new Set([path.join(root,'.env'),path.join(path.dirname(files[0].file),'.env')]);
  const environment = [...candidates].map(name => sourceFile(root,name,true)).filter(Boolean);
  return { files, sources: [...files,...environment].map(({file,sha256})=>[file,sha256]) };
}

function servicesIn(model, configuration, project) {
  const all = model?.services;
  if (!all || typeof all !== 'object' || Array.isArray(all) || model.name !== project ||
      !serviceName.test(configuration.service ?? '') || !Object.hasOwn(all,configuration.service)) {
    throw Error('The resolved Compose project must contain the explicitly selected workspace service.');
  }
  const configured = configuration.runServices ?? [];
  if (!Array.isArray(configured) || configured.length > maxServices || new Set(configured).size !== configured.length ||
      configured.some(name=>typeof name!=='string'||!serviceName.test(name)||!Object.hasOwn(all,name))) {
    throw Error('Select named Compose runServices from the reviewed project.');
  }
  const selected = new Set();
  function visit(name) {
    if (selected.has(name)) return;
    const service = all[name];
    if (!service || typeof service !== 'object' || Array.isArray(service) || !serviceName.test(name) ||
        service.container_name || service.external_links?.length || service.links?.length || service.volumes_from?.length ||
        [service.network_mode,service.pid,service.ipc].some(value=>typeof value==='string'&&/^(?:container|service):/u.test(value)) ||
        service.profiles?.length || service.scale !== undefined && service.scale !== 1 ||
        service.deploy?.replicas !== undefined && service.deploy.replicas !== 1 || service.deploy?.mode === 'global' ||
        Object.hasOwn(service.labels ?? {},ownLabel)) {
      throw Error('Choose one managed container per service without shared container names or external container references.');
    }
    selected.add(name);
    if (selected.size > maxServices) throw Error('Review at most eight Compose services including dependencies.');
    const entries = Array.isArray(service.depends_on) ? service.depends_on : Object.keys(service.depends_on ?? {});
    for (const dependency of entries) {
      if (!Object.hasOwn(all,dependency) || !serviceName.test(dependency)) throw Error('Compose resolved a dependency outside the reviewed service graph.');
      visit(dependency);
    }
  }
  visit(configuration.service);
  for (const name of configured.length ? configured : Object.keys(all)) visit(name);
  for (const type of ['networks','volumes']) {
    for (const [name,resource] of Object.entries(model[type] ?? {})) {
      if (resource?.external || resource?.name && resource.name !== project+'_'+name) {
        throw Error('Use Compose networks and volumes within the isolated project namespace.');
      }
    }
  }
  return [configuration.service,...[...selected].filter(name=>name!==configuration.service).sort()];
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])]));
  return value;
}

async function observeCompose({root,configFile,configuration,project,docker}) {
  if (!projectName.test(project)) throw Error('Use an isolated Compose project identity.');
  const before = composeFiles(root,configFile,configuration);
  const result = await docker(['compose','--project-name',project,...before.files.flatMap(({file})=>['-f',file]),'config','--format','json']);
  let model;
  try {
    if (result.code!==0)throw Error();
    model=JSON.parse(result.stdout);
  } catch { throw Error('The local Docker Compose plugin could not resolve these explicit project files.'); }
  const selected=servicesIn(model,configuration,project);
  if (JSON.stringify(before.sources)!==JSON.stringify(composeFiles(root,configFile,configuration).sources)) {
    throw Error('The Compose sources changed while reading the project.');
  }
  return { project, files:before.files.map(({file})=>path.relative(root,file)), service:configuration.service, services:selected,
    sources:before.sources, signature:hash(JSON.stringify([before.sources,stable(model),selected])) };
}

function assertComposeSources(root, compose) {
  const declared=compose.files.map(file=>path.resolve(root,file));
  const environment=new Set([path.join(root,'.env'),path.join(path.dirname(declared[0]),'.env')]);
  const now=[...declared.map(file=>sourceFile(root,file)),
    ...[...environment].map(file=>sourceFile(root,file,true)).filter(Boolean)].map(record=>[record.file,record.sha256]);
  if(JSON.stringify(now)!==JSON.stringify(compose.sources))throw Error('The reviewed Compose files changed before the operation.');
}

const filter = project => ['container','ls','--all','--no-trunc','--quiet','--filter','label='+projectLabel+'='+project];
const identityTemplate = '{"id":{{json .Id}},"project":{{json (index .Config.Labels "'+projectLabel+'")}},' +
  '"service":{{json (index .Config.Labels "'+serviceLabel+'")}},"owner":{{json (index .Config.Labels "'+ownLabel+'")}},' +
  '"oneOff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"running":{{json .State.Running}}}';

async function projectIds(project,docker) {
  if (!projectName.test(project)) throw Error('The saved Compose project identity is invalid.');
  const result=await docker(filter(project));
  if (result.code!==0) throw Error('The local Docker service could not check the Compose project.');
  const ids=result.stdout.trim().split(/\r?\n/u).filter(Boolean);
  if (ids.length>maxServices||new Set(ids).size!==ids.length||ids.some(id=>!idPattern.test(id))) {
    throw Error('The exact Compose project inventory could not be identified.');
  }
  return ids;
}

async function identity(id,docker) {
  let found;
  try {
    const result=await docker(['container','inspect','--format',identityTemplate,id]);
    if(result.code!==0)throw Error();
    found=JSON.parse(result.stdout);
  } catch { throw Error('The exact Compose container could not be inspected.'); }
  if(found?.id!==id||typeof found.running!=='boolean')throw Error('The Compose container identity could not be verified.');
  return found;
}

async function locateProject(session,docker) {
  const { project, service, services, ids, observedIds } = session.compose;
  const listed = await projectIds(project,docker);
  const owners = new Map();
  for (const id of listed) {
    const found=await identity(id,docker);
    if(found.project!==project||!services.includes(found.service)||owners.has(found.service)||
        String(found.oneOff).toLowerCase()!=='false'||
        (found.service===service?found.owner!==session.session:Boolean(found.owner))||
        ids&&ids[found.service]!==id||observedIds&&Object.hasOwn(observedIds,found.service)&&observedIds[found.service]!==id) {
      throw Error('Compose service ownership changed or could not be verified.');
    }
    owners.set(found.service,{service:found.service,id,running:found.running});
  }
  return services.flatMap(name=>owners.get(name)||[]);
}

function validateSavedCompose(compose) {
  if(!projectName.test(compose?.project??'')||!serviceName.test(compose?.service??'')||
      !Array.isArray(compose.services)||!compose.services.length||compose.services.length>maxServices||
      new Set(compose.services).size!==compose.services.length||compose.services[0]!==compose.service||
      compose.services.some(name=>typeof name!=='string'||!serviceName.test(name))||
      !/^[a-f0-9]{64}$/u.test(compose.signature??'')||
      compose.ids&&(typeof compose.ids!=='object'||Object.keys(compose.ids).length!==compose.services.length||
        !compose.services.every(name=>idPattern.test(compose.ids[name]??''))||
        new Set(Object.values(compose.ids)).size!==compose.services.length)||
      compose.observedIds&&(typeof compose.observedIds!=='object'||Array.isArray(compose.observedIds)||
        Object.entries(compose.observedIds).some(([name,id])=>!compose.services.includes(name)||!idPattern.test(id)))) {
    throw Error('The saved Dev Container Compose session is invalid.');
  }
}

module.exports = { observeCompose, assertComposeSources, projectIds, locateProject, validateSavedCompose };
