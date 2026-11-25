'use strict';

const { randomBytes } = require('node:crypto');
const { visibleClassLayout } = require('./source-analysis-model');

function literal(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,character =>
    '\\u' + character.charCodeAt(0).toString(16).padStart(4,'0'));
}

function diagramHtml(diagram,{focus,external=true,relationships='all',revision=0}={}) {
  const nonce = randomBytes(24).toString('base64url');
  const view = visibleClassLayout(diagram,{focus,external,relationships});
  const payload = {
    ...view,focus:focus||'',external,relationships,revision,localCount:diagram.localCount,externalCount:diagram.externalCount,
    omittedRelations:diagram.omittedRelations,
    choices:diagram.nodes.filter(node => !node.external).map(node => ({ id:node.id,label:node.qualified }))
  };
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Java Class Diagram</title>
<style nonce="${nonce}">
body { margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font-family:var(--vscode-font-family); }
header { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px 16px; position:sticky; top:0;
  background:var(--vscode-sideBar-background); border-bottom:1px solid var(--vscode-panel-border); z-index:5; }
select,button,input { font:inherit; color:var(--vscode-input-foreground); border:1px solid var(--vscode-input-border);
  background:var(--vscode-input-background); padding:4px; }
select { max-width:270px; }
input[type=checkbox] { margin:0 4px; }
input[type=range] { width:70px; padding:0; }
button { cursor:pointer; }
button:focus-visible,select:focus-visible,input:focus-visible { outline:2px solid var(--vscode-focusBorder); }
#notice { color:var(--vscode-descriptionForeground); }
#viewport { overflow:auto; }
#scroller { position:relative; }
#surface { position:absolute; top:0; left:0; transform-origin:top left; }
canvas { position:absolute; left:0; top:0; pointer-events:none; }
.card { position:absolute; box-sizing:border-box; display:flex; flex-direction:column; overflow:hidden;
  border:1px solid var(--vscode-panel-border); border-radius:5px; padding:9px; background:var(--vscode-editorWidget-background); }
.card.active { border:2px solid var(--vscode-focusBorder); }
.card.external { border-style:dashed; }
.kind { color:var(--vscode-descriptionForeground); font-size:11px; }
.node-name { font-weight:700; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:3px 0; }
.member { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-align:left; font-size:11px; margin:1px 0; }
.members { flex:1; overflow:auto; display:flex; flex-direction:column; }
#relationship-panel { padding:8px 16px; border-bottom:1px solid var(--vscode-panel-border); }
#relation-links { display:grid; gap:4px; max-height:165px; overflow:auto; margin-top:8px; }
.relation-link { overflow:hidden; text-align:left; text-overflow:ellipsis; white-space:nowrap; }
</style>
<body>
<header>
  <label>Focus <select id="focus"></select></label>
  <label>Relationships <select id="relationships">
    <option value="all">All relationships</option>
    <option value="structure">Inheritance and nesting</option>
    <option value="associations">Field associations</option>
    <option value="dependencies">Member dependencies</option>
  </select></label>
  <label><input id="external" type="checkbox">External types</label>
  <label>Zoom <input id="zoom" type="range" min="50" max="140" value="100"><span id="zoom-text">100%</span></label>
  <button id="refresh" type="button">Refresh</button>
  <button id="save" type="button">Export Mermaid</button>
  <span id="notice" role="status"></span>
</header>
<details id="relationship-panel">
  <summary>Relationship source links</summary>
  <div id="relation-links"></div>
</details>
<div id="viewport" aria-label="Compiler class relationships">
  <div id="scroller"><div id="surface"><canvas id="edges" aria-label="Graph of Java inheritance, nesting, field associations and member dependencies"></canvas></div></div>
</div>
<script nonce="${nonce}">
const model = ${literal(payload)};
const vscode = acquireVsCodeApi();
const send = message => vscode.postMessage({ ...message,revision:model.revision });
const get = id => document.getElementById(id);
const surface = get('surface'), scroller = get('scroller'), canvas = get('edges'), ctx = canvas.getContext('2d');
const byId = new Map(model.nodes.map(type => [type.id,type]));
const focus=get('focus'),external=get('external'),relationships=get('relationships');
const notice = model.nodes.length + ' shown · ' + model.localCount + ' project types' +
  (model.omitted ? ' · ' + model.omitted + ' more, choose a focused type' : '') +
  (model.omittedRelations?' · '+model.omittedRelations+' relationship occurrences exceeded the analysis limit':'');
get('notice').textContent = notice;
canvas.width = model.width;
canvas.height = model.height;
const baseOption = document.createElement('option');
baseOption.value = '';
baseOption.textContent = 'All types';
focus.appendChild(baseOption);
for (const item of model.choices) {
  const option = document.createElement('option');
  option.value = item.id;
  option.textContent = item.label;
  focus.appendChild(option);
}
focus.value = model.focus;
external.checked = model.external;
relationships.value=model.relationships;
function optionsChanged() { send({type:'options',focus:focus.value,external:external.checked,relationships:relationships.value}); }
focus.addEventListener('change',optionsChanged);
external.addEventListener('change',optionsChanged);
relationships.addEventListener('change',optionsChanged);
get('refresh').addEventListener('click',() => send({type:'refresh'}));
get('save').addEventListener('click',() => send({type:'export'}));
const selected = vscode.getState()?.zoom || 100;
const zoom = get('zoom');
zoom.value = String(selected);
function rescale() {
  const amount = Number(zoom.value);
  get('zoom-text').textContent = amount + '%';
  scroller.style.width = Math.ceil(model.width * amount/100) + 'px';
  scroller.style.height = Math.ceil(model.height * amount/100) + 'px';
  surface.style.transform = 'scale(' + amount/100 + ')';
  vscode.setState({...vscode.getState(),zoom:amount});
}
zoom.addEventListener('input',rescale);
rescale();
let selectedType = model.focus;
const cards = new Map();
const label = (tag, css, value) => {
  const element = document.createElement(tag);
  element.className = css;
  element.textContent = value;
  element.title = value;
  return element;
};
const panel=get('relationship-panel'), links=get('relation-links');
panel.open=vscode.getState()?.relationshipLinks??Boolean(model.focus);
panel.addEventListener('toggle',()=>vscode.setState({...vscode.getState(),relationshipLinks:panel.open}));
const rows=[];
for (const edge of model.edges) {
  if (model.focus && edge.from!==model.focus && edge.to!==model.focus) continue;
  for (const [index,origin] of (edge.origins||[]).entries()) rows.push({edge,index,origin});
}
for (const {edge,index,origin} of rows.slice(0,100)) {
  const message=origin.label+' · '+origin.member+' · '+edge.from+' → '+edge.to;
  const link=label('button','relation-link',message);
  link.title=message+' · '+origin.signature;
  link.type='button';
  link.addEventListener('click',()=>send({type:'relationship',id:edge.id,origin:index}));
  links.appendChild(link);
}
if (!rows.length) links.appendChild(label('span','kind','No member links in this view.'));
if (rows.length>100) links.appendChild(label('span','kind','Showing 100 of '+rows.length+' source links. Filter the relationship view to narrow the list.'));
function redraw() {
  const style = getComputedStyle(document.body);
  const defaultColor = style.getPropertyValue('--vscode-descriptionForeground').trim() || '#9299aa';
  const focusColor = style.getPropertyValue('--vscode-focusBorder').trim() || '#51a8fb';
  ctx.clearRect(0,0,canvas.width,canvas.height);
  for (const edge of model.edges) {
    const from = byId.get(edge.from), to = byId.get(edge.to);
    if (!from || !to) continue;
    const adjacent = edge.from === selectedType || edge.to === selectedType;
    const startX = from.x + from.w/2, endX = to.x + to.w/2;
    const direction = from.y >= to.y ? -1 : 1;
    const startY = direction < 0 ? from.y : from.y + from.h;
    const endY = direction < 0 ? to.y + to.h : to.y;
    const mid = (startY + endY)/2;
    ctx.strokeStyle = adjacent ? focusColor : defaultColor;
    ctx.lineWidth = adjacent ? 2 : 1;
    ctx.globalAlpha = adjacent || !selectedType ? 0.9 : 0.28;
    ctx.setLineDash(edge.kind==='extends'||edge.kind==='associates'?[]:edge.kind==='implements'?[5,4]:edge.kind==='uses'?[7,4]:[2,4]);
    ctx.beginPath();
    ctx.moveTo(startX,startY);
    ctx.lineTo(startX,mid);
    ctx.lineTo(endX,mid);
    ctx.lineTo(endX,endY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(endX-5,endY-direction*7);
    ctx.lineTo(endX,endY);
    ctx.lineTo(endX+5,endY-direction*7);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
for (const type of model.nodes) {
  const card = document.createElement('article');
  card.className = 'card' + (type.external ? ' external' : '') + (type.id === selectedType ? ' active' : '');
  card.style.left = type.x + 'px';
  card.style.top = type.y + 'px';
  card.style.width = type.w + 'px';
  card.style.height = type.h + 'px';
  card.appendChild(label('span','kind',type.kind.replaceAll('_',' ').toLowerCase()));
  const name = label(type.external ? 'span' : 'button','node-name',type.qualified);
  if (!type.external) {
    name.type = 'button';
    name.addEventListener('click',() => send({type:'source',node:type.id}));
  }
  card.appendChild(name);
  const members = document.createElement('div');
  members.className = 'members';
  for (const [index,member] of type.members.entries()) {
    const text = member.kind === 'field' ? member.name + ' : ' + member.signature : member.signature;
    const entry = label('button','member',text);
    entry.type = 'button';
    entry.addEventListener('click',() => send({type:'source',node:type.id,member:index}));
    members.appendChild(entry);
  }
  if (type.omittedMembers) members.appendChild(label('span','kind','+' + type.omittedMembers + ' more source members'));
  card.appendChild(members);
  card.addEventListener('pointerenter',() => {
    cards.get(selectedType)?.classList.remove('active');
    selectedType = type.id;
    card.classList.add('active');
    redraw();
  });
  cards.set(type.id,card);
  surface.appendChild(card);
}
redraw();
window.addEventListener('message',event => {
  if (event.data?.type === 'stale') get('notice').textContent = 'Java sources changed. Refresh to update links.';
});
</script>
</body>
</html>`;
}

module.exports = { diagramHtml };
