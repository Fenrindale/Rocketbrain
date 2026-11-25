'use strict';

const MAX_SYMBOLS = 2500, MAX_DEPTH = 48;
const TYPES = new Set([5,10,11,19,23,26]);
const CALLABLES = new Set([6,9,12,24,25]);
const DATA = new Set([7,8,13,14,22]);
const GROUPS = Object.freeze({all:'All declarations',types:'Types',callables:'Methods and functions',members:'Fields and properties'});
const isWord = char => Boolean(char && /[\p{ID_Continue}$]/u.test(char));
const encloses = (outer,start,end) => outer.start<=start && end<=outer.end;

function sourcePositions(text) {
  const starts=[0], lines=text.split(/\r?\n/);
  for (const line of text.matchAll(/\r?\n/g)) starts.push(line.index+line[0].length);
  function offset(point) {
    if (!Number.isSafeInteger(point?.line) || !Number.isSafeInteger(point?.character) || point.line<0 || point.line>=lines.length ||
        point.character<0 || point.character>lines[point.line].length) return;
    return starts[point.line]+point.character;
  }
  function span(value) {
    const start=offset(value?.start),end=offset(value?.end);
    if (start===undefined || end===undefined || start>=end) return;
    return {start,end};
  }
  function point(value) {
    let left=0,right=starts.length-1;
    while(left<right) {
      const mid=Math.ceil((left+right)/2);
      if(starts[mid]<=value)left=mid;
      else right=mid-1;
    }
    return {line:left,character:value-starts[left]};
  }
  return {offset,span,range:(start,end)=>({start:point(start),end:point(end)})};
}

function shortName(value) {
  if (value.startsWith('`') && value.indexOf('`',1)>=0) return value.slice(1,value.indexOf('`',1));
  return value.split(/\s*[(<:]\s*/u,1)[0].trim();
}

function verifiedAnchor(text,span,raw,owner,language) {
  if (!span) return;
  if (language==='kotlin' && raw.name==='Companion' && raw.kind===5) {
    const head=/^\s*(companion[ \t]+object)\b/.exec(text.slice(span.start,Math.min(span.end,span.start+160)));
    if (head) return {start:span.start+head[0].indexOf(head[1]),end:span.start+head[0].length};
  }
  if (span.end-span.start>800) return;
  const selection=text.slice(span.start,span.end), selected=selection.trim(), name=raw.name.trim();
  const leading=selection.length-selection.trimStart().length;
  const exact=(part,at=leading)=>({start:span.start+at,end:span.start+at+part.length});
  const plain=selected.startsWith('`')&&selected.endsWith('`')?selected.slice(1,-1):selected;
  if (selected && (plain===name || plain===shortName(name))) {
    const bounds=exact(selected);
    const typeLeader=/\b(?:class|interface|record|enum|object|typealias)\s*$/u;
    const hasTypeLeader=!TYPES.has(raw.kind) || raw.kind===26 || typeLeader.test(text.slice(Math.max(0,bounds.start-160),bounds.start));
    const hasParameterList=!CALLABLES.has(raw.kind) || /^\s*\(/.test(text.slice(bounds.end,bounds.end+160));
    if (hasTypeLeader && hasParameterList && !isWord(text[bounds.start-1]) && !isWord(text[bounds.end])) return bounds;
  }
  if (raw.kind===4) {
    const pkg=/^\s*package\s+([\p{ID_Continue}.$]+)\s*;?\s*$/u.exec(selection);
    if (pkg?.[1]===name) return exact(pkg[1],pkg[0].indexOf(pkg[1],pkg[0].indexOf('package')+7));
  }
  if (language==='kotlin' && raw.kind===9 && shortName(owner||'')===name && selected.startsWith('(') && selected.endsWith(')')) {
    return exact(selected);
  }
}

function signature(text,selection,name,kind) {
  if (!CALLABLES.has(kind) || name.includes('(')) return '';
  const header=/^[ \t]*(\([^()\r\n]{0,160}\))/.exec(text.slice(selection.end,selection.end+165));
  return header?.[1] || '';
}

function normalizeStructure(raw,text,{language,sameFile}={}) {
  if (raw!=null && !Array.isArray(raw)) throw Error('The language server returned an invalid file structure.');
  const stats={received:0,skipped:0,recovered:0,duplicates:0,limited:false};
  const positions=sourcePositions(text), seen=new Set();
  function visit(values,depth,owner) {
    if (!Array.isArray(values)) return [];
    if (depth>MAX_DEPTH) { stats.limited=true; return []; }
    const output=[];
    for (const raw of values) {
      if (stats.received===MAX_SYMBOLS) { stats.limited=true; break; }
      stats.received++;
      if (!raw || typeof raw.name!=='string' || !raw.name.trim() || raw.name.length>400 || !Number.isInteger(raw.kind) || raw.kind<1 || raw.kind>26 ||
          raw.location && !sameFile?.(raw.location.uri)) { stats.skipped++; continue; }
      const name=raw.name.trim(), full=positions.span(raw.range||raw.location?.range);
      const selection=verifiedAnchor(text,positions.span(raw.selectionRange||raw.location?.range),raw,owner,language);
      const children=visit(raw.children,depth+1,name);
      if (!selection) { stats.skipped++; output.push(...children); continue; }
      const unique=raw.kind+'|'+selection.start+'|'+selection.end;
      if (seen.has(unique)) { stats.duplicates++; output.push(...children); continue; }
      seen.add(unique);
      const repaired=!full || !encloses(full,selection.start,selection.end);
      const span=repaired?selection:full;
      if (repaired) stats.recovered++;
      const childNodes=[], displaced=[];
      for (const child of children) {
        if (encloses(span,child.start,child.end)) childNodes.push(child);
        else displaced.push(child);
      }
      const detail=typeof raw.detail==='string'?raw.detail.trim().slice(0,240):'';
      output.push({name,kind:raw.kind,detail,signature:signature(text,selection,name,raw.kind),
        range:positions.range(span.start,span.end),selectionRange:positions.range(selection.start,selection.end),
        start:selection.start,end:selection.end,span,children:childNodes,repaired,
        deprecated:raw.deprecated===true || Array.isArray(raw.tags)&&raw.tags.includes(1),
        container:typeof raw.containerName==='string'?raw.containerName.slice(0,150):''},...displaced);
    }
    return output.sort((a,b)=>a.start-b.start||a.end-b.end);
  }
  const roots=visit(raw,0,'');
  const rows=[];
  function flatten(nodes,parents) {
    for (const node of nodes) {
      const path=parents.length?parents.join(' · '):node.container;
      rows.push({...node,id:rows.length,path,depth:parents.length});
      flatten(node.children,[...parents,node.name]);
    }
  }
  flatten(roots,[]);
  return {roots,rows,stats,positionOffset:positions.offset};
}

function filterStructure(rows,group='all') {
  if (!Object.hasOwn(GROUPS,group)) throw Error('Choose a file structure filter.');
  const kinds={types:TYPES,callables:CALLABLES,members:DATA}[group];
  return kinds ? rows.filter(row=>kinds.has(row.kind)) : rows;
}

function currentSymbol(rows,offset) {
  return rows.filter(row=>Number.isSafeInteger(offset)&&encloses(row.span,offset,offset)).sort((a,b)=>
    b.depth-a.depth || (a.span.end-a.span.start)-(b.span.end-b.span.start))[0];
}

module.exports = {GROUPS,normalizeStructure,filterStructure,currentSymbol};
