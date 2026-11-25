'use strict';

const {positions}=require('./format-edits');
const {normalizeStructure}=require('./file-structure');
const {sourceLayout,analyzeSql}=require('../db/sql-analysis');

const sameSpan=(a,b)=>a.start===b.start&&a.end===b.end;
const contains=(parent,child)=>parent.start<=child.start&&parent.end>=child.end;
const valid=(span,length)=>Number.isSafeInteger(span?.start)&&Number.isSafeInteger(span?.end)&&span.start>=0&&
  span.end>span.start&&span.end<=length;
const spanSize=span=>span.end-span.start;

function protocolAncestors(text,response,point) {
  const result=[];
  const offset=positions(text);
  let prior={start:point,end:point},item=response;
  for (let depth=0;item&&depth<40;depth++,item=item.parent) {
    let span;
    try {span={start:offset(item.range?.start),end:offset(item.range?.end)};}
    catch {return [];}
    if (!valid(span,text.length)||!contains(span,prior)) return [];
    if (!sameSpan(span,prior)) result.push(span);
    prior=span;
  }
  return item?[]:result;
}

function identifierParts(text,range,point) {
  const value=text.slice(range.start,range.end);
  if (!/^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(value)) return [];
  const pieces=value.matchAll(/\p{Lu}+(?=\p{Lu}\p{Ll}|\d|[_$]|$)|\p{Lu}?\p{Ll}+[\p{M}]*|\p{N}+|[\p{L}\p{M}]+/gu);
  for (const piece of pieces) {
    const start=range.start+piece.index,end=start+piece[0].length;
    if (start<=point&&point<end && (start!==range.start||end!==range.end)) return [{start,end}];
  }
  return [];
}

function selectionLadder(text,initial,ancestors,point) {
  const nodes=ancestors.filter(span=>valid(span,text.length)&&contains(span,initial)).sort((a,b)=>spanSize(a)-spanSize(b));
  const owned=[];
  if(nodes[0])owned.push(...identifierParts(text,nodes[0],point));
  const result=[initial];
  for(const span of [...owned,...nodes]) {
    const last=result.at(-1);
    if(contains(span,last)&&!sameSpan(span,last))result.push(span);
  }
  return result;
}

function kotlinSelectionAncestors(text,response,points,sameFile) {
  const offset=positions(text,'Kotlin');
  const model=normalizeStructure(response,text,{language:'kotlin',sameFile});
  const declarations=model.rows.map(row=>({start:offset(row.range.start),end:offset(row.range.end)}));
  const identifiers=[...text.matchAll(/\x60[^\r\n\x60]+\x60|[\p{L}_$][\p{L}\p{M}\p{N}_$]*/gu)];
  return points.map(point=>{
    const result=declarations.filter(span=>span.start<=point&&point<=span.end);
    const token=identifiers.find(match=>match.index<=point&&point<match.index+match[0].length);
    if(token)result.push({start:token.index,end:token.index+token[0].length});
    return result;
  });
}

const SQL_CLAUSES=new Set(['SELECT','FROM','WHERE','GROUP','HAVING','ORDER','LIMIT','WINDOW','INTO','FOR','QUALIFY']);
const NON_FUNCTION=new Set([...SQL_CLAUSES,'IN','EXISTS','AS','ON','AND','OR','OVER','PARTITION','BY']);
const isIdentifier=token=>token?.kind==='word'||token?.kind==='identifier';
const isSymbol=(token,value)=>token?.kind==='symbol'&&token.value===value;

function sqlSelectionAncestors(text,point) {
  const {tokens,nonCode}=sourceLayout(text);
  let left=0,right=tokens.length;
  for(let at=0;at<tokens.length;at++) {
    if(!isSymbol(tokens[at],';'))continue;
    if(tokens[at].end<=point)left=at+1;
    else {right=at;break;}
  }
  if(!['SELECT','WITH'].includes(tokens[left]?.upper)||left>=right)return [];
  const start=tokens[left].start,end=tokens[right-1].end;
  const model=analyzeSql(text.slice(start,end));
  if(!model.scopes.length)return [];
  const result=[{start,end:tokens[right]?.end??end},{start,end}];
  const push=(from,to)=>{if(from!==undefined&&to!==undefined&&from<=point&&point<=to)result.push({start:from,end:to});};
  const index=tokens.findIndex((token,i)=>i>=left&&i<right&&token.start<=point&&point<token.end);
  push(tokens[index]?.start,tokens[index]?.end);
  for(const comment of nonCode)push(comment.start,comment.end);
  let begin=index,stop=index;
  if(isIdentifier(tokens[index])) {
    while(begin-2>=left&&isSymbol(tokens[begin-1],'.')&&isIdentifier(tokens[begin-2]))begin-=2;
    while(stop+2<right&&isSymbol(tokens[stop+1],'.')&&isIdentifier(tokens[stop+2]))stop+=2;
    push(tokens[begin].start,tokens[stop].end);
  }
  for(let at=left;at<right;at++) {
    const token=tokens[at],close=token.close;
    if(close===undefined||token.start>point||tokens[close].end<point)continue;
    push(tokens[at+1]?.start,tokens[close-1]?.end);
    push(token.start,tokens[close].end);
    const previous=tokens[at-1];
    if(at>left&&isIdentifier(previous)&&!NON_FUNCTION.has(previous.upper))push(previous.start,tokens[close].end);
  }
  const tokenIndex=new Map(tokens.map((token,index)=>[token.start,index]));
  for(const scope of model.scopes) {
    const from=scope.start+start,to=scope.end+start;
    if(from>point||point>to)continue;
    push(from,to);
    const first=tokenIndex.get(from);
    if(first===undefined)continue;
    const boundaries=[];
    let cursor=first;
    while(cursor<right&&tokens[cursor].end<=to) {
      const token=tokens[cursor];
      if(SQL_CLAUSES.has(token.upper))boundaries.push(cursor);
      cursor=token.close===undefined?cursor+1:token.close+1;
    }
    for(let at=0;at<boundaries.length;at++) {
      const head=boundaries[at],tail=(boundaries[at+1]??cursor)-1;
      if(head<tail)push(tokens[head+1].start,tokens[tail].end);
      push(tokens[head].start,tokens[tail].end);
    }
  }
  return result;
}

module.exports={protocolAncestors,selectionLadder,kotlinSelectionAncestors,sqlSelectionAncestors};
