'use strict';

const { randomBytes } = require('node:crypto');
const { card, MAX_POSITION } = require('./relationship-diagram');

function browser(card, limit) {
  const host = acquireVsCodeApi(), find = name => document.getElementById(name);
  const world=find('world'), canvas=find('edges'), viewport=find('viewport'), details=find('details');
  const paint=canvas.getContext('2d'), positions=new Map(), elements=new Map();
  let frame, selected, renderedToken, stale=false, drag, scheduled=false;
  const clamp = value => Math.max(0,Math.min(limit,Math.round(value)));
  function send(type, options={}) { host.postMessage({type,token:frame?.token,...options}); }
  function element(tag,text,cls) {
    const child=document.createElement(tag);
    if (text!==undefined) child.textContent=text;
    if (cls) child.className=cls;
    return child;
  }
  function button(label, action, disabled=false) {
    const control=element('button',label);
    control.type='button'; control.disabled=disabled;
    control.addEventListener('click',action);
    return control;
  }
  function draw() {
    scheduled=false;
    const current=[...positions.values()].filter(position=>!position.hidden);
    const width=Math.min(limit+card.width+card.margin,Math.max(viewport.clientWidth-3,420,...current.map(position=>position.x+card.width+card.margin)));
    const height=Math.min(limit+card.height+card.margin,Math.max(viewport.clientHeight-3,300,...current.map(position=>position.y+card.height+card.margin)));
    world.style.width=width+'px'; world.style.height=height+'px';
    if (canvas.width!==width || canvas.height!==height) {canvas.width=width;canvas.height=height;}
    paint.clearRect(0,0,width,height);
    const colors=getComputedStyle(document.body);
    for (const edge of frame.diagram.edges) {
      const from=positions.get(edge.from), to=positions.get(edge.to);
      if (!from || !to || from.hidden || to.hidden) continue;
      paint.lineWidth=edge.from===selected || edge.to===selected?2.5:1.25;
      const color=colors.getPropertyValue(paint.lineWidth>2?'--vscode-focusBorder':'--vscode-descriptionForeground').trim() || '#808080';
      paint.strokeStyle=color;paint.fillStyle=color;
      paint.setLineDash(edge.ownership==='inverse'?[6,4]:edge.kind==='inheritance'?[2,3]:[]);
      const x=from.x+card.width/2,y=from.y+card.height/2, dx=to.x-from.x, dy=to.y-from.y;
      let ending, angle;
      paint.beginPath();
      if (edge.from===edge.to) {
        ending={x:from.x+card.width,y:from.y+17};angle=Math.PI;
        paint.moveTo(from.x+card.width,y+15);
        paint.bezierCurveTo(from.x+card.width+50,y+13,from.x+card.width+47,ending.y,ending.x,ending.y);
      } else {
        if (dx===0 && dy===0) continue;
        const margin=Math.min(.47,(card.width/2)/Math.abs(dx),(card.height/2)/Math.abs(dy));
        ending={x:x+dx*(1-margin),y:y+dy*(1-margin)};angle=Math.atan2(dy,dx);
        paint.moveTo(x+dx*margin,y+dy*margin);paint.lineTo(ending.x,ending.y);
      }
      paint.stroke();paint.setLineDash([]);
      paint.beginPath();paint.moveTo(ending.x,ending.y);
      paint.lineTo(ending.x-8*Math.cos(angle-.45),ending.y-8*Math.sin(angle-.45));
      paint.lineTo(ending.x-8*Math.cos(angle+.45),ending.y-8*Math.sin(angle+.45));
      paint.closePath();paint.fill();
    }
    if (renderedToken!==frame.token) {renderedToken=frame.token;send('rendered');}
  }
  function redraw() { if (frame && !scheduled) {scheduled=true;requestAnimationFrame(draw);} }
  function place(item,id) {
    const position=positions.get(id);
    item.style.left=position.x+'px';item.style.top=position.y+'px';item.hidden=position.hidden;
  }
  function select(id, reveal=false) {
    selected=id;
    for (const [key,item] of elements) item.classList.toggle('selected',key===id);
    find('entities').value=id || '';
    if (reveal && elements.get(id) && !elements.get(id).hidden) elements.get(id).scrollIntoView({block:'nearest',inline:'nearest'});
    renderDetails();redraw();
  }
  function renderDetails() {
    details.replaceChildren();
    const node=frame.diagram.nodes.find(item=>item.id===selected);
    if (!node) {details.append(element('p','Select an entity to inspect its mappings.'));return;}
    const position=positions.get(node.id);
    details.append(element('h2',node.name),element('p',node.fqn,'muted'));
    const controls=element('div',undefined,'actions');
    if (node.hasSource) controls.append(button('Open declaration',()=>send('openSource',{id:node.id}),stale));
    controls.append(button(position.hidden?'Show entity':'Hide entity',()=>send('visibility',{id:node.id,hidden:!position.hidden}),stale));
    for (const [name,x,y] of [['left',-20,0],['up',0,-20],['down',0,20],['right',20,0]])
      controls.append(button('Move '+name,()=>send('move',{id:node.id,x:clamp(position.x+x),y:clamp(position.y+y)}),stale || position.hidden));
    details.append(controls,element('h3','Relationships'));
    const related=frame.diagram.edges.filter(edge=>edge.from===node.id || edge.to===node.id);
    if (!related.length) details.append(element('p','No resolved relationships in this view.','muted'));
    const list=element('ul');
    for (const edge of related) {
      const row=element('li');
      row.append(element('div',edge.fromType.split('.').at(-1)+' · '+edge.name+' · '+edge.label+' · '+edge.toType.split('.').at(-1)));
      if (edge.ownership) row.append(element('small',edge.ownership,'muted'));
      if (edge.hasSource) row.append(button('Open mapping',()=>send('openSource',{id:edge.id}),stale));
      if (edge.from!==edge.to) row.append(button('Select related entity',()=>select(edge.from===node.id?edge.to:edge.from,true)));
      list.append(row);
    }
    details.append(list);
    const unresolved=frame.diagram.unresolved.filter(item=>item.entity===node.fqn);
    if (unresolved.length) details.append(element('p','Unresolved mappings · '+unresolved.map(item=>item.property).join(', '),'muted'));
    details.append(element('h3','Persistent attributes'));
    const attributes=element('dl');
    for (const item of node.attributes) attributes.append(element('dt',item.name),element('dd',item.type || 'Type unavailable','muted'));
    details.append(attributes);
  }
  function render(next) {
    frame=next;stale=false;drag=undefined;
    const picker=find('entities');picker.replaceChildren();
    const blank=element('option','Select an entity');blank.value='';picker.append(blank);
    for (const item of elements.values()) item.remove();
    elements.clear();positions.clear();
    for (const node of next.diagram.nodes) {
      const position={...next.layout[node.id]};positions.set(node.id,position);
      const option=element('option',node.fqn+(position.hidden?' · hidden':''));option.value=node.id;picker.append(option);
      const item=element('article',undefined,'entity');
      item.style.width=card.width+'px';item.style.height=card.height+'px';
      const header=button(node.name,()=>select(node.id));header.title=node.fqn;header.className='handle';
      const tableLabel=node.table?(next.diagram.mode==='observed'?'Table · ':'Declared table · ')+node.table:'Table unavailable';
      const table=element('span',tableLabel,'table-label');table.title=tableLabel;
      item.append(header,table,element('small',node.attributes.length+' attributes'+(node.abstract?' · abstract':''),'muted'));
      world.append(item);elements.set(node.id,item);place(item,node.id);
      header.addEventListener('pointerdown',event=>{
        if (stale || event.button!==0) return;
        drag={id:node.id,pointer:event.pointerId,x:event.clientX,y:event.clientY,startX:positions.get(node.id).x,startY:positions.get(node.id).y,moved:false};
        header.setPointerCapture(event.pointerId);
      });
      header.addEventListener('pointermove',event=>{
        if (!drag || drag.id!==node.id || drag.pointer!==event.pointerId) return;
        const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
        if (!drag.moved && Math.abs(dx)+Math.abs(dy)<4) return;
        drag.moved=true;
        const entry=positions.get(node.id);entry.x=clamp(drag.startX+dx);entry.y=clamp(drag.startY+dy);
        place(item,node.id);redraw();
      });
      header.addEventListener('pointerup',()=>{
        if (drag?.id!==node.id) return;
        const moved=drag.moved;drag=undefined;
        if (moved && !stale) {const {x,y}=positions.get(node.id);send('move',{id:node.id,x,y});}
      });
      header.addEventListener('pointercancel',()=>{
        if (drag?.id!==node.id) return;
        Object.assign(positions.get(node.id),{x:drag.startX,y:drag.startY});drag=undefined;place(item,node.id);redraw();
      });
    }
    const {diagram}=next, {coverage}=diagram;
    const scope=diagram.mode==='observed'?diagram.scopeLabel+' · observed Hibernate mappings · source revision unverified':'Workspace source declarations';
    find('scope-label').textContent=scope;
    const hidden=[...positions.values()].filter(item=>item.hidden).length;
    find('count').textContent=[diagram.nodes.length+' entities',diagram.edges.length+' relationships',hidden?hidden+' hidden':'',
      coverage.excluded?coverage.excluded+' outside view':'',coverage.ambiguous?coverage.ambiguous+' ambiguous':'',
      coverage.unresolved?coverage.unresolved+' unresolved mappings':'',
      coverage.omittedEdges?coverage.omittedEdges+' relationships outside limit':'',coverage.partial?'partial coverage':''].filter(Boolean).join(' · ');
    find('status').textContent='';find('reset').disabled=!diagram.nodes.length;
    select(positions.has(selected)?selected:diagram.nodes.find(node=>node.fqn===diagram.focus)?.id);
  }
  find('entities').addEventListener('change',event=>{if(frame)select(event.target.value,true);});
  for (const name of ['scope','focus','refresh','reset']) find(name).addEventListener('click',()=>{if(frame && (!stale || name!=='reset'))send(name);});
  window.addEventListener('resize',redraw);
  window.addEventListener('message',event=>{
    const data=event.data;
    if (data.type==='diagram') render(data);
    else if (data.type==='status') {
      find('status').textContent=data.text;
      if (data.stale) {stale=true;find('reset').disabled=true;if(frame)renderDetails();}
    }
  });
  send('ready');
}

