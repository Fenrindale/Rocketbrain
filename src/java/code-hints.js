'use strict';

const {positions}=require('./format-edits');

const PARAMETER_MODES=new Set(['none','literals','all']);
const labelText=label=>typeof label==='string'?label:Array.isArray(label)?label.map(part=>part?.value).join(''):'';
const literal=/^[ \t]*([+-]?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9][0-9_]*)?)[uUlLfFdD]{0,2}|true|false|null|"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])')(?=\s*[,)]|$)/u;

function literalArgument(text,offset,language) {
  const match=literal.exec(text.slice(offset,offset+4096));
  return Boolean(match&&!(language==='kotlin'&&match[1].startsWith('"')&&/\$(?:\{|[\p{L}_])/u.test(match[1].replace(/\\./gu,''))));
}

function hintKind(hint,label,language) {
  if(hint.kind===1||hint.kind===2)return hint.kind;
  if(hint.kind!==undefined)return;
  if(/^[\p{L}_$][\p{L}\p{N}_$]*:\s*$/u.test(label))return 2;
  if(/^:\s*\S/u.test(label)||language==='java'&&/^[\w.$<>?\[\], \t]+$/u.test(label))return 1;
}

function filterInlayHints(hints,{text,range,language,parameters='literals',types=true}={}) {
  if(!Array.isArray(hints)||!PARAMETER_MODES.has(parameters))return [];
  const offset=positions(text),seen=new Set(),result=[];
  const start=offset(range.start),end=offset(range.end);
  for(const hint of hints.slice(0,1500)) {
    let at;
    try{at=offset(hint?.position);}catch{continue;}
    if(at<start||at>end)continue;
    const label=labelText(hint.label);
    if(!label.trim()||label.length>400||/[\x00-\x1f\x7f]/.test(label))continue;
    const kind=hintKind(hint,label,language);
    if(kind===1?!types:kind!==2||parameters==='none'||
      parameters==='literals'&&!literalArgument(text,at,language))continue;
    const key=at+':'+kind+':'+label;
    if(seen.has(key))continue;
    seen.add(key);
    result.push({label,kind,position:{line:hint.position.line,character:hint.position.character},
      paddingLeft:hint.paddingLeft===true,paddingRight:hint.paddingRight===true});
  }
  return result;
}

function semanticTokenAt(text,position,legend,data) {
  if(!Array.isArray(legend?.tokenTypes)||!Array.isArray(legend?.tokenModifiers)||
      !Array.isArray(data)&&!(data instanceof Uint32Array)||data.length>1000000||data.length%5)return null;
  const offset=positions(text);
  let anchor;
  try{anchor=offset(position);}catch{return null;}
  let line=0,column=0;
  for(let i=0;i<data.length;i+=5) {
    const [delta,start,length,kind,mask]=data.slice(i,i+5);
    if([delta,start,length,kind,mask].some(value=>!Number.isSafeInteger(value)||value<0)||length===0)return null;
    line+=delta;
    column=delta?start:column+start;
    if(line>position.line||line===position.line&&column>position.character)return null;
    if(line!==position.line||column+length<=position.character)continue;
    try{
      const from=offset({line,character:column}),to=offset({line,character:column+length});
      const type=legend.tokenTypes[kind];
      if(from>anchor||to<=anchor||typeof type!=='string'||!/^[\w.-]{1,80}$/.test(type))return null;
      const modifiers=legend.tokenModifiers.slice(0,32).filter((name,index)=>mask>>>index&1&&typeof name==='string'&&/^[\w.-]{1,80}$/.test(name));
      return {text:text.slice(from,to),type,modifiers,range:{start:{line,character:column},end:{line,character:column+length}}};
    }catch{return null;}
  }
  return null;
}

module.exports={PARAMETER_MODES,filterInlayHints,semanticTokenAt};
