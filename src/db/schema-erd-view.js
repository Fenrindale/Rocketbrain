'use strict';

const { card, maxPosition } = require('./schema-erd');

function diagramClient({ card, maxPosition }) {
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const canvas = byId('diagram'), context = canvas.getContext('2d');
  const entity = byId('entity'), viewport = byId('viewport'), status = byId('status');
  let current, layout, selected, drag, zoom = 1, positioned = new Map();

  function send(type, more = {}) {
    if (current) vscode.postMessage({ type, token: current.token, ...more });
  }

  function colors() {
    const styles = getComputedStyle(document.body);
    const css = (name, fallback) => styles.getPropertyValue('--vscode-' + name).trim() || fallback;
    return { canvas: css('editor-background', '#172029'), border: css('widget-border', '#526375'),
      text: css('foreground', '#e5ecf4'), muted: css('descriptionForeground', '#afbac8'),
      line: css('charts-blue', '#6bb1e8'), virtual: css('charts-orange', '#f0ae61'),
      card: css('sideBar-background', '#263542'), current: css('focusBorder', '#6cd7cc') };
  }

  function caption(text, x, y, maxWidth) {
    if (context.measureText(text).width <= maxWidth) { context.fillText(text, x, y); return; }
    const characters = [...text];
    while (characters.length && context.measureText(characters.join('') + '…').width > maxWidth) characters.pop();
    context.fillText(characters.join('') + '…', x, y);
  }

  function drawEdge(edge, index, palette) {
    const from = positioned.get(edge.child), to = positioned.get(edge.parent);
    if (!edge.childInDiagram || !edge.parentInDiagram || !from || !to) return;
    const active = edge.child === selected || edge.parent === selected;
    context.globalAlpha = active ? 1 : 0.48;
    context.strokeStyle = edge.kind === 'logical' ? palette.virtual : palette.line;
    context.lineWidth = active ? 2.6 : 1.5;
    context.setLineDash(edge.kind === 'logical' ? [6, 4] : []);
    const offset = 40 + index % 6 * 12;
    context.beginPath();
    if (from === to) {
      const right = from.x + card.width, up = from.y + offset;
      context.moveTo(right, up);
      context.bezierCurveTo(right + 46, up, right + 46, up + 35, right, up + 35);
      context.stroke();
      context.beginPath();
      context.moveTo(right + 8, up + 30); context.lineTo(right, up + 35); context.lineTo(right + 8, up + 40);
    } else {
      const rightwards = to.x >= from.x + card.width / 2;
      const vertically = Math.abs(to.x - from.x) < card.width * 0.8;
      const below = to.y >= from.y;
      const x1 = vertically ? from.x + offset * 1.5 : from.x + (rightwards ? card.width : 0);
      const x2 = vertically ? to.x + offset * 1.5 : to.x + (rightwards ? 0 : card.width);
      const y1 = vertically ? from.y + (below ? card.height : 0) : from.y + offset;
      const y2 = vertically ? to.y + (below ? 0 : card.height) : to.y + offset;
      context.moveTo(x1, y1);
      if (vertically) context.bezierCurveTo(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, x2, y2);
      else context.bezierCurveTo((x1 + x2) / 2, y1, (x1 + x2) / 2, y2, x2, y2);
      context.stroke();
      context.beginPath();
      if (vertically) {
        const start = y2 + (below ? -8 : 8);
        context.moveTo(x2 - 4, start); context.lineTo(x2, y2); context.lineTo(x2 + 4, start);
      } else {
        const start = x2 + (rightwards ? -8 : 8);
        context.moveTo(start, y2 - 4); context.lineTo(x2, y2); context.lineTo(start, y2 + 4);
      }
    }
    context.setLineDash([]);
    context.stroke();
    context.globalAlpha = 1;
  }

  function drawCard(node, position, palette) {
    const { x, y } = position, active = node.name === selected;
    context.fillStyle = palette.card;
    context.strokeStyle = active ? palette.current : palette.border;
    context.lineWidth = active ? 2 : 1;
    context.beginPath();
    context.roundRect(x, y, card.width, card.height, 9);
    context.fill(); context.stroke();
    context.font = '600 15px system-ui';
    context.fillStyle = palette.text;
    caption(node.name, x + 12, y + 23, card.width - 22);
    context.font = '12px system-ui';
    context.fillStyle = palette.muted;
    context.fillText(node.kind === 'view' ? 'View' : 'Table', x + 12, y + 42);
    context.strokeStyle = palette.border;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(x + 11, y + 51); context.lineTo(x + card.width - 11, y + 51); context.stroke();
    for (const [index, column] of node.columns.slice(0, 4).entries()) {
      context.font = '12px ui-monospace, Consolas, monospace';
      context.fillStyle = palette.text;
      caption((column.primaryKey ? 'PK  ' : '    ') + column.name, x + 12, y + 72 + index * 17, card.width - 24);
    }
    if (node.columns.length > 4) {
      context.font = '11px system-ui'; context.fillStyle = palette.muted;
      context.fillText('+' + (node.columns.length - 4) + ' columns', x + 12, y + 144);
    }
  }

  function draw() {
    if (!current) return;
    positioned = new Map(layout.positions.map(position => [position.name, position]));
    const end = layout.positions.reduce((size, item) => ({
      width: Math.max(size.width, item.x + card.width + card.gap),
      height: Math.max(size.height, item.y + card.height + card.margin)
    }), { width: 610, height: 350 });
    if (canvas.width !== end.width || canvas.height !== end.height) {
      canvas.width = end.width;
      canvas.height = end.height;
    }
    canvas.style.width = canvas.width * zoom + 'px';
    canvas.style.height = canvas.height * zoom + 'px';
    const palette = colors();
    context.fillStyle = palette.canvas;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = palette.text; context.font = '600 16px system-ui';
    caption(current.diagram.database, 24, 27, canvas.width - 48);
    context.font = '12px system-ui';
    context.fillStyle = palette.line; context.fillText('→ Physical foreign key', 24, 46);
    if (current.diagram.edges.some(edge => edge.kind === 'logical')) {
      context.fillStyle = palette.virtual; context.fillText('⇢ Logical relationship', 167, 46);
    }
    current.diagram.edges.forEach((edge, index) => drawEdge(edge, index, palette));
    for (const node of current.diagram.nodes) drawCard(node, positioned.get(node.name), palette);
  }

  function text(tag, value) {
    const element = document.createElement(tag);
    element.textContent = value;
    return element;
  }

  function showDetails() {
    entity.value = selected || '';
    byId('attributes').replaceChildren();
    byId('relationships').replaceChildren();
    const node = current.diagram.nodes.find(value => value.name === selected);
    byId('open-table').disabled = node?.kind !== 'table';
    byId('move').disabled = !node;
    if (!node) return;
    const position = layout.positions.find(item => item.name === selected);
    byId('left').value = position.x;
    byId('top').value = position.y;
    for (const col of node.columns) {
      const row = document.createElement('li');
      row.append(text('strong', col.name), text('span', [col.type, col.primaryKey ? 'PK' : '', col.nullable ? 'nullable' : ''].filter(Boolean).join(' · ')));
      byId('attributes').append(row);
    }
    const edges = current.diagram.edges.filter(edge => edge.child === node.name ||
      edge.parentInDiagram && edge.parent === node.name);
    if (!edges.length) byId('relationships').append(text('li', 'No observed relationships.'));
    for (const edge of edges) {
      const row = document.createElement('li');
      row.append(text('strong', edge.name));
      row.append(text('span', edge.kind === 'logical' ? 'Logical · workspace only' : 'Physical foreign key'));
      const outbound = edge.child === node.name, target = outbound ? edge.parent : edge.child;
      const destination = outbound && edge.parentSchema !== current.diagram.database ? edge.parentSchema + '.' + target : target;
      if ((outbound && edge.parentInDiagram) || (!outbound && edge.childInDiagram)) {
        const button = text('button', (outbound ? '→ ' : '← ') + destination);
        button.addEventListener('click', () => choose(target, true));
        row.append(button);
      } else row.append(text('span', (outbound ? '→ ' : '← ') + destination + ' · outside diagram'));
      row.append(text('span', edge.pairs.map(pair => pair.child + ' → ' + pair.parent).join(', ')));
      if (edge.onDelete || edge.onUpdate) row.append(text('span', [edge.onDelete && 'DELETE ' + edge.onDelete, edge.onUpdate && 'UPDATE ' + edge.onUpdate].filter(Boolean).join(' · ')));
      byId('relationships').append(row);
    }
  }

  function choose(name, center) {
    if (!current.diagram.nodes.some(node => node.name === name)) return;
    selected = name;
    draw();
    showDetails();
    if (center) {
      const position = positioned.get(name);
      viewport.scrollLeft = (position.x + card.width / 2) * zoom - viewport.clientWidth / 2;
      viewport.scrollTop = (position.y + card.height / 2) * zoom - viewport.clientHeight / 2;
    }
  }

  function setPosition(name, x, y) {
    const position = layout.positions.find(item => item.name === name);
    if (!position) return;
    position.x = Math.max(card.margin, Math.min(maxPosition, Math.round(x)));
    position.y = Math.max(card.top, Math.min(maxPosition, Math.round(y)));
    draw();
    byId('left').value = position.x;
    byId('top').value = position.y;
    status.textContent = 'Unsaved layout changes';
  }

  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / zoom, y: (event.clientY - rect.top) / zoom };
  };
  canvas.addEventListener('pointerdown', event => {
    if (!current || event.button !== 0) return;
    const { x, y } = point(event);
    const hit = [...layout.positions].reverse().find(item => x >= item.x && x <= item.x + card.width && y >= item.y && y <= item.y + card.height);
    if (!hit) return;
    choose(hit.name, false);
    drag = { name: hit.name, dx: x - hit.x, dy: y - hit.y, x, y };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', event => {
    if (!drag) return;
    const { x, y } = point(event);
    if (drag.moved || Math.abs(x - drag.x) + Math.abs(y - drag.y) >= 4) {
      drag.moved = true;
      setPosition(drag.name, x - drag.dx, y - drag.dy);
    }
  });
  for (const type of ['pointerup', 'pointercancel']) canvas.addEventListener(type, () => { drag = undefined; });
  entity.addEventListener('change', () => choose(entity.value, true));
  byId('zoom').addEventListener('change', event => { zoom = Number(event.target.value); if (selected) choose(selected, true); else draw(); });
  byId('coordinates').addEventListener('submit', event => {
    event.preventDefault();
    setPosition(selected, Number(byId('left').value), Number(byId('top').value));
  });
  byId('reset').addEventListener('click', () => {
    layout = structuredClone(current.defaultLayout);
    draw(); showDetails(); status.textContent = 'Default positions restored';
  });
  byId('save').addEventListener('click', () => send('saveLayout', { layout }));
  byId('export-layout').addEventListener('click', () => send('exportLayout', { layout }));
  byId('import-layout').addEventListener('click', () => send('importLayout'));
  byId('refresh').addEventListener('click', () => send('refresh'));
  byId('open-table').addEventListener('click', () => send('openTable', { name: selected }));
  byId('logical').addEventListener('click', () => send('logical'));
  byId('export-png').addEventListener('click', () => {
    const token = current.token;
    canvas.toBlob(blob => {
      if (!blob || blob.type !== 'image/png' || token !== current?.token) return;
      const reader = new FileReader();
      reader.addEventListener('load', () => {
        const data = String(reader.result);
        if (token === current?.token && data.startsWith('data:image/png;base64,')) send('exportPng', { image: data.slice(22) });
      });
      reader.readAsDataURL(blob);
    }, 'image/png');
  });
  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'diagram') {
      const preserve = message.keepPositions && layout?.diagram === message.diagram.identity;
      const previous = preserve ? selected : null;
      current = message;
      if (!preserve) layout = structuredClone(message.layout);
      const options = message.diagram.nodes.map(node => {
        const option = text('option', node.name); option.value = node.name; return option;
      });
      entity.replaceChildren(...options);
      selected = previous || message.diagram.focus || message.diagram.nodes[0]?.name;
      byId('scope').textContent = ['Visible to the connected account', message.diagram.nodes.length + ' entities',
        message.diagram.foreignKeysLoaded ? '' : 'Foreign key metadata unavailable'].filter(Boolean).join(' · ');
      byId('logical').hidden = !message.logicalAvailable;
      status.textContent = '';
      byId('controls').disabled = false;
      draw(); showDetails();
    } else if (message?.token === current?.token && message.type === 'layout') {
      layout = structuredClone(message.layout);
      draw(); showDetails(); status.textContent = 'Layout imported';
    } else if (message?.token === current?.token && message.type === 'status') status.textContent = message.text;
    else if (message?.type === 'stale') {
      byId('controls').disabled = true;
      current = undefined;
      status.textContent = message.text;
    }
  });
  new MutationObserver(() => draw()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  vscode.postMessage({ type: 'ready' });
}

