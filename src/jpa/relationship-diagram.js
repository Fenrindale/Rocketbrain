'use strict';

const { createHash } = require('node:crypto');

const NODE_LIMIT = 64, EDGE_LIMIT = 192, MAX_POSITION = 3200;
const card = Object.freeze({ width:210, height:108, margin:24, gapX:80, gapY:60 });
const relations = new Map([['oneToOne','1 → 1'], ['oneToMany','1 → many'], ['manyToOne','many → 1'], ['manyToMany','many → many']]);
const providerRelations = { ONE_TO_ONE:'oneToOne', ONE_TO_MANY:'oneToMany', MANY_TO_ONE:'manyToOne', MANY_TO_MANY:'manyToMany' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const validId = /^[0-9a-f]{64}$/;
const text = (value, limit=480) => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value) && value.length <= limit ? value : null;
const fqn = value => text(value) && /^[\p{L}\p{N}_$.]+$/u.test(value) ? value : null;
const sourceLocation = value => value?.uri && value?.range ? { uri:value.uri, range:value.range } : null;

function observedScopes(snapshot) {
  if (snapshot?.state !== 'observed' || !Array.isArray(snapshot.factories)) return [];
  const scopes = snapshot.factories.filter(item => /^factory-[1-9]\d{0,15}$/.test(item?.id || '') && item.provider === 'hibernate' &&
    Array.isArray(item.entities) && item.entities.length && ['observed','partial'].includes(item.state)).map(factory => {
    const name = text(factory.factoryName, 128);
    const entities = [...new Set(factory.entities.map(item => fqn(item.javaType)).filter(Boolean))].sort(compare);
    return { key:factory.id, name, label:name || `Hibernate ${text(factory.version,128) || ''} · ${factory.id}`,
      identity:digest(['observed-factory', factory.provider, name || entities]), entities, factory };
  });
  const counts = new Map();
  for (const scope of scopes) counts.set(scope.identity, (counts.get(scope.identity) || 0)+1);
  return scopes.map(scope => counts.get(scope.identity) > 1 ? { ...scope,
    label:`${scope.label} · ${scope.key}`, identity:digest([scope.identity,snapshot.processId,scope.key]), layoutSessionOnly:true } : scope);
}

const sourceScope = Object.freeze({ key:'source', label:'Workspace source', identity:digest(['workspace-source']) });

function chooseScope(scopes, model, activeUri) {
  if (!scopes.length) return sourceScope;
  const editorTypes = new Set(model.entities.filter(item => item.uri === activeUri).map(item => item.fqn));
  if (editorTypes.size) {
    const matches = scopes.filter(scope => scope.entities.some(name => editorTypes.has(name)));
    if (matches.length===1) return matches[0];
    if (!matches.length) return sourceScope;
    return null;
  }
  return scopes.length===1 ? scopes[0] : null;
}

function uniqueBy(items, key) {
  const result = new Map();
  for (const item of items) {
    const name = key(item);
    if (name) result.set(name, result.has(name) ? null : item);
  }
  return result;
}

