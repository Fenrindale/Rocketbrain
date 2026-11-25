'use strict';

const {LIMITS,Reader,parseHprof,checkpoint,corrupt}=require('./hprof-format');

const ADDRESS=/^0x[0-9a-f]{1,16}$/i;
const MAX_RESULTS=500,MAX_SHOWN_PATH=128,MAX_LINKS=80;
const address=id=>'0x'+id.toString(16);

async function references(decoded,signal) {
  const {objects,positions,roots,bytes,idSize,classesByName}=decoded;
  const nodes=[null,...objects];
  const outgoing=Array.from(nodes,()=>[]),incoming=Array.from(nodes,()=>[]);
  const layouts=new Map();
  let edgeCount=0,work=0,nonStrong=0,unresolvedReferences=0;
  function edge(from,id,label,required=false) {
    if(!id)return;
    const to=positions.get(id);
    if(edgeCount+unresolvedReferences===LIMITS.edges)throw Error('The heap exceeds the 1,500,000 reference analysis limit.');
    if(to===undefined){
      if(required)throw corrupt('A GC root or class reference has no object record.');
      unresolvedReferences++;
      nodes[from].unresolved=(nodes[from].unresolved??0)+1;
      return;
    }
    edgeCount++;
    const link={from,to,label};
    outgoing[from].push(link);
    incoming[to].push(link);
  }
  function layout(id) {
    let fields=layouts.get(id);
    if(fields)return fields;
    const seen=new Set();
    fields=[];
    const initial=id;
    while(id){
      const type=nodes[positions.get(id)];
      if(!type||type.kind!=='class'||seen.has(id)||seen.size===512)throw corrupt('An instance class hierarchy is incomplete or cyclic.');
      seen.add(id);
      for(const field of type.fields)fields.push({type:field.type,size:field.size,label:field.label,
        nonStrong:type.typeName==='java.lang.ref.Reference'&&field.label==='referent'});
      id=type.superId;
    }
    layouts.set(initial,fields);
    return fields;
  }
  for(const [root,kind] of roots)edge(0,root,kind,true);
  for(let index=1;index<nodes.length;index++){
    if(++work%8192===0)await checkpoint(signal);
    const node=nodes[index];
    if(node.kind==='class'){
      for(const reference of node.references)edge(index,reference.id,reference.label);
    }else if(node.kind==='instance'){
      edge(index,node.classId,'class metadata',true);
      const fields=layout(node.classId),record=new Reader(bytes,node.offset,node.offset+node.shallow,idSize);
      for(const field of fields){
        if(field.type!==2){record.take(field.size);continue;}
        const target=record.id();
        if(field.nonStrong&&target){nonStrong++;continue;}
        edge(index,target,field.label);
      }
      if(record.left)throw corrupt('An instance payload does not match its declared fields.');
    }else if(node.kind==='array'){
      edge(index,node.classId,'class metadata',true);
      const record=new Reader(bytes,node.offset,node.offset+node.shallow,idSize);
      for(let element=0;element<node.length;element++){
        if(++work%8192===0)await checkpoint(signal);
        const target=record.id();
        if(target)edge(index,target,'['+element+']');
      }
    }else edge(index,classesByName.get(node.typeName),'class metadata');
  }
  return {nodes,outgoing,incoming,edgeCount,nonStrong,unresolvedReferences};
}

async function pathParents(outgoing,signal) {
  const parents=new Array(outgoing.length),queue=new Uint32Array(outgoing.length);
  let tail=1,work=0;
  for(let head=0;head<tail;head++){
    for(const edge of outgoing[queue[head]]){
      if(++work%8192===0)await checkpoint(signal);
      if(parents[edge.to])continue;
      parents[edge.to]=edge;
      queue[tail++]=edge.to;
    }
  }
  return parents;
}

// Semi-dominators use a DFS forest rooted at the synthetic GC-root vertex.
// Cycles and alternate retention paths participate in the same computation.
async function dominators(nodes,outgoing,incoming,signal) {
  const capacity=nodes.length+1;
  const number=new Uint32Array(nodes.length),vertex=new Uint32Array(capacity),parent=new Uint32Array(capacity);
  const nextEdge=new Uint32Array(capacity),dfs=[0];
  let count=1,work=0;
  number[0]=1;
  while(dfs.length){
    if(++work%8192===0)await checkpoint(signal);
    const from=dfs.at(-1),edge=outgoing[from][nextEdge[from]++];
    if(!edge){dfs.pop();continue;}
    if(number[edge.to])continue;
    parent[++count]=number[from];
    vertex[count]=edge.to;
    number[edge.to]=count;
    dfs.push(edge.to);
  }
  const semi=new Uint32Array(count+1),label=new Uint32Array(count+1),ancestor=new Uint32Array(count+1);
  const idom=new Uint32Array(count+1),buckets=new Uint32Array(count+1),nextBucket=new Uint32Array(count+1);
  for(let index=1;index<=count;index++)semi[index]=label[index]=index;
  const chain=[];
  function evaluate(index) {
    let current=index;
    while(ancestor[ancestor[current]]){
      chain.push(current);
      current=ancestor[current];
    }
    while(chain.length){
      const child=chain.pop(),above=ancestor[child];
      if(semi[label[above]]<semi[label[child]])label[child]=label[above];
      ancestor[child]=ancestor[above];
    }
    return label[index];
  }
  for(let index=count;index>=2;index--){
    const node=vertex[index];
    for(const edge of incoming[node]){
      if(++work%8192===0)await checkpoint(signal);
      const candidate=number[edge.from];
      if(candidate)semi[index]=Math.min(semi[index],semi[evaluate(candidate)]);
    }
    const previous=parent[index],bucket=semi[index];
    nextBucket[index]=buckets[bucket];buckets[bucket]=index;
    ancestor[index]=previous;
    for(let current=buckets[previous];current;current=nextBucket[current]){
      const above=evaluate(current);
      idom[current]=semi[above]<semi[current]?above:previous;
    }
    buckets[previous]=0;
  }
  const parentNode=new Uint32Array(nodes.length),retained=new Float64Array(nodes.length),retainedObjects=new Uint32Array(nodes.length);
  for(let index=2;index<=count;index++){
    if(index%8192===0)await checkpoint(signal);
    if(idom[index]!==semi[index])idom[index]=idom[idom[index]];
    const node=vertex[index];
    parentNode[node]=vertex[idom[index]];
    retained[node]=nodes[node].shallow;
    retainedObjects[node]=1;
  }
  for(let index=count;index>=2;index--){
    const node=vertex[index],above=parentNode[node];
    retained[above]+=retained[node];
    retainedObjects[above]+=retainedObjects[node];
  }
  return {parentNode,retained,retainedObjects,reachable:count-1};
}