function diagramHtml(nonce) {
  return `<!doctype html><html lang="en"><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<title>Schema Diagram</title>
<style nonce="${nonce}">
*{box-sizing:border-box}html,body{height:100%;margin:0}body{display:flex;flex-direction:column;color:var(--vscode-foreground,#e5ecf4);background:var(--vscode-editor-background,#172029);font:13px var(--vscode-font-family,system-ui)}
header{padding:14px 18px 10px;border-bottom:1px solid var(--vscode-widget-border,#526375)}h1{font-size:17px;margin:0 0 4px}header p{margin:0;color:var(--vscode-descriptionForeground,#afbac8)}
fieldset{display:flex;flex:1;min-height:0;min-width:0;flex-direction:column;border:0;margin:0;padding:0}nav{display:flex;gap:7px;flex-wrap:wrap;padding:10px 18px;border-bottom:1px solid var(--vscode-widget-border,#526375)}
button,select,input{font:inherit;color:var(--vscode-input-foreground,#f4f8fc);background:var(--vscode-input-background,#263542);border:1px solid var(--vscode-widget-border,#526375);border-radius:5px;padding:5px 8px}
button:enabled{cursor:pointer}button:enabled:hover{border-color:var(--vscode-focusBorder,#6cd7cc)}button:disabled{opacity:.45}button:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid var(--vscode-focusBorder,#6cd7cc);outline-offset:1px}
.workbench{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,29%);min-height:0;flex:1}.viewport{overflow:auto;overscroll-behavior:contain}canvas{display:block;touch-action:none;cursor:grab}canvas:active{cursor:grabbing}
aside{padding:12px 14px;overflow:auto;background:var(--vscode-sideBar-background,#263542);border-left:1px solid var(--vscode-widget-border,#526375)}h2{font-size:13px;margin:12px 0 6px}ul{margin:0;padding:0;list-style:none}li{display:flex;flex-direction:column;gap:4px;padding:6px 0;border-bottom:1px solid var(--vscode-widget-border,#526375);overflow-wrap:anywhere}li span{color:var(--vscode-descriptionForeground,#afbac8)}li button{text-align:left}
#entity{display:block;max-width:100%;width:100%;margin:5px 0 8px}form{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:8px}input[type=number]{width:63px}footer{padding:7px 18px;min-height:30px;border-top:1px solid var(--vscode-widget-border,#526375);color:var(--vscode-descriptionForeground,#afbac8)}
@media(max-width:610px){.workbench{grid-template-columns:1fr;grid-template-rows:minmax(190px,1fr) minmax(150px,40%)}aside{border-left:0;border-top:1px solid var(--vscode-widget-border,#526375)}}
</style>
<header><h1>Schema Diagram</h1><p id="scope"></p></header>
<fieldset id="controls" disabled>
<nav aria-label="Diagram actions"><button id="refresh">Refresh</button><button id="save">Save Layout</button><button id="reset">Reset Positions</button><button id="import-layout">Import Layout</button><button id="export-layout">Export Layout</button><button id="export-png">Export PNG</button><button id="logical" hidden>Logical Relationships</button><label>Zoom <select id="zoom"><option value=".5">50%</option><option value=".75">75%</option><option value="1" selected>100%</option><option value="1.25">125%</option><option value="1.5">150%</option></select></label></nav>
<div class="workbench"><div class="viewport" id="viewport" tabindex="0" aria-label="Schema diagram canvas"><canvas id="diagram" aria-hidden="true"></canvas></div>
<aside><label for="entity">Entity</label><select id="entity"></select><button id="open-table" disabled>Open Table Preview</button>
<form id="coordinates"><label>X <input id="left" type="number" min="${card.margin}" max="${maxPosition}" required></label><label>Y <input id="top" type="number" min="${card.top}" max="${maxPosition}" required></label><button id="move" disabled>Move</button></form>
<h2>Columns</h2><ul id="attributes"></ul><h2>Relationships</h2><ul id="relationships"></ul></aside></div>
</fieldset>
<footer id="status" role="status" aria-live="polite"></footer>
<script nonce="${nonce}">(${diagramClient.toString()})(${JSON.stringify({ card, maxPosition })});</script></html>`;
}

module.exports = { diagramHtml };
