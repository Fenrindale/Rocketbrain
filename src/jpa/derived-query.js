'use strict';

const { matching,rangeAt,splitTop } = require('../spring/java');

const repositoryTypes = new Set([
  'org.springframework.data.jpa.repository.JpaRepository',
  ...['Repository','CrudRepository','ListCrudRepository','PagingAndSortingRepository','ListPagingAndSortingRepository']
    .map(name => 'org.springframework.data.repository.'+name)
]);
const specialRoles = new Map(Object.entries({
  ScrollPosition:'ScrollPosition',OffsetScrollPosition:'ScrollPosition',KeysetScrollPosition:'ScrollPosition',
  Pageable:'Pageable',PageRequest:'Pageable',Sort:'Sort',Limit:'Limit'
}).map(([name,role]) => ['org.springframework.data.domain.'+name,role]));
const bindableTypes = new Set([
  ...['String','CharSequence','Object','Boolean','Byte','Short','Integer','Long','Float','Double','Character','Iterable']
    .map(name => 'java.lang.'+name),
  ...['List','Set','Collection','ArrayList','HashSet','LinkedHashSet','LinkedList','Optional','UUID','Date'].map(name => 'java.util.'+name),
  ...['LocalDate','LocalTime','LocalDateTime','OffsetDateTime','Instant'].map(name => 'java.time.'+name),
  'java.math.BigInteger','java.math.BigDecimal','java.sql.Timestamp','java.sql.Date'
]);
const primitive = new Set(['boolean','byte','short','int','long','char','float','double']);
const reservedMethods = new Set(['findById','findAllById','existsById','deleteById']);
const subjectPattern = /^(?:find|read|get|query|search|stream|count|exists|delete|remove)(?:All|Distinct)?(?:First\d{0,8}|Top\d{0,8})?By/;
const supportedName = /^[\p{L}\p{N}_]+$/u;
const defaultPart = {operator:'SIMPLE_PROPERTY',arity:1};

function operator(operator,arity,suffixes,shape) { return {operator,arity,suffixes,shape}; }
const operators = [
  operator('IS_NOT_NULL',0,['IsNotNull','NotNull']),
  operator('IS_NULL',0,['IsNull','Null']),
  operator('BETWEEN',2,['IsBetween','Between']),
  operator('LESS_THAN',1,['IsLessThan','LessThan']),
  operator('LESS_THAN_EQUAL',1,['IsLessThanEqual','LessThanEqual']),
  operator('GREATER_THAN',1,['IsGreaterThan','GreaterThan']),
  operator('GREATER_THAN_EQUAL',1,['IsGreaterThanEqual','GreaterThanEqual']),
  operator('BEFORE',1,['IsBefore','Before']),
  operator('AFTER',1,['IsAfter','After']),
  operator('NOT_LIKE',1,['IsNotLike','NotLike'],'string'),
  operator('LIKE',1,['IsLike','Like'],'string'),
  operator('STARTING_WITH',1,['IsStartingWith','StartingWith','StartsWith'],'string'),
  operator('ENDING_WITH',1,['IsEndingWith','EndingWith','EndsWith'],'string'),
  operator('IS_NOT_EMPTY',0,['IsNotEmpty','NotEmpty'],'collection'),
  operator('IS_EMPTY',0,['IsEmpty','Empty'],'collection'),
  operator('NOT_CONTAINING',1,['IsNotContaining','NotContaining','NotContains'],'string-or-collection'),
  operator('CONTAINING',1,['IsContaining','Containing','Contains'],'string-or-collection'),
  operator('NOT_IN',1,['IsNotIn','NotIn'],'in'),
  operator('IN',1,['IsIn','In'],'in'),
  operator('UNSUPPORTED',0,['IsNear','Near','IsWithin','Within','MatchesRegex','Matches','Regex','Exists']),
  operator('TRUE',0,['IsTrue','True'],'boolean'),
  operator('FALSE',0,['IsFalse','False'],'boolean'),
  operator('NEGATING_SIMPLE_PROPERTY',1,['IsNot','Not']),
  operator('SIMPLE_PROPERTY',1,['Is','Equals'])
];

function resolveStandard(name,file,sourceTypes,allowed) {
  if (name.includes('.')) return allowed.has(name) ? name : undefined;
  if (file.imports[name]) return allowed.has(file.imports[name]) ? file.imports[name] : undefined;
  const local = file.packageName ? file.packageName+'.'+name : name;
  if (sourceTypes.has(local)) return undefined;
  if (allowed.has(local)) return local;
  const matches = [...new Set(file.wildcards)].map(pkg => pkg+'.'+name).filter(value => allowed.has(value));
  return matches.length === 1 ? matches[0] : undefined;
}