async function analyzeHprof(bytes,{signal}={}) {
  const decoded=await parseHprof(bytes,{signal});
  const {nodes,outgoing,incoming,edgeCount,nonStrong,unresolvedReferences}=await references(decoded,signal);
  const {positions,idSize}=decoded;
  const graph=await dominators(nodes,outgoing,incoming,signal);
  const parents=await pathParents(outgoing,signal),types=new Map();
  const shallowTotal=nodes.reduce((sum,node)=>sum+(node?.shallow||0),0);
  const metrics={objects:nodes.length-1,reachable:graph.reachable,unreachable:nodes.length-1-graph.reachable,
    edges:edgeCount,roots:outgoing[0].length,excludedNonStrongReferences:nonStrong,unresolvedReferences,shallowPayloadBytes:shallowTotal,
    retainedPayloadBytes:graph.retained[0],idSize,fileBytes:bytes.length};
  const typeKey=node=>node.kind+' '+node.typeName;
  const ranked=[];
  for(let index=1;index<nodes.length;index++){
    if(index%8192===0)await checkpoint(signal);
    const node=nodes[index],group=typeKey(node);
    let type=types.get(group);
    if(!type){
      type={key:group,type:node.typeName,kind:node.kind,instances:0,shallowPayloadBytes:0,largestRetainedPayloadBytes:null,members:[]};
      types.set(group,type);
    }
    type.members.push(index);
    type.instances++;
    type.shallowPayloadBytes+=node.shallow;
    if(parents[index]){
      type.largestRetainedPayloadBytes=Math.max(type.largestRetainedPayloadBytes??0,graph.retained[index]);
      ranked.push(index);
    }
  }
  const compare=(left,right)=>graph.retained[right]-graph.retained[left]||
    graph.retainedObjects[right]-graph.retainedObjects[left]||left-right;
  ranked.sort(compare);
  const summary=index=>{
    const node=nodes[index],reachable=Boolean(parents[index]);
    return {address:address(node.id),type:node.typeName,kind:node.kind,shallowPayloadBytes:node.shallow,
      retainedPayloadBytes:reachable?graph.retained[index]:null,retainedObjects:reachable?graph.retainedObjects[index]:null,reachable};
  };
  function objects({type,limit=100}={}) {
    const count=Math.min(MAX_RESULTS,Math.max(1,Number.isSafeInteger(limit)?limit:100));
    const ordered=type?(types.get(type)?.members??[]).slice().sort(compare):ranked;
    return {total:ordered.length,rows:ordered.slice(0,count).map(summary)};
  }
  function inspect(key) {
    if(typeof key!=='string'||!ADDRESS.test(key))throw Error('Use an object ID from the inspected heap dump.');
    const id=idSize===8?BigInt(key):Number(key),index=positions.get(id);
    if(!index)throw Error('The object ID is absent from the inspected heap dump.');
    const path=[];
    let length=0,current=index,root=null;
    while(parents[current]){
      const edge=parents[current];
      if(length<MAX_SHOWN_PATH)path.push({object:summary(current),via:edge.label});
      length++;
      current=edge.from;
      if(!current){root=edge.label;break;}
    }
    const links=items=>({total:items.length,rows:items.slice(0,MAX_LINKS).map(edge=>({
      label:edge.label,object:summary(edge.from===index?edge.to:edge.from)
    }))});
    return {...summary(index),path: path.reverse(),pathLength:length,pathTruncated:length>MAX_SHOWN_PATH,root,
      dominator:graph.parentNode[index]?summary(graph.parentNode[index]):null,
      incoming:links(incoming[index].filter(edge=>edge.from!==0)),outgoing:links(outgoing[index]),
      unresolvedOutgoing:nodes[index].unresolved??0};
  }
  function classes({query='',limit=100}={}) {
    const count=Math.min(MAX_RESULTS,Math.max(1,Number.isSafeInteger(limit)?limit:100));
    const term=String(query).slice(0,256).toLowerCase();
    const sorted=[...types.values()].filter(item=>item.type.toLowerCase().includes(term)).sort((left,right)=>
      (right.largestRetainedPayloadBytes??-1)-(left.largestRetainedPayloadBytes??-1)||
      right.shallowPayloadBytes-left.shallowPayloadBytes||left.type.localeCompare(right.type));
    return {total:sorted.length,rows:sorted.slice(0,count).map(({members,...row})=>row)};
  }
  return {metrics,classes,objects,inspect};
}

module.exports={analyzeHprof};
