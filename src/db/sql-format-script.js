'use strict';

const { sourceLayout } = require('./sql-analysis');

const programKinds = new Set(['PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT']);
const objectKinds = new Set([...programKinds, 'TABLE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'PACKAGE',
  'USER', 'ROLE', 'SEQUENCE', 'SERVER', 'TABLESPACE', 'SPATIAL', 'FULLTEXT', 'UNIQUE']);
const opens = new Set(['BEGIN', 'IF', 'CASE', 'LOOP', 'WHILE', 'REPEAT']);
const named = new Set(['BEGIN', 'LOOP', 'WHILE', 'REPEAT']);
const word = token => token?.kind === 'word' ? token.upper : '';
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const identifier = token => token?.kind === 'identifier' || token?.kind === 'word';
const mismatch = () => Error('Close or complete the stored-program block before formatting.');
const keywordText = (text, style) => style === 'upper' ? text.toUpperCase() : style === 'lower' ? text.toLowerCase() : text;

function layout(source, options) {
  return sourceLayout(source, { ...options, formatLayout: true });
}

function delimiterDirective(line) {
  const command = /^\uFEFF?[ \t]*DELIMITER(?=[ \t\r]|$)/i.exec(line);
  if (!command) return undefined;
  const next = /^[ \t]+([^ \t\r]+)[ \t]*\r?$/.exec(line.slice(command[0].length))?.[1];
  if (!next || !/^[!$%&*+,./:;<=>?@^_|~-][!$%&*+,./:;<=>?@^_|~\w-]{0,15}$/.test(next) ||
      /(?:--|\/\*|\*\/)/.test(next)) throw Error('Use a standalone DELIMITER directive between complete SQL statements.');
  return next;
}

function splitFormatScript(source, options) {
  const { tokens, nonCode } = layout(source, options);
  const protectedSpans = [...nonCode, ...tokens.filter(token => token.kind === 'identifier')].sort((a, b) => a.start - b.start);
  const statements = [], directives = [];
  let delimiter = ';', start = 0, hasCode = false, spanIndex = 0;
  function finish(end, terminated) {
    if (hasCode) {
      if (statements.length === 100) throw Error('Format at most 100 SQL statements.');
      statements.push({ start, end, delimiter, terminated });
    }
    start = end + (terminated ? delimiter.length : 0);
    hasCode = false;
  }

  for (let i = 0; i < source.length;) {
    if (i === 0 || source[i - 1] === '\n') {
      const newline = source.indexOf('\n', i);
      const eol = newline < 0 ? source.length : newline;
      const line = source.slice(i, eol);
      const next = delimiterDirective(line);
      if (next) {
        if (hasCode) throw Error('Use a standalone DELIMITER directive between complete SQL statements.');
        if (directives.length === 100) throw Error('Format at most 100 DELIMITER changes.');
        directives.push(line);
        delimiter = next;
        start = i = Math.min(eol + 1, source.length);
        continue;
      }
    }

    while (protectedSpans[spanIndex]?.end <= i) spanIndex++;
    const span = protectedSpans[spanIndex];
    if (span?.start === i) {
      if (source[i] === "'" || source[i] === '"' || source[i] === '`') hasCode = true;
      i = span.end;
    } else if (source.startsWith(delimiter, i)) {
      finish(i, true);
      i = start;
    } else {
      if (!/\s|\uFEFF/.test(source[i])) hasCode = true;
      i++;
    }
  }
  if (hasCode && delimiter !== ';') throw Error('Terminate each statement with the current DELIMITER.');
  finish(source.length, false);
  return { statements, directives };
}

const statementEnd = item => item.end + (item.terminated ? item.delimiter.length : 0);

function sourceForStatement(source, statement) {
  const end = statementEnd(statement);
  const selected = source.slice(statement.start,end);
  const sql = statement.delimiter === ';' ? selected :
    'DELIMITER ' + statement.delimiter + '\n' + selected + '\nDELIMITER ;';
  return { start: statement.start, end, sql, compound: statement.delimiter !== ';' };
}

function clientStatementAt(source, offset, options) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) {
    throw Error('Place the cursor inside a SQL statement.');
  }
  const { statements } = splitFormatScript(source, options);
  const statement = statements.find(item => offset >= item.start &&
    (offset < statementEnd(item) || (offset === source.length && offset === statementEnd(item))));
  if (!statement) throw Error('Place the cursor inside a SQL statement, outside the DELIMITER directives.');
  return sourceForStatement(source,statement);
}