function buildDiagram(model, scope=sourceScope, focus) {
  const sources = uniqueBy(model.entities, item => fqn(item.fqn));
  const observed = scope.factory;
  const input = observed ? uniqueBy(observed.entities, item => fqn(item.javaType)) : sources;
  const entities = new Map([...input].filter(([,entity])=>entity).sort(([left],[right])=>compare(left,right)));
  const ids = new Map([...entities.keys()].map(name=>[name,digest(['entity', name])]));
  if (focus !== undefined && !entities.has(focus)) throw Error('Choose a managed entity in the selected diagram scope.');

  const edges = [], unresolved = [];
  let unresolvedCount = 0;
  const add = (from, to, kind, name, ownership, location) => {
    edges.push({ id:digest([from,to,kind,name]), from:ids.get(from), to:ids.get(to), fromType:from, toType:to,
      kind, name, label:relations.get(kind) || 'extends', ownership, source:location });
  };
  for (const [name, entity] of entities) {
    const source = sources.get(name);
    const parent = fqn(observed ? entity.superEntityJavaType : entity.superFqn);
    if (entities.has(parent)) add(name,parent,'inheritance','extends',null,sourceLocation(source));
    for (const attribute of entity.attributes || []) {
      const kind = observed ? providerRelations[attribute.kind] : attribute.kind;
      const property = text(attribute.name,256);
      if (!property || !relations.has(kind) || (observed && attribute.association!==true)) continue;
      if (attribute.declaredIn && entities.has(attribute.declaredIn) && attribute.declaredIn!==name) continue;
      const target = fqn(observed ? (attribute.targetEntityJavaType || (!attribute.collection ? attribute.javaType : null)) : attribute.targetFqn);
      if (!entities.has(target) || (!observed && attribute.status!=='known')) {
        unresolvedCount++;
        if (unresolved.length < EDGE_LIMIT) unresolved.push({ entity:name, property });
        continue;
      }
      const locations = (source?.attributes || []).filter(item => item.name===property && item.kind===kind && item.targetFqn===target);
      const location = observed ? locations.length===1 ? sourceLocation(locations[0]) : null : sourceLocation(attribute);
      const ownership = observed ? attribute.inverse===true?'inverse':attribute.inverse===false?'owning':null
        : attribute.mappedBy === '' ? 'owning' : text(attribute.mappedBy) ? 'inverse' : null;
      add(name,target,kind,property,ownership,location);
    }
  }

  const all = [...entities.keys()];
  const nearby = focus === undefined ? all : [focus, ...[...new Set(edges.flatMap(edge=>edge.fromType===focus?[edge.toType]:edge.toType===focus?[edge.fromType]:[]).filter(name=>name!==focus))].sort(compare)];
  const visible = new Set(nearby.slice(0,NODE_LIMIT));
  const boundedEdges = edges.filter(edge=>visible.has(edge.fromType) && visible.has(edge.toType));
  const nodes = [...visible].map(name => {
    const entity = entities.get(name), source = sources.get(name);
    return { id:ids.get(name), fqn:name, name:text(entity.name,256) || name.split('.').at(-1), source:sourceLocation(source),
      table:observed ? text(entity.table) : text(entity.table?.name), abstract:observed && entity.abstract===true,
      attributes:(entity.attributes || []).slice(0,40).map(item=>({ name:text(item.name,256), type:text(item.javaType,256) })).filter(item=>item.name) };
  });
  return { mode:observed?'observed':'source', scope:scope.key, scopeLabel:scope.label, identity:scope.identity,
    sourceRevisionMatched:false, storage:scope.layoutSessionOnly?'session':'workspace', focus:focus??null,
    nodes, edges:boundedEdges.slice(0,EDGE_LIMIT), unresolved,
    coverage:{ entities:all.length, excluded:all.length-nodes.length, ambiguous:[...input.values()].filter(item=>!item).length, unresolved:unresolvedCount,
      omittedEdges:boundedEdges.length-Math.min(EDGE_LIMIT,boundedEdges.length), partial:observed?observed.state!=='observed'||observed.truncated===true:model.sourceCoverage?.complete===false } };
}

function readLayout(value) {
  const result = Object.create(null);
  if (!value || typeof value!=='object' || Array.isArray(value)) return result;
  for (const [id,item] of Object.entries(value).slice(0,512)) if (validId.test(id) && item &&
      Number.isInteger(item.x) && item.x>=0 && item.x<=MAX_POSITION && Number.isInteger(item.y) && item.y>=0 && item.y<=MAX_POSITION &&
      (item.hidden===undefined || typeof item.hidden==='boolean')) result[id]={ x:item.x,y:item.y,hidden:item.hidden===true };
  return result;
}

function defaultPosition(index, total) {
  const cols=Math.max(1,Math.ceil(Math.sqrt(total*1.25)));
  return { x:card.margin+(index%cols)*(card.width+card.gapX), y:card.margin+Math.floor(index/cols)*(card.height+card.gapY), hidden:false };
}

function layoutFor(diagram, saved) {
  return Object.fromEntries(diagram.nodes.map((node,index)=>[node.id,{...(saved[node.id] || defaultPosition(index,diagram.nodes.length))}]));
}

function editLayout(diagram, saved, action) {
  if (action?.type==='reset') return Object.create(null);
  if (!diagram.nodes.some(node=>node.id===action?.id)) throw Error('Choose an entity shown in the current diagram.');
  const next=readLayout(saved), current=layoutFor(diagram,next)[action.id];
  if (!Object.hasOwn(next,action.id) && Object.keys(next).length>=512) throw Error('Reset the current layout before saving additional entity positions.');
  if (action.type==='move') {
    const checked=readLayout({[action.id]:{x:action.x,y:action.y,hidden:current.hidden}})[action.id];
    if (!checked) throw Error('The diagram position is outside the supported canvas.');
    next[action.id]=checked;
  } else if (action.type==='visibility' && typeof action.hidden==='boolean') next[action.id]={ ...current,hidden:action.hidden };
  else throw Error('Unsupported diagram change.');
  return next;
}

module.exports={ observedScopes, sourceScope, chooseScope, buildDiagram, readLayout, layoutFor, editLayout, card, MAX_POSITION, NODE_LIMIT };
