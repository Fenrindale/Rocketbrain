'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { sourceEndpoints } = require('../src/java/spring');

const PREFIX = '/endpoint-fixture';
const PERSON = PREFIX + '/people/{id}';
const COMMAND = PREFIX + '/commands/echo';
const BRIDGE = '/probe/endpoint-routing';
const STATIC = '/endpoint-static';
const EXPECTED = [
  ['webflux','ReactiveEndpointProbe.java','GET',PERSON,'GET'],
  ['webflux','ReactiveEndpointProbe.java','POST',COMMAND,'POST'],
  ['webflux','ReactiveEndpointProbe.java','GET',STATIC,'RouterFunctions.route'],
  ['feign','FixtureEndpointClient.java','GET',PERSON,'@GetMapping'],
  ['feign','FixtureEndpointClient.java','POST',COMMAND,'@RequestMapping'],
  ['mvc','EndpointBridge.java','GET',BRIDGE,'@GetMapping']
];

function readConfig() {
  const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  for (const value of [config.baseUrl,config.endpointProbeUrl]) {
    const url = new URL(value);
    assert.equal(url.protocol,'http:');
    assert.equal(url.hostname,'127.0.0.1');
    assert.ok(url.port && url.origin === value);
  }
  assert.notEqual(config.baseUrl,config.endpointProbeUrl);
  assert.ok(['mysql','mariadb'].includes(config.dbEngine));
  return config;
}

function ownedSources(config) {
  const directory = path.join(config.projectPath,'src','endpoint-probe','java','fixture','boot');
  return Object.fromEntries([...new Set(EXPECTED.map(item=>item[1]))].map(name => {
    const file = path.join(directory,name);
    return [name,{uri:pathToFileURL(file).href,text:fs.readFileSync(file,'utf8')}];
  }));
}

function selectDeclarations(endpoints,sources) {
  const selected = EXPECTED.map(([kind,name,verb,endpoint,marker]) => {
    const candidates = endpoints.filter(item => item.kind === kind && item.state === 'declared' && item.path === endpoint &&
      item.methods.join('|') === verb && item.uri.endsWith('/' + name));
    assert.equal(candidates.length,1,kind+' '+verb+' '+endpoint);
    const item = candidates[0], start = item.range.start, end = item.range.end;
    const line = sources[name].text.split(/\r?\n/)[start.line];
    assert.equal(end.line,start.line);
    assert.ok(line.slice(start.character,end.character).startsWith(marker),kind+' exact source marker');
    return [item,marker];
  });
  const unresolved = endpoints.filter(item => item.kind === 'webflux' && item.state === 'unresolved' && item.uri.endsWith('/ReactiveEndpointProbe.java'));
  assert.equal(unresolved.length,1);
  assert.equal(unresolved[0].path,null);
  assert.ok(sources['ReactiveEndpointProbe.java'].text.split(/\r?\n/)[unresolved[0].range.start.line].includes('dynamicProbePath()'));
  assert.equal(endpoints.some(item => item.path === '/endpoint-computed'),false);
  return selected;
}

async function runtimeBindings(config, selected) {
  const request = (base,endpoint,method='GET',headers={}) => fetch(base+endpoint,{method,headers,redirect:'error',signal:AbortSignal.timeout(8000)});
  const find = (kind,name) => selected.map(item=>item[0]).find(item=>item.kind===kind && item.path===name);
  const server = find('webflux',PERSON), client = find('feign',PERSON);
  const command = find('webflux',COMMAND), outgoingCommand = find('feign',COMMAND);
  const bridge = find('mvc',BRIDGE), staticRoute = find('webflux',STATIC);
  assert.equal(server.path,client.path);
  assert.deepEqual(server.methods,client.methods);
  assert.ok(server.constrained && client.constrained);
  assert.equal(command.path,outgoingCommand.path);
  assert.deepEqual(command.methods,outgoingCommand.methods);
  const route = server.path.replace('{id}','7'), origin = config.endpointProbeUrl;
  const [person, echo, direct, computed, wrongMethod, wrongAccept, feign, fixtureState] = await Promise.all([
    request(origin,route,server.methods[0],{Accept:'text/plain'}),
    request(origin,command.path,command.methods[0]),
    request(origin,staticRoute.path,staticRoute.methods[0]),
    request(origin,'/endpoint-computed'),
    request(origin,command.path,'GET'),
    request(origin,route,server.methods[0],{Accept:'application/json'}),
    request(config.baseUrl,bridge.path,bridge.methods[0]),
    request(config.baseUrl,'/probe/testing-state')
  ]);
  for (const response of [person,echo,direct,computed,feign,fixtureState]) assert.equal(response.status,200,response.url);
  assert.deepEqual([wrongMethod.status,wrongAccept.status],[404,404]);
  const [personBody,commandBody,staticBody,computedBody,clientBody,database] = await Promise.all([
    person.text(),echo.text(),direct.text(),computed.text(),feign.json(),fixtureState.json()
  ]);
  assert.match(personBody,/^GET:7:\d+\.\d+\.\d+/);
  assert.equal(/mariadb/i.test(personBody),config.dbEngine==='mariadb');
  assert.equal(commandBody,'POST:echo');
  assert.equal(staticBody,'static');
  assert.equal(computedBody,'dynamic');
  assert.deepEqual(clientBody,{person:personBody,echo:commandBody});
  assert.deepEqual(database,{people:2,departments:1,rolledBackNames:0});
  return {engine:config.dbEngine,databaseVersion:personBody.slice('GET:7:'.length),database,serverRoutes:3,feignContracts:2,
    mvcBridge:true,wrongMethod:wrongMethod.status,wrongAccept:wrongAccept.status,computedPathUnresolved:true};
}

async function runSpringEndpointContractChecks(api,vscode,checks) {
  const config = readConfig(), sources = ownedSources(config);
  const endpoints = await api.java.spring.endpoints();
  const selected = selectDeclarations(endpoints,sources);
  for (const [item,marker] of selected) {
    const opened = await vscode.commands.executeCommand('rocketbrain.spring.endpoints',item);
    assert.deepEqual(opened?.range,item.range);
    const editor = vscode.window.activeTextEditor;
    assert.equal(editor.document.uri.toString(),item.uri);
    assert.ok(editor.document.getText(editor.selection).startsWith(marker));
  }
  const symbols = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider','@/endpoint-fixture/people');
  for (const [item] of selected.filter(([value])=>value.path===PERSON)) {
    assert.ok(symbols.some(symbol => symbol.location.uri.toString() === item.uri && symbol.name === item.name &&
      symbol.location.range.start.line === item.range.start.line && symbol.location.range.start.character === item.range.start.character));
  }
  const runtime = await runtimeBindings(config,selected);
  checks.push('The Spring endpoints command and workspace symbols navigate real MVC, WebFlux and Feign declarations. Owned Feign requests reach the exact WebFlux HTTP method and path, including the database-backed route and predicate controls.');
  return { ...runtime,nativeView:true };
}

async function verifySpringEndpointBackends() {
  const config = readConfig(), sources = ownedSources(config);
  const endpoints = Object.values(sources).flatMap(file=>sourceEndpoints(file.text,file.uri));
  return {...await runtimeBindings(config,selectDeclarations(endpoints,sources)),nativeView:false};
}

if (require.main === module) verifySpringEndpointBackends().then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.stack);process.exitCode=1;});

module.exports = {runSpringEndpointContractChecks,verifySpringEndpointBackends};
