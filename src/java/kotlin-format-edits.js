'use strict';

const {buildFormatEdits,positions} = require('./format-edits');
const {kotlinFormatSpans} = require('./kotlin-format-lexical');
const {editedText} = require('./refactoring');
const {singleEdit} = require('./extract-value');

const kotlinFormatterOptions = style => ({insertSpaces:true,tabSize:style.indentSize});
const leading = /^([ \t]*)(?=\S)/;

function columns(prefix,width) {
  let column=0;
  for (const char of prefix) column += char==='\t'?width-column%width:1;
  return column;
}

function renderLeading(text,spans,{insertSpaces,tabWidth},eol,from,to,base) {
  let offset=0, spanIndex=0;
  return text.split(eol).map(line => {
    const start=offset, prefix=leading.exec(line)?.[1];
    offset += line.length+eol.length;
    while (spans[spanIndex]?.end<=start) spanIndex++;
    const inside=spans[spanIndex]?.start<start;
    if (prefix===undefined || inside || start<from || start+prefix.length>to) return line;
    const size=base+columns(prefix,tabWidth);
    const indent=insertSpaces?' '.repeat(size):'\t'.repeat(Math.floor(size/tabWidth))+' '.repeat(size%tabWidth);
    return indent+line.slice(prefix.length);
  }).join(eol);
}

function kotlinSelection(text,requested,spans,eol) {
  if (!requested) return {from:0,to:text.length};
  const offset=positions(text,'Kotlin'), from=offset(requested.start), to=offset(requested.end);
  const endsLine=to===text.length || requested.end.character===0 || text.startsWith(eol,to);
  const cutsProtected=spans.some(({start,end})=>start<from&&from<end || start<to&&to<end);
  if (requested.start.character!==0 || !endsLine || from>=to || cutsProtected) {
    throw Error('Select complete Kotlin lines containing a statement or block. Keep strings and block comments whole.');
  }
  return {from,to};
}

function buildKotlinFormatEdits(before,requested,raw,style,eol) {
  const initial=kotlinFormatSpans(before);
  const {from,to}=kotlinSelection(before,requested,initial.protectedSpans,eol);
  const checked=buildFormatEdits(before,requested,raw,{...style,insertSpaces:true},eol,'Kotlin');
  const suffix=before.slice(to), prefix=before.slice(0,from);
  let formatted=editedText(before,checked), base=0;
  if (requested && checked.length) {
    const old=before.slice(from,to), oldIndent=old.split(eol).map(line=>leading.exec(line)?.[1]).find(value=>value!==undefined);
    base=columns(oldIndent || '',style.tabWidth);
    let text=formatted.slice(from,formatted.length-suffix.length);
    while (text.endsWith(eol)) text=text.slice(0,-eol.length);
    if (old.endsWith(eol) && text) text+=eol;
    formatted=prefix+text+suffix;
  }
  const output=kotlinFormatSpans(formatted);
  if (JSON.stringify(output.literalTokens)!==JSON.stringify(initial.literalTokens)) {
    throw Error('The Kotlin formatter changed a string or character token. Choose a narrower formatting range.');
  }
  const result=(!style.insertSpaces || base) ? renderLeading(formatted,output.protectedSpans,style,eol,from,formatted.length-suffix.length,base) : formatted;
  if (!result.startsWith(prefix) || !result.endsWith(suffix)) throw Error('The Kotlin formatter changed text outside the selected lines.');
  return before===result ? [] : [singleEdit(before,result)];
}

module.exports = {kotlinFormatterOptions,buildKotlinFormatEdits};
