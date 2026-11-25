'use strict';

const { randomBytes } = require('node:crypto');
const { layoutBeanGraph } = require('./bean-graph');

function scriptData(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char => '\\u' + char.charCodeAt(0).toString(16).padStart(4,'0'));
}

function runGraph(graph,layout) {
  const api = acquireVsCodeApi();
  const byId = new Map(graph.nodes.map(item => [item.id,item]));
  const bySite = new Map(graph.sites.map(item => [item.id,item]));
  const state = api.getState() || {};
  const get = id => document.getElementById(id);
  const focus = get('focus'), cycle = get('cycle'), depth = get('depth'), candidates = get('candidates'), zoom = get('zoom');
  const viewport = get('viewport'), frame = get('frame'), layer = get('layer'), canvas = get('canvas'), cards = get('cards');
  const details = get('details'), notice = get('notice');
  let selected = byId.has(state.focus) ? state.focus : '';
  const options = (root,label) => { root.replaceChildren(); root.add(new Option(label,'')); };
  const make = (tag,value,klass) => {
    const node = document.createElement(tag);
    if (value !== undefined) node.textContent = value;
    if (klass) node.className = klass;
    return node;
  };
  function action(label,callback) {
    const button = make('button',label);
    button.type = 'button';
    button.addEventListener('click',callback);
    return button;
  }
  const targetButton = id => action(byId.get(id)?.name || 'Bean',() => select(id));
  const sourceButton = (label,kind,id) => action(label,() => api.postMessage({type:'reveal',kind,id}));
  const displayState = {
    active:'Active in model',unknown:'Unknown',inactive:'Inactive',resolved:'Resolved',
    ambiguous:'Ambiguous',missing:'Missing',optional:'Optional, no local target'
  };
  const names = ids => ids.map(id => byId.get(id)?.name || 'Bean').join(' → ');
  const openCandidates = Boolean(state.includeCandidates);
  candidates.checked = openCandidates;
  depth.value = ['1','2','3'].includes(state.depth) ? state.depth : '2';
  zoom.value = Number.isFinite(state.zoom) && state.zoom >= 60 && state.zoom <= 140 ? state.zoom : 100;
  options(cycle,'All cycles');
  for (const item of graph.cycles) cycle.add(new Option(names(item.members.slice(0,3)) + (item.members.length > 3 ? '…' : ''),item.id));
  cycle.value = graph.cycles.some(item => item.id === state.cycle) ? state.cycle : '';

  function compileChoices() {
    const query = get('query').value.trim().toLowerCase();
    options(focus,'Overview');
    for (const bean of graph.nodes) {
      if (bean.id === selected || [bean.name,bean.type,...bean.aliases].some(value => value.toLowerCase().includes(query))) {
        focus.add(new Option(bean.name + ' · ' + bean.type,bean.id));
      }
    }
    focus.value = selected;
  }

  function select(id) {
    if (!byId.has(id)) return;
    selected = id;
    cycle.value = '';
    compileChoices();
    viewport.scrollTop = 0;
    viewport.scrollLeft = 0;
    render();
  }

  function remembers() {
    api.setState({focus:selected,cycle:cycle.value,depth:depth.value,includeCandidates:candidates.checked,zoom:Number(zoom.value)});
  }

  function overview() {
    details.append(make('h2','Workspace sources'));
    const summary = [graph.nodes.length + ' beans',graph.sites.length + ' injection sites',graph.cycles.length + ' cycle groups'];
    details.append(make('p',summary.join(' · '),'muted'));
    details.append(make('p',graph.coverage.closedWorld ? 'Configured closed source model.' :
      'External bean registration may change the graph.','muted'));
    const unresolved = graph.sites.filter(site => ['unknown','ambiguous','missing'].includes(site.state));
    if (unresolved.length) {
      details.append(make('h3','Unresolved sites (' + unresolved.length + ')'));
      const items = make('ul');
      for (const site of unresolved.slice(0,20)) {
        const item = make('li');
        item.append(action((byId.get(site.owner)?.name || 'Bean') + '.' + site.name,() => select(site.owner)),
          make('span',displayState[site.state],'muted'));
        items.append(item);
      }
      details.append(items);
    }
  }

  function detailsForCycle(item) {
    details.append(make('h2','Cycle group'),make('p',item.members.length + ' connected beans'));
    details.append(make('h3','Resolved cycle path'));
    const chain = item.witness.length ? [item.witness[0].from,...item.witness.map(step => step.to)] : [];
    details.append(make('p',names(chain.slice(0,61)) + (chain.length > 61 ? ' …' : ''),'path'));
    const list = make('ol');
    for (const step of item.witness.slice(0,60)) {
      const site = bySite.get(step.siteId), item = make('li');
      item.append(make('span',names([step.from,step.to])));
      if (site?.hasSource) item.append(sourceButton('Open injection site','site',site.id));
      list.append(item);
    }
    details.append(list);
  }

  function detailsForBean(bean) {
    details.append(make('h2',bean.name),make('p',bean.type,'code'),
      make('p',[displayState[bean.state],bean.origin,bean.primary ? 'Primary' : ''].filter(Boolean).join(' · '),'muted'));
    if (bean.aliases.length > 1) details.append(make('p','Aliases: ' + bean.aliases.join(', '),'muted'));
    for (const reason of bean.reasons) details.append(make('p',reason,'muted'));
    if (bean.hasSource) details.append(sourceButton('Open declaration','bean',bean.id));
    const group = graph.cycles.find(item => item.members.includes(bean.id));
    if (group) details.append(action('Show cycle path',() => {selected = ''; cycle.value = group.id; compileChoices(); render();}));
    const owned = graph.sites.filter(site => site.owner === bean.id);
    details.append(make('h3','Injection sites (' + owned.length + ')'));
    if (!owned.length) details.append(make('p','No modeled injection sites.','muted'));
    for (const site of owned.slice(0,80)) {
      const entry = make('section',undefined,'site');
      entry.append(make('h4',site.name || site.type),
        make('p',[displayState[site.state] || site.state,site.origin,site.relation === 'deferred' ? 'Deferred provider' : '',
          site.qualifier ? '@Qualifier ' + site.qualifier : ''].filter(Boolean).join(' · '),'muted'),
        make('p',site.type || site.requested,'code'));
      if (site.reason) entry.append(make('p',site.reason));
      if (site.targets.length) {
        entry.append(make('span',site.relation === 'candidate' ? 'Candidates' : 'Dependencies','muted'));
        const targets = make('div',undefined,'links');
        for (const id of site.targets.slice(0,30)) targets.append(targetButton(id));
        const hidden = site.targets.length - Math.min(site.targets.length,30) + site.omittedTargets;
        if (hidden) targets.append(make('span',hidden + ' targets omitted','muted'));
        entry.append(targets);
      } else if (site.omittedTargets) entry.append(make('p',site.omittedTargets + ' targets omitted','muted'));
      if (site.hasSource) entry.append(sourceButton('Open injection site','site',site.id));
      details.append(entry);
    }
    if (owned.length > 80) details.append(make('p',(owned.length - 80) + ' more sites omitted from this panel.','muted'));
    const incoming = [...new Set(graph.links.filter(link => link.to === bean.id && link.kind === 'resolved').map(link => link.from))];
    if (incoming.length) {
      details.append(make('h3','Resolved dependents (' + incoming.length + ')'));
      const links = make('div',undefined,'links');
      for (const id of incoming.slice(0,40)) links.append(targetButton(id));
      details.append(links);
    }
  }

  function draw(layout) {
    const ratio = Math.min(window.devicePixelRatio || 1,1.5,8190 / Math.max(layout.width,layout.height));
    canvas.width = Math.ceil(layout.width * ratio);
    canvas.height = Math.ceil(layout.height * ratio);
    canvas.style.width = layout.width + 'px';
    canvas.style.height = layout.height + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(ratio,ratio);
    const colors = getComputedStyle(document.body);
    const paint = key => colors.getPropertyValue(key).trim();
    const cycleLinks = new Set((graph.cycles.find(item => item.id === cycle.value)?.witness || [])
      .map(edge => edge.from + ':' + edge.to));
    const positions = new Map(layout.nodes.map(node => [node.id,node]));
    for (const edge of layout.links) {
      const a = positions.get(edge.from), b = positions.get(edge.to);
      const selectedCycle = edge.kind === 'resolved' && cycleLinks.has(edge.from + ':' + edge.to);
      const color = selectedCycle ? paint('--cycle') : edge.kind === 'candidate' ? paint('--candidate') :
        edge.kind === 'deferred' ? paint('--deferred') : paint('--dependency');
      ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = selectedCycle ? 3 : 1.5;
      ctx.setLineDash(edge.kind === 'candidate' ? [3,4] : edge.kind === 'deferred' ? [8,4] : []);
      const left = b.x < a.x;
      const sameColumn = a.x === b.x;
      let sx = left ? a.x : a.x+a.w, sy = a.y + a.h/2;
      let tx = left ? b.x+b.w : b.x, ty = b.y + b.h/2;
      let direction = left ? -1 : 1;
      ctx.beginPath();
      if (sameColumn) {
        const back = sy > ty;
        sx = back ? a.x : a.x + a.w;
        tx = back ? b.x : b.x + b.w;
        direction = back ? 1 : -1;
        if (a.id === b.id) {sy -= 15; ty += 13;}
        ctx.moveTo(sx,sy);
        ctx.bezierCurveTo(sx - direction*34,sy,tx - direction*34,ty,tx,ty);
      } else {
        ctx.moveTo(sx,sy);
        const bend = (sx + tx)/2;
        ctx.bezierCurveTo(bend,sy,bend,ty,tx,ty);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(tx,ty);
      ctx.lineTo(tx-direction*8,ty-4);
      ctx.lineTo(tx-direction*8,ty+4);
      ctx.closePath();
      ctx.fill();
    }
  }

  function render() {
    const view = layout(graph,{focus:selected,cycle:cycle.value,includeCandidates:candidates.checked,depth:Number(depth.value)});
    cards.replaceChildren();
    const scale = Number(zoom.value)/100;
    get('zoom-value').textContent = zoom.value + '%';
    frame.style.width = view.width * scale + 'px';
    frame.style.height = view.height * scale + 'px';
    layer.style.transform = 'scale(' + scale + ')';
    for (const at of view.nodes) {
      const bean = byId.get(at.id);
      const card = action(bean.name,() => select(bean.id));
      card.className = 'card ' + bean.state;
      card.setAttribute('aria-pressed',String(selected === bean.id));
      card.title = bean.type;
      card.style.left = at.x + 'px'; card.style.top = at.y + 'px';
      card.style.width = at.w + 'px'; card.style.height = at.h + 'px';
      card.append(make('span',bean.type,'type'),make('span',displayState[bean.state],'muted'));
      cards.append(card);
    }
    draw(view);
    details.replaceChildren();
    const group = graph.cycles.find(item => item.id === cycle.value);
    if (group) detailsForCycle(group);
    else if (selected) detailsForBean(byId.get(selected));
    else overview();
    if (!view.nodes.length) cards.append(make('p','No source beans found in this scope.','empty'));
    const omitted = [view.omittedBeans ? view.omittedBeans + ' more beans in this view' : '',
      view.omittedLinks ? view.omittedLinks + ' more links in this view' : '',
      graph.coverage.modelIncomplete || graph.coverage.omittedBeans || graph.coverage.omittedSites || graph.coverage.omittedLinks ?
        'Source/model coverage limited' : ''].filter(Boolean);
    notice.textContent = [view.nodes.length + ' shown',...omitted].join(' · ');
    remembers();
  }

  get('query').addEventListener('input',compileChoices);
  focus.addEventListener('change',() => {selected = focus.value;cycle.value = '';render();});
  cycle.addEventListener('change',() => {selected = '';compileChoices();render();});
  for (const input of [depth,candidates,zoom]) input.addEventListener('change',render);
  get('refresh').addEventListener('click',() => api.postMessage({type:'refresh'}));
  window.addEventListener('message',event => {
    if (event.data?.type === 'error' && typeof event.data.message === 'string') notice.textContent = event.data.message;
  });
  get('profiles').textContent = 'Profiles: ' + (graph.profiles.join(', ') || 'default');
  compileChoices();
  render();
}

function beanGraphHtml(graph) {
  const nonce = randomBytes(24).toString('base64url');
  const safe = { ...graph,nodes:graph.nodes.map(({source,...bean}) => ({...bean,hasSource:Boolean(source)})),
    sites:graph.sites.map(({source,...site}) => ({...site,hasSource:Boolean(source)})) };
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Spring Bean Dependencies</title>
<style nonce="${nonce}">
body { margin:0; font:var(--vscode-font-size) var(--vscode-font-family); color:var(--vscode-foreground);
  background:var(--vscode-editor-background); height:100vh; display:flex; flex-direction:column;
  --dependency:var(--vscode-textLink-foreground,#70aefa); --candidate:var(--vscode-descriptionForeground,#999);
  --deferred:var(--vscode-charts-purple,#b991f0); --cycle:var(--vscode-charts-orange,#e1a75e); }
header { padding:8px 14px; background:var(--vscode-sideBar-background); border-bottom:1px solid var(--vscode-panel-border); }
.controls,.legend,.links { display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px; }
.legend { margin-top:8px; gap:8px 14px; color:var(--vscode-descriptionForeground); }
.legend span { white-space:nowrap; }
.line { display:inline-block; width:18px; height:0; margin-right:5px; vertical-align:middle; border-top:2px solid var(--dependency); }
.line.candidate { border-top:2px dotted var(--candidate); } .line.deferred { border-top:2px dashed var(--deferred); }
.line.cycle { border-color:var(--cycle); } #notice { color:var(--vscode-descriptionForeground); }
button,select,input { color:var(--vscode-input-foreground); font:inherit; background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--vscode-panel-border)); padding:5px 8px; border-radius:4px; }
button { cursor:pointer; } button:hover { background:var(--vscode-list-hoverBackground); }
button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid var(--vscode-focusBorder); outline-offset:1px; }
input[type=search] { width:140px; } select { max-width:225px; } input[type=range] { width:75px; padding:0; }
label { white-space:nowrap; } main { display:grid; grid-template-columns:minmax(250px,1fr) minmax(220px,320px);
  min-height:0; flex:1; } #viewport,#details { overflow:auto; }
#frame,#layer { position:relative; } #layer { transform-origin:top left; }
canvas { position:absolute; pointer-events:none; } .card { position:absolute; z-index:1; text-align:left; color:var(--vscode-foreground);
  background:var(--vscode-editorWidget-background); border:1px solid var(--vscode-panel-border); overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; font-weight:600; }
.card .type,.card .muted { display:block; overflow:hidden; text-overflow:ellipsis; font-size:.84em; margin-top:4px; font-weight:400; }
.card .type,.code { font-family:var(--vscode-editor-font-family,monospace); }
.card.inactive,.card.unknown { border-style:dashed; } .card[aria-pressed=true] { border:2px solid var(--vscode-focusBorder); }
#details { border-left:1px solid var(--vscode-panel-border); background:var(--vscode-sideBar-background); padding:8px 14px 20px; }
h2,h3,h4,p { overflow-wrap:anywhere; } h2 { font-size:1.25em; margin:12px 0 6px; } h3 { font-size:1.08em; margin:14px 0 6px; }
h4,p { margin:6px 0; } .muted { color:var(--vscode-descriptionForeground); } .path { color:var(--cycle); }
.site { padding:8px 0; border-top:1px solid var(--vscode-panel-border); }
.site button,.links { margin:5px 0; } #details li { margin:6px 0; } #details li button { margin-right:6px; }
.empty { padding:14px; }
@media(max-width:630px) { main { grid-template-columns:1fr; grid-template-rows:minmax(200px,2fr) minmax(140px,1fr); }
  #details { border-left:none; border-top:1px solid var(--vscode-panel-border); } }
</style>
<body>
<header>
  <div class="controls">
    <input id="query" type="search" aria-label="Find a bean by name or type" placeholder="Find a bean">
    <label>Bean <select id="focus"></select></label>
    <label>Cycle <select id="cycle"></select></label>
    <label>Hops <select id="depth"><option>1</option><option>2</option><option>3</option></select></label>
    <label><input id="candidates" type="checkbox"> Candidate links</label>
    <label>Zoom <input id="zoom" type="range" min="60" max="140" step="10"> <span id="zoom-value"></span></label>
    <button id="refresh" type="button">Refresh</button>
  </div>
  <div class="legend">
    <span id="profiles"></span><span><i class="line"></i>Resolved</span><span><i class="line deferred"></i>Deferred</span>
    <span><i class="line candidate"></i>Candidate</span><span><i class="line cycle"></i>Cycle path</span>
    <span id="notice" role="status" aria-live="polite"></span>
  </div>
</header>
<main>
  <section id="viewport" aria-label="Bean dependency graph"><div id="frame"><div id="layer">
    <canvas id="canvas" aria-hidden="true"></canvas><div id="cards"></div>
  </div></div></section>
  <aside id="details" aria-label="Bean or cycle details"></aside>
</main>
<script nonce="${nonce}">
(${runGraph.toString()})(${scriptData(safe)},${layoutBeanGraph.toString()});
</script>
</body></html>`;
}

module.exports = { beanGraphHtml };
