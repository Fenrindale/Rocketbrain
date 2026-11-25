'use strict';

const { lexJava, parseJavaFile, literal, rangeAt } = require('../spring/java');
const { decodeExpression } = require('../jpa/literals');

const nativeQuery = 'org.springframework.data.jpa.repository.Query';
const nativeAnnotations = new Map([
  ['org.springframework.data.jpa.repository.NativeQuery', 'value'],
  ['jakarta.persistence.NamedNativeQuery', 'query'],
  ['javax.persistence.NamedNativeQuery', 'query']
]);
const receivers = new Map([
  ['org.springframework.jdbc.core.JdbcTemplate', new Set(['query', 'queryForObject', 'queryForList', 'queryForMap', 'queryForRowSet', 'update', 'execute'])],
  ['org.springframework.jdbc.core.JdbcOperations', new Set(['query', 'queryForObject', 'queryForList', 'queryForMap', 'queryForRowSet', 'update', 'execute'])],
  ['org.springframework.jdbc.core.namedparam.NamedParameterJdbcTemplate', new Set(['query', 'queryForObject', 'queryForList', 'queryForMap', 'queryForRowSet', 'update', 'execute'])],
  ['org.springframework.jdbc.core.namedparam.NamedParameterJdbcOperations', new Set(['query', 'queryForObject', 'queryForList', 'queryForMap', 'queryForRowSet', 'update', 'execute'])],
  ['jakarta.persistence.EntityManager', new Set(['createNativeQuery'])],
  ['javax.persistence.EntityManager', new Set(['createNativeQuery'])]
]);
const candidateCalls = new Set([...receivers.values()].flatMap(methods => [...methods]));
const nativeMethod = name => name === 'createNativeQuery';
const activeUnicode = /(?:^|[^\\])(?:\\\\)*\\u+[0-9a-f]{4}/i;
const sqlHead = /^(?:\uFEFF|\s|--[^\r\n]*[\r\n]|#[^\r\n]*[\r\n]|\/\*[\s\S]*?\*\/)*(?:SELECT|WITH|INSERT|UPDATE|DELETE|REPLACE|CALL|CREATE|ALTER|DROP)\b/i;
const maxFragments = 128;

function matches(tokens) {
  const pairs = new Map(), inside = new Map(), stack = [], braces = [];
  const kinds = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
  for (const [index, token] of tokens.entries()) {
    inside.set(index, braces.at(-1));
    if (token.kind !== 'symbol') continue;
    if (kinds.has(token.text)) {
      stack.push(index);
      if (token.text === '{') braces.push(index);
    } else if ([')', ']', '}'].includes(token.text)) {
      const open = stack.pop();
      if (kinds.get(tokens[open]?.text) !== token.text) return null;
      pairs.set(open, index);
      if (token.text === '}') braces.pop();
    }
  }
  return stack.length ? null : { pairs, inside };
}

function enclosingTypes(file, tokens, topology) {
  const byStart = new Map(tokens.map((token, index) => [token.start, index]));
  const result = [];
  for (const type of file.types) {
    const name = byStart.get(type.start);
    const open = tokens.findIndex((token, index) => index > name && token.text === '{');
    const close = topology.pairs.get(open);
    if (close === undefined) continue;
    const methods = [];
    for (const method of type.methods) {
      const parameters = byStart.get(method.start) + 1;
      const end = topology.pairs.get(parameters);
      if (end === undefined) continue;
      let body = end + 1;
      while (body < close && !['{', ';'].includes(tokens[body].text)) body++;
      const finish = topology.pairs.get(body);
      if (tokens[body]?.text === '{' && finish !== undefined && topology.inside.get(body) === open) {
        methods.push({ ...method, body, finish });
      }
    }
    result.push({ type, open, close, methods });
  }
  return result;
}

function firstArgument(tokens, open, close, pairs) {
  for (let at = open + 1; at < close; at++) {
    if (tokens[at].text === ',') return tokens.slice(open + 1, at);
    if (pairs.has(at)) at = pairs.get(at);
  }
  return tokens.slice(open + 1, close);
}

function fieldUnshadowed(tokens, method, receiverIndex) {
  const name = tokens[receiverIndex].text;
  // Refuse a bare field if the same bare name occurs in any other role in the
  // method. Explicit this.field and uniquely typed parameters are preferable.
  return !tokens.slice(method.body + 1, method.finish).some((token, i) => {
    const at = i + method.body + 1;
    return token.text === name && at !== receiverIndex && token.kind === 'id' &&
      tokens[at - 1]?.text !== '.' && tokens[at + 1]?.text !== '.';
  });
}

function receiverType(tokens, receiverIndex, method, type) {
  const receiver = tokens[receiverIndex];
  if (receiver?.kind !== 'id') return undefined;
  const name = receiver.text;
  const qualified = tokens[receiverIndex - 1]?.text === '.';
  if (qualified && (tokens[receiverIndex - 2]?.text !== 'this' || tokens[receiverIndex - 3]?.text === '.')) return undefined;
  const candidates = qualified ? [] : method.parameters.filter(parameter => parameter.name === name);
  if (candidates.length === 1) return candidates[0].type.name;
  if (candidates.length > 1 || !qualified && !fieldUnshadowed(tokens, method, receiverIndex)) return undefined;
  const fields = type.fields.filter(field => field.name === name);
  return fields.length === 1 ? fields[0].type.name : undefined;
}

function scanJavaSql(text) {
  const lexed = lexJava(text), { tokens } = lexed, fragments = [], unknown = [], claimed = new Set();
  const range = (start, end) => rangeAt(text, start, end);
  const report = (code, reason, start, end) => unknown.push({ code, reason, ...(Number.isInteger(start) && { start, end, range: range(start, end) }) });
  const relevant = tokens.some(token => token.kind === 'id' && (candidateCalls.has(token.text) || ['Query', 'NativeQuery', 'NamedNativeQuery', 'NamedNativeQueries'].includes(token.text)) ||
    ['string', 'text-block'].includes(token.kind) && sqlHead.test(decodeExpression([token])?.text || ''));
  if (!relevant) return { fragments, unknown };
  const topology = matches(tokens);
  if (!topology || activeUnicode.test(text) || /\r(?!\n)/.test(text) || lexed.issues.some(issue => !issue.startsWith('Java Unicode pre-lexing'))) {
    report('java-source-uncertain', 'Java lexical boundaries are uncertain; these strings were not bound.');
    return { fragments, unknown };
  }
  const file = parseJavaFile({ text, uri: 'java-source' });
  const contexts = enclosingTypes(file, tokens, topology);
  let count = 0;
  function claim(parts) {
    for (const token of parts || []) if (['string', 'text-block'].includes(token.kind)) claimed.add(token.start);
  }
  function add(parts, origin, start, end, unresolved) {
    claim(parts);
    if (++count > maxFragments) {
      if (count === maxFragments + 1) report('java-fragment-limit', 'Java SQL usage inspection is limited to 128 fragment candidates per file.');
      return;
    }
    if (unresolved) { report('java-receiver-uncertain', unresolved, start, end); return; }
    const decoded = decodeExpression(parts);
    if (!decoded?.text || !decoded.text.isWellFormed() || decoded.text.includes('\0')) {
      report('java-sql-dynamic', 'The SQL argument is not one bounded literal or an all-literal concatenation.', start, end);
      return;
    }
    if (/(?:#|\$|:)\{/.test(decoded.text)) {
      report('java-sql-interpolation', 'The SQL contains an expression or template placeholder.', start, end);
      return;
    }
    if (!sqlHead.test(decoded.text)) {
      report('java-sql-form', 'This fragment has no supported SQL statement heading.', start, end);
      return;
    }
    fragments.push({ ...decoded, start, end, origin });
  }
  function annotations(items) {
    for (const annotation of items) {
      const native = literal(annotation, 'nativeQuery', false);
      if (annotation.name === nativeQuery) {
        if (native === false) claim(annotation.attributes.value);
        else {
          const unresolved = native === true ? undefined : 'The Spring Data native SQL mode cannot be proven.';
          add(annotation.attributes.value, 'spring-data-native-query', annotation.start, annotation.end, unresolved);
          if (annotation.attributes.countQuery?.length && literal(annotation, 'countQuery', null) !== '') {
            add(annotation.attributes.countQuery, 'spring-data-native-count-query', annotation.start, annotation.end, unresolved);
          }
        }
      } else if (nativeAnnotations.has(annotation.name)) {
        add(annotation.attributes[nativeAnnotations.get(annotation.name)], 'native-query-annotation', annotation.start, annotation.end);
      }
    }
  }
  for (const { type } of contexts) {
    annotations(type.annotations);
    for (const method of type.methods) annotations(method.annotations);
  }
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== 'id' || !candidateCalls.has(token.text) || tokens[index - 1]?.text !== '.' || tokens[index + 1]?.text !== '(') continue;
    const close = topology.pairs.get(index + 1);
    if (close === undefined) continue;
    const parts = firstArgument(tokens, index + 1, close, topology.pairs);
    const context = contexts.find(current => index > current.open && index < current.close);
    const method = context?.methods.find(current => index > current.body && index < current.finish);
    const type = method && topology.inside.get(index) === method.body ? receiverType(tokens, index - 2, method, context.type) : undefined;
    if (receivers.get(type)?.has(token.text)) {
      add(parts, nativeMethod(token.text) ? 'entity-manager-native-query' : 'spring-jdbc-sql', token.start, tokens[close].end);
    } else if (nativeMethod(token.text) || parts.some(part => ['string', 'text-block'].includes(part.kind) &&
      sqlHead.test(decodeExpression([part])?.text || ''))) {
      add(parts, 'unbound-java-query-call', token.start, tokens[close].end,
        'The call receiver is outside the proven Spring JDBC or JPA declaration scope.');
    }
  }
  for (const token of tokens) {
    if (unknown.length >= 128) break;
    if (!claimed.has(token.start) && ['string', 'text-block'].includes(token.kind) && sqlHead.test(decodeExpression([token])?.text || '')) {
      report('java-sql-unassociated', 'A SQL-looking string is outside a recognized native query annotation or typed SQL call.', token.start, token.end);
    }
  }
  return { fragments, unknown };
}

function javaSourceSpan(fragment, start, end) {
  const first = fragment.map[start], last = fragment.ends[end - 1];
  if (!Number.isInteger(first) || !Number.isInteger(last) || last <= first) return null;
  for (let at = start + 1; at < end; at++) {
    if (fragment.map[at] !== fragment.ends[at - 1]) return null;
  }
  return { start: first, end: last };
}

module.exports = { scanJavaSql, javaSourceSpan };
