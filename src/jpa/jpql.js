'use strict';
const provider = require('./provider');

// A bounded JPQL name/path binder, not an executable query compiler. Scopes are
// established before expression paths are bound, so a subquery may shadow its
// parent and still resolve correlated references to other parent aliases.
const RESERVED = new Set(('select distinct from join left right inner outer fetch on where order by group having asc desc nulls first last and or not null is true false between like escape in member of empty as end then else when case new update delete set exists all any some treat leading trailing both current_date current_time current_timestamp local date time datetime true false').split(' '));
const FUNCTIONS = new Set(('abs avg ceiling coalesce concat count exp extract floor id index length ln locate lower max min mod nullif power replace round sign size sqrt substring sum trim type upper version cast function key value entry').split(' '));
const EXTENSIONS = new Set('with union intersect except limit offset window over lateral recursive filter within ilike collate elements indices sql insert conflict returning'.split(' '));
const BASIC = new Set('java.lang.String java.lang.Long java.lang.Integer java.lang.Double java.lang.Float java.lang.Boolean java.lang.Short java.lang.Byte java.lang.Character java.math.BigDecimal java.math.BigInteger java.time.LocalDate java.time.LocalTime java.time.LocalDateTime java.time.Instant java.util.UUID'.split(' '));
const managed = model => [...model.entities, ...(model.embeddables || []), ...(model.mappedSuperclasses || [])];
const uniqueType = (model, fqn) => { const values = managed(model).filter(item => item.fqn === fqn); return values.length === 1 ? values[0] : null; };
const entity = (model, name) => { const values = model.entities.filter(item => item.entityNameKnown !== false && (item.name === name || item.fqn === name)); return values.length === 1 ? values[0] : null; };

function lex(text) {
  const tokens = [], issues = []; let i = 0;
  while (i < text.length) {
    const start = i, char = text[i];
    if (/\s/.test(char)) { i++; continue; }
    if (char === "'") {
      i++; let closed = false;
      while (i < text.length) if (text[i++] === "'") { if (text[i] === "'") i++; else { closed = true; break; } }
      tokens.push({ kind: 'string', text: text.slice(start, i), start, end: i });
      if (!closed) issues.push('Unterminated JPQL string literal.');
      continue;
    }
    if (/[\p{L}_$]/u.test(char)) {
      i++; while (i < text.length && /[\p{L}\p{N}_$]/u.test(text[i])) i++;
      const value = text.slice(start, i); tokens.push({ kind: 'id', text: value, lower: value.toLowerCase(), start, end: i }); continue;
    }
    if (/\d/.test(char)) { i++; while (i < text.length && /[\w.]/.test(text[i])) i++; tokens.push({ kind: 'number', text: text.slice(start, i), start, end: i }); continue; }
    if (text.startsWith('--', i) || text.startsWith('/*', i) || ['`', '"', ';', '#', '[', ']'].includes(char)) issues.push('Comments, quoted identifiers, multiple statements or provider-specific syntax are outside this JPQL binder.');
    tokens.push({ kind: 'symbol', text: char, start, end: ++i });
  }
  if (tokens.length > 8192) issues.push('JPQL token limit exceeded.');
  return { tokens, issues };
}
function pathAt(tokens, start, end = tokens.length) {
  if (tokens[start]?.kind !== 'id') return null;
  const items = [tokens[start]]; let next = start + 1;
  while (next + 1 < end && tokens[next].text === '.' && tokens[next + 1].kind === 'id') { items.push(tokens[next + 1]); next += 2; }
  return { items, next };
}
function lookup(query, scope, name) {
  const key = name.toLowerCase();
  for (let current = scope; current; current = current.parent === null ? null : query._scopes[current.parent]) if (Object.hasOwn(current.aliases, key)) return current.aliases[key];
  return undefined;
}
function scopeAt(query, cursor) { return query._scopes?.filter(item => cursor >= item.start && cursor <= item.end).at(-1); }

