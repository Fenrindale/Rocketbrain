'use strict';

const { editedText } = require('./refactoring');
const { sourcePosition } = require('./structural-search');

function hierarchyCatalog(compiler) {
  if (!Array.isArray(compiler?.classes) || !Array.isArray(compiler.files)) {
    throw Error('The Java compiler did not produce a hierarchy proof.');
  }
  return {
    classes:new Map(compiler.classes.map(item => [item.id,item])),
    files:new Map(compiler.files.map(item => [item.uri,item.events]))
  };
}

function hierarchyCandidates(compiler,{uri,offset,direction}) {
  if (!['pull','push'].includes(direction) || !Number.isSafeInteger(offset) || offset < 0) {
    throw Error('Select a Java class and Pull Up or Push Down.');
  }
  const { classes } = hierarchyCatalog(compiler);
  const units = [...classes.values()].filter(item => item.uri === uri);
  const primary = units.filter(item => item.plain);
  const source = units.filter(item => item.start <= offset && offset < item.end)
    .sort((a,b) => b.start - a.start || a.end - b.end)[0] || (primary.length === 1 ? primary[0] : undefined);
  if (!source?.plain) throw Error('Select a plain top-level Java class with a nongeneric superclass.');
  const targets = [...classes.values()].filter(item => item.plain && item.package === source.package &&
    (direction === 'pull' ? item.id === source.superclass : item.superclass === source.id));
  if (!targets.length) throw Error('Choose a direct same-package superclass or subclass with observed Java source.');
  const members = source.members.filter(member => member.movable);
  if (!members.length) throw Error('No concrete instance methods or compile-time constants are eligible in this class.');
  return {source,targets,members};
}

function classFamily(classes,source,target) {
  return [...classes.values()].filter(item => item.id === source.id || item.id === target.id ||
    item.ancestors.includes(source.id) || item.ancestors.includes(target.id) ||
    source.ancestors.includes(item.id) || target.ancestors.includes(item.id));
}

const keyMovedTo = (key,oldOwner,newOwner) => {
  const prefix = key.slice(0,2) + oldOwner + '#';
  if (!key.startsWith(prefix)) throw Error('The compiler did not bind that member to its source class.');
  return key.slice(0,2) + newOwner + '#' + key.slice(prefix.length);
};
const inMember = (event,member) => event.start >= member.start && event.end <= member.end;

function formatMember(text,member,indent,eol) {
  const start = member.commentStart, sourceLine = text.lastIndexOf('\n',start-1) + 1;
  const before = text.slice(sourceLine,start);
  const originalIndent = /^[ \t]*$/.test(before) ? before : '';
  const raw = text.slice(start,member.end);
  const lines = raw.split(/\r?\n/);
  // Reindent only ordinary source. Text blocks are refused because indentation can change data.
  return lines.map((line,index) => index && !line ? '' :
    indent + (index && line.startsWith(originalIndent) ? line.slice(originalIndent.length) : line)).join(eol);
}

function elementRemoval(text,member) {
  const line = text.lastIndexOf('\n',member.commentStart-1) + 1, next = text.indexOf('\n',member.end);
  const alone = !text.slice(line,member.commentStart).trim() && !text.slice(member.end,next < 0 ? text.length : next).trim();
  return {start:alone ? line : member.commentStart,end:alone && next >= 0 ? next + 1 : member.end};
}

function targetInsertion(target,text) {
  const close = target.end - 1;
  if (text[close] !== '}') throw Error('The destination class body cannot be edited precisely.');
  const line = text.lastIndexOf('\n',close-1) + 1, closingIndent = text.slice(line,close);
  const alone = /^[ \t]*$/.test(closingIndent);
  const first = target.members.find(item => item.commentStart > target.start);
  const firstLine = first && text.lastIndexOf('\n',first.commentStart-1) + 1;
  const memberIndent = first ? text.slice(firstLine,first.commentStart) : '';
  const indent = memberIndent && /^[ \t]*$/.test(memberIndent) ? memberIndent : (alone ? closingIndent : '') + '    ';
  return {pos:alone ? line : close,needsLeadingLine:!alone,indent,eol:text.includes('\r\n') ? '\r\n' : '\n'};
}

