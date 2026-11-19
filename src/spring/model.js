'use strict';
const { parseJavaFile, annotation, strings, literal, rangeAt } = require('./java');
const { configuration, resolveTemplate } = require('./configuration');
const { parseProfileExpression, matchesProfileTree } = require('./profile-expression');

const COMPONENTS = ['Component', 'Service', 'Repository', 'Controller', 'RestController', 'Configuration', 'SpringBootApplication', 'Named'];
function decapitalize(name) { return /^[A-Z]{2}/.test(name) ? name : name[0].toLowerCase() + name.slice(1); }
function triAnd(states) { return states.some(item => item.state === 'inactive') ? { state: 'inactive', reasons: states.filter(item => item.state === 'inactive').map(item => item.reason) } : states.some(item => item.state === 'unknown') ? { state: 'unknown', reasons: states.filter(item => item.state === 'unknown').map(item => item.reason) } : { state: 'active', reasons: [] }; }

function profileExpression(expression, profiles) {
  try {
    const { tree } = parseProfileExpression(expression);
    const value = matchesProfileTree(tree, profiles);
    return { state: value ? 'active' : 'inactive', reason: `Profile expression ${expression}: ${value}` };
  } catch (error) { return { state: 'unknown', reason: error.message }; }
}

function conditions(annotations, config, options) {
  const states = [];
  for (const item of annotations) {
    if (!item.known) { if (!item.name.startsWith('java.lang.')) states.push({ state: 'unknown', reason: `Meta-annotation effects of ${item.name} are not evaluated` }); continue; }
    if (item.shortName === 'Profile') {
      if (config.profileState === 'unknown') { states.push({ state: 'unknown', reason: 'Active profiles cannot be inferred across multiple configuration contexts' }); continue; }
      const values = strings(item);
      if (!values?.length) states.push({ state: 'unknown', reason: 'Non-literal/empty profile expression' });
      else {
        const results = values.map(value => profileExpression(value, config.profiles));
        states.push(results.some(value => value.state === 'active') ? { state: 'active' } : results.some(value => value.state === 'unknown') ? { state: 'unknown', reason: 'Unknown profile expression' } : { state: 'inactive', reason: `Inactive profiles: ${values.join(', ')}` });
      }
    } else if (item.shortName === 'ConditionalOnProperty') {
      const names = strings(item, item.attributes.name ? 'name' : 'value');
      const prefix = literal(item, 'prefix', ''), expected = literal(item, 'havingValue', ''), missing = literal(item, 'matchIfMissing', false);
      if (!names?.length || prefix === undefined || expected === undefined || missing === undefined) { states.push({ state: 'unknown', reason: 'Non-literal ConditionalOnProperty arguments' }); continue; }
      for (const name of names) {
        const key = (prefix ? prefix.replace(/\.$/, '') + '.' : '') + name;
        const entry = config.entries.get(key);
        if (!entry) states.push(missing && !config.ambiguousContext ? { state: 'active' } : options.closedWorld ? { state: 'inactive', reason: `Missing property ${key}` } : { state: 'unknown', reason: `Property ${key} may come from an external source` });
        else {
          const value = entry.ambiguousContext ? { state: 'unknown', reason: 'Property condition has multiple possible configuration contexts' } : resolveTemplate(entry.value, config.entries);
          if (value.state !== 'resolved') states.push({ state: 'unknown', reason: value.reason });
          else { const matches = expected ? value.value.toLowerCase() === String(expected).toLowerCase() : value.value.toLowerCase() !== 'false'; states.push({ state: matches ? 'active' : 'inactive', reason: `Property condition ${key}: ${matches}` }); }
        }
      }
    } else if (item.shortName === 'Conditional' || item.shortName.startsWith('ConditionalOn')) states.push({ state: 'unknown', reason: `${item.shortName} requires runtime/classpath/registration-order evaluation` });
  }
  return triAnd(states);
}
function qualifier(annotations) { const item = annotation(annotations, 'Qualifier') || annotation(annotations, 'Named'); return item ? literal(item, 'value', undefined) : null; }
function beanAliases(item, fallback) {
  if (!item) return [fallback];
  const values = strings(item, item.attributes.name ? 'name' : 'value');
  return values === null ? [] : values.length ? values : [fallback];
}
function makeInjection(file, owner, member, annotations, origin, factoryBeanId, options) {
  const value = annotation(annotations, 'Value');
  return {
    id: `${file.uri}#${member.start}`, uri: file.uri, range: rangeAt(file.text, member.start, member.end), owner: owner.fqn, ownerBeanId: factoryBeanId || `${file.uri}#${owner.start}`, name: member.name, type: member.type,
    qualifier: qualifier(annotations), qualifierPresent: Boolean(annotation(annotations, 'Qualifier') || annotation(annotations, 'Named')),
    required: literal(annotation(annotations, 'Autowired'), 'required', true) !== false,
    origin, parameterNameAvailable: origin === 'field' || Boolean(options.parameterNames),
    expression: value ? literal(value, 'value', undefined) : undefined,
    valueRange: value ? rangeAt(file.text, value.start, value.end) : null,
    qualifierRange: (annotation(annotations, 'Qualifier') || annotation(annotations, 'Named')) ? rangeAt(file.text, (annotation(annotations, 'Qualifier') || annotation(annotations, 'Named')).start, (annotation(annotations, 'Qualifier') || annotation(annotations, 'Named')).end) : null,
    annotations
  };
}

