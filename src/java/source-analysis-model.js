'use strict';

const { rangeAt } = require('../spring/java');

const KINDS = new Set(['CLASS','INTERFACE','ENUM','RECORD','ANNOTATION_TYPE']);
const STRUCTURE = new Set(['extends','implements','nestedIn']);
const RELATIONS = new Set([...STRUCTURE,'associates','uses']);
const RELATION_MODES = new Set(['all','structure','associations','dependencies']);
const ROLE_LABELS = Object.freeze({field:'Field type','field-argument':'Field type argument',return:'Return type',
  'return-argument':'Return type argument',parameter:'Parameter type','parameter-argument':'Parameter type argument',
  throws:'Thrown type','throws-argument':'Thrown type argument',construct:'Construction','construct-argument':'Construction type argument',
  call:'Method call'});
const TYPE_ID = /^[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u;

function plain(value, maximum = 240) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,maximum) : '';
}

function checkedLocation(location,sources,{precise=false}={}) {
  const source = sources.get(location?.uri);
  if (!source || !Number.isSafeInteger(location.start) || !Number.isSafeInteger(location.end) ||
      location.start < 0 || location.end <= location.start || location.end > source.text.length) {
    throw Error('The compiler returned an invalid Java source location.');
  }
  // Structural links open the declaration start. Member occurrences select the source that establishes the relationship.
  const range = rangeAt(source.text,location.start,precise?location.end:location.start);
  return { uri:location.uri,range };
}

function classDiagram(report,sourceFiles) {
  if (!Array.isArray(report?.declarations) || report.declarations.length > 300) throw Error('Invalid Java class diagram report.');
  const byFile = new Map(sourceFiles.map(source => [source.uri,source]));
  const byId = new Map(), edges = [], grouped = new Map();
  let omittedRelations=0,occurrences=0;
  for (const declaration of report.declarations) {
    if (!TYPE_ID.test(declaration.id ?? '') || byId.has(declaration.id) || !KINDS.has(declaration.kind) ||
        !Array.isArray(declaration.members) || !Array.isArray(declaration.relations) || declaration.relations.length>500) {
      throw Error('Invalid compiler Java type declaration.');
    }
    const type = {
      id:declaration.id,name:plain(declaration.name),kind:declaration.kind,qualified:declaration.id,external:false,
      location:checkedLocation(declaration.location,byFile), members:declaration.members.map(member => ({
        name:plain(member.name),signature:plain(member.signature,380),kind:plain(member.kind),
        modifiers:(Array.isArray(member.modifiers) ? member.modifiers : []).map(item => plain(item,32)),
        location:checkedLocation(member.location,byFile)
      })),
      omittedMembers:Number.isSafeInteger(declaration.omittedMembers) ? declaration.omittedMembers : 0
    };
    byId.set(type.id,type);
    if (Number.isSafeInteger(declaration.omittedRelations)&&declaration.omittedRelations>0) omittedRelations+=declaration.omittedRelations;
    for (const edge of declaration.relations) {
      if (!TYPE_ID.test(edge.target ?? '') || !RELATIONS.has(edge.kind)) throw Error('Invalid Java type relationship.');
      if (STRUCTURE.has(edge.kind)) {
        edges.push({ from:type.id,to:edge.target,kind:edge.kind,signature:plain(edge.signature,350) });
        continue;
      }
      if (!Object.hasOwn(ROLE_LABELS,edge.role) || (edge.kind==='associates')!==edge.role.startsWith('field') || ++occurrences>9000) {
        throw Error('Invalid Java relationship occurrence.');
      }
      const key=JSON.stringify([type.id,edge.target,edge.kind]);
      if (!grouped.has(key)) {
        const relation={id:'relation-'+grouped.size,from:type.id,to:edge.target,kind:edge.kind,origins:[]};
        grouped.set(key,relation);
        edges.push(relation);
      }
      grouped.get(key).origins.push({role:edge.role,label:ROLE_LABELS[edge.role],member:plain(edge.member,180),
        signature:plain(edge.signature,350),location:checkedLocation(edge.location,byFile,{precise:true})});
    }
  }
  for (const edge of edges) {
    if (!byId.has(edge.to)) byId.set(edge.to,{ id:edge.to,name:edge.to.split('.').at(-1),
      qualified:edge.to,kind:'EXTERNAL',external:true,members:[],omittedMembers:0 });
  }
  const nodes = [...byId.values()].sort((a,b) => Number(a.external) - Number(b.external) || a.id.localeCompare(b.id));
  return {nodes,edges,localCount:report.declarations.length,externalCount:nodes.length-report.declarations.length,omittedRelations};
}