function selectedClientStatement(source, { start,end }, options) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > source.length || start >= end) return;
  const text = source.slice(start,end);
  const first = start + text.length - text.trimStart().length;
  const last = start + text.trimEnd().length;
  const { statements } = splitFormatScript(source, options);
  const statement = statements.find(item => {
    if (item.delimiter === ';' || first < item.start || first >= item.end) return false;
    const body = source.slice(item.start,item.end);
    return first === item.start + body.length - body.trimStart().length &&
      (last === item.start + body.trimEnd().length || last === statementEnd(item));
  });
  if (statement) return sourceForStatement(source,statement);
}

function programHeader(tokens, dialect) {
  const first = labelIndex(tokens, 0);
  if (word(tokens[first]) === 'BEGIN' && word(tokens[first + 1]) === 'NOT' && word(tokens[first + 2]) === 'ATOMIC') {
    if (dialect !== 'mariadb') throw Error('BEGIN NOT ATOMIC requires the MariaDB formatting dialect.');
    return { anonymous: true, start: first, keywords: [first, first + 1, first + 2] };
  }
  if (word(tokens[0]) !== 'CREATE') return undefined;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (symbol(token, '(')) { i = token.close; continue; }
    const kind = word(token);
    if (!objectKinds.has(kind)) continue;
    if (kind === 'PACKAGE') throw Error('Package definitions are outside the supported stored-program formatting grammar.');
    if (!programKinds.has(kind)) return undefined;
    const start = tokens.findIndex((part, index) => index > i && word(part) === 'BEGIN');
    return { anonymous: false, start, keywords: [0, i] };
  }
  return undefined;
}

function labelIndex(tokens, index) {
  return identifier(tokens[index]) && symbol(tokens[index + 1], ':') && named.has(word(tokens[index + 2])) ? index + 2 : index;
}

function blockLayout(tokens, first, anonymous) {
  const lines = new Map(), blocks = [], keywords = new Set();
  const initial = first >= 2 && labelIndex(tokens, first - 2) === first ? first - 2 : first;
  let beginning = true, expressionCases = 0, declaring = false, handler = false, outerEnd;
  if (!anonymous) lines.set(initial, 0);

  for (let i = initial; i < tokens.length; i++) {
    const token = tokens[i];
    if (symbol(token, '(')) { i = token.close; continue; }
    const block = blocks.at(-1);
    const wordAt = word(token);
    if (expressionCases) {
      if (wordAt === 'CASE') expressionCases++;
      if (wordAt === 'END') expressionCases--;
      continue;
    }
    if (block?.pending && block.pending !== 'WHEN' && wordAt === block.pending) {
      keywords.add(i);
      block.pending = null;
      beginning = true;
      continue;
    }
    if (wordAt === 'CASE' && (!beginning || block?.pending)) { expressionCases++; continue; }

    if (block?.kind === 'CASE' && (wordAt === 'WHEN' || wordAt === 'ELSE') && (beginning || block.pending === 'WHEN')) {
      keywords.add(i);
      lines.set(i, block.depth + 1);
      block.pending = wordAt === 'WHEN' ? 'THEN' : null;
      beginning = wordAt === 'ELSE';
      continue;
    }
    if (block?.kind === 'IF' && beginning && (wordAt === 'ELSEIF' || wordAt === 'ELSE')) {
      keywords.add(i);
      lines.set(i, block.depth);
      block.pending = wordAt === 'ELSEIF' ? 'THEN' : null;
      beginning = wordAt === 'ELSE';
      continue;
    }
    if (wordAt === 'UNTIL' && beginning && block?.kind === 'REPEAT') {
      keywords.add(i);
      lines.set(i, block.depth + 1);
      block.until = true;
      beginning = false;
      continue;
    }
    if (wordAt === 'END' && (beginning || block?.until)) {
      if (!block || block.pending) throw mismatch();
      keywords.add(i);
      lines.set(i, block.depth);
      blocks.pop();
      if (block.kind !== 'BEGIN') {
        if (word(tokens[++i]) !== block.kind) throw mismatch();
        keywords.add(i);
      }
      if (!blocks.length && outerEnd === undefined) outerEnd = i;
      beginning = false;
      continue;
    }
    if (symbol(token, ';')) {
      if (block?.pending || block?.until) throw mismatch();
      beginning = true;
      declaring = handler = false;
      continue;
    }

    if (declaring && wordAt === 'HANDLER') handler = true;
    const handlerBlock = declaring && handler && wordAt === 'BEGIN';
    if (!beginning && !handlerBlock) continue;
    const depth = block ? block.depth + (block.kind === 'CASE' ? 2 : 1) : 0;
    if (i > initial) lines.set(i, depth);
    const opener = labelIndex(tokens, i);
    const kind = word(tokens[opener]);
    if (opens.has(kind)) {
      const pending = kind === 'IF' ? 'THEN' : kind === 'WHILE' ? 'DO' : kind === 'CASE' ? 'WHEN' : null;
      blocks.push({ kind, depth, pending });
      if (blocks.length > 16) throw Error('Format at most 16 stored-program block levels.');
      i = opener;
      keywords.add(i);
      if (kind === 'BEGIN' && word(tokens[i + 1]) === 'NOT' && word(tokens[i + 2]) === 'ATOMIC') {
        keywords.add(i + 1);
        i += 2;
        keywords.add(i);
      }
      beginning = !pending;
      declaring = handler = false;
    } else {
      if (!block || block.pending) throw mismatch();
      declaring = kind === 'DECLARE';
      beginning = false;
    }
  }
  if (blocks.length || expressionCases) throw mismatch();
  return { lines, keywords, outerEnd };
}

