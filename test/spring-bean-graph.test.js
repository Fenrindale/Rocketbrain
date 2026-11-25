'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { analyzeSpring } = require('../src/spring/model');
const { beanDependencyGraph,layoutBeanGraph,LIMITS } = require('../src/spring/bean-graph');
const { beanGraphHtml } = require('../src/spring/bean-graph-view');
const { browserRuntime } = require('./helpers/browser-runtime');

function fixture() {
  const header = [
    'package graph;',
    'import org.springframework.stereotype.Component;',
    'import org.springframework.context.annotation.Bean;',
    'import org.springframework.context.annotation.Configuration;',
    'import org.springframework.context.annotation.Profile;',
    'import org.springframework.beans.factory.annotation.Autowired;',
    'import org.springframework.beans.factory.annotation.Qualifier;',
    'import org.springframework.beans.factory.annotation.Value;',
    'import org.springframework.beans.factory.ObjectProvider;'
  ].join('\n');
  const units = {
    Alpha:'@Component class Alpha { Alpha(Beta beta) {} @Value("${private.secret:never-show-value}") String setting; }',
    Beta:'@Component class Beta { @Autowired Alpha alpha; }',
    DeferredAlpha:'@Component class DeferredAlpha { DeferredAlpha(DeferredBeta beta) {} }',
    DeferredBeta:'@Component class DeferredBeta { DeferredBeta(ObjectProvider<DeferredAlpha> alpha) {} }',
    Channel:'interface Channel {}',
    Blue:'@Component class Blue implements Channel {}',
    Red:'@Component class Red implements Channel {}',
    Consumer:'@Component class Consumer { Consumer(Channel channel, Absent absent){} @Autowired void setBeta(Beta beta) {} }',
    Factory:'@Configuration class Factory { @Bean Product product(@Qualifier("beta") Beta beta) { return new Product(); } }',
    Product:'class Product {}',
    Off:'@Component @Profile("off") class Off { @Value("${inactive.secret:hidden}") String setting; }',
    Absent:'class Absent {}'
  };
  const files = Object.entries(units).map(([name,body]) => ({uri:'file:///private/graph/'+name+'.java',text:header+'\n'+body}));
  return beanDependencyGraph(analyzeSpring(files,[],{activeProfiles:['test'],closedWorld:true}));
}

const bean = (graph,name) => graph.nodes.find(item => item.name === name);
const sites = (graph,name) => graph.sites.filter(item => item.owner === bean(graph,name)?.id);

test('bean graph preserves resolved, ambiguous, deferred and missing source evidence', () => {
  const graph = fixture();
  assert.equal(graph.mode,'spring-local-bean-dependencies');
  assert.deepEqual(graph.profiles,['test']);
  assert.deepEqual(sites(graph,'alpha').map(site => [site.origin,site.state,site.targets]),[
    ['constructor','resolved',[bean(graph,'beta').id]]
  ]);
  assert.equal(sites(graph,'beta')[0].origin,'field');
  assert.equal(sites(graph,'product')[0].origin,'factory-parameter');
  assert.equal(sites(graph,'product')[0].qualifier,'beta');
  const consumer = sites(graph,'consumer');
  assert.equal(consumer.find(site => site.name === 'channel').state,'ambiguous');
  assert.deepEqual(new Set(consumer.find(site => site.name === 'channel').targets),new Set([bean(graph,'blue').id,bean(graph,'red').id]));
  assert.equal(consumer.find(site => site.name === 'absent').state,'missing');
  assert.equal(consumer.find(site => site.name === 'beta').origin,'method-parameter');
  assert.equal(bean(graph,'off').state,'inactive');
  assert.deepEqual(sites(graph,'off'),[]);
  const provider = sites(graph,'deferredBeta')[0];
  assert.equal(provider.state,'resolved');
  assert.equal(provider.relation,'deferred');
  assert.deepEqual(provider.targets,[bean(graph,'deferredAlpha').id]);
  assert.doesNotMatch(JSON.stringify(graph),/never-show-value|private.secret|inactive.secret/);
  assert.equal(graph.cycles.length,1);
  const cycle = graph.cycles[0];
  assert.deepEqual(new Set(cycle.members),new Set([bean(graph,'alpha').id,bean(graph,'beta').id]));
  assert.equal(cycle.witness.length,2);
  assert.equal(cycle.witness[0].from,cycle.witness[1].to);
  assert.ok(cycle.witness.every(step => graph.sites.some(site => site.id === step.siteId && site.targets.includes(step.to))));
});

