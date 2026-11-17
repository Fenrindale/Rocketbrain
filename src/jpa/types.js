'use strict';
const { parseJavaFile, rangeAt } = require('../spring/java');
const { parseExpression } = require('./type-parser');
const provider = require('./provider');

const BOX = { byte: 'java.lang.Byte', short: 'java.lang.Short', int: 'java.lang.Integer', long: 'java.lang.Long', float: 'java.lang.Float', double: 'java.lang.Double', boolean: 'java.lang.Boolean', char: 'java.lang.Character' };
const SIMPLE = new Set('String Long Integer Double Float Boolean Short Byte Character Object Number Class Void'.split(' '));
const NUMERIC = ['java.lang.Integer', 'java.lang.Long', 'java.math.BigInteger', 'java.math.BigDecimal', 'java.lang.Float', 'java.lang.Double'];
const SMALL = new Set(['java.lang.Byte', 'java.lang.Short']);
const TEMPORAL = new Set('java.util.Date java.util.Calendar java.sql.Date java.sql.Time java.sql.Timestamp java.time.LocalDate java.time.LocalTime java.time.LocalDateTime java.time.Instant java.time.OffsetDateTime java.time.OffsetTime java.time.ZonedDateTime'.split(' '));
const UNKNOWN = reason => ({ kind: 'unknown', javaType: null, reason });
const INVALID = reason => ({ kind: 'invalid', javaType: null, reason });
const BOOL = { kind: 'boolean', javaType: 'java.lang.Boolean' };
const STRING = { kind: 'string', javaType: 'java.lang.String' };
const INT = { kind: 'numeric', javaType: 'java.lang.Integer' };
const LONG = { kind: 'numeric', javaType: 'java.lang.Long' };
const DOUBLE = { kind: 'numeric', javaType: 'java.lang.Double' };
const managed = model => [...model.entities, ...(model.embeddables || []), ...(model.mappedSuperclasses || [])];
function unique(values) { return values.length === 1 ? values[0] : null; }
function javaName(value) { return BOX[value] || (SIMPLE.has(value) ? 'java.lang.' + value : value); }
function typeFromJava(value, model, environment) {
  if (value === '<null>') return { kind: 'null', javaType: null };
  if (!value || typeof value !== 'string' || /[?&]/.test(value)) return UNKNOWN('Java type is unresolved.');
  value = value.replace(/\s+/g, '');
  if (value.endsWith('[]')) return { kind: 'array', javaType: value, elementType: typeFromJava(value.slice(0, -2), model, environment) };
  const collection = /^(?:java\.util\.)?(?:List|Set|Collection|Iterable|Stream|Optional)<(.+)>$/.exec(value);
  if (collection) return { kind: value.includes('Optional<') ? 'optional' : 'collection', javaType: value.split('<')[0], elementType: typeFromJava(collection[1], model, environment) };
  const name = javaName(value), record = unique(managed(model).filter(item => item.fqn === name));
  if (record) return { kind: record.kind === 'entity' ? 'entity' : 'embeddable', javaType: name };
  if (NUMERIC.includes(name) || SMALL.has(name)) return { kind: 'numeric', javaType: name };
  if (name === 'java.lang.String') return STRING;
  if (name === 'java.lang.Boolean') return BOOL;
  if (name === 'java.lang.Character') return { kind: 'character', javaType: name };
  if (TEMPORAL.has(name)) return { kind: 'temporal', javaType: name };
  if (name === 'java.lang.Class') return { kind: 'class', javaType: name };
  if (name === 'java.time.Duration') return { kind: 'duration', javaType: name, durationKind: 'unknown' };
  const local = environment?.get(name);
  if (local?.length === 1) return { kind: local[0].type.kind === 'enum' ? 'enum' : 'object', javaType: name };
  if (['java.lang.Object', 'java.lang.Number', 'java.util.UUID', 'jakarta.persistence.Tuple', 'javax.persistence.Tuple'].includes(name)) return { kind: 'object', javaType: name };
  return UNKNOWN('External or ambiguous Java type: ' + name);
}
function splitTop(tokens, delimiter = ',') {
  const values = []; let start = 0, depth = 0;
  for (let i = 0; i < tokens.length; i++) { if (tokens[i].text === '(') depth++; else if (tokens[i].text === ')') depth--; else if (!depth && tokens[i].text === delimiter) { values.push(tokens.slice(start, i)); start = i + 1; } }
  values.push(tokens.slice(start)); return values.filter(value => value.length);
}
function environmentFor(model) {
  const environment = new Map();
  for (const file of model.files || []) {
    if (!/\.java(?:$|[?#])/i.test(file.uri)) continue;
    const parsed = parseJavaFile(file);
    for (const type of parsed.types) { if (!environment.has(type.fqn)) environment.set(type.fqn, []); environment.get(type.fqn).push({ type, file: parsed }); }
  }
  return environment;
}
function analyzeQueryTypes(model, file, query, context = {}, hooks = {}) {
  const profile = context.providerProfile || provider.normalizeProviderProfile(model.options?.providerProfile);
  const environment = context.environment || environmentFor(model), diagnostics = [], errors = [], unknowns = new Set(), supported = new Set(), parameters = new Map(), scopeResults = new Map(), ast = [];
  let checkedNodes = 0, totalNodes = 0, inferenceDepth = 0;
  query.providerAnalysis ||= provider.profileSummary(profile);
  function usedFeature(name){if(!query.providerAnalysis.usedFeatures.includes(name))query.providerAnalysis.usedFeatures.push(name);}
  for (const reason of context.unknownReasons || []) unknowns.add(reason);
  if (query.status === 'unknown' && query.reason) unknowns.add('Path/declaration binding is partial: ' + query.reason);
  const records = managed(model), find = fqn => unique(records.filter(item => item.fqn === fqn));
  const spans = (start, end) => hooks.sourceSpans ? hooks.sourceSpans(query, start, end) : [{ uri: file.uri, range: rangeAt(file.text, query._map?.[start] ?? 0, query._ends?.[end - 1] ?? query._map?.[start] ?? 0) }];
  function unknown(message, node) { unknowns.add(message); if (node) node.type = UNKNOWN(message); return UNKNOWN(message); }
  function error(code, message, node) { errors.push({ code: 'jpa.type.' + code, message, start: node?.start ?? 0, end: node?.end ?? query.text?.length ?? 0 }); }
  function numeric(value) { return value?.kind === 'numeric'; }
  function root(fqn) { let record = find(fqn), count = 0; while (record?.superFqn && count++ < 32) record = find(record.superFqn); return record?.fqn; }
  function compatible(actual, expected, mode = 'compare') {
    if (!actual || !expected || [actual.kind, expected.kind].includes('unknown') || [actual.kind, expected.kind].includes('parameter')) return null;
    if (actual.kind === 'null') return true;
    if (expected.kind === 'choice') { const matches = expected.alternatives.map(value => compatible(actual, value, mode)); return matches.includes(true) ? true : matches.includes(null) ? null : false; }
    if (actual.kind === 'choice') { const matches = actual.alternatives.map(value => compatible(value, expected, mode)); return matches.includes(true) ? true : matches.includes(null) ? null : false; }
    if (actual.kind === 'array' && expected.kind === 'collection') { if(profile.enabled&&context.parameterContract==='spring-data-method'||provider.feature(profile,'arrayCollectionBindings')){usedFeature(context.parameterContract==='spring-data-method'?'spring-data-array-binding':'profile-array-binding');return compatible(actual.elementType,expected.elementType,mode);}return null; }
    if (actual.kind === 'collection' && expected.kind === 'array') return null;
    if (expected.kind === 'numeric' && !expected.javaType) return numeric(actual) ? !expected.integral || !['java.lang.Float','java.lang.Double','java.math.BigDecimal'].includes(actual.javaType) : false;
    if (expected.kind==='temporal'&&!expected.javaType)return actual.kind==='temporal';
    if (expected.kind==='enum'&&!expected.javaType)return actual.kind==='enum';
    if (expected.kind==='comparable')return ['numeric','string','character','temporal','enum'].includes(actual.kind)?true:actual.kind==='object'?null:false;
    if (expected.javaType === 'java.lang.Object') return actual.kind !== 'collection';
    if (expected.javaType === 'java.lang.Number') return numeric(actual);
    if (actual.javaType && actual.javaType === expected.javaType) return true;
    if (numeric(actual) && numeric(expected)) return mode === 'result' || mode === 'constructor' ? null : true;
    if (actual.kind === 'entity' && expected.kind === 'entity') {
      if (!root(actual.javaType) || root(actual.javaType) !== root(expected.javaType)) return false;
      if (mode === 'compare') return true;
      let current = find(actual.javaType), count = 0; while (current && count++ < 32) { if (current.fqn === expected.javaType) return true; current = find(current.superFqn); } return null;
    }
    if (actual.kind === 'collection' && expected.kind === 'collection') return expected.elementType?.kind==='unknown'?true:compatible(actual.elementType, expected.elementType, mode);
    if (actual.kind === 'array' && expected.kind === 'array') return expected.elementType?.kind==='unknown'?true:compatible(actual.elementType, expected.elementType, mode);
    if (actual.kind === 'temporal' && expected.kind === 'temporal') return null;
    if (actual.kind === 'character' && expected.kind === 'string' || actual.kind === 'string' && expected.kind === 'character') return actual.literalLength === 1 || expected.literalLength === 1 ? true : null;
    // Provider enum/string coercion and external inheritance are not inferred.
    if (actual.kind === 'enum' && expected.kind === 'string' || actual.kind === 'string' && expected.kind === 'enum') return null;
    if (actual.kind === 'object' || expected.kind === 'object') return null;
    return false;
  }
  const bindings = [...(context.bindings || []), ...(context.symbolicParameters || [])];
  function parameter(node) {
    let item = parameters.get(node.key);
    if (!item) {
      const values = bindings.filter(value => node.name !== undefined ? value.name === node.name : value.position === node.position);
      const types = [...new Set(values.map(value => value.javaType).filter(Boolean))];
      item = { key: node.key, ...(node.name === undefined ? { position: node.position } : { name: node.name }), expectedTypes: [], boundType: types.length === 1 ? typeFromJava(types[0], model, environment) : null, bindingSource: [...new Set(values.map(value => value.source || 'static-source'))], synthetic: values.some(value => value.source === 'spel'), locations: [], bindingUnresolved: values.some(value => value.state === 'unknown') || types.length > 1, state: 'unbound' };
      if (node.position !== undefined && node.position < 1) error('parameter.ordinal', 'Positional JPQL parameters start at 1.', node);
      parameters.set(node.key, item);
    }
    item.locations.push({ start: node.start, end: node.end });
    return { kind: 'parameter', javaType: null, key: node.key };
  }
  function valueType(type) {
    if (type?.kind !== 'parameter') return type;
    const item = parameters.get(type.key); return item?.boundType || item?.expectedTypes.find(value => value.kind !== 'unknown' && value.kind !== 'choice' && value.javaType) || item?.expectedTypes.find(value => value.kind !== 'unknown' && value.kind !== 'choice') || UNKNOWN('Parameter scalar/collection or Java type is not constrained.');
  }
  function requireType(node, expected, message) {
    const type = node.type;
    if (type?.kind === 'parameter') { parameters.get(type.key).expectedTypes.push(expected); return; }
    const match = compatible(type, expected);
    if (match === false) error('argument', message, node);
    else if (match === null) unknown(message + ' Compatibility is unresolved.');
  }
  function compare(left, right, node, label = 'Compared expressions') {
    if (left.type?.kind === 'parameter') { parameters.get(left.type.key).expectedTypes.push(valueType(right.type)); return; }
    if (right.type?.kind === 'parameter') { parameters.get(right.type.key).expectedTypes.push(valueType(left.type)); return; }
    const match = compatible(left.type, right.type);
    if (match === false) error('comparison', label + ' have incompatible Java domain types: ' + display(left.type) + ' and ' + display(right.type) + '.', node);
    else if (match === null) unknown(label + ' compatibility is unresolved.');
  }
  function display(type) { return type?.javaType || type?.kind || 'unknown'; }
  function promote(types, operator) {
    const values = types.map(valueType).filter(value => value.kind !== 'null');
    if (!values.length) return { kind: 'null', javaType: null };
    if (values.some(value => value.kind === 'unknown' || value.kind === 'parameter')) return UNKNOWN('Numeric result promotion is unresolved.');
    if (values.some(value => !numeric(value))) return INVALID('Known nonnumeric arithmetic operand.');
    const names = values.map(value => SMALL.has(value.javaType) ? 'java.lang.Integer' : value.javaType), name = [...NUMERIC].reverse().find(value => names.includes(value));
    if (names.some(value => !value) && name !== 'java.lang.Double') return unknown('Numeric parameter has no concrete Java result type.');
    if (operator === '/' && !['java.lang.Double', 'java.lang.Float', 'java.math.BigDecimal'].includes(name)) return unknown('Integral division has a provider/database-dependent result type.');
    return { kind: 'numeric', javaType: name };
  }
  function common(nodes, at) {
    const values = nodes.map(item => valueType(item.type)).filter(value => value.kind !== 'null');
    if (!values.length) return { kind: 'null', javaType: null };
    if (values.every(numeric)) return promote(values);
    if (values.every(value => compatible(value, values[0]) === true)) return values[0];
    if (values.some(value => value.kind === 'unknown')) return unknown('CASE/COALESCE branch type is unresolved.');
    if (values.some(value => compatible(value, values[0]) === null)) return unknown('CASE/COALESCE common Java type is provider-dependent.');
    error('branches', 'CASE/COALESCE branches have incompatible Java domain types.', at); return INVALID('Incompatible branch types.');
  }
  function alias(scope, name) { for (let current = scope; current; current = current.parent === null ? null : query._scopes[current.parent]) if (Object.hasOwn(current.aliases, name.toLowerCase())) return current.aliases[name.toLowerCase()]; return undefined; }
  function attribute(type, name, node) {
    const record = find(type.javaType); if (!record) return unknown('Persistent path target is not a unique local managed type.', node);
    const field = record.attributes.find(value => value.name === name); if (!field) return unknown('Persistent path type is absent or incomplete: ' + name, node);
    if (field.collection) return { kind: 'collection', javaType: field.javaType, elementType: typeFromJava(field.targetFqn || field.elementJavaType, model, environment) };
    return typeFromJava(field.targetFqn || field.javaType, model, environment);
  }
  function path(node, scope) {
    const [head, ...tail] = node.parts;
    let fqn = alias(scope, head), type;
    if (fqn !== undefined) type = typeFromJava(fqn, model, environment);
    else if (scope.resultAliases && Object.hasOwn(scope.resultAliases, head.toLowerCase())) type = scope.resultAliases[head.toLowerCase()];
    else {
      const full = node.parts.join('.'), enumClass = unique([...environment.keys()].filter(name => full.startsWith(name + '.') && environment.get(name).length === 1 && environment.get(name)[0].type.kind === 'enum'));
      if (enumClass) return { kind: 'enum', javaType: enumClass };
      const entity = unique(model.entities.filter(value => value.entityNameKnown !== false && (value.name === full || value.fqn === full)));
      if (entity) return { kind: 'class', javaType: 'java.lang.Class', entityType: entity.fqn };
      return unknown('An expression path/identifier is unresolved: ' + full, node);
    }
    for (const name of tail) {
      if (type.kind === 'collection') return unknown('Collection traversal requires an explicit member alias.', node);
      type = attribute(type, name, node);
    }
    return type;
  }
  function constructor(node) {
    const entries = environment.get(node.className);
    if (entries?.length !== 1) return unknown('DTO class/signature is external or ambiguous: ' + node.className, node);
    const { type, file: source } = entries[0];
    if (type.kind !== 'class' || source.issues.some(value => /Unbalanced|Unsupported|Nested|Unicode/.test(value))) return unknown('DTO constructor source coverage is partial.', node);
    let candidates = type.methods.filter(method => method.constructor);
    if (!candidates.length) candidates = [{ parameters: [] }];
    candidates = candidates.filter(method => method.parameters.length === node.args.length);
    const results = candidates.map(method => method.parameters.map((parameter, i) => compatible(valueType(node.args[i].type), typeFromJava(parameter.type.array ? parameter.type.name + '[]' : parameter.type.name, model, environment), 'constructor')));
    if (!results.some(values => values.every(value => value === true))) {
      if (results.some(values => values.every(value => value !== false))) return unknown('DTO constructor overload matching is unresolved.', node);
      error('constructor', 'No supported local constructor of ' + node.className + ' accepts (' + node.args.map(arg => display(valueType(arg.type))).join(', ') + ').', node);
    }
    return { kind: 'object', javaType: node.className };
  }
  function functionType(node) {
    const args = node.args, name = node.name, arity = (minimum, maximum = minimum) => { if (args.length < minimum || args.length > maximum) error('arity', name.toUpperCase() + ' has incompatible argument count.', node); };
    const need = (index, expected, label) => { if (args[index]) requireType(args[index], expected, name.toUpperCase() + ' requires ' + label + ' argument ' + (index + 1) + '.'); };
    const number = { kind: 'numeric', javaType: null };
    supported.add('function:' + name);
    const invokedName=name==='function'&&args[0]?.kind==='literal'&&args[0].literalKind==='string'?args[0].value:name;
    const contract=provider.functionContract(profile,invokedName,context.providerDeclarations||[]),actualArgs=name==='function'?args.slice(1):args;
    const builtins=new Set('lower upper length trim concat replace substring left right locate count avg sum min max abs ceiling floor exp ln sqrt sign mod power round coalesce nullif size type id version extract current_date current_time current_timestamp local_date local_time local_datetime'.split(' '));
    if(contract&&contract.certainty!=='registry-presence-only'){
      query.providerAnalysis.usedFunctions.push({name:invokedName,certainty:contract.certainty,registryObserved:Boolean(provider.descriptor(profile,invokedName)),contributor:contract.contributor||null});
      if(contract.certainty!=='runtime-profile-contract')unknown('Function '+invokedName+' has a source/declared contract; runtime activation/overrides are not proved.');
      if(actualArgs.length<contract.minArgs||actualArgs.length>contract.maxArgs)error('provider.arity','Function '+invokedName+' argument count does not match the selected profile.',node);
      for(let i=0;i<actualArgs.length;i++){
        const expected=contract.arguments?.[i];if(!expected){if(i<contract.maxArgs)unknown('Provider function argument metadata is incomplete: '+invokedName);continue;}
        if(expected.category==='ANY'&&!expected.javaType)continue;
        const categories={STRING,NUMERIC:number,INTEGER:{...number,integral:true},BOOLEAN:BOOL,TEMPORAL:{kind:'temporal',javaType:null},DATE:{kind:'temporal',javaType:null},TIME:{kind:'temporal',javaType:null},COMPARABLE:{kind:'comparable',javaType:null},ENUM:{kind:'enum',javaType:null},COLLECTION:{kind:'collection',javaType:null,elementType:UNKNOWN('Any collection element.')},ARRAY:{kind:'array',javaType:null,elementType:UNKNOWN('Any array element.')}};
        const expectedType=expected.javaType?typeFromJava(expected.javaType,model,environment):categories[expected.category];
        if(expectedType)requireType(actualArgs[i],expectedType,'Function '+invokedName+' argument '+(i+1)+' does not match its provider-profile contract.');else unknown('Provider function argument category is unsupported.');
      }
      return contract.returns?.javaType?typeFromJava(contract.returns.javaType,model,environment):Number.isInteger(contract.returns?.argumentIndex)?valueType(actualArgs[contract.returns.argumentIndex]?.type)||unknown('Provider argument-based return type is unresolved.'):unknown('Provider function return contract is unresolved.');
    }
    if(contract&&(!builtins.has(name)||contract.overridden)){
      query.providerAnalysis.usedFunctions.push({name:invokedName,certainty:'registry-presence-only',registryObserved:true});return unknown('The runtime registry reports '+invokedName+' but does not provide a structured return/argument contract.');
    }
    if (['lower', 'upper', 'length', 'trim'].includes(name)) { arity(1, name === 'trim' ? 2 : 1); need(0, STRING, 'a String'); if (args[1]) need(1, STRING, 'a character/String'); return name === 'length' ? INT : STRING; }
    if (['concat', 'replace', 'substring', 'left', 'right', 'locate'].includes(name)) {
      if (name === 'concat') arity(2, 256); else if (name === 'replace') arity(3); else if (name === 'locate') arity(2, 3); else if (name === 'substring') arity(2, 3); else arity(2);
      const stringCount = name === 'concat' || name === 'replace' ? args.length : name === 'locate' ? 2 : 1;
      for (let i = 0; i < args.length; i++) {
        if (i < stringCount && numeric(valueType(args[i].type))) unknown(name.toUpperCase() + ' numeric-to-string coercion is provider-dependent.');
        else need(i, i < stringCount ? STRING : number, i < stringCount ? 'a String' : 'an integer');
      }
      return name === 'locate' ? INT : STRING;
    }
    if (['count', 'avg', 'sum', 'min', 'max'].includes(name)) {
      arity(1); if (name === 'count') return LONG;
      if (['avg', 'sum'].includes(name)) need(0, number, 'a numeric');
      const type = valueType(args[0]?.type);
      if (name === 'avg') return DOUBLE;
      if (name === 'sum') return numeric(type) ? ['java.math.BigInteger', 'java.math.BigDecimal'].includes(type.javaType) ? type : ['java.lang.Double', 'java.lang.Float'].includes(type.javaType) ? DOUBLE : LONG : type?.kind === 'unknown' ? UNKNOWN('SUM argument type is unresolved.') : INVALID('Nonnumeric SUM argument.');
      if (!['numeric', 'string', 'character', 'temporal', 'unknown', 'parameter', 'null'].includes(type?.kind)) error('aggregate', name.toUpperCase() + ' requires an orderable scalar domain type.', node);
      return type || UNKNOWN('Aggregate argument is missing.');
    }
    if (['abs', 'ceiling', 'floor', 'exp', 'ln', 'sqrt', 'sign', 'mod', 'power', 'round'].includes(name)) {
      arity(['mod', 'power', 'round'].includes(name) ? 2 : 1); args.forEach((_, i) => need(i, number, 'a numeric'));
      if (['exp', 'ln', 'sqrt', 'power'].includes(name)) return DOUBLE;
      if (['sign', 'mod'].includes(name)) return INT;
      const type = valueType(args[0]?.type); return numeric(type) ? type : type?.kind === 'unknown' ? UNKNOWN('Arithmetic function result is unresolved.') : INVALID('Nonnumeric function argument.');
    }
    if (name === 'coalesce') { arity(2, 256); return common(args, node); }
    if (name === 'nullif') { arity(2); if (args.length === 2) compare(args[0], args[1], node, 'NULLIF arguments'); return valueType(args[0]?.type) || UNKNOWN('NULLIF argument is missing.'); }
    if (name === 'size') { arity(1); if (args[0]?.type.kind === 'parameter') requireType(args[0], { kind: 'collection', javaType: null, elementType: UNKNOWN('Collection element is unresolved.') }, 'SIZE requires a collection.'); else if (args[0]?.type.kind !== 'collection' && args[0]?.type.kind !== 'unknown') error('collection', 'SIZE requires a collection-valued path.', node); return INT; }
    if (name === 'type') { arity(1); if (args[0] && valueType(args[0].type).kind !== 'entity') unknown('TYPE argument is not resolved to a managed entity.'); return { kind: 'class', javaType: 'java.lang.Class' }; }
    if (name === 'id' || name === 'version') { arity(1); const record = find(valueType(args[0]?.type)?.javaType), fields = record?.attributes.filter(value => name === 'id' ? value.id : value.version); return fields?.length === 1 ? typeFromJava(fields[0].javaType, model, environment) : unknown('ID/VERSION result type is composite, absent or unresolved.'); }
    if (name === 'extract') { arity(1); if (args[0] && valueType(args[0].type).kind !== 'temporal') { if (valueType(args[0].type).kind === 'unknown') unknown('EXTRACT temporal argument is unresolved.'); else error('temporal', 'EXTRACT requires a temporal Java domain type.', node); } const field = node.field?.toLowerCase(),extension=field&&provider.extractType(profile,field);if(extension){usedFeature('extract-extension');return typeFromJava(extension,model,environment);} if (field === 'second') return DOUBLE; if (['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute'].includes(field)) return INT; if (field === 'date') return { kind: 'temporal', javaType: 'java.time.LocalDate' }; if (field === 'time') return { kind: 'temporal', javaType: 'java.time.LocalTime' }; return unknown('EXTRACT field is unresolved.'); }
    const temporal = { current_date: 'java.sql.Date', current_time: 'java.sql.Time', current_timestamp: 'java.sql.Timestamp', local_date: 'java.time.LocalDate', local_time: 'java.time.LocalTime', local_datetime: 'java.time.LocalDateTime' }[name];
    if (temporal) { arity(0); return { kind: 'temporal', javaType: temporal }; }
    return unknown('Function result/argument contract is external or unsupported: ' + name, node);
  }
  function infer(node, scope) {
    if (!node) return unknown('Expression AST is absent.');
    if(inferenceDepth>=128)return unknown('Typed AST traversal depth exceeded its bounded limit.',node);inferenceDepth++;
    totalNodes++; let type;
    switch (node.kind) {
      case 'literal':
        type = node.literalKind === 'string' ? { ...STRING, literalLength: node.value.length } : node.literalKind === 'null' ? { kind: 'null', javaType: null } : ['true', 'false'].includes(node.literalKind) ? BOOL : !/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[fFdDlL]?$/.test(node.value) ? unknown('Numeric literal form is unsupported.') : /^\d+[lL]$/.test(node.value) ? LONG : /[fF]$/.test(node.value) ? { kind: 'numeric', javaType: 'java.lang.Float' } : /[.eEdD]/.test(node.value) ? DOUBLE : /^\d+$/.test(node.value) ? INT : unknown('Numeric literal form is unsupported.'); break;
      case 'parameter': type = parameter(node); break;
      case 'path': type = path(node, scope); break;
      case 'star': type = { kind: 'star', javaType: null }; break;
      case 'member': type = attribute(infer(node.object, scope), node.property, node); break;
      case 'constructor': node.args.forEach(arg => infer(arg, scope)); type = constructor(node); supported.add('constructor'); break;
      case 'function': node.args.forEach(arg => infer(arg, scope)); type = functionType(node); break;
      case 'treat': {
        const base = infer(node.value, scope), target = unique(model.entities.filter(value => value.name === node.target || value.fqn === node.target));
        if (!target || base.kind !== 'entity') type = unknown('TREAT target/base type is unresolved.');
        else { let current = find(target.fqn), depth = 0; while (current && current.fqn !== base.javaType && depth++ < 32) current = find(current.superFqn); type = current ? { kind: 'entity', javaType: target.fqn } : unknown('TREAT managed subtype relationship is unresolved.'); }
        supported.add('treat'); break;
      }
      case 'cast': { infer(node.value, scope); const name = provider.castType(profile,node.target)||{ string: 'java.lang.String', integer: 'java.lang.Integer', long: 'java.lang.Long', float: 'java.lang.Float', double: 'java.lang.Double' }[node.target.toLowerCase()]; type = name ? typeFromJava(name, model, environment) : unknown('CAST target is unsupported.');if(provider.castType(profile,node.target))usedFeature('cast-extension'); supported.add('cast'); break; }
      case 'duration':{infer(node.amount,scope);requireType(node.amount,{kind:'numeric',javaType:null},'Duration magnitude requires a numeric expression.');type=provider.feature(profile,'temporalArithmetic')?{kind:'duration',javaType:'java.time.Duration',durationKind:['year','quarter','month','week','day'].includes(node.unit)?'year-day':'week-nanosecond'}:unknown('Duration literals require a supported provider profile.');usedFeature('duration-literal');break;}
      case 'duration-conversion':{const value=infer(node.value,scope);if(!provider.feature(profile,'temporalArithmetic')||value.kind!=='duration')type=unknown('Duration conversion source/provider is unresolved.');else{type=LONG;usedFeature('duration-conversion');}break;}
      case 'filter':{infer(node.predicate,scope);requireType(node.predicate,BOOL,'Aggregate FILTER requires a Boolean predicate.');type=infer(node.value,scope);if(!provider.feature(profile,'filterClause'))type=unknown('FILTER requires a supported provider profile.');else if(node.value.kind!=='function'||!['count','sum','avg','min','max'].includes(node.value.name))type=unknown('FILTER on this function kind is not covered.');usedFeature('aggregate-filter');break;}
      case 'window':{type=infer(node.value,scope);node.partition.forEach(value=>infer(value,scope));node.order.forEach(value=>infer(value,scope));for(const boundary of[node.frame?.start,node.frame?.end])if(boundary?.expression){infer(boundary.expression,scope);requireType(boundary.expression,{kind:'numeric',javaType:null},'Window frame offset requires a supported numeric expression.');}if(!provider.feature(profile,'windowFunctions'))type=unknown('Window functions require a supported provider profile.');usedFeature('aggregate-window');break;}
      case 'subquery': { const child = query._scopes.find(value => value.start === node.bodyStart); const result = child && analyzeScope(child); type = result?.selectionTypes.length === 1 ? { kind: 'subquery', javaType: null, elementType: result.selectionTypes[0] } : unknown('Subquery projection is absent or non-scalar.'); supported.add('subquery'); break; }
      case 'quantified': { const value = infer(node.argument, scope); type = value.kind === 'subquery' ? value.elementType : unknown('ALL/ANY/SOME requires a scalar subquery.'); break; }
      case 'exists': { const value = infer(node.argument, scope); if (value.kind !== 'subquery') unknown('EXISTS subquery is unresolved.'); type = BOOL; break; }
      case 'unary': { const value = infer(node.argument, scope);if(profile.enabled&&value.kind==='duration'&&['+','-'].includes(node.op))type=value;else{requireType(node.argument, node.op === 'not' ? BOOL : { kind: 'numeric', javaType: null }, 'Unary ' + node.op + ' has an incompatible operand.'); type = node.op === 'not' ? BOOL : valueType(value);} break; }
      case 'binary': {
        infer(node.left, scope); infer(node.right, scope);
        if (['and', 'or'].includes(node.op)) { requireType(node.left, BOOL, 'Boolean operator requires Boolean operands.'); requireType(node.right, BOOL, 'Boolean operator requires Boolean operands.'); type = BOOL; }
        else if (['+', '-', '*', '/'].includes(node.op)) { if ([valueType(node.left.type)?.kind,valueType(node.right.type)?.kind].some(kind=>['temporal','duration'].includes(kind))){const inferred=provider.temporalArithmetic(profile,node.op,valueType(node.left.type),valueType(node.right.type));type=inferred&&!inferred.unknown?inferred:unknown(inferred?.unknown||'Temporal/duration arithmetic uses provider/HQL semantics outside the numeric JPQL type subset.');if(inferred)usedFeature('temporal-arithmetic');} else { requireType(node.left, { kind: 'numeric', javaType: null }, 'Arithmetic requires numeric operands.'); requireType(node.right, { kind: 'numeric', javaType: null }, 'Arithmetic requires numeric operands.'); type = promote([node.left.type, node.right.type], node.op); } }
        else if (node.op === '||') { requireType(node.left, STRING, 'String concatenation requires String operands.'); requireType(node.right, STRING, 'String concatenation requires String operands.'); type = STRING; }
        else if (node.op.endsWith('member')) { const collection = valueType(node.right.type); if (collection.kind === 'collection') { const proxy = { type: collection.elementType }; compare(node.left, proxy, node, 'Collection MEMBER operands'); } else if (collection.kind === 'parameter') unknown('MEMBER collection element type is unresolved.'); else if (collection.kind !== 'unknown') error('collection', 'MEMBER OF requires a collection-valued path.', node); type = BOOL; }
        else { const left = node.left.type.kind === 'subquery' ? { ...node.left, type: node.left.type.elementType } : node.left, right = node.right.type.kind === 'subquery' ? { ...node.right, type: node.right.type.elementType } : node.right; compare(left, right, node); type = BOOL; }
        supported.add('operator:' + node.op); break;
      }
      case 'like': infer(node.argument, scope); infer(node.pattern, scope); requireType(node.argument, STRING, 'LIKE requires a String expression.'); requireType(node.pattern, STRING, 'LIKE requires a String pattern.'); if (node.escape) { infer(node.escape, scope); requireType(node.escape, STRING, 'LIKE ESCAPE requires a character/String.'); } type = BOOL; break;
      case 'between': infer(node.argument, scope); infer(node.lower, scope); infer(node.upper, scope); compare(node.argument, node.lower, node); compare(node.argument, node.upper, node); type = BOOL; break;
      case 'in': {
        infer(node.argument, scope); for (const value of node.values) { infer(value, scope); if (value.type.kind === 'parameter' && node.values.length === 1) { const elementType = valueType(node.argument.type), collection = { kind: 'collection', javaType: null, elementType }; parameters.get(value.type.key).expectedTypes.push(node.form === 'list' ? { kind: 'choice', javaType: null, alternatives: [elementType, collection] } : collection); } else { const type = value.type.kind === 'subquery' || value.type.kind === 'collection' ? value.type.elementType : value.type; compare(node.argument, { ...value, type }, node, 'IN/subquery operands'); } } type = BOOL; supported.add('in'); break;
      }
      case 'is': infer(node.argument, scope); if (node.test === 'empty' && valueType(node.argument.type).kind !== 'collection') { if (valueType(node.argument.type).kind === 'unknown') unknown('IS EMPTY collection is unresolved.'); else error('collection', 'IS EMPTY requires a collection-valued path.', node); } if (['true', 'false'].includes(node.test)) requireType(node.argument, BOOL, 'IS TRUE/FALSE requires a Boolean expression.'); type = BOOL; break;
      case 'case': {
        if (node.base) infer(node.base, scope);
        for (const branch of node.branches) { infer(branch.condition, scope); if (node.base) compare(node.base, branch.condition, node); else requireType(branch.condition, BOOL, 'Searched CASE requires Boolean WHEN predicates.'); infer(branch.result, scope); }
        if (node.otherwise) infer(node.otherwise, scope); type = common([...node.branches.map(value => value.result), ...(node.otherwise ? [node.otherwise] : [])], node); supported.add('case'); break;
      }
      default: type = unknown(node.reason || 'Unsupported expression AST: ' + node.kind, node);
    }
    node.type = type || UNKNOWN('Expression type is unresolved.'); if (node.type.kind === 'unknown') unknowns.add(node.type.reason || 'Expression type is unresolved.'); else checkedNodes++; inferenceDepth--; return node.type;
  }
  function parse(tokens, scope, label, selection = false) {
    const result = parseExpression(tokens, { selection, provider: profile.enabled });
    if (result.issues.length) { result.issues.forEach(value => unknown(label + ': ' + value)); result.ast._partial = true; }
    infer(result.ast, scope); ast.push({ clause: label, scope: scope.start, expression: result.ast });
    if (selection && result.resultAlias) { scope.resultAliases ||= Object.create(null); scope.resultAliases[result.resultAlias.toLowerCase()] = result.ast.type; }
    return result.ast;
  }
  function analyzeScope(scope) {
    if (scopeResults.has(scope.start)) return scopeResults.get(scope.start);
    const result = { selectionTypes: [] }; scopeResults.set(scope.start, result);
    const tokens = query._tokens.slice(scope.tokenStart, scope.tokenEnd), top = []; let depth = 0;
    for (let i = 0; i < tokens.length; i++) { if (tokens[i].text === '(') depth++; else if (tokens[i].text === ')') depth--; else if (!depth && tokens[i].kind === 'id' && tokens[i - 1]?.text !== '.') top.push({ word: tokens[i].lower, index: i }); }
    const clause = word => top.find(value => value.word === word)?.index ?? -1;
    const boundary = index => Math.min(tokens.length, ...['where', 'group', 'having', 'order'].map(clause).filter(value => value > index));
    if (scope.statement === 'select') {
      const from = clause('from'); let start = tokens[0]?.lower === 'select' ? 1 : 0; if (tokens[start]?.lower === 'distinct') start++;
      if (from > start) for (const part of splitTop(tokens.slice(start, from))) { const expression = parse(part, scope, 'select', true); const type = valueType(expression.type); result.selectionTypes.push(type); if (['collection', 'subquery'].includes(type.kind)) unknown('Direct collection/scalar-subquery projection grammar is outside the typed JPQL subset.'); }
      else unknown('SELECT projection syntax is absent or implicit.');
    }
    for (const item of top.filter(value => value.word === 'on')) {
      const end = Math.min(boundary(item.index), ...top.filter(value => value.index > item.index && ['join', 'left', 'right', 'inner', 'outer'].includes(value.word)).map(value => value.index));
      const expression = parse(tokens.slice(item.index + 1, end), scope, 'join-on'); requireType(expression, BOOL, 'JOIN ON requires a Boolean predicate.');
    }
    for (const name of ['where', 'having']) {
      const at = clause(name); if (at < 0) continue; const expression = parse(tokens.slice(at + 1, boundary(at)), scope, name); requireType(expression, BOOL, name.toUpperCase() + ' requires a Boolean predicate.');
    }
    for (const name of ['group', 'order']) {
      const at = clause(name); if (at < 0) continue;
      for (let part of splitTop(tokens.slice(at + (tokens[at + 1]?.lower === 'by' ? 2 : 1), boundary(at)))) {
        if (name === 'order') { const suffix = part.findIndex(token => ['asc', 'desc', 'nulls'].includes(token.lower)); if (suffix >= 0) part = part.slice(0, suffix); }
        const expression = parse(part, scope, name + '-by'); if (valueType(expression.type).kind === 'collection') unknown('Collection-valued GROUP/ORDER expression is provider-specific.');
      }
    }
    if (scope.statement === 'update') {
      const set = clause('set'); if (set < 0) unknown('UPDATE SET clause is absent.');
      else for (const assignment of splitTop(tokens.slice(set + 1, boundary(set)))) {
        const equals = assignment.findIndex(token => token.text === '='); if (equals < 0) { unknown('UPDATE assignment boundary is unresolved.'); continue; }
        let left = assignment.slice(0, equals);
        if (left.length === 1 && left[0].kind === 'id') { const rootRecord = find(scope.rootFqn); const field = rootRecord?.attributes.find(value => value.name === left[0].text); const target = field && typeFromJava(field.targetFqn || field.javaType, model, environment), right = parse(assignment.slice(equals + 1), scope, 'update-value'); if (!target) unknown('Unqualified UPDATE field is unresolved.'); else { const match = compatible(valueType(right.type), target, 'assignment'); if (right.type.kind === 'parameter') parameters.get(right.type.key).expectedTypes.push(target); else if (match === false) error('assignment', 'UPDATE value is incompatible with the Java domain attribute type.', right); else if (match === null) unknown('UPDATE assignment compatibility is unresolved.'); } }
        else { const target = parse(left, scope, 'update-target'), right = parse(assignment.slice(equals + 1), scope, 'update-value'); if (right.type.kind === 'parameter') parameters.get(right.type.key).expectedTypes.push(valueType(target.type)); else { const match = compatible(valueType(right.type), valueType(target.type), 'assignment'); if (match === false) error('assignment', 'UPDATE value is incompatible with ' + display(valueType(target.type)) + '.', right); else if (match === null) unknown('UPDATE assignment compatibility is unresolved.'); } }
      }
    }
    supported.add('statement:' + scope.statement); return result;
  }
  if (!query.text || query._unsupported || !query._scopes?.length) unknown('Query syntax/source is outside the supported typed JPQL subset.');
  else {
    const result = analyzeScope(query._scopes[0]);
    const target = context.resultType && typeFromJava(context.resultType, model, environment);
    if (target && result.selectionTypes.length) {
      if (result.selectionTypes.length > 1) { if (!(target.kind === 'array' && target.elementType.javaType === 'java.lang.Object') && !['jakarta.persistence.Tuple', 'javax.persistence.Tuple', 'java.lang.Object'].includes(target.javaType)) error('result', 'Multiple select items require a compatible tuple/Object[] result target.', { start: 0, end: query.text.length }); }
      else { const match = compatible(result.selectionTypes[0], target, 'result'); if (match === false) error('result', 'Selected Java type ' + display(result.selectionTypes[0]) + ' is incompatible with result target ' + display(target) + '.', { start: 0, end: query.text.length }); else if (match === null) unknown('Typed result target compatibility is unresolved.'); }
    }
  }
  for (const item of parameters.values()) {
    item.expectedTypes = [...new Map(item.expectedTypes.map(type => [JSON.stringify(type), type])).values()];
    const known = item.expectedTypes.filter(type => type.kind !== 'unknown');
    for (let i = 0; i < known.length; i++) for (let j = i + 1; j < known.length; j++) if (compatible(known[i], known[j]) === false) error('parameter.conflict', 'Parameter ' + item.key + ' has incompatible query constraints.', item.locations[0]);
    if (item.boundType) {
      let unresolved = false, invalid = false;
      for (const expected of known) { const match = compatible(item.boundType, expected, 'binding'); if (match === false) invalid = true; else if (match === null) unresolved = true; }
      if (invalid) { error('parameter.binding', 'Static binding of ' + item.key + ' has Java type ' + display(item.boundType) + ', incompatible with its query usage.', item.locations[0]); item.state = 'invalid'; }
      else item.state = unresolved || item.boundType.kind === 'unknown' || item.bindingUnresolved ? 'unknown' : 'known';
    } else item.state = item.bindingUnresolved ? 'unknown' : known.length ? 'inferred' : 'unknown';
    if (context.parameterContract === 'spring-data-method' && !item.synthetic && !item.bindingSource.length) { error('parameter.missing', 'Query parameter ' + item.key + ' has no matching supported repository method binding.', item.locations[0]); item.state = 'invalid'; }
    if (item.state === 'unknown') unknown('Parameter binding/type is unresolved: ' + item.key);
    item.locations = item.locations.flatMap(value => spans(value.start, value.end));
  }
  const real = [...parameters.values()].filter(item => !item.synthetic);
  if (real.some(item => item.name !== undefined) && real.some(item => item.position !== undefined)) error('parameter.style', 'Named and positional JPQL parameters are mixed.', { start: 0, end: query.text?.length || 0 });
  const state = unknowns.size ? 'unknown' : errors.length ? 'invalid' : 'known';
  for (const item of errors) for (const span of spans(item.start, item.end)) diagnostics.push({ ...span, code: state === 'unknown' ? 'jpa.type.partial' : item.code, severity: state === 'unknown' ? 'information' : 'warning', message: item.message + (state === 'unknown' ? ' Overall typed coverage is partial; this is not a complete invalid-query verdict.' : ' Source type finding; no query was executed.') });
  if (unknowns.size) diagnostics.push({ uri: file.uri, range: query.range, code: 'jpa.type.unknown', severity: 'information', message: [...unknowns].join('; ') });
  query.providerAnalysis.state=profile.enabled?'conditional-on-profile':'unconfigured';
  const output = { state, selectionTypes: scopeResults.get(query._scopes?.[0]?.start)?.selectionTypes || [], parameters: [...parameters.values()], diagnostics, coverage: { supported: [...supported], unknown: [...unknowns], checkedNodes, totalNodes, allSupportedComponentsChecked: unknowns.size === 0 }, providerProfileId:profile.id, validityVerified: false, ast };
  query.typeAnalysis = output; model.diagnostics.push(...diagnostics); return output;
}

module.exports = { analyzeQueryTypes, typeFromJava, environmentFor };