function diagramHtml() {
  const nonce=randomBytes(24).toString('base64');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'"><title>JPA Relationships</title>
  <style nonce="${nonce}">
  *{box-sizing:border-box} body{margin:0;color:var(--vscode-editor-foreground);font:var(--vscode-font-size) var(--vscode-font-family)}
  header{padding:.65rem .8rem;border-bottom:1px solid var(--vscode-panel-border)} h1{margin:0 0 .25rem;font-size:1.2rem}
  .toolbar,.actions{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center} .toolbar{margin:.5rem 0}
  button,select{font:inherit;padding:.3em .55em;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);border:1px solid var(--vscode-panel-border);border-radius:2px}
  button:hover{background:var(--vscode-button-secondaryHoverBackground)} button:disabled{opacity:.55} button:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder)}
  .muted,#count,#status{color:var(--vscode-descriptionForeground)} #status:not(:empty){display:block;margin:.35rem 0}
  main{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,29%);height:calc(100vh - 130px);min-height:390px}
  #viewport{overflow:auto;background:var(--vscode-editor-background)} #world{position:relative;min-width:100%;min-height:100%}
  canvas{position:absolute;inset:0;pointer-events:none} .entity{position:absolute;display:flex;flex-direction:column;align-items:stretch;gap:.45rem;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-panel-border);border-radius:5px;overflow:hidden}
  .entity[hidden]{display:none} .entity.selected{border-color:var(--vscode-focusBorder);box-shadow:0 0 0 1px var(--vscode-focusBorder)}
  .entity small,.table-label{padding:0 .5rem}.handle{cursor:grab;text-align:left;touch-action:none;user-select:none;font-weight:600;border-width:0 0 1px;border-radius:0}
  .handle,.table-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.table-label{font-family:var(--vscode-editor-font-family)}
  #details{border-left:1px solid var(--vscode-panel-border);overflow:auto;padding:.7rem .85rem;overflow-wrap:anywhere;background:var(--vscode-sideBar-background)}
  h2,h3{margin:.25rem 0 .45rem} h3{margin-top:1rem} p{margin:.4rem 0} ul{padding-left:1em} li{margin:.45rem 0} li button{margin:.2rem .3rem 0 0} li small{display:block}
  dl{display:grid;grid-template-columns:auto 1fr;gap:.3rem .5rem;margin:0} dd{margin:0} @media(max-width:640px){main{grid-template-columns:1fr;grid-template-rows:minmax(260px,55vh) auto;height:auto}#details{border-left:0;border-top:1px solid var(--vscode-panel-border)}}
  </style></head><body><header><h1>JPA Relationships</h1><div id="scope-label" class="muted">Loading mappings</div>
  <div class="toolbar"><button type="button" id="scope">Scope</button><button type="button" id="focus">Focus</button><button type="button" id="refresh">Refresh</button>
  <button type="button" id="reset">Reset layout</button><select id="entities" aria-label="Entities"></select></div>
  <div id="count"></div><output id="status" role="status"></output></header>
  <main><section id="viewport" aria-label="Relationship diagram" tabindex="0"><div id="world"><canvas id="edges" aria-hidden="true"></canvas></div></section>
  <aside id="details" aria-label="Entity details"></aside></main><script nonce="${nonce}">(${browser.toString()})(${JSON.stringify(card)},${MAX_POSITION});</script></body></html>`;
}

module.exports={diagramHtml};
