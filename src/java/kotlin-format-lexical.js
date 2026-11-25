'use strict';

function kotlinFormatSpans(text) {
  const protectedSpans = [], literalTokens = [];
  let offset = 0;
  const starts = value => text.startsWith(value,offset);
  const uncertain = () => { throw Error('Kotlin formatting requires complete, unambiguous comment and literal spans.'); };

  function blockComment() {
    offset += 2;
    let nested = 1;
    while (offset<text.length) {
      if (starts('/*')) { nested++; offset+=2; }
      else if (starts('*/')) {
        nested--;
        offset+=2;
        if (!nested) return;
      } else offset++;
    }
    uncertain();
  }

  function singleQuote(quote) {
    offset++;
    while (offset<text.length && text[offset]!=='\r' && text[offset]!=='\n') {
      if (text[offset]===quote) { offset++; return; }
      offset += quote==="'" && text[offset]==='\\' ? 2 : 1;
    }
    uncertain();
  }

  function string(depth,dollars=1) {
    if (depth>24) throw Error('Kotlin formatting exceeded its string template nesting limit.');
    const raw = starts('"""');
    offset += raw?3:1;
    const prefix = '$'.repeat(dollars), opening = prefix+'{';
    while (offset<text.length) {
      if (raw && starts('"""')) {
        while (text[offset]==='"') offset++;
        return;
      }
      if (!raw) {
        if (text[offset]==='"') { offset++; return; }
        if (text[offset]==='\\') { offset+=2; continue; }
        if (text[offset]==='\n' || text[offset]==='\r') uncertain();
      }
      if (starts(opening)) { offset+=opening.length; code(true,depth+1); }
      else if (starts(prefix+'`')) { offset+=prefix.length; singleQuote('`'); }
      else offset++;
    }
    uncertain();
  }

  function code(template,depth) {
    let braces = 0;
    while (offset<text.length) {
      const start = offset, char = text[offset];
      if (starts('//') || offset===0 && starts('#!')) {
        const next = text.indexOf('\n',offset);
        offset = next < 0 ? text.length : next;
        continue;
      }
      if (starts('/*')) {
        blockComment();
        if (!template) protectedSpans.push({start,end:offset});
        continue;
      }
      if (char==='"' || char==='\'' || char==='`' || char==='$') {
        if (char==='$') {
          while (text[offset]==='$') offset++;
          if (text[offset]!=='"') continue;
          const dollars = offset-start;
          if (dollars>16) uncertain();
          string(depth,dollars);
        } else if (char==='"') string(depth);
        else singleQuote(char);
        if (!template) {
          protectedSpans.push({start,end:offset});
          literalTokens.push(text.slice(start,offset));
        }
        continue;
      }
      if (template) {
        if (char==='{') braces++;
        if (char==='}') {
          if (!braces) { offset++; return; }
          braces--;
        }
      }
      offset++;
    }
    if (template) uncertain();
  }

  code(false,0);
  return {protectedSpans,literalTokens};
}

module.exports = {kotlinFormatSpans};
