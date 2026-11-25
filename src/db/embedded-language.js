'use strict';

const { lexJava } = require('../spring/java');
const { decodeExpression } = require('../jpa/literals');
const { parseXml } = require('../jpa/xml');
const { sourceTokens } = require('./sql-analysis');
const { decodeLiteral } = require('./schema-program-paths');
const { literal: encodeSqlLiteral } = require('./schema-designer-ddl');

const limit = 16384;
const javaLanguages = new Set(['sql', 'json', 'regex', 'html']);
const mapperStatements = new Set(['select', 'insert', 'update', 'delete', 'sql']);
const unicodeWarning = 'Java Unicode pre-lexing escapes are not fully modeled';

function validateValue(text, language) {
  if (typeof text !== 'string' || !text.isWellFormed() || text.length > limit || text.includes('\0')) {
    throw Error('Use text up to 16,384 characters without NUL or unpaired surrogates.');
  }
  if (['sql', 'json'].includes(language) && !text.trim()) throw Error('Enter a nonempty SQL or JSON fragment.');
  if (language === 'json') {
    try { JSON.parse(text); }
    catch { throw Error('Fix the JSON syntax before applying it to the original source.'); }
  }
}

function javaSnippet(text, offset) {
  const { tokens, issues } = lexJava(text);
  const activeUnicode = /(?:^|[^\\])(?:\\\\)*\\u+[0-9a-f]{4}/i.test(text);
  if (activeUnicode || /\r(?!\n)/.test(text) || issues.some(issue => issue !== unicodeWarning)) {
    throw Error('Java string boundaries are uncertain. Fix source tokenization first.');
  }
  const token = tokens.find(item => ['string', 'text-block'].includes(item.kind) && item.start <= offset && offset < item.end);
  if (!token) throw Error('Place the cursor inside one Java string literal or text block.');
  const decoded = decodeExpression([token]);
  if (!decoded) throw Error('This Java literal uses unsupported escaping.');
  return { ...decoded, start: token.start, end: token.end, kind: token.kind };
}

function normalizeXmlPart(source, part) {
  const { text, map, ends } = part;
  let normalized = '';
  const mapped = [], mappedEnds = [];
  for (let i = 0; i < text.length; i++) {
    let end = ends[i], char = text[i];
    const start = map[i];
    if (char === '\r' && source[start] === '\r') {
      char = '\n';
      if (text[i + 1] === '\n' && source[end] === '\n') end = ends[++i];
    }
    normalized += char;
    mapped.push(start);
    mappedEnds.push(end);
  }
  return { ...part, text: normalized, map: mapped, ends: mappedEnds };
}

function mapperSnippet(text, offset) {
  const mapper = parseXml({ text }, { mapper: true });
  const statement = mapper.children.find(node => mapperStatements.has(node.name) && node.start <= offset && offset < node.end);
  if (!statement) throw Error('Place the cursor in a MyBatis mapper SQL statement or reusable SQL fragment.');
  const parts = statement.parts.filter(part => part.text.trim());
  if (statement.children.length || parts.length !== 1 || /(?:#|\$)\{/.test(parts[0]?.text ?? '')) {
    throw Error('Open one static MyBatis SQL fragment. Dynamic tags, includes and mapper placeholders need their original context.');
  }
  const part = parts[0];
  if (offset < part.start || offset >= part.end) throw Error('Place the cursor inside the mapper SQL text.');
  return normalizeXmlPart(text, part);
}

function sqlSnippet(text, offset, sqlMode) {
  if (!Array.isArray(sqlMode)) throw Error('Connect to the applicable MySQL or MariaDB database to read its SQL string mode.');
  const tokens = sourceTokens(text, { sqlMode });
  const index = tokens.findIndex(token => token.kind === 'string' && token.start <= offset && offset < token.end);
  const token = tokens[index];
  if (!token || text[token.start] !== "'" || [tokens[index - 1], tokens[index + 1]].some(item => item?.kind === 'string')) {
    throw Error('Place the cursor inside one single-quoted SQL JSON literal.');
  }
  const value = text.slice(token.start, token.end);
  const decoded = decodeLiteral({ value }, sqlMode.includes('NO_BACKSLASH_ESCAPES'));
  return { start: token.start, end: token.end, kind: 'sql-literal', text: decoded, sqlMode: [...sqlMode].sort() };
}

function inspectEmbedded(hostLanguage, language, text, offset, sqlMode) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || !Number.isInteger(offset) || offset < 0 || offset >= text.length) {
    throw Error('Open a supported source of up to one MiB and place the cursor inside its fragment.');
  }
  let snippet;
  if (hostLanguage === 'java' && javaLanguages.has(language)) snippet = javaSnippet(text, offset);
  else if (hostLanguage === 'xml' && language === 'sql') snippet = mapperSnippet(text, offset);
  else if (hostLanguage === 'sql' && language === 'json') snippet = sqlSnippet(text, offset, sqlMode);
  else throw Error('Choose a supported Java, MyBatis or SQL fragment.');
  validateValue(snippet.text, language);
  return { ...snippet, hostLanguage, language, original: text.slice(snippet.start, snippet.end) };
}

function javaString(text) {
  return JSON.stringify(text).replace(/\\u00([0-1][0-9a-f])/g, (escape, hex, offset, encoded) => {
    let backslashes = 0;
    for (let i = offset - 1; encoded[i] === '\\'; i--) backslashes++;
    return backslashes % 2 ? escape : '\\' + parseInt(hex, 16).toString(8).padStart(3, '0');
  });
}

function javaTextBlock(text, original) {
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]*)"""$/.exec(original)?.[1] ?? '';
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();
  const encoded = lines.map(line => {
    const value = javaString(line).slice(1, -1);
    return indent + value.replace(/ +$/, whitespace => '\\s'.repeat(whitespace.length));
  }).join(eol);
  return '"""' + eol + encoded + (trailingNewline ? '' : '\\') + eol + indent + '"""';
}

function replacementFor(snippet, text) {
  validateValue(text, snippet.language);
  if (text === snippet.text) return snippet.original;
  if (['text', 'cdata'].includes(snippet.kind) && /[\x01-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/u.test(text)) {
    throw Error('This value contains characters that XML 1.0 cannot store.');
  }
  switch (snippet.kind) {
    case 'string':
      return javaString(text);
    case 'text-block':
      return ['regex', 'html'].includes(snippet.language) ? javaTextBlock(text, snippet.original) : javaString(text);
    case 'text':
      return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\r', '&#13;');
    case 'cdata':
      if (text.includes(']]>') || text.includes('\r')) throw Error('This value cannot be stored in one XML CDATA section.');
      return text;
    case 'sql-literal':
      return encodeSqlLiteral(text, { sqlMode: snippet.sqlMode.join(',') });
    default:
      throw Error('This embedded language host is unsupported.');
  }
}

function projectionRange(snippet, start, end) {
  if (snippet.hostLanguage !== 'java' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > snippet.text.length) throw Error('Choose a valid range in the original Java fragment.');
  const position = snippet.map[start] ?? snippet.ends.at(-1) ?? snippet.start + (snippet.kind === 'string' ? 1 : 3);
  return { start: position, end: start === end ? position : snippet.ends[end - 1] };
}

module.exports = { inspectEmbedded, replacementFor, projectionRange };
