'use strict';

const {editedText} = require('./refactoring');
const {lexJava,rangeAt} = require('../spring/java');
const {singleEdit} = require('./extract-value');

const MAX_EDITS = 4000;

const lineEnding = (text,eol) => text.replace(/\r?\n/g,eol);
const protocolRange = ({start,end}) => ({start:{line:start.line,character:start.character},end:{line:end.line,character:end.character}});
const mixedTabs = style => !style.insertSpaces && style.indentSize !== style.tabWidth;

function formatterOptions(style) {
  return {insertSpaces:style.insertSpaces || mixedTabs(style),tabSize:style.indentSize};
}

function positions(text,language='Java') {
  const starts = [0], ends = [];
  for (const match of text.matchAll(/\r?\n/g)) {
    ends.push(match.index);
    starts.push(match.index+match[0].length);
  }
  ends.push(text.length);
  return ({line,character}={}) => {
    if (!Number.isSafeInteger(line) || !Number.isSafeInteger(character) || line<0 || line>=starts.length ||
        character<0 || character>ends[line]-starts[line]) throw Error('The formatter returned a position outside the '+language+' source.');
    return starts[line]+character;
  };
}

function renderTabStops(text,eol,style,from,to) {
  const {tokens,issues} = lexJava(text);
  if (issues.length) throw Error('Split Java indentation and tab widths require source without ambiguous lexical escapes.');
  const literalRows = new Set();
  for (const token of tokens.filter(token=>token.kind==='text-block')) {
    const {start,end} = rangeAt(text,token.start,token.end);
    for (let line=start.line+1;line<=end.line;line++) literalRows.add(line);
  }
  let start = 0, disabled = false;
  return text.split(eol).map((line,row) => {
    const prefix = /^ +(?=\S)/.exec(line)?.[0], offset = start;
    start += line.length+eol.length;
    const marker = /^\s*(?:\/\/|\/\*)\s*@formatter:(off|on)\b/.exec(line);
    if (marker) disabled = marker[1]==='off';
    if (marker || disabled || literalRows.has(row) || !prefix || offset<from || offset+prefix.length>to) return line;
    const tabCount = Math.floor(prefix.length/style.tabWidth);
    return '\t'.repeat(tabCount)+' '.repeat(prefix.length%style.tabWidth)+line.slice(prefix.length);
  }).join(eol);
}

function buildFormatEdits(before,requested,raw,style,eol,language='Java') {
  if (!Array.isArray(raw) || raw.length>MAX_EDITS) throw Error('The formatter returned an invalid or excessive '+language+' edit set.');
  const offset = positions(before,language);
  const from = requested ? offset(requested.start) : 0, to = requested ? offset(requested.end) : before.length;
  if (to<from) throw Error('Select an ordered '+language+' formatting range.');
  const edits = raw.map(change => {
    if (typeof change?.newText!=='string' || change.annotationId!==undefined || change.newEol!==undefined) {
      throw Error('The formatter returned an invalid '+language+' text edit.');
    }
    const start = offset(change.range?.start), end = offset(change.range?.end), range = protocolRange(change.range);
    if (start<from || end>to || start>end) throw Error('The formatter would change source outside the selected '+language+' range. Select the complete statement or block.');
    return {range,newText:lineEnding(change.newText,eol)};
  });
  const formatted = editedText(before,edits);
  const result = mixedTabs(style) ? renderTabStops(formatted,eol,style,from,formatted.length-(before.length-to)) : formatted;
  if (requested && (result.slice(0,from)!==before.slice(0,from) || !result.endsWith(before.slice(to)))) {
    throw Error('The formatter changed source outside the selected '+language+' range.');
  }
  if (result===before) return [];
  return mixedTabs(style) ? [singleEdit(before,result)] : edits;
}

module.exports = {lineEnding,protocolRange,positions,formatterOptions,buildFormatEdits};
