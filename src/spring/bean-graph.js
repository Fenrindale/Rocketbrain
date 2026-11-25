'use strict';

const { createHash } = require('node:crypto');
const { findCycles } = require('../java/dependency-graph');

const LIMITS = Object.freeze({ beans:1500,sites:5000,links:16000,targets:150 });
const GRAPH_STATES = new Set(['active','inactive','unknown']);
const RESOLUTION_STATES = new Set(['resolved','ambiguous','missing','optional','inactive','unknown']);
const text = (value,limit = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,limit) : '';
const opaque = (prefix,id) => prefix + createHash('sha256').update(id).digest('hex').slice(0,24);
const list = value => Array.isArray(value) ? value : [];
const ordered = (a,b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id);

function source(item) {
  return typeof item?.uri === 'string' && item.range ? {uri:item.uri,range:structuredClone(item.range)} : undefined;
}

function beanDependencyGraph(model) {
  const beans = list(model?.beans).filter(bean => typeof bean?.id === 'string').sort(ordered);
  const graph = {
    revision:model?.revision,mode:'spring-local-bean-dependencies',profiles:list(model?.profiles).slice(0,32).map(name => text(name,100)),
    nodes:[],sites:[],links:[],cycles:[],
    coverage:{sourceBeans:beans.length,omittedBeans:0,omittedSites:0,omittedLinks:0,
      modelIncomplete:Boolean(model?.incomplete || model?.truncated),closedWorld:Boolean(model?.closedWorld)}
  };
  const byBean = new Map(), linkByKey = new Map();
  for (const bean of beans) {
    if (byBean.has(bean.id)) continue;
    if (graph.nodes.length >= LIMITS.beans) { graph.coverage.omittedBeans++; continue; }
    const node = {
      id:opaque('b',bean.id),name:text(bean.name),type:text(bean.type),origin:text(bean.origin,80),
      state:GRAPH_STATES.has(bean.state) ? bean.state : 'unknown',
      primary:Boolean(bean.primary),aliases:list(bean.aliases).slice(0,20).map(alias => text(alias,160)),
      reasons:list(bean.reasons).slice(0,12).map(reason => text(reason)),source:source(bean)
    };
    byBean.set(bean.id,node);
    graph.nodes.push(node);
  }

  const sites = list(model?.injections).filter(item => typeof item?.id === 'string' && !item.valueRange &&
    item.resolution?.kind !== 'property');
  for (const injection of sites) {
    const owner = byBean.get(injection.ownerBeanId);
    if (!owner || graph.sites.length >= LIMITS.sites) { graph.coverage.omittedSites++; continue; }
    const resolution = injection.resolution || {};
    const state = RESOLUTION_STATES.has(resolution.state) ? resolution.state : 'unknown';
    const hasSelection = state === 'resolved' && owner.state === 'active';
    const provider = injection.type?.name?.split('.').at(-1) === 'ObjectProvider';
    const targetIds = hasSelection ? list(resolution.selected) :
      ['unknown','ambiguous'].includes(state) ? list(resolution.candidates) : [];
    const relation = hasSelection ? (provider ? 'deferred' : 'resolved') : 'candidate';
    const targets = [...new Set(targetIds)].slice(0,LIMITS.targets).flatMap(beanId => {
      const node = byBean.get(beanId);
      return node && (relation === 'candidate' || node.state === 'active') ? [node.id] : [];
    });
    graph.sites.push({
      id:opaque('i',injection.id),owner:owner.id,name:text(injection.name,150),type:text(injection.type?.raw || injection.type?.name),
      requested:text(resolution.requested),qualifier:text(injection.qualifier,160),origin:text(injection.origin,80),state,relation,
      required:injection.required !== false,reason:text(resolution.reason),targets,
      omittedTargets:Math.max(0,new Set(targetIds).size - targets.length),source:source(injection)
    });
  }
  const relations = ['resolved','deferred','candidate'];
  // Keep confirmed direct edges ahead of candidates if a large workspace exceeds the display model.
  for (const relation of relations) {
    for (const site of graph.sites.filter(item => item.relation === relation)) {
      for (const to of site.targets) {
        const key = site.owner + ':' + to + ':' + relation;
        const previous = linkByKey.get(key);
        if (previous) { previous.sites.push(site.id); continue; }
        if (graph.links.length >= LIMITS.links) { graph.coverage.omittedLinks++; continue; }
        const link = {from:site.owner,to,kind:relation,sites:[site.id]};
        graph.links.push(link);
        linkByKey.set(key,link);
      }
    }
  }
  const direct = graph.links.filter(link => link.kind === 'resolved')
    .map(link => ({from:link.from,to:link.to,evidence:link.sites}));
  graph.cycles = findCycles(graph.nodes.map(node => node.id),direct).map(({members,witness}) => ({
    id:opaque('c',members.join(':')),members,witness:witness.map(({from,to,evidence}) => ({from,to,siteId:evidence}))
  }));
  return graph;
}