function compoundCreation(source, options) {
  const { tokens } = layout(source, options);
  const type = word(tokens[1]);
  if (word(tokens[0]) !== 'CREATE' || !['PROCEDURE', 'FUNCTION', 'TRIGGER'].includes(type)) return undefined;
  const header = programHeader(tokens, options.dialect);
  if (!header || header.start < 0) return undefined;
  const { outerEnd } = blockLayout(tokens, header.start, false);
  const label = labelIndex(tokens, header.start - 2) === header.start ? tokens[header.start - 2] : undefined;
  let next = outerEnd + 1;
  if (label && identifier(tokens[next]) && tokens[next].value.toLowerCase() === label.value.toLowerCase()) next++;
  if (symbol(tokens[next], ';')) next++;
  if (next !== tokens.length) throw Error('End the compound creation before including another SQL command.');
  return { type, tokens };
}

function tokenText(source, tokens, keywords, style) {
  return tokens.map((token, index) => {
    const text = source.slice(token.start, token.end);
    return [token.kind, keywords?.has(index) ? keywordText(text, style) : text];
  });
}

function formatProgram(source, options) {
  const { tokens } = layout(source, options);
  const header = programHeader(tokens, options.dialect);
  if (!header) return undefined;
  if (header.start < 0 && tokens.some(token => symbol(token, ';'))) throw mismatch();
  const { lines, keywords } = header.start < 0 ? { lines: new Map(), keywords: new Set() } :
    blockLayout(tokens, header.start, header.anonymous);
  for (const index of header.keywords) keywords.add(index);
  const pieces = [];
  let previous = 0;
  for (const [index, token] of tokens.entries()) {
    const depth = lines.get(index);
    const preceding = tokens[index - 1]?.end;
    if (depth !== undefined && /^[ \t\r\n]*$/.test(source.slice(preceding, token.start))) {
      pieces.push(source.slice(previous, preceding), options.eol, options.indent.repeat(depth));
      previous = token.start;
    }
    if (keywords.has(index) && options.keywordCase !== 'preserve') {
      pieces.push(source.slice(previous, token.start), keywordText(token.value, options.keywordCase));
      previous = token.end;
    }
  }
  pieces.push(source.slice(previous));
  const formatted = pieces.join('');
  if (JSON.stringify(tokenText(source, tokens, keywords, options.keywordCase)) !== JSON.stringify(tokenText(formatted, layout(formatted, options).tokens))) {
    throw Error('Formatting would change stored-program tokens.');
  }
  return formatted;
}

module.exports = { formatProgram, splitFormatScript, delimiterDirective, compoundCreation, clientStatementAt,
  selectedClientStatement, keywordText };