test('bean graph layout focuses on dependency depth, candidate links and cycle paths with bounded overlays', () => {
  const graph = fixture(), consumer = bean(graph,'consumer'), beta = bean(graph,'beta'), alpha = bean(graph,'alpha');
  const first = layoutBeanGraph(graph,{focus:consumer.id,depth:1});
  const second = layoutBeanGraph(graph,{focus:consumer.id,depth:2,includeCandidates:true});
  assert.deepEqual(new Set(first.nodes.map(node => node.id)),new Set([consumer.id,beta.id]));
  assert.ok(second.nodes.some(node => node.id === alpha.id));
  assert.ok(second.links.some(edge => edge.kind === 'candidate' && edge.to === bean(graph,'blue').id));
  assert.ok(second.nodes.find(node => node.id === consumer.id).x < second.nodes.find(node => node.id === beta.id).x);
  const cycle = layoutBeanGraph(graph,{cycle:graph.cycles[0].id});
  assert.equal(cycle.nodes.length,2);
  assert.equal(cycle.links.length,2);
  assert.ok(cycle.width > 210 && cycle.height > 75);
  const max = beanDependencyGraph({beans:Array.from({length:LIMITS.beans + 2},(_,i) => ({id:'fixture-'+i,name:'bean-'+i}))});
  const bounded = layoutBeanGraph(max);
  assert.equal(max.coverage.omittedBeans,2);
  assert.equal(bounded.nodes.length,60);
  assert.equal(bounded.omittedBeans,LIMITS.beans-60);
});

test('bean graph Webview exposes no absolute source paths or executable model text', () => {
  const graph = fixture();
  graph.nodes[0].name = '</script><script>globalThis.bad = true</script>';
  const html = beanGraphHtml(graph);
  assert.match(html,/Spring Bean Dependencies/);
  assert.match(html,/default-src 'none'; style-src 'nonce-/);
  assert.match(html,/canvas id="canvas"/);
  assert.doesNotMatch(html,/file:\/\/\/private|<script>globalThis.bad|never-show-value/);
  assert.match(html,/\\u003c\/script\\u003e/);
});

const runtime = browserRuntime();
test('bean graph Webview renders, focuses and reveals by modeled identity', {skip:runtime.skip,timeout:30000},async () => {
  const browser = await runtime.chromium.launch({executablePath:runtime.executablePath,headless:true});
  try {
    const graph = fixture();
    const page = await browser.newPage({viewport:{width:1150,height:810}});
    const errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.route('https://bean-graph.local/',route => route.fulfill({contentType:'text/html',body:beanGraphHtml(graph)}));
    await page.addInitScript(() => {
      window.messages = [];
      window.acquireVsCodeApi = () => ({getState:() => ({}),setState:() => {},postMessage:message => window.messages.push(message)});
    });
    await page.goto('https://bean-graph.local/');
    assert.ok(await page.locator('button.card').count() >= 6);
    assert.match(await page.locator('#details').innerText(),/Unresolved sites/);
    await page.getByRole('searchbox',{name:'Find a bean by name or type'}).fill('consumer');
    await page.locator('#focus').selectOption(bean(graph,'consumer').id);
    assert.match(await page.locator('#details').innerText(),/Ambiguous/);
    assert.match(await page.locator('#details').innerText(),/Missing/);
    await page.getByRole('checkbox',{name:'Candidate links'}).check();
    assert.equal(await page.locator('button.card').filter({hasText:'blue'}).count(),1);
    await page.getByRole('button',{name:'Open declaration',exact:true}).click();
    await page.locator('#cycle').selectOption(graph.cycles[0].id);
    assert.equal(await page.locator('button.card').count(),2);
    const details = await page.locator('#details').innerText();
    assert.match(details,/Resolved cycle path/);
    assert.match(details,/(alpha → beta → alpha|beta → alpha → beta)/);
    await page.getByRole('button',{name:'Open injection site',exact:true}).first().click();
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    assert.deepEqual(await page.evaluate(() => window.messages),[
      {type:'reveal',kind:'bean',id:bean(graph,'consumer').id},
      {type:'reveal',kind:'site',id:graph.cycles[0].witness[0].siteId},
      {type:'refresh'}
    ]);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