/** Standalone so the same bounded layout runs in the editor Webview and in tests. */
function layoutBeanGraph(graph,{ focus = '',cycle = '',includeCandidates = false,depth = 2 } = {}) {
  const LIMIT = 60, MAX_LINKS = 360, W = 214, H = 78, STEP_X = 274, STEP_Y = 116, PAD = 34;
  const byId = new Map(graph.nodes.map(node => [node.id,node]));
  const chosen = graph.cycles.find(item => item.id === cycle);
  const edges = graph.links.filter(edge => includeCandidates || edge.kind !== 'candidate');
  const outgoing = new Map(), incoming = new Map();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from,[]);
    if (!incoming.has(edge.to)) incoming.set(edge.to,[]);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }
  const limitDepth = Math.min(3,Math.max(1,Number.isInteger(depth) ? depth : 2));
  function distances(id,adjacency) {
    const found = new Map([[id,0]]), queue = [id];
    for (let offset = 0; offset < queue.length; offset++) {
      const previous = queue[offset], level = found.get(previous);
      if (level >= limitDepth) continue;
      for (const next of adjacency.get(previous) || []) if (!found.has(next)) {
        found.set(next,level + 1);
        queue.push(next);
      }
    }
    return found;
  }
  let selected;
  const ranks = new Map();
  if (chosen) {
    const witness = new Set(chosen.witness.flatMap(edge => [edge.from,edge.to]));
    selected = [...chosen.members].sort((a,b) => Number(witness.has(b)) - Number(witness.has(a)));
  } else if (byId.has(focus)) {
    const from = distances(focus,outgoing), to = distances(focus,incoming);
    selected = [...new Set([...from.keys(),...to.keys()])];
    for (const id of selected) {
      ranks.set(id,from.has(id) && to.has(id) ? 0 : from.has(id) ? from.get(id) : -to.get(id));
    }
    selected.sort((a,b) => Number(b === focus) - Number(a === focus) ||
      Math.min(from.get(a) ?? Infinity,to.get(a) ?? Infinity) - Math.min(from.get(b) ?? Infinity,to.get(b) ?? Infinity));
  } else {
    const cycleIds = new Set(graph.cycles.flatMap(item => item.members));
    const degree = id => (incoming.get(id)?.length || 0) + (outgoing.get(id)?.length || 0);
    selected = graph.nodes.map(node => node.id).sort((a,b) => Number(cycleIds.has(b)) - Number(cycleIds.has(a)) ||
      Number(byId.get(b).state === 'active') - Number(byId.get(a).state === 'active') || degree(b) - degree(a));
  }
  const visible = selected.slice(0,LIMIT).filter(id => byId.has(id)), used = new Set(visible);
  const links = edges.filter(edge => used.has(edge.from) && used.has(edge.to));
  const placed = [];
  if (ranks.size) {
    const bands = new Map();
    for (const id of visible) {
      const rank = ranks.get(id);
      if (!bands.has(rank)) bands.set(rank,[]);
      bands.get(rank).push(id);
    }
    [...bands.keys()].sort((a,b) => a - b).forEach((rank,column) => {
      bands.get(rank).forEach((id,row) => placed.push({id,x:PAD+column*STEP_X,y:PAD+row*STEP_Y,w:W,h:H}));
    });
  } else {
    const columns = Math.max(1,Math.min(4,Math.ceil(Math.sqrt(visible.length))));
    visible.forEach((id,index) => placed.push({id,x:PAD+(index%columns)*STEP_X,y:PAD+Math.floor(index/columns)*STEP_Y,w:W,h:H}));
  }
  const cycleWitness = new Set((chosen?.witness || []).map(edge => edge.from + ':' + edge.to));
  const prioritized = links.sort((a,b) =>
    Number(cycleWitness.has(b.from + ':' + b.to)) - Number(cycleWitness.has(a.from + ':' + a.to)));
  return { nodes:placed,links:prioritized.slice(0,MAX_LINKS),
    width:Math.max(320,...placed.map(item => item.x + item.w + PAD)),
    height:Math.max(150,...placed.map(item => item.y + item.h + PAD)),
    omittedBeans:Math.max(0,selected.length - visible.length),omittedLinks:Math.max(0,links.length - MAX_LINKS) };
}

module.exports = { beanDependencyGraph, layoutBeanGraph, LIMITS };