function analyzeSpring(javaFiles, configFiles = [], options = {}) {
  const files = javaFiles.map(parseJavaFile), config = configuration(configFiles, options), beans = [], injections = [], bindings = [], issues = [...config.issues];
  const types = new Map();
  for (const file of files) for (const type of file.types) types.set(type.fqn, type);
  const inScope = type => !options.basePackages?.length || options.basePackages.some(pkg => type.fqn === pkg || type.fqn.startsWith(pkg + '.'));
  const inScopeFile = file => !options.basePackages?.length || options.basePackages.some(pkg => file.packageName === pkg || file.packageName.startsWith(pkg + '.'));
  const incomplete = config.issues.length > 0 || files.some(file => inScopeFile(file) && (file.issues.length || file.types.some(type => inScope(type) && type.annotations.some(item => !item.known && !item.name.startsWith('java.lang.')))));
  const closedWorld = Boolean(options.closedWorld) && !incomplete;
  const conditionOptions = { ...options, closedWorld };
  for (const file of files) {
    if (inScopeFile(file)) for (const message of file.issues) issues.push({ uri: file.uri, message });
    for (const type of file.types) {
      if (!inScope(type) || type.kind !== 'class') continue;
      const stereotype = type.annotations.find(item => item.known && COMPONENTS.includes(item.shortName));
      if (!stereotype) continue;
      const names = beanAliases(stereotype, decapitalize(type.name));
      const condition = conditions(type.annotations, config, conditionOptions);
      const bean = { id: `${file.uri}#${type.start}`, name: names[0] || type.name, aliases: names, type: type.fqn, qualifiers: [qualifier(type.annotations)].filter(value => typeof value === 'string'), primary: Boolean(annotation(type.annotations, 'Primary')), fallback: Boolean(annotation(type.annotations, 'Fallback')), uri: file.uri, range: type.range, origin: 'component', ...condition };
      bean.nameUnknown = !names.length;
      bean.qualifierUnknown = Boolean(annotation(type.annotations, 'Qualifier') || annotation(type.annotations, 'Named')) && qualifier(type.annotations) === undefined;
      if (!names.length || bean.qualifierUnknown) { bean.state = 'unknown'; bean.reasons.push('Non-literal component name or qualifier'); }
      if (file.issues.length) { bean.state = 'unknown'; bean.reasons.push('This file contains Java constructs outside the supported parser subset'); }
      beans.push(bean);
      const configurationProperties = annotation(type.annotations, 'ConfigurationProperties');
      if (configurationProperties) {
        const prefix = literal(configurationProperties, 'prefix', literal(configurationProperties, 'value', ''));
        if (typeof prefix !== 'string') issues.push({ uri: file.uri, message: 'Non-literal ConfigurationProperties prefix is unknown.' });
        else for (const field of type.fields) {
          const setter = type.methods.find(method => method.name === 'set' + field.name[0].toUpperCase() + field.name.slice(1) && method.parameters.length === 1);
          const key = (prefix ? prefix + '.' : '') + field.name.replace(/[A-Z]/g, char => '-' + char.toLowerCase());
          const normalized = key.replace(/[-_]/g, '').toLowerCase();
          const entry = [...config.entries.values()].find(item => item.key.replace(/[-_]/g, '').toLowerCase() === normalized);
          const supported = /^(?:java\.lang\.)?(?:String|Integer|Long|Boolean|Double|int|long|boolean|double)$/.test(field.type.name) || /^(?:int|long|boolean|double)$/.test(field.type.raw);
          const resolution = bean.state !== 'active' ? { state: bean.state, reason: 'Configuration Bean is not active.', definitions: [] } : !setter || !supported ? { state: 'unknown', reason: 'Only scalar JavaBean properties with a setter are modeled.', definitions: [] } : entry?.ambiguousContext ? { state: 'unknown', reason: 'Configuration root is ambiguous.', definitions: [entry] } : entry ? resolveTemplate(entry.value, config.entries) : { state: 'unresolved', reason: 'No local property; field defaults and external binding are not evaluated.', definitions: [] };
          if (entry) resolution.definitions = [entry, ...(resolution.definitions || [])];
          bindings.push({ beanId: bean.id, owner: type.fqn, prefix, name: field.name, key, type: field.type, uri: file.uri, range: rangeAt(file.text, field.start, field.end), resolution });
        }
      }
      for (const field of type.fields) if (annotation(field.annotations, 'Autowired') || annotation(field.annotations, 'Inject') || annotation(field.annotations, 'Value')) injections.push(makeInjection(file, type, field, field.annotations, 'field', bean.id, options));
      const constructors = type.methods.filter(method => method.constructor);
      const overloadedFactories = new Set(type.methods.filter(method => annotation(method.annotations, 'Bean')).map(method => method.name).filter((name, index, names) => names.indexOf(name) !== index));
      for (const method of type.methods) {
        const factory = annotation(method.annotations, 'Bean');
        let factoryId;
        if (factory) {
          const aliases = beanAliases(factory, method.name);
          const methodConditions = conditions(method.annotations, config, conditionOptions);
          const combined = triAnd([{ state: bean.state, reason: bean.reasons.join('; ') }, { state: methodConditions.state, reason: methodConditions.reasons.join('; ') }]);
          factoryId = `${file.uri}#${method.start}`;
          beans.push({ id: factoryId, name: aliases[0] || method.name, aliases, type: method.type.name, qualifiers: [qualifier(method.annotations)].filter(value => typeof value === 'string'), primary: Boolean(annotation(method.annotations, 'Primary')), fallback: Boolean(annotation(method.annotations, 'Fallback')), uri: file.uri, range: rangeAt(file.text, method.start, method.end), origin: 'factory-method', configuration: type.fqn, ...combined });
          beans.at(-1).nameUnknown = !aliases.length;
          beans.at(-1).qualifierUnknown = Boolean(annotation(method.annotations, 'Qualifier') || annotation(method.annotations, 'Named')) && qualifier(method.annotations) === undefined;
          if (!aliases.length || beans.at(-1).qualifierUnknown) { beans.at(-1).state = 'unknown'; beans.at(-1).reasons.push('Non-literal Bean name or qualifier'); }
          if (overloadedFactories.has(method.name)) { beans.at(-1).state = 'unknown'; beans.at(-1).reasons.push('Overloaded Bean factory selection is not modeled'); }
        }
        const injectable = factory || annotation(method.annotations, 'Autowired') || annotation(method.annotations, 'Inject') || (method.constructor && constructors.length === 1);
        if (injectable) for (const parameter of method.parameters) injections.push(makeInjection(file, type, parameter, [...method.annotations.filter(item => item.shortName === 'Autowired'), ...parameter.annotations], factory ? 'factory-parameter' : method.constructor ? 'constructor' : 'method-parameter', factoryId || bean.id, options));
      }
    }
  }
  function assignable(candidate, requested, visited = new Set()) {
    if (candidate === requested || requested === 'java.lang.Object') return true;
    if (visited.has(candidate)) return false; visited.add(candidate);
    const type = types.get(candidate);
    if (!type) return null;
    const matches = type.superTypes.map(parent => assignable(parent, requested, new Set(visited)));
    return matches.includes(true) ? true : matches.includes(null) ? null : false;
  }
  const diagnosticItems = [];
  const diagnostics = (injection, code, message, severity = 'warning') => diagnosticItems.push({ uri: injection.uri, range: injection.valueRange || injection.range, code, message, severity });
  for (const injection of injections) {
    const owner = beans.find(bean => bean.id === injection.ownerBeanId);
    if (owner?.state !== 'active') { injection.resolution = { state: owner?.state === 'inactive' ? 'inactive' : 'unknown', reason: 'The owning Bean is inactive or conditional.', candidates: [] }; continue; }
    if (injection.expression !== undefined || annotation(injection.annotations, 'Value')) {
      const resolution = resolveTemplate(injection.expression, config.entries);
      injection.resolution = { ...resolution, kind: 'property', candidates: [] };
      if (resolution.state !== 'resolved') diagnostics(injection, resolution.reason?.startsWith('Cyclic') ? 'spring.property.cycle' : 'spring.property.unresolved', resolution.reason, 'information');
      continue;
    }
    const ref = injection.type;
    if (/[?&]/.test(ref.raw) || injection.annotations.some(item => !item.known && !item.name.startsWith('java.lang.'))) { injection.resolution = { state: 'unknown', reason: 'Generic specialization or custom injection annotations are not modeled.', candidates: [] }; continue; }
    const simple = ref.name.split('.').at(-1);
    const collection = ['List', 'Set', 'Collection', 'Map'].includes(simple) || ref.array;
    const optional = simple === 'Optional' || simple === 'ObjectProvider' || !injection.required;
    const requested = collection || ['Optional', 'ObjectProvider'].includes(simple) ? (simple === 'Map' ? ref.arguments[1] : ref.arguments[0])?.name || (ref.array ? ref.name : '') : ref.name;
    if (!requested || injection.qualifierPresent && typeof injection.qualifier !== 'string') { injection.resolution = { state: 'unknown', reason: 'Generic type or qualifier is not a supported literal.', candidates: [] }; continue; }
    let candidates = beans.filter(bean => bean.state !== 'inactive' && assignable(bean.type, requested) !== false);
    if (injection.qualifierPresent) candidates = candidates.filter(bean => bean.qualifierUnknown || bean.nameUnknown || bean.qualifiers.includes(injection.qualifier) || bean.aliases.includes(injection.qualifier));
    const possible = candidates.filter(bean => bean.state === 'unknown' || assignable(bean.type, requested) === null), active = candidates.filter(bean => bean.state === 'active' && assignable(bean.type, requested) === true);
    const result = { kind: 'bean', requested, candidates: candidates.map(bean => bean.id), selected: [], state: 'unknown' };
    if (possible.length) result.reason = 'At least one possible Bean has an unevaluated condition, qualifier or external type hierarchy.';
    else if (collection || simple === 'ObjectProvider') { result.state = 'resolved'; result.selected = active.map(bean => bean.id); result.reason = collection ? 'All locally matching Beans; Primary does not filter collections.' : 'Provider candidates; runtime lookup remains deferred.'; }
    else {
      let chosen = active;
      const primary = chosen.filter(bean => bean.primary);
      if (primary.length === 1) chosen = primary;
      else if (primary.length > 1) chosen = primary;
      else { const regular = chosen.filter(bean => !bean.fallback); if (regular.length) chosen = regular; if (chosen.length > 1 && injection.parameterNameAvailable) { const named = chosen.filter(bean => bean.aliases.includes(injection.name)); if (named.length === 1) chosen = named; } }
      if (chosen.length === 1) { result.state = 'resolved'; result.selected = [chosen[0].id]; result.reason = 'Resolved within the configured local source model.'; }
      else if (chosen.length > 1) { result.state = 'ambiguous'; result.reason = `Multiple local candidates for ${requested}: ${chosen.map(bean => bean.name).join(', ')}.`; diagnostics(injection, 'spring.bean.ambiguous', result.reason + ' Runtime Bean registration may alter this model.'); }
      else if (optional) { result.state = 'optional'; result.reason = 'No local candidate; this injection is optional.'; }
      else if (closedWorld) { result.state = 'missing'; result.reason = `No candidate for ${requested} in the explicitly closed local model.`; diagnostics(injection, 'spring.bean.missing', result.reason); }
      else { result.reason = `No local candidate for ${requested}; dependency/automatic registrations are outside this model.`; }
    }
    injection.resolution = result;
  }
  const names = new Map();
  for (const bean of beans.filter(bean => bean.state === 'active')) { if (!names.has(bean.name)) names.set(bean.name, []); names.get(bean.name).push(bean); }
  for (const [name, group] of names) if (group.length > 1) diagnosticItems.push({ uri: group[1].uri, range: group[1].range, code: 'spring.bean.duplicate-name', severity: 'warning', message: `Multiple local Bean declarations named ${name}. Runtime overriding policy is not evaluated.` });
  return {
    version: 1, mode: 'local-semantic-index', closedWorld, requestedClosedWorld: Boolean(options.closedWorld), incomplete, profiles: config.profiles,
    beans, injections, bindings, diagnostics: diagnosticItems, properties: [...config.entries.values()], issues,
    assumptions: ['Workspace source candidates filtered by configured basePackages; component-scan/Import registration is not executed.', 'Local application configuration plus explicit overrides; external ConfigData/environment sources are not loaded.'],
    limits: ['No SpEL or custom Condition execution.', 'No XML, dependency Bean introspection, composed annotations, FactoryBean or proxy/generic specialization.', 'Records/nested classes and unsupported Java declarations are omitted.']
  };
}

function definitionsAt(model, uri, position) {
  const within = range => (position.line > range.start.line || position.line === range.start.line && position.character >= range.start.character) && (position.line < range.end.line || position.line === range.end.line && position.character <= range.end.character);
  const injections = model.injections.filter(item => item.uri === uri && (within(item.range) || item.valueRange && within(item.valueRange) || item.qualifierRange && within(item.qualifierRange)));
  return [...injections.flatMap(item => item.resolution.kind === 'property' ? (item.resolution.definitions || []).filter(entry => entry.uri && entry.range) : (item.resolution.selected?.length ? item.resolution.selected : item.resolution.candidates || []).map(id => model.beans.find(bean => bean.id === id)).filter(Boolean)), ...(model.bindings || []).filter(item => item.uri === uri && within(item.range)).flatMap(item => (item.resolution.definitions || []).filter(entry => entry.uri && entry.range))];
}

module.exports = { analyzeSpring, definitionsAt, profileExpression, conditions };
