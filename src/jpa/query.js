'use strict';
const { lexJava, rangeAt, literal } = require('../spring/java');
const jpql = require('./jpql');
const { decodeExpression } = require('./literals');
const { resolveQuery } = require('./dynamic');
const { resolveSpel } = require('./spel');
const { analyzeQueryTypes, environmentFor } = require('./types');
const { callContext, methodContext, enclosingMethod, matching } = require('./type-context');
const provider = require('./provider');

const managed = model => [...model.entities, ...(model.embeddables || []), ...(model.mappedSuperclasses || [])];
function uniqueType(model, fqn) { const matches = managed(model).filter(type => type.fqn === fqn); return matches.length === 1 ? matches[0] : null; }
function offsetAt(text, position) { if (typeof position === 'number') return position; const lines = text.split('\n'); let offset = 0; for (let i = 0; i < position.line && i < lines.length - 1; i++) offset += lines[i].length + 1; return Math.min(text.length, offset + position.character); }
function contains(range, position) { return (position.line > range.start.line || position.line === range.start.line && position.character >= range.start.character) && (position.line < range.end.line || position.line === range.end.line && position.character <= range.end.character); }

function sourceSpans(file, query, start, end) {
  const result = []; let first = start;
  const uriAt = index => query._sourceUris?.[index] || file.uri;
  const append = (a, b) => { const uri = uriAt(a), text = query._sourceFiles?.get(uri) ?? (uri === file.uri ? file.text : null); if (text === null) return; result.push({ uri, range: rangeAt(text, query._map[a] ?? query._literalEnd, b > a ? query._ends[b - 1] ?? query._literalEnd : query._map[a] ?? query._literalEnd) }); };
  if (end <= start) { append(start, end); return result; }
  for (let i = start + 1; i <= end; i++) if (i === end || uriAt(i) !== uriAt(i - 1) || query._map[i] !== query._ends[i - 1] && !(query._map[i] === query._map[i - 1] && query._ends[i] === query._ends[i - 1])) { append(first, i); first = i; }
  return result;
}
function sourceRanges(file, query, start, end) { return sourceSpans(file, query, start, end).map(value => value.range); }
function sourceRange(file, query, start, end) { return sourceRanges(file, query, start, end)[0] || query.range; }
function addReference(model, file, query, token, target) {
  if (!target?.uri || !target.range) return;
  for (const { uri, range } of sourceSpans(file, query, token.start, token.end)) {
    const key = JSON.stringify([uri, range, target.uri, target.range]);
    if (!model.references.some(item => item._key === key)) model.references.push({ uri, range, targets: [{ uri: target.uri, range: target.range }], kind: 'jpa-query', _key: key });
  }
}
function inspectJPQL(model, file, query) { jpql.inspect(model, file, query, { sourceRange, sourceRanges, sourceSpans, addReference }); }