function repositoryDomain(file,type,sourceTypes,resolveType) {
  const index = file.tokens.findIndex(token => token.start === type.start);
  const open = file.tokens.findIndex((token,position) => position > index && token.text === '{');
  const header = file.tokens.slice(index+1,open);
  if (index < 0 || open < 0 || header[0]?.text !== 'extends') return undefined;
  const declarations = splitTop(header.slice(1));
  const candidates = declarations.flatMap(tokens => {
    const start = tokens.findIndex(token => token.text === '<');
    if (start < 1 || matching(tokens,start,'<','>') !== tokens.length-1) return [];
    const name = tokens.slice(0,start).map(token => token.text).join('');
    if (!resolveStandard(name,file,sourceTypes,repositoryTypes)) return [];
    const args = splitTop(tokens.slice(start+1,-1));
    const entity = args[0]?.map(token => token.text).join('');
    return args.length === 2 && /^[\p{L}_$][\p{L}\p{N}_$.]*$/u.test(entity) ? [resolveType(entity,file)] : [];
  });
  return candidates.length === 1 ? {domainFqn:candidates[0],customBases:declarations.length > 1} : undefined;
}

function segments(value,pattern,offset) {
  const result = [];
  let start = 0;
  for (const match of value.matchAll(pattern)) {
    result.push({text:value.slice(start,match.index),offset:offset+start});
    start = match.index+match[0].length;
  }
  result.push({text:value.slice(start),offset:offset+start});
  return result;
}

function sourcePropertyNames(type) {
  const names = new Set(type.sourceType?.fields?.map(field => field.name));
  for (const method of type.sourceType?.methods || []) {
    const getter = /^(?:get|is)(\p{Lu}.*)$/u.exec(method.name);
    if (getter && !method.parameters.length) names.add(decapitalize(getter[1]));
  }
  return names;
}

function decapitalize(value) {
  return /^\p{Lu}{2}/u.test(value) ? value : value[0].toLowerCase()+value.slice(1);
}

function attributeNamed(type,spelling,sourceNames) {
  const name = decapitalize(spelling);
  const alternative = spelling[0].toLowerCase()+spelling.slice(1);
  for (const candidate of new Set([name,alternative])) {
    const matches = type.attributes.filter(attribute => attribute.name === candidate);
    if (matches.length > 1) return {blocked:true};
    if (matches.length === 1) return {attribute:matches[0]};
    if (sourceNames.has(candidate)) return {blocked:true};
  }
  return {};
}

function resolvePath(domain,word,offset,managed) {
  const pieces = segments(word,/_/g,offset);
  if (pieces.length > 6 || pieces.some(piece => !piece.text.length)) {
    return {reason:'Use a bounded property path with one underscore per explicit traversal.'};
  }
  const unresolved = text => ({reason:'Persistent property path '+text+' is unresolved in the local entity model.'});
  const uniqueTarget = fqn => {
    const targets = fqn && managed.get(fqn);
    return targets?.length === 1 && targets[0];
  };
  function camel(type,text,start,allowSplit,depth) {
    if (!type?.attributesComplete || depth >= 6) return unresolved(text);
    const sourceNames = sourcePropertyNames(type);
    const direct = attributeNamed(type,text,sourceNames);
    if (direct.attribute) return {items:[{attribute:direct.attribute,start,end:start+text.length}]};
    if (direct.blocked || !allowSplit || !type.sourceType || type.superFqn ||
        /^(?:\p{Lu}{2}|[^\p{Lu}\p{Ll}])/u.test(text)) return unresolved(text);
    const heads = [];
    for (const match of text.matchAll(/\p{Lu}/gu)) {
      if (match.index === 0) continue;
      const prefix = attributeNamed(type,text.slice(0,match.index),sourceNames);
      if (prefix.attribute || prefix.blocked) heads.push({...prefix,length:match.index});
    }
    if (heads.length > 1) return {reason:'Property path '+text+' has competing prefixes. Use an underscore to select the traversal.'};
    const [head] = heads;
    if (!head?.attribute || head.attribute.collection || head.attribute.status !== 'known') return unresolved(text);
    const remainder = camel(uniqueTarget(head.attribute.targetFqn),text.slice(head.length),start+head.length,true,depth+1);
    if (!remainder.items) return remainder;
    return {items:[{attribute:head.attribute,start,end:start+head.length},...remainder.items]};
  }
  let type = domain;
  const items = [];
  for (let i=0; i<pieces.length; i++) {
    const piece = pieces[i];
    const result = camel(type,piece.text,piece.offset,pieces.length === 1,items.length);
    if (!result.items) return result;
    items.push(...result.items);
    const leaf = items.at(-1).attribute;
    if (i < pieces.length-1 && (leaf.collection || leaf.status !== 'known')) {
      return {reason:'Traversal needs a uniquely mapped non-collection intermediate property.'};
    }
    type = uniqueTarget(leaf.targetFqn);
  }
  return {items};
}

