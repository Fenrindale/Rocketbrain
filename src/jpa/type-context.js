'use strict';
const { typeRef, literal, rangeAt } = require('../spring/java');
const { decodeExpression } = require('./literals');
const PRIMITIVE = new Set('boolean byte short int long float double char void'.split(' '));
function matching(tokens, start) { const symbol = tokens[start]?.text, end = { '(': ')', '{': '}', '[': ']' }[symbol]; let depth = 0; for (let i = start; i < tokens.length; i++) { if (tokens[i].text === symbol) depth++; else if (tokens[i].text === end && --depth === 0) return i; } return -1; }
function split(tokens) { const result = []; let depth = 0, start = 0; for (let i = 0; i < tokens.length; i++) { if (['(', '{', '[', '<'].includes(tokens[i].text)) depth++; else if ([')', '}', ']', '>'].includes(tokens[i].text)) depth--; else if (!depth && tokens[i].text === ',') { result.push(tokens.slice(start, i)); start = i + 1; } } result.push(tokens.slice(start)); return result; }
function javaType(ref, file, environment) {
  if (!ref) return null;
  const rawBase = ref.raw?.replace(/\[\]$/g, '').split('<')[0];
  let base = PRIMITIVE.has(rawBase) ? rawBase : ref.name;
  if (rawBase && !rawBase.includes('.') && !file?.imports?.[rawBase] && environment?.has(file?.packageName + '.' + rawBase)) base = file.packageName + '.' + rawBase;
  if (!base || base.endsWith('.var') || base === 'var') return null;
  return base + (ref.arguments?.length ? '<' + ref.arguments.map(value => javaType(value, file, environment)).join(',') + '>' : '') + (ref.array ? '[]' : '');
}
function resolveName(name, file, environment) { if (PRIMITIVE.has(name)) return name; return javaType(typeRef(name.split('.').flatMap((part, i) => [...(i ? [{ text: '.', kind: 'symbol' }] : []), { text: part, kind: 'id' }]), file), file, environment); }
function enclosingMethod(file, index) {
  const tokens = file.tokens, position = tokens[index]?.start ?? index;
  for (const owner of file.types || []) for (const method of owner.methods) {
    const at = tokens.findIndex(token => token.start === method.start), open = at + 1;
    if (tokens[open]?.text !== '(') continue;
    let body = matching(tokens, open) + 1; while (body < tokens.length && !['{', ';'].includes(tokens[body].text)) body++;
    const end = tokens[body]?.text === '{' ? matching(tokens, body) : body;
    if (tokens[body]?.text === '{' && position >= tokens[body].start && position <= tokens[end]?.end) return { method, owner, body, end };
  }
  return null;
}
function expressionType(tokens, file, variables, environment) {
  while (tokens[0]?.text === '(' && matching(tokens, 0) === tokens.length - 1) tokens = tokens.slice(1, -1);
  const decoded = decodeExpression(tokens); if (decoded) return 'java.lang.String';
  if (tokens.length === 1) {
    const token = tokens[0];
    if (token.kind === 'char') return 'char';
    if (token.kind === 'number') return /[lL]$/.test(token.text) ? 'long' : /[fF]$/.test(token.text) ? 'float' : /[.eEdD]/.test(token.text) ? 'double' : 'int';
    if (['true', 'false'].includes(token.text)) return 'boolean';
    if (token.text === 'null') return '<null>';
    if (token.kind === 'id') { const values = variables.get(token.text); return values?.size === 1 ? [...values][0] : null; }
  }
  if (['+', '-'].includes(tokens[0]?.text)) return expressionType(tokens.slice(1), file, variables, environment);
  if (tokens.at(-1)?.text === 'class' && tokens.at(-2)?.text === '.') return 'java.lang.Class';
  if (tokens[0]?.text === 'new') { let end = 1; while (end < tokens.length && tokens[end].text !== '(' && tokens[end].text !== '[') end++; return resolveName(tokens.slice(1, end).map(token => token.text).join(''), file, environment); }
  let depth = 0, question = -1;
  for (let i = 0; i < tokens.length; i++) { if (['(', '[', '{'].includes(tokens[i].text)) depth++; else if ([')', ']', '}'].includes(tokens[i].text)) depth--; else if (!depth && tokens[i].text === '?') question = i; else if (!depth && question >= 0 && tokens[i].text === ':') { const left = expressionType(tokens.slice(question + 1, i), file, variables, environment), right = expressionType(tokens.slice(i + 1), file, variables, environment); return left === right ? left : null; } }
  if (tokens[0]?.kind === 'id' && tokens[1]?.text === '.' && ['of', 'asList'].includes(tokens[2]?.text) && tokens[3]?.text === '(' && matching(tokens, 3) === tokens.length - 1) {
    const collection = tokens[0].text === 'Set' ? 'java.util.Set' : ['List', 'Arrays'].includes(tokens[0].text) ? 'java.util.List' : null;
    const values = split(tokens.slice(4, -1)).map(value => expressionType(value, file, variables, environment));
    if (collection && values.length && values.every(value => value && value === values[0])) return collection + '<' + values[0] + '>';
  }
  return null;
}
function variablesFor(file, location, until, environment) {
  const variables = new Map(), tokens = file.tokens;
  const add = (name, value) => { if (!variables.has(name)) variables.set(name, new Set()); variables.get(name).add(value); };
  for (const field of location?.owner.fields || []) add(field.name, javaType(field.type, file, environment));
  for (const parameter of location?.method.parameters || []) add(parameter.name, javaType(parameter.type, file, environment));
  for (let i = location?.body + 1 || 0; i < Math.min(until, location?.end ?? until); i++) {
    if (tokens[i]?.kind !== 'id' || !['=', ';'].includes(tokens[i + 1]?.text)) continue;
    let start = i - 1; while (start >= (location?.body ?? 0) && ![';', '{', '}', '=', '(', ')'].includes(tokens[start].text)) start--;
    const prefix = tokens.slice(start + 1, i);
    if (!prefix.length || prefix.some(token => !['id', 'symbol'].includes(token.kind) || token.kind === 'symbol' && !['.', '<', '>', ',', '[', ']', '?'].includes(token.text))) continue;
    const ref = typeRef(prefix.filter(token => token.text !== 'final'), file); let type = javaType(ref, file, environment);
    if (!type && tokens[i + 1].text === '=') { let end = i + 2; while (end < tokens.length && tokens[end].text !== ';') end++; type = expressionType(tokens.slice(i + 2, end), file, variables, environment); }
    if (type || prefix.some(token => token.text === 'var')) add(tokens[i].text, type);
  }
  return variables;
}
function methodContext(file, method, environment) {
  const bindings = [], unknownReasons = [];
  for (let i = 0; i < method.parameters.length; i++) {
    const parameter = method.parameters[i], annotation = parameter.annotations.find(value => value.shortName === 'Param' && (value.name === 'org.springframework.data.repository.query.Param' || !file.imports.Param && file.wildcards.includes('org.springframework.data.repository.query')));
    const name = annotation ? literal(annotation, 'value', undefined) : parameter.name;
    if (annotation && typeof name !== 'string') unknownReasons.push('A repository @Param name is not a resolved literal.');
    if (typeof name === 'string') bindings.push({ name, javaType: javaType(parameter.type, file, environment), source: annotation ? 'spring-data-param-annotation' : 'source-parameter-name-unverified-compiler-flag', state: annotation ? 'known' : 'unknown' });
    bindings.push({ position: i + 1, javaType: javaType(parameter.type, file, environment), source: 'spring-data-method-position', state: 'known' });
  }
  let resultType = javaType(method.type, file, environment);
  const generic = /^(?:java\.util\.)?(?:List|Set|Collection|Optional|Stream|Iterable)<(.+)>$/.exec(resultType || ''); if (generic) resultType = generic[1];
  return { bindings, resultType, parameterContract: 'spring-data-method', unknownReasons, methodParameters: method.parameters.map(value => ({ name: value.name, javaType: javaType(value.type, file, environment) })) };
}
function callContext(file, callIndex, environment) {
  const tokens = file.tokens, location = enclosingMethod(file, callIndex), close = matching(tokens, callIndex + 1);
  const context = { bindings: [], method: location?.method, resultType: null, unknownReasons: [] };
  if (close < 0) { context.unknownReasons.push('Java createQuery invocation boundary is unresolved.'); return context; }
  const args = split(tokens.slice(callIndex + 2, close)), result = args[1];
  if (result?.at(-1)?.text === 'class' && result.at(-2)?.text === '.') context.resultType = javaType(typeRef(result.slice(0, -2), file), file, environment);
  function binding(at) {
    const end = matching(tokens, at + 1); if (end < 0) return at + 1;
    const args = split(tokens.slice(at + 2, end)), key = decodeExpression(args[0]), ordinal = args[0]?.length === 1 && /^\d+$/.test(args[0][0].text) ? Number(args[0][0].text) : null;
    if (!key && ordinal === null) { context.unknownReasons.push('A setParameter name/ordinal is dynamic.'); return end; }
    const type = expressionType(args[1] || [], file, variablesFor(file, location, at, environment), environment);
    context.bindings.push({ ...(key ? { name: key.text } : { position: ordinal }), javaType: type, source: 'entity-manager-setParameter', state: type ? 'known' : 'unknown', uri: file.uri, range: args[1]?.length ? rangeAt(file.text, args[1][0].start, args[1].at(-1).end) : undefined });
    return end;
  }
  let at = close + 1;
  while (tokens[at]?.text === '.' && tokens[at + 1]?.kind === 'id' && tokens[at + 2]?.text === '(') { const end = tokens[at + 1].text === 'setParameter' ? binding(at + 1) : matching(tokens, at + 2); if (end < at) break; at = end + 1; }
  return context;
}

module.exports = { callContext, methodContext, enclosingMethod, expressionType, javaType, matching };
