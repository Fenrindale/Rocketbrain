'use strict';

const {randomBytes}=require('node:crypto');
const {positions}=require('./format-edits');

const MAX_SIGNATURES=32,MAX_PARAMETERS=64,MAX_DOC=24000,MAX_LABEL=4096,TOTAL_DOC=96000;
const bounded=(value,max)=>typeof value==='string'?value.slice(0,max).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g,'').trim():'';

function documentation(value,budget) {
  const input=typeof value==='string'?value:value?.value,limit=Math.min(MAX_DOC,budget.remaining);
  if(typeof input==='string'&&input.length>limit)budget.limited=true;
  const text=bounded(input,limit);
  budget.remaining-=text.length;
  return text;
}

function normalizeHover(raw,text,point) {
  if(raw?.range) {
    const offset=positions(text);
    try {
      const start=offset(raw.range.start),end=offset(raw.range.end);
      if(start>=end||point<start||point>end)return null;
    }catch{return null;}
  }
  const values=Array.isArray(raw?.contents)?raw.contents:[raw?.contents];
  const budget={remaining:TOTAL_DOC};
  const parts=values.slice(0,12).map(value=>({text:documentation(value,budget),language:bounded(value?.language,24)})).filter(value=>value.text);
  return parts.length?{kind:'documentation',parts,limited:budget.limited===true||values.length>12}:null;
}

const validIndex=(index,length)=>Number.isSafeInteger(index)&&index>=0&&index<length;
function parameter(label,raw,budget) {
  let start,end;
  if(Array.isArray(raw?.label)&&raw.label.length===2) {
    [start,end]=raw.label;
    if(!validIndex(start,label.length)||!Number.isSafeInteger(end)||end<=start||end>label.length)start=end=undefined;
  } else if(typeof raw?.label==='string'&&raw.label) {
    const first=label.indexOf(raw.label);
    if(first>=0&&first===label.lastIndexOf(raw.label)){start=first;end=first+raw.label.length;}
  }
  const name=start===undefined?bounded(raw?.label,256):label.slice(start,end);
  return {name,start,end,documentation:documentation(raw?.documentation,budget)};
}

function normalizeSignatures(raw) {
  if(!Array.isArray(raw?.signatures)||!raw.signatures.length)return null;
  const activeSignature=raw.activeSignature??0;
  const signatures=[],budget={remaining:TOTAL_DOC};
  for(const [index,item] of raw.signatures.slice(0,MAX_SIGNATURES).entries()) {
    if(typeof item?.label!=='string'||!item.label.trim()||item.label.length>MAX_LABEL||
        /[\u0000-\u001f\u007f]/.test(item.label))continue;
    const doc=documentation(item.documentation,budget);
    const parameters=(Array.isArray(item.parameters)?item.parameters:[]).slice(0,MAX_PARAMETERS).map(value=>parameter(item.label,value,budget));
    const active=item.activeParameter??raw.activeParameter??0;
    signatures.push({label:item.label,active:index===activeSignature,activeParameter:validIndex(active,parameters.length)?active:undefined,
      documentation:doc,parameters});
  }
  return signatures.length?{kind:'signatures',signatures,limited:budget.limited===true||raw.signatures.length>MAX_SIGNATURES}:null;
}

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
function readable(text) {
  const blocks=[];
  let lines=[],code=false;
  function flush() {
    const value=lines.join('\n').trim();
    if(value) {
      const cleaned=value.replace(/\[([^\]\r\n]+)\]\([^\r\n]*?\)/g,'$1').replace(/^[-*_]{3,}\s*$/gm,'');
      blocks.push(code?'<pre><code>'+escape(value)+'</code></pre>':
        '<div class="documentation">'+escape(cleaned.trim())+'</div>');
    }
    lines=[];
  }
  for(const line of text.split('\n')) {
    if(/^\s*\x60\x60\x60[\w+-]*\s*$/.test(line)){flush();code=!code;}
    else lines.push(line);
  }
  flush();
  return blocks.join('');
}

function renderSignature(signature) {
  const active=signature.parameters[signature.activeParameter];
  const {label}=signature;
  const code=active?.start===undefined?escape(label):
    escape(label.slice(0,active.start))+'<mark>'+escape(label.slice(active.start,active.end))+'</mark>'+escape(label.slice(active.end));
  const parameterDocs=signature.parameters.filter(item=>item.documentation).map(item=>
    '<dt>'+escape(item.name)+'</dt><dd>'+readable(item.documentation)+'</dd>').join('');
  return '<details'+(signature.active?' open':'')+'><summary><code>'+code+'</code>'+
    (signature.active?'<span class="current">Current overload</span>':'')+'</summary>'+
    (signature.documentation?readable(signature.documentation):'<p class="muted">No documentation to display for this signature.</p>')+
    (parameterDocs?'<dl>'+parameterDocs+'</dl>':'')+'</details>';
}

function informationHtml(report) {
  const nonce=randomBytes(18).toString('base64url');
  const body=report.kind==='documentation'?report.parts.map(part=>part.language?'<pre><code>'+escape(part.text)+'</code></pre>':readable(part.text)).join(''):
    report.signatures.map(renderSignature).join('');
  const limited=report.limited?'<p class="muted">Some information exceeds the display limit.</p>':'';
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">'+
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'nonce-'+nonce+'\';">'+
    '<meta name="viewport" content="width=device-width, initial-scale=1">'+
    '<style nonce="'+nonce+'">body{background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);line-height:1.55;margin:0;padding:24px}main{max-width:70ch;margin:auto}details,pre{border:1px solid var(--vscode-panel-border);border-radius:4px;margin:0 0 14px;padding:12px}summary{cursor:pointer;overflow-wrap:anywhere}code{font-family:var(--vscode-editor-font-family);font-size:var(--vscode-editor-font-size)}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--vscode-textCodeBlock-background)}.documentation{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0}.current,.muted{color:var(--vscode-descriptionForeground)}.current{margin-left:8px;font-family:var(--vscode-font-family)}mark{background:var(--vscode-editor-selectionBackground);color:var(--vscode-editor-foreground);font-weight:bold}dt{font-weight:bold}dd{margin:0 0 10px 1em}</style>'+
    '</head><body><main>'+body+limited+'</main></body></html>';
}

module.exports={normalizeHover,normalizeSignatures,informationHtml};