function partSpec(text) {
  const localCase = /Ignor(?:e|ing)Case$/.exec(text);
  const base = localCase ? text.slice(0,-localCase[0].length) : text;
  if (!base.length || /Ignor(?:e|ing)Case/.test(base)) return undefined;
  for (const candidate of operators) {
    const suffix = candidate.suffixes.find(value => base.endsWith(value));
    if (suffix) return {...candidate,path:base.slice(0,-suffix.length),ignoreCase:!!localCase};
  }
  return {...defaultPart,path:base,ignoreCase:!!localCase};
}

function shapeSupported(spec,attribute) {
  if (attribute.status !== 'known') return false;
  if (spec.ignoreCase && attribute.javaType !== 'java.lang.String') return false;
  if (spec.shape === 'boolean') return ['boolean','java.lang.Boolean'].includes(attribute.javaType);
  if (spec.shape === 'string') return attribute.javaType === 'java.lang.String';
  if (spec.shape === 'collection') return attribute.collection;
  if (spec.shape === 'string-or-collection') return attribute.collection || attribute.javaType === 'java.lang.String';
  return !attribute.collection;
}

function inspectExpression(domain,expression,start,managed) {
  const reject = reason => ({reason});
  if (!expression || expression.length > 240 || !supportedName.test(expression)) return reject('The derived method name is outside the bounded source grammar.');
  const sections = segments(expression,/OrderBy(?=\p{Lu}|[^\u0000-\u007f])/gu,start);
  if (sections.length > 2) return reject('Use at most one OrderBy clause.');
  let predicate = sections[0].text;
  const allCase = /AllIgnor(?:e|ing)Case$/.exec(predicate);
  if (allCase) predicate = predicate.slice(0,-allCase[0].length);
  if (/AllIgnor(?:e|ing)Case/.test(predicate) || /AllIgnor(?:e|ing)Case/.test(sections[1]?.text || '')) {
    return reject('Use AllIgnoreCase once at the end of the predicate.');
  }
  const groups = predicate ? segments(predicate,/Or(?=\p{Lu}|[^\u0000-\u007f])/gu,start)
    .map(value => segments(value.text,/And(?=\p{Lu}|[^\u0000-\u007f])/gu,value.offset)) : [];
  const orderings = sections.length === 2 ? segments(sections[1].text,/(?<=Asc|Desc)(?=\p{Lu})/gu,sections[1].offset) : [];
  if (groups.flat().length > 12 || orderings.length > 6 || (!groups.length && !orderings.length)) {
    return reject('Use at most twelve predicate parts and six static sort fields.');
  }
  const predicateGroups = [], order = [], refs = [];
  let expected = 0;
  for (const group of groups) {
    const criteria = [];
    for (const token of group) {
      const spec = partSpec(token.text);
      if (!spec?.path || spec.operator === 'UNSUPPORTED') return reject('A predicate operator or IgnoreCase placement is outside the supported source grammar.');
      const path = resolvePath(domain,spec.path,token.offset,managed);
      if (path.reason) return path;
      const leaf = path.items.at(-1).attribute;
      if (!shapeSupported(spec,leaf)) return reject('The operator '+spec.operator+' cannot be checked for '+spec.path+' in the source model.');
      refs.push(...path.items);
      criteria.push({path:path.items.map(item => item.attribute.name).join('.'),operator:spec.operator,arity:spec.arity,
        ignoreCase:spec.ignoreCase ? 'ALWAYS' : allCase ? 'WHEN_POSSIBLE' : 'NEVER'});
      expected += spec.arity;
    }
    predicateGroups.push(criteria);
  }
  for (const token of orderings) {
    const sorting = /^(.+?)(Asc|Desc)?$/.exec(token.text);
    if (!sorting || ['Asc','Desc'].includes(sorting[1])) return reject('A static sort needs a persistent property before its direction.');
    const path = resolvePath(domain,sorting[1],token.offset,managed);
    if (path.reason) return path;
    if (path.items.at(-1).attribute.collection || path.items.at(-1).attribute.status !== 'known') return reject('The static sort property cannot be checked from source.');
    refs.push(...path.items);
    order.push({path:path.items.map(item => item.attribute.name).join('.'),direction:sorting[2] === 'Desc' ? 'DESC' : 'ASC'});
  }
  return {predicateGroups,order,refs,expected};
}

