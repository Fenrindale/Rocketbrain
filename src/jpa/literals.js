'use strict';

// Decode only literal (+ literal)* and parenthesized literal expressions. No
// variable lookup, evaluation, interpolation or executable Java is involved.
const whitespace = char => /[\t\n\f\r \v\u001c-\u001f\u1680\u2000-\u2006\u2008-\u200a\u2028\u2029\u205f\u3000]/u.test(char);
const SIMPLE = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', s: ' ', '"': '"', "'": "'", '\\': '\\' };

function unitsFor(token) {
  const raw = token.text, units = []; let consecutive = 0, lastUnicode = false;
  if (raw.length > 262144) return null;
  for (let i = 0; i < raw.length;) {
    const start = i; let char = raw[i++], unicode = false;
    if (char === '\\' && (lastUnicode || consecutive % 2 === 0) && raw[i] === 'u') {
      while (raw[i] === 'u') i++;
      const hex = raw.slice(i, i + 4); if (!/^[0-9a-f]{4}$/i.test(hex)) return null;
      char = String.fromCharCode(parseInt(hex, 16)); i += 4; unicode = true;
      // These can change token boundaries or subsequent escape eligibility.
      // They require whole-compilation-unit Unicode preprocessing, not a
      // per-literal decoder, and are deliberately not approximated here.
      if (['"', '\\', '\r', '\n'].includes(char)) return null;
    }
    units.push({ char, start: token.start + start, end: token.start + i });
    consecutive = char === '\\' ? consecutive + 1 : 0; lastUnicode = unicode;
  }
  return units;
}
function escapes(units, block) {
  const result = [];
  for (let i = 0; i < units.length; i++) {
    const first = units[i];
    if (first.char !== '\\') { if (!block && ['\n', '\r', '"'].includes(first.char)) return null; result.push(first); continue; }
    const next = units[++i]; if (!next) return null;
    if (next.char === '\n' && block) continue;
    let char;
    if (Object.hasOwn(SIMPLE, next.char)) char = SIMPLE[next.char];
    else if (/[0-7]/.test(next.char)) {
      let digits = next.char, maximum = /[0-3]/.test(next.char) ? 3 : 2;
      while (digits.length < maximum && /[0-7]/.test(units[i + 1]?.char || '')) digits += units[++i].char;
      char = String.fromCharCode(parseInt(digits, 8));
    } else return null;
    result.push({ char, start: first.start, end: units[i].end });
  }
  return result;
}
function textBlock(units) {
  if (units.slice(0, 3).map(item => item.char).join('') !== '"""' || units.slice(-3).map(item => item.char).join('') !== '"""') return null;
  let opening = 3; while ([' ', '\t', '\f'].includes(units[opening]?.char)) opening++;
  if (!['\r', '\n'].includes(units[opening]?.char)) return null;
  if (units[opening].char === '\r' && units[opening + 1]?.char === '\n') opening++;
  const content = units.slice(opening + 1, -3), normalized = [];
  for (let i = 0; i < content.length; i++) {
    const unit = content[i];
    if (unit.char === '\r') { const end = content[i + 1]?.char === '\n' ? content[++i].end : unit.end; normalized.push({ ...unit, char: '\n', end }); }
    else normalized.push(unit);
  }
  // Lexical validity is checked before stripIndent: stripping trailing spaces
  // must not turn an illegal backslash-space into a valid line continuation.
  for (let i = 0; i < normalized.length; i++) if (normalized[i].char === '\\') {
    const next = normalized[++i]?.char;
    if (next !== '\n' && !Object.hasOwn(SIMPLE, next) && !/^[0-7]$/.test(next || '')) return null;
  }
  const lines = [[]];
  for (const unit of normalized) { if (unit.char === '\n') { lines.at(-1).newline = unit; lines.push([]); } else lines.at(-1).push(unit); }
  let indent = Infinity;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]; let leading = 0; while (leading < line.length && whitespace(line[leading].char)) leading++;
    if (leading < line.length || i === lines.length - 1) indent = Math.min(indent, leading);
  }
  if (!Number.isFinite(indent)) indent = 0;
  const stripped = [];
  for (const line of lines) {
    let first = 0, last = line.length;
    while (first < last && first < indent && whitespace(line[first].char)) first++;
    while (last > first && whitespace(line[last - 1].char)) last--;
    for (let i = first; i < last; i++) stripped.push(line[i]); if (line.newline) stripped.push(line.newline);
  }
  return escapes(stripped, true);
}
function literal(token) {
  const units = unitsFor(token); if (!units) return null;
  if (token.kind === 'text-block') return textBlock(units);
  if (token.kind !== 'string' || units[0]?.char !== '"' || units.at(-1)?.char !== '"') return null;
  return escapes(units.slice(1, -1), false);
}
function decodeExpression(tokens) {
  if (!tokens?.length || tokens.length > 2048) return null;
  let cursor = 0, count = 0;
  function primary(depth) {
    if (depth > 32) return null;
    if (tokens[cursor]?.text === '(') { cursor++; const value = expression(depth + 1); if (!value || tokens[cursor++]?.text !== ')') return null; return value; }
    const token = tokens[cursor++]; if (!token || !['string', 'text-block'].includes(token.kind) || ++count > 256) return null;
    const decoded = literal(token); return decoded && decoded.length <= 16384 ? { units: decoded, literalKinds: [token.kind] } : null;
  }
  function expression(depth) {
    const value = primary(depth); if (!value) return null;
    while (tokens[cursor]?.text === '+') { cursor++; const next = primary(depth); if (!next) return null; value.units.push(...next.units); value.literalKinds.push(...next.literalKinds); if (value.units.length > 16384) return null; }
    return value;
  }
  const result = expression(0); if (!result || cursor !== tokens.length) return null;
  return { text: result.units.map(item => item.char).join(''), map: result.units.map(item => item.start), ends: result.units.map(item => item.end), literalKinds: result.literalKinds };
}

module.exports = { decodeExpression };