function filterClassRelations(diagram,mode) {
  if (!RELATION_MODES.has(mode)) throw Error('Choose a supported class relationship view.');
  if (mode==='all') return diagram.edges;
  if (mode==='structure') return diagram.edges.filter(edge=>STRUCTURE.has(edge.kind));
  return diagram.edges.filter(edge=>edge.kind===(mode==='associations'?'associates':'uses'));
}

function visibleClassLayout(diagram,{focus,external=true,maxNodes=90,relationships='all'}={}) {
  const available=filterClassRelations(diagram,relationships), externalTargets=new Set(available.map(edge=>edge.to));
  const byId = new Map(diagram.nodes.map(node => [node.id,node]));
  const selected = focus && byId.has(focus) ? new Set([focus]) : null;
  if (selected) {
    for (const edge of available) if (edge.from === focus || edge.to === focus) {
      selected.add(edge.from);
      selected.add(edge.to);
    }
  }
  const candidates = diagram.nodes.filter(node => (!node.external || external&&externalTargets.has(node.id)) && (!selected || selected.has(node.id)));
  const nodes = candidates.slice(0,maxNodes), ids = new Set(nodes.map(node => node.id));
  const edges = available.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  const parents = new Map();
  for (const edge of edges) {
    if (edge.kind!=='extends'&&edge.kind!=='implements') continue;
    if (!parents.has(edge.from)) parents.set(edge.from,[]);
    parents.get(edge.from).push(edge.to);
  }
  const ranks = new Map(), inProgress = new Set();
  function rank(id) {
    if (ranks.has(id)) return ranks.get(id);
    if (inProgress.has(id)) throw Error('Cyclic compiler type hierarchy.');
    inProgress.add(id);
    const parentsOf = parents.get(id) || [];
    const depth = parentsOf.length ? Math.max(...parentsOf.map(parent => rank(parent))) + 1 : 0;
    ranks.set(id,depth);
    inProgress.delete(id);
    return depth;
  }
  const lanes = new Map();
  for (const node of nodes) {
    const depth = rank(node.id);
    if (!lanes.has(depth)) lanes.set(depth,[]);
    lanes.get(depth).push(node);
  }
  const CARD_W = 248, CARD_H = 132, PADDING = 30, columns = 4, DX = CARD_W + 48, DY = CARD_H + 52;
  const positions = [];
  let row = 0;
  for (const [,lane] of [...lanes.entries()].sort((a,b) => a[0] - b[0])) {
    lane.forEach((node,index) => positions.push({ ...node,x:PADDING + (index % columns)*DX,
      y:PADDING + (row + Math.floor(index / columns))*DY,w:CARD_W,h:CARD_H }));
    row += Math.ceil(lane.length / columns);
  }
  return { nodes:positions,edges,width:PADDING*2 + DX*(Math.min(nodes.length,columns) - 1) + CARD_W,
    height:PADDING*2 + DY*Math.max(0,row - 1) + CARD_H, omitted:candidates.length - nodes.length };
}

function mermaidDiagram(diagram,{external=true,relationships='all'}={}) {
  const edges=filterClassRelations(diagram,relationships), externalTargets=new Set(edges.map(edge=>edge.to));
  const nodes = diagram.nodes.filter(node => !node.external || external&&externalTargets.has(node.id));
  const identifiers = new Map(nodes.map((node,index) => [node.id,'Type' + index]));
  const rows = ['classDiagram'];
  // The compiler supplies Java identifiers. Keep member labels separate
  // from Mermaid grammar so generic or annotation text cannot alter structure.
  for (const node of nodes) rows.push('    class ' + identifiers.get(node.id) + '["' + node.qualified + '"]');
  for (const edge of edges) {
    if (!identifiers.has(edge.from) || !identifiers.has(edge.to)) continue;
    const operator = {'extends':'--|>','implements':'..|>','nestedIn':'..>','associates':'-->','uses':'..>'}[edge.kind];
    const label=edge.kind==='nestedIn'?'nested in':edge.origins?.length?
      [...new Set(edge.origins.map(item=>ROLE_LABELS[item.role].toLowerCase()))].join(', '):'';
    rows.push('    ' + identifiers.get(edge.from) + ' ' + operator + ' ' + identifiers.get(edge.to) +
      (label ? ' : '+label : ''));
  }
  return rows.join('\n') + '\n';
}