function hierarchyEdits(compiler,sources,{uri,offset,direction,targetId,memberIds}) {
  const catalog = hierarchyCatalog(compiler);
  const {source,targets,members} = hierarchyCandidates(compiler,{uri,offset,direction});
  const target = targets.find(item => item.id === targetId);
  if (!target) throw Error('Choose a direct source hierarchy destination from this review.');
  if (!Array.isArray(memberIds) || !memberIds.length || memberIds.length > 16 ||
      new Set(memberIds).size !== memberIds.length) throw Error('Select up to 16 distinct Java members.');
  const chosen = members.filter(member => memberIds.includes(member.key)).sort((a,b) => a.start - b.start);
  if (chosen.length !== memberIds.length) throw Error('Select only supported members from the reviewed class.');
  const sourceFile = sources.find(item => item.uri === source.uri), destinationFile = sources.find(item => item.uri === target.uri);
  if (!sourceFile || !destinationFile) throw Error('Both inheritance endpoints need saved Java source.');
  const family = classFamily(catalog.classes,source,target);
  for (const member of chosen) {
    if (source.inheritedSlots.includes(member.slot) || target.inheritedSlots.includes(member.slot) && direction !== 'push' ||
        family.some(item => item.members.some(other => other.slot === member.slot && other.key !== member.key))) {
      throw Error('The hierarchy already declares or overrides ' + member.name + ' with the same slot.');
    }
    if (source.members.some(other => other.key !== member.key && other.start < member.end && member.start < other.end)) {
      throw Error('Select standalone Java member declarations.');
    }
    const body = sourceFile.text.slice(member.start,member.end);
    if (body.includes('"""') || member.constant !== null && !body.trimEnd().endsWith(';')) {
      throw Error('Text blocks and shared field declarations cannot be moved through the hierarchy.');
    }
    if (catalog.files.get(source.uri).some(event => inMember(event,member) && event.receiver)) {
      throw Error('The selected member uses an explicit this or super receiver.');
    }
  }
  const insertion = targetInsertion(target,destinationFile.text);
  const inserted = (insertion.needsLeadingLine ? insertion.eol : '') +
    chosen.map(member => formatMember(sourceFile.text,member,insertion.indent,insertion.eol)).join(insertion.eol+insertion.eol) +
    insertion.eol;
  if (Buffer.byteLength(inserted) > 128 * 1024) throw Error('Review at most 128 KiB of moved Java declarations.');
  const changes = Object.create(null);
  function add(file,start,end,newText) {
    (changes[file.uri] ||= []).push({
      range:{start:sourcePosition(file.text,start),end:sourcePosition(file.text,end)},newText
    });
  }
  for (const member of chosen) {
    const {start,end} = elementRemoval(sourceFile.text,member);
    add(sourceFile,start,end,'');
  }
  add(destinationFile,insertion.pos,insertion.pos,inserted);
  const updated = sources.map(file => changes[file.uri] ? {...file,text:editedText(file.text,changes[file.uri])} : file);
  return {source,target,chosen,changes,updated};
}

function verifyHierarchyBindings(before,after,move) {
  const original = hierarchyCatalog(before), proposed = hierarchyCatalog(after);
  const afterSource = proposed.classes.get(move.source.id), afterTarget = proposed.classes.get(move.target.id);
  if (!afterSource || !afterTarget || afterTarget.superclass !== move.target.superclass ||
      afterSource.superclass !== move.source.superclass || original.files.size !== proposed.files.size) {
    throw Error('The prospective edit changed the observed Java hierarchy.');
  }
  const remapped = new Map(), relocated = new Map();
  for (const member of move.chosen) {
    const key = keyMovedTo(member.key,move.source.id,move.target.id);
    const target = afterTarget.members.find(item => item.key === key && item.type === member.type && item.constant === member.constant);
    if (!target || afterSource.members.some(item => item.key === member.key)) {
      throw Error('Javac did not observe the same selected member at its new declaration.');
    }
    remapped.set(member.key,key);
    relocated.set(member.key,target);
  }
  const stableType = value => value.replace(/capture#\d+/g,'capture');
  const compare = (left,right,description) => {
    if (left.length !== right.length) throw Error('The hierarchy move changed compiler bindings in ' + description + '.');
    for (let i=0; i<left.length; i++) {
      const first = left[i],second = right[i];
      if (first.kind !== second.kind || (remapped.get(first.key) || first.key) !== second.key ||
          stableType(first.type) !== stableType(second.type)) {
        throw Error('The hierarchy move would rebind a Java reference in ' + description + '.');
      }
    }
    return left.length;
  };
  let movedReferences = 0, otherReferences = 0;
  for (const member of move.chosen) {
    movedReferences += compare(original.files.get(member.uri).filter(event => inMember(event,member)),
      proposed.files.get(move.target.uri).filter(event => inMember(event,relocated.get(member.key))),member.name);
  }
  const targetMembers = [...relocated.values()];
  for (const [uri,events] of original.files) {
    const afterEvents = proposed.files.get(uri);
    if (!afterEvents) throw Error('A Java source disappeared from the prospective hierarchy.');
    otherReferences += compare(events.filter(event => uri !== move.source.uri || !move.chosen.some(member => inMember(event,member))),
      afterEvents.filter(event => uri !== move.target.uri || !targetMembers.some(member => inMember(event,member))),
      'a retained source');
  }
  return { movedReferences,otherReferences };
}

module.exports = { hierarchyCandidates, hierarchyEdits, verifyHierarchyBindings };