function inspect(model, file, query, hooks) {
  const parsed = lex(query.text), tokens = parsed.tokens, reasons = [...parsed.issues], references = [], missing = [];
  query._tokens = tokens; query._scopes = []; query._treats = []; query._unsupported = parsed.issues.length > 0;
  query.analysis = 'bounded-scoped-JPQL-name-binding'; query.validityVerified = false;
  const close = new Map(), open = [], excluded = new Set();
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].text === '(') { open.push(i); if (open.length > 32) reasons.push('JPQL nesting limit exceeded.'); }
    else if (tokens[i].text === ')') { const start = open.pop(); if (start === undefined) reasons.push('Unbalanced JPQL parentheses.'); else { close.set(start, i); if (tokens[i + 1]?.text === '.' && tokens[start - 1]?.lower !== 'treat') reasons.push('Navigation from a function/group result is not modeled.'); } }
    if (tokens[i].kind === 'id' && EXTENSIONS.has(tokens[i].lower) && !provider.isExtensionKeyword(query._providerProfile,tokens[i].lower) && tokens[i - 1]?.text !== '.' && tokens[i - 1]?.text !== ':') reasons.push('Set/CTE/provider extension syntax is not modeled: ' + tokens[i].text);
    if (tokens[i].kind === 'id' && tokens[i + 1]?.text === '(' && tokens[i - 1]?.lower !== 'new' && !FUNCTIONS.has(tokens[i].lower) && !RESERVED.has(tokens[i].lower) && !provider.knownFunction(query._providerProfile,tokens[i].lower) && !provider.isExtensionKeyword(query._providerProfile,tokens[i].lower) && tokens[i - 1]?.text !== '.') reasons.push('Unrecognized function semantics: ' + tokens[i].text);
  }
  if (open.length) reasons.push('Unbalanced JPQL parentheses.');
  if (reasons.length) return finish(true);

  function ref(token, target) { if (target) references.push([token, target]); }
  function path(scope, items, joining = false) {
    let type = uniqueType(model, lookup(query, scope, items[0].text));
    if (!type) { reasons.push('Alias/entity target is external, incomplete or ambiguous: ' + items[0].text); return null; }
    let attribute;
    for (let i = 1; i < items.length; i++) {
      const token = items[i]; attribute = type.attributes.find(value => value.name === token.text);
      if (!attribute) {
        if (type.attributesComplete !== false) missing.push({ token, type }); else reasons.push('Persistent attribute coverage is partial: ' + type.name);
        return null;
      }
      ref(token, attribute);
      if (i < items.length - 1 || joining) {
        if (attribute.collection && i < items.length - 1) { reasons.push('Collection navigation requires an explicit join/member alias.'); return null; }
        const targetFqn = attribute.targetFqn || attribute.elementJavaType;
        type = uniqueType(model, targetFqn) || (attribute.collection && BASIC.has(targetFqn) ? { name: targetFqn, fqn: targetFqn, attributes: [], attributesComplete: false, basic: true } : null);
        if (!type) { reasons.push('A path target is basic, external or ambiguous: ' + attribute.name); return null; }
      }
    }
    return joining ? type : attribute || type;
  }
  function bind(scope, index, type) {
    if (tokens[index]?.lower === 'as') index++;
    const token = tokens[index];
    if (token?.kind === 'id' && !RESERVED.has(token.lower)) {
      const key = token.lower;
      if (Object.hasOwn(scope.aliases, key)) reasons.push('Duplicate identification variable in one scope: ' + token.text);
      scope.aliases[key] = type?.fqn || null; excluded.add(index); ref(token, type); return index + 1;
    }
    return index;
  }
  function declaration(scope, index, end) {
    if (tokens[index]?.lower === 'in' && tokens[index + 1]?.text === '(') {
      const last = close.get(index + 1), p = pathAt(tokens, index + 2, last);
      if (!p || last === undefined || p.next !== last) { reasons.push('Collection member declaration is incomplete.'); return index + 1; }
      const type = path(scope, p.items, true); for (let n = index; n <= last; n++) excluded.add(n);
      return bind(scope, last + 1, type);
    }
    const p = pathAt(tokens, index, end);
    if (!p) { reasons.push('Entity declaration is incomplete.'); return index + 1; }
    const name = p.items.map(value => value.text).join('.');
    const target = entity(model, name) || (p.items.length > 1 && lookup(query, scope, p.items[0].text) !== undefined ? path(scope, p.items, true) : null);
    if (scope.statement !== 'select') scope.rootFqn = target?.fqn || null;
    if (!target) reasons.push('Entity declaration is external, nonliteral or ambiguous: ' + name);
    else ref(p.items.at(-1), target);
    for (let n = index; n < p.next; n++) excluded.add(n);
    const next = bind(scope, p.next, target);
    // Standard update/delete may omit an explicit alias; bind the entity name
    // for explicit qualified paths, but do not guess arbitrary unqualified paths.
    if (next === p.next && scope.statement !== 'select' && target) scope.aliases[target.name.toLowerCase()] = target.fqn;
    if (next === p.next && scope.statement === 'select') reasons.push('An explicit identification variable is required by this binder.');
    return next;
  }
  function treat(scope, index, end) {
    if (tokens[index]?.lower !== 'treat' || tokens[index + 1]?.text !== '(') return null;
    const last = close.get(index + 1), p = pathAt(tokens, index + 2, last);
    if (last === undefined || !p || tokens[p.next]?.lower !== 'as') { reasons.push('TREAT expression is incomplete.'); return null; }
    const name = pathAt(tokens, p.next + 1, last), base = path(scope, p.items, true), target = name && entity(model, name.items.map(value => value.text).join('.'));
    if (!name || name.next !== last || !base || !target) { reasons.push('TREAT target is not a unique local entity.'); return { next: last + 1, target: null }; }
    let current = target, depth = 0;
    while (current && current.fqn !== base.fqn && depth++ < 32) current = uniqueType(model, current.superFqn);
    if (!current || current.fqn !== base.fqn) { reasons.push('TREAT subtype relationship is unresolved in the local managed hierarchy.'); return { next: last + 1, target: null }; }
    ref(name.items.at(-1), target); for (let n = index; n <= last; n++) excluded.add(n);
    query._treats.push({ start: tokens[index].start, after: tokens[last].end, fqn: target.fqn });
    return { next: last + 1, target };
  }
  function build(start, end, parent, nesting = 0) {
    if (nesting > 32 || query._scopes.length >= 128) { query._scopeIncomplete = true; reasons.push('JPQL scope limit exceeded.'); return; }
    const statement = tokens[start]?.lower === 'from' ? 'select' : tokens[start]?.lower;
    const scope = { parent: parent ? query._scopes.indexOf(parent) : null, aliases: Object.create(null), start: tokens[start]?.start ?? 0, end: tokens[end]?.start ?? query.text.length, tokenStart: start, tokenEnd: end, statement };
    query._scopes.push(scope);
    if (!['select', 'update', 'delete'].includes(statement)) { reasons.push('Only SELECT, UPDATE and DELETE statements are modeled.'); return; }
    // Discover subqueries and omit their bodies from this scope's declaration scan.
    const children = new Map();
    for (let i = start; i < end; i++) if (tokens[i].text === '(' && ['select', 'from'].includes(tokens[i + 1]?.lower)) { const last = close.get(i); if (last !== undefined) { children.set(i, last); i = last; } }
    let from = -1;
    if (statement === 'update') from = start;
    else for (let i = start; i < end; i++) { if (children.has(i)) { i = children.get(i); continue; } if (tokens[i].text === '(') { i = close.get(i) ?? i; continue; } if (tokens[i].lower === 'from') { from = i; break; } }
    if (statement === 'delete' && from < 0) from = start;
    if (from < 0) reasons.push('No FROM declaration was found.');
    else {
      let i = declaration(scope, from + 1, end), depth = 0;
      for (; i < end; i++) {
        const token = tokens[i];
        if (children.has(i)) { i = children.get(i); continue; }
        if (token.text === '(') { depth++; continue; } if (token.text === ')') { depth--; continue; }
        if (depth) continue;
        if (['where', 'group', 'having', 'order', 'set'].includes(token.lower)) break;
        if (token.text === ',') { i = declaration(scope, i + 1, end) - 1; continue; }
        if (token.lower === 'join') {
          let at = i + 1; if (tokens[at]?.lower === 'fetch') at++;
          const downcast = treat(scope, at, end);
          if (downcast) { i = bind(scope, downcast.next, downcast.target) - 1; continue; }
          const p = pathAt(tokens, at, end);
          if (!p) { reasons.push('JOIN declaration is incomplete.'); continue; }
          const target = p.items.length > 1 ? path(scope, p.items, true) : entity(model, p.items[0].text);
          if (!target) reasons.push('JOIN target cannot be resolved to a local entity.');
          if (p.items.length === 1) ref(p.items[0], target);
          for (let n = at; n < p.next; n++) excluded.add(n);
          i = bind(scope, p.next, target) - 1;
        }
      }
    }
    // Parent aliases have now been declared. A child's declarations shadow only
    // inside the child; sibling aliases are never visible to one another.
    for (const [first, last] of children) build(first + 1, last, scope, nesting + 1);
    for (let i = start; i < end; i++) {
      if (children.has(i)) { i = children.get(i); continue; }
      if (excluded.has(i)) continue;
      const token = tokens[i];
      if (token.lower === 'new') { const p = pathAt(tokens, i + 1, end); if (p) { for (let n = i + 1; n < p.next; n++) excluded.add(n); i = p.next - 1; } continue; }
      if (scope.statement === 'update' && token.kind === 'id' && tokens[i + 1]?.text === '=' && (tokens[i - 1]?.lower === 'set' || tokens[i - 1]?.text === ',')) {
        const type = uniqueType(model, scope.rootFqn), attribute = type?.attributes.find(value => value.name === token.text);
        if (attribute) ref(token, attribute);
        else if (type?.attributesComplete !== false && type) missing.push({ token, type });
        else reasons.push('Unqualified UPDATE assignment target is unresolved.');
        continue;
      }
      const downcast = treat(scope, i, end);
      if (downcast) {
        let at = downcast.next, type = downcast.target;
        while (tokens[at]?.text === '.' && tokens[at + 1]?.kind === 'id') {
          const property = tokens[at + 1], attribute = type?.attributes.find(value => value.name === property.text);
          if (!attribute && type?.attributesComplete !== false && type) missing.push({ token: property, type });
          if (attribute) ref(property, attribute);
          type = attribute && uniqueType(model, attribute.targetFqn); at += 2;
        }
        i = at - 1; continue;
      }
      if (token.kind !== 'id' || tokens[i - 1]?.text === '.' || tokens[i - 1]?.text === ':' || tokens[i + 1]?.text !== '.') continue;
      const p = pathAt(tokens, i, end);
      if (lookup(query, scope, token.text) !== undefined) path(scope, p.items);
      else reasons.push('A path has an unresolved alias or enum/class literal: ' + token.text);
      i = p.next - 1;
    }
  }
  build(0, tokens.length, null);
  query._aliases = query._scopes[0]?.aliases || {};
  query.parameters = tokens.filter((token, i) => token.kind === 'id' && tokens[i - 1]?.text === ':').map(token => ({ name: token.text, range: hooks.sourceRange(file, query, token.start, token.end) }));
  finish(false);

  function finish(unsupported) {
    query._unsupported = unsupported || Boolean(query._scopeIncomplete);
    for (const [token, target] of references) hooks.addReference(model, file, query, token, target);
    if (reasons.length) {
      query.status = 'unknown'; query.reason = [...new Set(reasons)].join('; ');
      model.diagnostics.push({ uri: file.uri, range: query.range, code: 'jpa.jpql.unknown', severity: 'information', message: query.reason });
      return;
    }
    const seen = new Set();
    for (const item of missing) {
      const key = item.token.start + ':' + item.type.fqn; if (seen.has(key)) continue; seen.add(key);
      for (const span of hooks.sourceSpans(file, query, item.token.start, item.token.end)) model.diagnostics.push({ ...span, code: 'jpa.jpql.property.missing', severity: 'warning', message: `${item.token.text} is not a persistent attribute in the local ${item.type.name} model. This is a source-model finding, not query execution.` });
    }
    query.status = missing.length ? 'invalid' : 'known';
    query.reason = missing.length ? 'A persistent path is absent from a complete local managed type.' : 'Supported scoped JPQL entity/property paths are bound. Function result types, constructor signatures, parameter values and complete query validity are not asserted.';
  }
}

function completionType(model, query, cursor, parts) {
  const scope = scopeAt(query, cursor); if (!scope) return null;
  let type = uniqueType(model, lookup(query, scope, parts.shift()));
  for (const part of parts) {
    const attribute = type?.attributes.find(item => item.name === part);
    if (attribute?.collection) return null;
    type = attribute && uniqueType(model, attribute.targetFqn);
  }
  return type;
}

function treatedCompletion(model, query, cursor) {
  for (const treat of [...(query._treats || [])].reverse()) {
    if (treat.after > cursor) continue;
    const suffix = query.text.slice(treat.after, cursor);
    if (!/^\.(?:[\p{L}_$][\p{L}\p{N}_$]*\.)*[\p{L}\p{N}_$]*$/u.test(suffix)) continue;
    const parts = suffix.slice(1).split('.'), partial = parts.pop(); let type = uniqueType(model, treat.fqn);
    for (const part of parts) { const attribute = type?.attributes.find(item => item.name === part); type = attribute && !attribute.collection && uniqueType(model, attribute.targetFqn); }
    return type ? { type, partial } : null;
  }
  return null;
}

module.exports = { inspect, completionType, treatedCompletion };