function analyzeQueries(model, parsedFiles, helpers) {
  model.queries ||= []; model.diagnostics ||= []; model.references ||= []; model.issues ||= [];
  const environment = environmentFor(model), sourceFiles = new Map(model.files.map(value => [value.uri, value.text]));
  const providerProfile = provider.normalizeProviderProfile(model.options?.providerProfile), providerDeclarations = provider.contributorDeclarations(parsedFiles);
  function inspect(file, query, context = {}) {
    Object.defineProperty(query, '_sourceFiles', { value: sourceFiles, enumerable: false });
    Object.defineProperty(query, '_providerProfile', { value: providerProfile, enumerable: false });
    Object.defineProperty(query, '_providerEnvironment', { value: environment, enumerable: false });
    query.providerAnalysis = provider.profileSummary(providerProfile);
    if (!query._unsupported) inspectJPQL(model, file, query);
    analyzeQueryTypes(model, file, query, { ...context, symbolicParameters: query.symbolicParameters || [], environment, providerProfile, providerDeclarations }, { sourceSpans: (value, start, end) => sourceSpans(file, value, start, end) });
  }
  for (const file of parsedFiles) {
    if (model.options?.basePackages?.length && !model.options.basePackages.some(pkg => file.packageName === pkg || file.packageName.startsWith(pkg + '.'))) continue;
    const tokens = file.tokens || lexJava(file.text).tokens, extracted = new Set(); file.tokens ||= tokens;
    function add(parts, source, forcedReason, supplied = {}) {
      if (model.queries.length >= 2000 || !parts?.length) return;
      const token = parts[0], range = rangeAt(file.text, token.start, parts.at(-1).end);
      const key = token.start + ':' + source; if (extracted.has(key)) return; extracted.add(key);
      const resolved = resolveQuery(parts, { file, tokens, parsedFiles, callIndex: supplied.callIndex, method: supplied.method });
      const variants = resolved?.alternatives?.length ? resolved.alternatives : [resolved];
      for (let index = 0; index < variants.length && model.queries.length < 2000; index++) {
        const value = variants[index], decoded = value?.text !== null && value?.text !== undefined ? resolveSpel(value, { file, method: supplied.method, model, entityName: supplied.entityName }) : value;
        const reasons = [...new Set([...(resolved?.unknownReasons || []), ...(decoded?.unknownReasons || [])])];
        const query = { uri: file.uri, text: decoded?.text ?? null, range, source, status: 'unknown', reason: forcedReason || reasons.join('; ') || (!decoded?.text ? 'Java query source is unresolved.' : ''), _map: decoded?.map || [], _ends: decoded?.ends || [], _sourceUris: decoded?.sourceUris || decoded?.map?.map(() => file.uri) || [], _literalStart: token.start, _literalEnd: parts.at(-1).end, literalKinds: decoded?.literalKinds || [], symbolicParameters: decoded?.symbolicParameters || [], dynamicResolution: { state: resolved?.resolution || 'unknown', alternatives: variants.length, alternativeIndex: index, reasons }, executedUserCode: false };
        model.queries.push(query); model.diagnostics.push(...(decoded?.diagnostics || []));
        if (forcedReason || typeof query.text !== 'string' || query.text.length > 16384) { query._unsupported = true; query.reason ||= 'Query exceeds its bounded source limit.'; model.diagnostics.push({ uri:file.uri,range,code:'jpa.jpql.unknown',severity:'information',message:query.reason }); }
        inspect(file, query, { ...(supplied.typeContext || {}), unknownReasons: [...(supplied.typeContext?.unknownReasons || []), ...reasons] });
        if (reasons.length) { query.status = 'unknown'; query.reason = reasons.join('; '); if (query.typeAnalysis.state !== 'unknown') { query.typeAnalysis.state = 'unknown'; query.typeAnalysis.coverage.unknown.push(...reasons); query.typeAnalysis.coverage.allSupportedComponentsChecked = false; } }
      }
    }
    for (const type of file.types || []) {
      for (const item of type.annotations) {
        if (helpers.jpa([item], 'NamedQuery', file)) add(item.attributes.query, 'named-query');
        else if (helpers.jpa([item], 'NamedNativeQuery', file)) add(item.attributes.query, 'native-sql', 'Native SQL is not validated as JPQL.');
      }
      const domain = /(?:JpaRepository|CrudRepository|Repository|ListCrudRepository|PagingAndSortingRepository)<([^,>]+)/.exec(file.text.slice(type.start, file.text.indexOf('{',type.start)));
      const domainFqn = domain && helpers.resolveType(domain[1].trim(), file), original = environment.get(domainFqn);
      // Spring Data's entityName template reads the Java @Entity declaration;
      // orm.xml entity-name overrides do not participate in that template.
      let templateEntityName;
      if (original?.length === 1) {
        const declaration = original[0], annotation = helpers.jpa(declaration.type.annotations, 'Entity', declaration.file);
        const name = literal(annotation, 'name', declaration.type.name);
        if (typeof name === 'string') templateEntityName = name.trim() ? name : declaration.type.name;
      }
      for (const method of type.methods) {
        const annotation = method.annotations.find(item => item.shortName === 'Query' && helpers.accepted(item, file, 'org.springframework.data.jpa.repository'));
        if (!annotation) continue;
        const native = literal(annotation, 'nativeQuery', false), context = methodContext(file, method, environment);
        add(annotation.attributes.value, native === false ? 'spring-data-query' : 'native-sql', native === false ? undefined : 'Native/unknown query mode is not validated as JPQL.', { method, entityName:templateEntityName,typeContext:context });
      }
      derivedMethods(model, file, type, helpers);
    }
    const receiverTypes = new Map();
    function receiver(name, type) { if (!receiverTypes.has(name)) receiverTypes.set(name, new Set()); receiverTypes.get(name).add(type); }
    for (const type of file.types || []) { for (const field of type.fields) receiver(field.name, field.type.name); for (const method of type.methods) for (const parameter of method.parameters) receiver(parameter.name, parameter.type.name); }
    for (let i = 0; i < tokens.length - 2; i++) if (tokens[i].kind === 'id' && tokens[i + 1].kind === 'id' && ['=', ';'].includes(tokens[i + 2].text)) receiver(tokens[i + 1].text, helpers.resolveType(tokens[i].text, file));
    for (let i = 2; i < tokens.length; i++) {
      if (!['createQuery', 'createNativeQuery'].includes(tokens[i].text) || tokens[i - 1].text !== '.' || tokens[i + 1]?.text !== '(') continue;
      const verified = receiverTypes.get(tokens[i - 2].text); if (verified?.size !== 1 || !['jakarta.persistence.EntityManager', 'javax.persistence.EntityManager'].includes([...verified][0])) continue;
      let end = i + 2, depth = 0;
      while (end < tokens.length) { if (!depth && [',', ')'].includes(tokens[end].text)) break; if (['(', '{', '['].includes(tokens[end].text)) depth++; else if ([')', '}', ']'].includes(tokens[end].text)) depth--; end++; }
      const context = callContext(file, i, environment), method = context.method;
      add(tokens.slice(i + 2, end), tokens[i].text === 'createNativeQuery' ? 'native-sql' : 'entity-manager-query', tokens[i].text === 'createNativeQuery' ? 'Native SQL is not validated as JPQL.' : undefined, { callIndex:i,method,typeContext:context });
    }
  }
  for (const value of model.mappingQueries || []) {
    const file = model.files.find(item => item.uri === value.uri); if (!file || typeof value.text !== 'string') continue;
    const query = { ...value, _sourceUris:value._map?.map(()=>file.uri)||[], _literalStart:value._map?.[0]??0,_literalEnd:value._ends?.at(-1)??0 }; model.queries.push(query);
    if (value.forcedReason || value.source==='native-sql'||value.source==='xml-native-query'||value.text.length>16384||!value._map?.length) { query._unsupported=true;query.status='unknown';query.reason=value.forcedReason||'Native, unmapped or oversized XML query remains unknown.'; }
    inspect(file,query);
  }
}