function analyzeParameters(file,method,sourceTypes,inspected) {
  const i = file.tokens.findIndex(token => token.start === method.start);
  const close = matching(file.tokens,i+1);
  const declared = splitTop(file.tokens.slice(i+2,close)).filter(value => value.length);
  if (i < 0 || close < 0 || declared.length !== method.parameters.length || declared.length > 32) {
    return {reason:'The complete parameter list is not available in the local Java model.'};
  }
  const bindable = [], special = [];
  for (const parameter of method.parameters) {
    const {raw,array} = parameter.type;
    const base = raw.split(/[<\[]/)[0];
    if (!base || /@|\.\.\./.test(raw) || /(^|\.)Class$/.test(base)) {
      return {reason:'Varargs, type annotations and projection parameters require additional Java binding evidence.'};
    }
    const role = !array && specialRoles.get(resolveStandard(base,file,sourceTypes,specialRoles));
    const implicit = !base.includes('.') && !file.imports[base] && !sourceTypes.has(file.packageName ? file.packageName+'.'+base : base) &&
      bindableTypes.has('java.lang.'+base);
    if (!role && !array && !primitive.has(base) && !implicit && !resolveStandard(base,file,sourceTypes,bindableTypes)) {
      return {reason:'Additional Java binding evidence is needed to classify parameter '+parameter.name+'.'};
    }
    (role ? special : bindable).push({name:parameter.name,...(role && {kind:role})});
  }
  const specialKinds = new Set(special.map(parameter => parameter.kind));
  if (specialKinds.size !== special.length || specialKinds.has('Pageable') &&
      (specialKinds.has('Sort') || specialKinds.has('Limit'))) {
    return {reason:'Duplicate or competing Spring Data special parameters require query-method validation.'};
  }
  return {parameters:{expected:inspected.expected,bindable,special}};
}

function analyzeDerivedMethods(model,file,type,{resolveType,accepted},sourceTypes,managed) {
  if (type.kind !== 'interface') return;
  const repository = repositoryDomain(file,type,sourceTypes,resolveType);
  if (!repository) return;
  const candidates = managed.get(repository.domainFqn);
  const domain = candidates?.length === 1 && candidates[0].kind === 'entity' && candidates[0];
  for (const method of type.methods) {
    if (model.queries.length >= 2000) break;
    const subject = subjectPattern.exec(method.name);
    if (!subject || reservedMethods.has(method.name) || method.modifiers?.some(modifier => ['default','static','private'].includes(modifier)) ||
        method.annotations.some(item => ['Query','NativeQuery','Procedure'].includes(item.shortName) &&
          accepted(item,file,'org.springframework.data.jpa.repository') ||
          item.shortName === 'Procedure' && accepted(item,file,'org.springframework.data.jpa.repository.query'))) continue;
    const range = rangeAt(file.text,method.start,method.end);
    const query = {uri:file.uri,text:method.name,range,source:'spring-data-derived',status:'unknown',
      reason:'The direct repository entity or custom repository fragment is unresolved in the local model.'};
    model.queries.push(query);
    if (!domain || repository.customBases) continue;
    const start = method.start+subject[0].length;
    const inspected = inspectExpression(domain,method.name.slice(subject[0].length),start,managed);
    if (inspected.reason) {
      query.reason = inspected.reason;
      continue;
    }
    for (const {attribute,start,end} of inspected.refs) {
      if (attribute.uri && attribute.range) model.references.push({uri:file.uri,range:rangeAt(file.text,start,end),
        targets:[{uri:attribute.uri,range:attribute.range}],kind:'jpa-derived-query'});
    }
    const parameters = analyzeParameters(file,method,sourceTypes,inspected);
    query.derivedAnalysis = {domain:domain.fqn,predicateGroups:inspected.predicateGroups,order:inspected.order,...parameters};
    if (parameters.reason) {
      query.reason = parameters.reason;
      continue;
    }
    const {expected,bindable} = parameters.parameters;
    const extra = bindable.length > expected;
    if (bindable.length !== expected) {
      query.status = extra ? 'unknown' : 'invalid';
      query.reason = extra ? 'Some method arguments have no matching predicate slot in this source analysis.' :
        'The method does not declare enough bindable arguments for its predicate.';
      model.diagnostics.push({uri:file.uri,range,code:'jpa.derived.arguments',severity:extra ? 'information' : 'warning',
        message:'Spring Data predicate needs '+expected+' bindable argument(s); the method declares '+bindable.length+
          '. '+query.reason});
      continue;
    }
    query.status = 'known';
    query.reason = 'Source property paths, operators and bindable argument count resolved.';
  }
}

module.exports = { analyzeDerivedMethods };
