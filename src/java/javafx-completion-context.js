'use strict';

const word = /^[$A-Z_a-z][\w$]*(?:\.[$A-Z_a-z][\w$]*)*$/u;
const imported = /^(?:[$A-Z_a-z][\w$]*\.)+(?:[$A-Z_a-z][\w$]*|\*)$/u;
const token = /^[\w$.:-]*/u;
const attribute = /^([\w$.:-]+)\s*=\s*(['"])([\s\S]*?)\2/u;

function completeTag(source, start) {
  let quote;
  for (let cursor = start; cursor < source.length; cursor++) {
    const char = source[cursor];
    if (quote) { if (char === quote) quote = undefined; }
    else if (char === '>' || char === '<') return cursor;
    else if (char === '"' || char === "'") quote = char;
  }
  return source.length;
}

function tagHole(source, start, cursor, parents) {
  const text = source.slice(start + 1, cursor);
  const head = token.exec(text)[0], afterTag = start + 1 + head.length;
  if (/^[\w$.]*$/u.test(text) && !text.includes('..')) {
    const after = token.exec(source.slice(cursor))[0];
    if (after.includes(':') || text.startsWith('.') || source[cursor] === '<') return;
    return {kind:'tag',start:start+1,end:cursor+after.length,prefix:text,parents:[...parents]};
  }
  if (!word.test(head) || !/^\s/u.test(source.slice(afterTag, cursor))) return;
  let offset = afterTag;
  const seen = new Set();
  while (offset < cursor) {
    const space = /^\s*/u.exec(source.slice(offset, cursor))[0];
    offset += space.length;
    const tail = source.slice(offset, cursor);
    const full = attribute.exec(tail);
    if (!full) break;
    if (seen.has(full[1])) return;
    seen.add(full[1]);
    offset += full[0].length;
    if (offset === cursor || !/\s/u.test(source[offset])) return;
  }
  const tail = source.slice(offset,cursor);
  const value = /^([a-zA-Z][\w]*)\s*=\s*(['"])([a-z]*)$/u.exec(tail);
  if (value) {
    const literal = new RegExp('^([a-z]*)' + value[2],'u').exec(source.slice(cursor));
    if (literal && !seen.has(value[1])) return {kind:'value',className:head,property:value[1],
      start:cursor-value[3].length,end:cursor+literal[1].length,prefix:value[3]};
    return;
  }
  if (!/^[a-z]?[\w]*$/u.test(tail) || /^[A-Z]/u.test(tail)) return;
  const after = source.slice(cursor,completeTag(source,cursor));
  const suffix = token.exec(after)[0];
  if (suffix.includes('.') || suffix.includes(':')) return;
  const equals = /^\s*=/u.test(after.slice(suffix.length));
  for (const match of after.slice(suffix.length).matchAll(/\s+([\w$.:-]+)\s*=\s*(['"])[\s\S]*?\2/gu)) seen.add(match[1]);
  return {kind:'property',className:head,start:offset,end:cursor+suffix.length,prefix:tail,seen,equals};
}

function fxmlCompletionContext(source, cursor) {
  if (typeof source !== 'string' || source.length > 512 * 1024 || !Number.isSafeInteger(cursor) ||
      cursor < 0 || cursor > source.length || /<!DOCTYPE|<!ENTITY/iu.test(source)) return;
  const imports = [], parents = [];
  let offset = 0, tags = 0, started = false;
  while (offset < cursor) {
    const open = source.indexOf('<',offset);
    if (open < 0 || open >= cursor || ++tags > 3000) return;
    const special = source.startsWith('<!--',open)?'-->':source.startsWith('<![CDATA[',open)?']]>':
      source.startsWith('<?',open)?'?>':undefined;
    if (special) {
      const close = source.indexOf(special,open+2);
      const entry = /^<\?import\s+([^\s?]*)/u.exec(source.slice(open,cursor));
      if (close < 0 || close >= cursor) {
        if (!started && entry && entry[0].length === cursor-open && special==='?>') {
          const suffix = token.exec(source.slice(cursor))[0];
          if (!suffix.includes(':')) return {kind:'import',start:cursor-entry[1].length,end:cursor+suffix.length,
            prefix:entry[1],imports};
        }
        return;
      }
      const full = /^<\?import\s+([^\s?]+)\s*\?>$/u.exec(source.slice(open,close+special.length));
      if (full && imported.test(full[1]) && imports.length<80 && !started) imports.push(full[1]);
      offset=close+special.length;
      continue;
    }
    const close=completeTag(source,open+1);
    if (close >= cursor) {
      if (started && !parents.length) return;
      const hole = tagHole(source,open,cursor,parents);
      return hole && {...hole,imports};
    }
    if (source[close] !== '>') return;
    const head = /^<(\/?)([\w$.:-]+)/u.exec(source.slice(open,close));
    if (!head || parents.length > 64) return;
    if (head[1]) {
      if (parents.pop() !== head[2]) return;
    } else {
      if (started && !parents.length) return;
      started = true;
      if (!/\/\s*>$/u.test(source.slice(open,close+1))) parents.push(head[2]);
    }
    offset=close+1;
  }
}

module.exports = { fxmlCompletionContext };