function derivedMethods(model, file, type, helpers) {
  if (type.kind !== 'interface') return;
  const tokens = file.tokens || lexJava(file.text).tokens, index = tokens.findIndex(token => token.start === type.start);
  const open = tokens.findIndex((token, position) => position > index && token.text === '{');
  const header = tokens.slice(index + 1, open), extendsAt = header.findIndex(token => token.text === 'extends');
  if (extendsAt < 0) return;
  const repository = header[extendsAt + 1];
  const resolved = helpers.resolveType(repository?.text, file);
  if (!['org.springframework.data.jpa.repository.JpaRepository', 'org.springframework.data.repository.CrudRepository', 'org.springframework.data.repository.Repository', 'org.springframework.data.repository.ListCrudRepository', 'org.springframework.data.repository.PagingAndSortingRepository'].includes(resolved) || header[extendsAt + 2]?.text !== '<') return;
  const domainToken = header[extendsAt + 3], domainFqn = helpers.resolveType(domainToken?.text, file), domain = uniqueType(model, domainFqn);
  for (const method of type.methods) {
    if (method.annotations.some(item => item.shortName === 'Query' && helpers.accepted(item, file, 'org.springframework.data.jpa.repository'))) continue;
    const match = /^(?:find|read|get|query|search|stream|count|exists|delete|remove)(?:All|First\d*|Top\d*)?By(.+)$/.exec(method.name); if (!match) continue;
    const query = { uri: file.uri, text: method.name, range: rangeAt(file.text, method.start, method.end), source: 'spring-data-derived', status: 'unknown', reason: 'Only direct attributes and explicit underscore traversal are modeled.' };
    model.queries.push(query); if (!domain) continue;
    const expression = match[1], start = method.start + method.name.length - expression.length, parts = expression.split('_'); let current = domain, offset = start, valid = true;
    const references = [];
    for (const part of parts) {
      const name = part[0]?.toLowerCase() + part.slice(1), attribute = current?.attributes.find(item => item.name === name);
      if (!attribute) { valid = false; break; }
      references.push({ uri: file.uri, range: rangeAt(file.text, offset, offset + part.length), targets: [{ uri: attribute.uri, range: attribute.range }], kind: 'jpa-derived-query' });
      offset += part.length + 1; current = uniqueType(model, attribute.targetFqn);
    }
    if (valid) { model.references.push(...references); query.status = 'known'; query.reason = 'Direct/underscore property path resolved; full Spring Data method parsing is not asserted.'; }
  }
}

