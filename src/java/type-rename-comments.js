'use strict';

const path = require('node:path');
const { lexJava, rangeAt } = require('../spring/java');

const escape = value => value.replace(/[.*+?^\x24{}()|[\]\\]/gu,'\\$&');
const note = /^\/\/[ \t]*(?:TODO|NOTE)(?:[ \t]+|:[ \t]*)/u;
function sameJavaTokens(first, second) {
  const report = text => lexJava(text);
  const before = report(first), after = report(second);
  const tokens = value => value.tokens.map(({kind,text})=>[kind,text]);
  return !before.issues.length && !after.issues.length && JSON.stringify(tokens(before)) === JSON.stringify(tokens(after));
}

function commentGroups(sources, mandatory, oldFqn, newName, editedText) {
  const groups = [];
  const originalName = oldFqn.split('.').at(-1);
  const finalQualified = oldFqn.slice(0,-originalName.length)+newName;
  const byUri = new Map(mandatory.map(entry=>[entry.textDocument.uri,entry.edits]));
  for (const source of sources) {
    if (groups.length === 30) break;
    if (path.extname(source.file) !== '.java') continue;
    const { issues, lineComments } = lexJava(source.text,{collectLineComments:true});
    if (issues.length) continue;
    const primary = byUri.get(source.uri);
    const names = primary ? [oldFqn,originalName] : [oldFqn];
    const match = new RegExp('(?<![\\p{L}\\p{N}_.$])(?:'+names.map(escape).join('|')+
      ')(?![\\p{L}\\p{N}_$]|\\.[\\p{L}_$])', 'gu');
    const edits = [];
    comments: for (const comment of lineComments) {
      const heading = note.exec(comment.text);
      if (!heading) continue;
      for (const found of comment.text.slice(heading[0].length).matchAll(match)) {
        if (edits.length === 80) { edits.length = 0; break comments; }
        const start = comment.start + heading[0].length + found.index;
        edits.push({ range: rangeAt(source.text,start,start+found[0].length),
          newText: found[0] === oldFqn ? finalQualified : newName });
      }
    }
    if (!edits.length) continue;
    const mandatoryText = editedText(source.text,primary || []);
    const withComments = editedText(source.text,[...(primary || []),...edits]);
    if (!sameJavaTokens(mandatoryText,withComments)) throw Error('An optional comment would change Java code.');
    groups.push({ id:String(groups.length+1), uri:source.uri, edits,
      textDocument:{uri:source.uri,version:source.version ?? null} });
  }
  return groups;
}

function withCommentGroups(mandatory, selected) {
  const work = new Map(mandatory.map(entry=>[entry.textDocument.uri,entry]));
  for (const group of selected) {
    const required = work.get(group.uri);
    work.set(group.uri,{ textDocument: group.textDocument, edits:[...(required?.edits || []),...group.edits] });
  }
  return [...work.values()];
}

module.exports = { commentGroups, withCommentGroups, sameJavaTokens };