function dataFlow(report,source,offset) {
  const block = report?.dataFlow;
  if (block?.error) throw Error(plain(block.error,300));
  if (block?.uri !== source.uri || !Array.isArray(block.events) || block.events.length > 700) throw Error('Invalid Java flow report.');
  const events = block.events.map((event,index) => {
    if (event.id !== index || !Number.isSafeInteger(event.start) || !Number.isSafeInteger(event.end) ||
        event.start < 0 || event.end <= event.start || event.end > source.text.length ||
        !Array.isArray(event.inputs) || event.inputs.some(id => !Number.isSafeInteger(id) || id < 0 || id >= index)) {
      throw Error('Invalid Java compiler data-flow event.');
    }
    return { ...event,name:plain(event.name,100),kind:plain(event.kind,48),uri:source.uri,
      range:rangeAt(source.text,event.start,event.end) };
  });
  const origin = events.find(event => event.start <= offset && offset < event.end) ||
    events.find(event => event.end === offset);
  if (!origin) throw Error('Place the cursor on a traced parameter, assignment, literal, read or return keyword.');
  return flowSlice(events,origin);
}

const VALUE_EVENTS = new Set(['parameter','definition','read','assignment','return','literal','argument','call-result',
  'choice','true-value','false-value','condition','branch','branch-merge','return-merge','narrowed']);
const WRAPPERS = new Set(['argument','true-value','false-value','choice','branch','branch-merge','return-merge','narrowed']);

function callFlow(report,source,sources,offset) {
  const block=report?.callFlow;
  if (block?.error) throw Error(plain(block.error,300));
  if (block?.uri!==source.uri||!block.method||!Number.isSafeInteger(block.originFrame)||block.originFrame<0||block.originFrame>48||
      !Array.isArray(block.events)||block.events.length>700||!Array.isArray(block.contexts)||block.contexts.length>32||
      !Number.isSafeInteger(block.omittedContexts)||block.omittedContexts<0) throw Error('Invalid Java call flow report.');
  const byUri=new Map(sources.map(item=>[item.uri,item]));
  function address(item) {
    const file=byUri.get(item?.uri);
    if (!file||!Number.isSafeInteger(item.start)||!Number.isSafeInteger(item.end)||item.start<0||
        item.end<=item.start||item.end>file.text.length||typeof item.method!=='string'||!item.method) {
      throw Error('Invalid Java call flow source range.');
    }
    return {uri:item.uri,range:rangeAt(file.text,item.start,item.end),method:plain(item.method,350)};
  }
  const events=block.events.map((event,index)=>{
    if (event?.id!==index||!VALUE_EVENTS.has(event.kind)||!Number.isSafeInteger(event.frame)||event.frame<0||event.frame>48||
        !Array.isArray(event.inputs)||event.inputs.some(id=>!Number.isSafeInteger(id)||id<0||id>=index)) {
      throw Error('Invalid Java call flow event.');
    }
    return {id:index,name:plain(event.name,350),kind:event.kind,frame:event.frame,start:event.start,end:event.end,
      inputs:[...event.inputs],...address(event)};
  });
  const local=events.filter(event=>event.uri===source.uri&&event.frame===block.originFrame&&event.method===plain(block.method,350));
  const atCursor=entries=>entries.sort((a,b)=>Number(WRAPPERS.has(a.kind))-Number(WRAPPERS.has(b.kind))||
    a.end-a.start-(b.end-b.start)||a.id-b.id)[0];
  const origin=atCursor(local.filter(item=>item.start<=offset&&offset<item.end))||atCursor(local.filter(item=>item.end===offset));
  if (!origin) throw Error('Place the cursor on a traced Java value, parameter, call or return keyword.');
  const contexts=block.contexts.map((location,index)=>({id:'caller-'+index,start:location?.start,...address(location)}));
  return {...flowSlice(events,origin),contexts,omittedContexts:block.omittedContexts};
}

function flowSlice(events,origin) {
  const useIndex = new Map();
  for (const event of events) for (const input of event.inputs) {
    if (!useIndex.has(input)) useIndex.set(input,[]);
    useIndex.get(input).push(event.id);
  }
  function traverse(neighbors) {
    const levels = new Map([[origin.id,0]]), visited = [origin.id];
    for (let index = 0; index < visited.length; index++) {
      const id = visited[index];
      for (const next of neighbors(id)) {
        if (levels.has(next)) continue;
        visited.push(next);
        levels.set(next,levels.get(id) + 1);
      }
    }
    return visited.slice(1).map(id => ({ ...events[id],steps:levels.get(id) }));
  }
  return {
    origin,inputs:traverse(id => events[id].inputs),uses:traverse(id => useIndex.get(id) || []),events:events.length
  };
}

module.exports = { classDiagram,visibleClassLayout,mermaidDiagram,dataFlow,callFlow,RELATION_MODES };