function completionsAt(model, uri, position) {
  const file = model.files.find(item => item.uri === uri); if (!file) return [];
  const offset = offsetAt(file.text, position), candidates = [];
  for (const query of model.queries) {
    if (!query._map?.length || query._unsupported || query.source === 'native-sql') continue;
    const cursors = new Set();
    for (let i = 0; i < query._map.length; i++) if ((query._sourceUris?.[i] || query.uri) === uri) { if (offset === query._map[i]) cursors.add(i); if (offset === query._ends[i]) cursors.add(i + 1); }
    if (cursors.size === 1) candidates.push({query,cursor:[...cursors][0]});
  }
  function calculate(query,cursor) {
    if (query._tokens?.some(token => token.kind === 'string' && cursor > token.start && cursor < token.end)) return [];
    const prefix = query.text.slice(0,cursor), entityContext = /\b(?:from|update|join)\s+([\w.$]*)$/i.exec(prefix);
    function replacement(start,end) {
      const spans = sourceSpans(file,query,start,end); if (spans.length!==1||spans[0].uri!==uri) return null;
      const range=start===end?rangeAt(file.text,offset,offset):spans[0].range;
      const sourceStart=offsetAt(file.text,range.start),sourceEnd=offsetAt(file.text,range.end);
      return file.text.slice(sourceStart,sourceEnd).includes('#{')?null:range;
    }
    if (entityContext&&!entityContext[1].includes('.')) { const range=replacement(cursor-entityContext[1].length,cursor);if(!range)return[];return model.entities.filter(entity=>entity.entityNameKnown!==false&&model.entities.filter(other=>other.name===entity.name).length===1&&entity.name.startsWith(entityContext[1])).map(entity=>({label:entity.name,kind:'entity',detail:entity.fqn,insertText:entity.name,range})); }
    const treated=jpql.treatedCompletion(model,query,cursor),path=/([\p{L}_$][\p{L}\p{N}_$]*(?:\.[\p{L}\p{N}_$]*)+)$/u.exec(prefix);if(!path&&!treated)return[];
    const parts=path?path[1].split('.'):[],partial=treated?treated.partial:parts.pop(),type=treated?treated.type:jpql.completionType(model,query,cursor,parts);if(!type)return[];
    let end=cursor;while(end<query.text.length&&/[\p{L}\p{N}_$]/u.test(query.text[end]))end++;
    const range=replacement(cursor-partial.length,end);if(!range)return[];
    return type.attributes.filter(attribute=>attribute.name.startsWith(partial)).map(attribute=>({label:attribute.name,kind:'property',detail:type.name+'.'+attribute.name+' · '+attribute.kind,insertText:attribute.name,range}));
  }
  const results=candidates.map(({query,cursor})=>calculate(query,cursor));if(!results.length)return[];
  const key=value=>JSON.stringify([value.label,value.kind,value.detail,value.insertText,value.range]);
  return [...new Map(results[0].filter(value=>results.every(items=>items.some(item=>key(item)===key(value)))).map(value=>[key(value),value])).values()];
}

function definitionsAt(model, uri, position) {
  const file = model.files.find(item => item.uri === uri); if (!file) return [];
  const pos = typeof position === 'number' ? rangeAt(file.text, position, position).start : position;
  const targets = model.references.filter(reference => reference.uri === uri && contains(reference.range, pos)).flatMap(reference => reference.targets || []);
  return [...new Map(targets.filter(target => target?.uri && target.range).map(target => [JSON.stringify(target), target])).values()];
}

module.exports = { analyzeQueries, completionsAt, definitionsAt };
