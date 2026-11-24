'use strict';

const { lexJava } = require('../spring/java');
const { parseProfileExpression } = require('../spring/profile-expression');
const { booleanExpression, analyzeConditionFlow } = require('./spring-condition-flow');

const CONTEXT = 'org.springframework.context.annotation.';
const BOOT = 'org.springframework.boot.autoconfigure.condition.';
const METADATA = 'org.springframework.core.type.AnnotatedTypeMetadata';
const ENVIRONMENT = 'org.springframework.core.env.Environment';
const PROFILES = 'org.springframework.core.env.Profiles';
const CONDITION_TYPES = Object.freeze({
  Profile: CONTEXT + 'Profile',
  Conditional: CONTEXT + 'Conditional',
  Condition: CONTEXT + 'Condition',
  ConditionContext: CONTEXT + 'ConditionContext',
  AnnotatedTypeMetadata: METADATA,
  Environment: ENVIRONMENT,
  Profiles: PROFILES,
  ConditionalOnExpression: BOOT + 'ConditionalOnExpression',
  ConditionalOnBooleanProperty: BOOT + 'ConditionalOnBooleanProperty',
  ConditionalOnClass: BOOT + 'ConditionalOnClass',
  ConditionalOnMissingClass: BOOT + 'ConditionalOnMissingClass',
  ConditionalOnBean: BOOT + 'ConditionalOnBean',
  ConditionalOnMissingBean: BOOT + 'ConditionalOnMissingBean',
  ConditionalOnSingleCandidate: BOOT + 'ConditionalOnSingleCandidate'
});
const CLASS_NAMES = new Set(['ConditionalOnClass', 'ConditionalOnMissingClass']);
const BEAN_NAMES = new Set(['ConditionalOnBean', 'ConditionalOnMissingBean', 'ConditionalOnSingleCandidate']);
const LIMITS = Object.freeze({ tokens: 256, depth: 16, branches: 16, locals: 16, characters: 1024, arguments: 16, reportItems: 2048 });
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const QUALIFIED = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;
const PROPERTY = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const BEAN = /^[A-Za-z_$][\w.$:-]*$/;
const spelling = tokens => tokens.map(token => token.text).join('');
const javaString = token => token?.kind === 'string' && /^"[\x20-\x21\x23-\x5b\x5d-\x7e]*"$/.test(token.text)
  && token.value.length <= LIMITS.characters ? token.value : null;

function splitValues(input) {
  if (!input?.length) return null;
  if (input[0].text !== '{') return [input];
  if (input.at(-1).text !== '}') return null;
  if (input.length === 2) return [];
  const parts = [[]];
  for (const token of input.slice(1, -1)) {
    if (token.text === ',') {
      if (!parts.at(-1).length || parts.length >= LIMITS.arguments + 1) return null;
      parts.push([]);
    } else parts.at(-1).push(token);
  }
  if (!parts.at(-1).length) parts.pop();
  return parts.length <= LIMITS.arguments ? parts : null;
}

function strings(input) {
  const parts = splitValues(input);
  if (!parts || parts.some(part => part.length !== 1 || javaString(part[0]) === null)) return null;
  return parts.map(part => javaString(part[0]));
}

function profileNames(values) {
  if (!values?.length || values.length > LIMITS.arguments) return null;
  try {
    return [...new Set(values.flatMap(value => parseProfileExpression(value).names))];
  } catch {
    return null;
  }
}

function joinOperators(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const first = tokens[i], second = tokens[i + 1];
    const operator = first.text + (second?.text || '');
    if (first.end === second?.start && ['&&', '||', '==', '!='].includes(operator)) {
      result.push({ text: operator });
      i++;
    } else result.push(first);
  }
  return result;
}

function closedSpel(value) {
  if (value === null) return null;
  const body = value.startsWith('#{') && value.endsWith('}') ? value.slice(2, -1) : value;
  const tokens = lexJava(body).tokens;
  // The Java lexer discards comments and some spacing. Check that the
  // entire input consists of checked tokens and ASCII whitespace.
  let offset = 0;
  for (const token of tokens) {
    if (!/^[ \t]*$/.test(body.slice(offset, token.start))) return null;
    offset = token.end;
  }
  if (!/^[ \t]*$/.test(body.slice(offset))) return null;
  const input = joinOperators(tokens);
  function literal(token) {
    if (/^(?:true|false)$/.test(token?.text)) return 'boolean';
    if (/^(?:0|[1-9]\d{0,8})$/.test(token?.text)) return 'decimal';
    if (/^'[A-Za-z0-9_. -]*'$/.test(token?.text)) return 'string';
    return null;
  }
  // In SpEL unary negation binds ahead of equality. A bare non-Boolean
  // operand would invoke conversion instead of comparing closed literals.
  if (input.some((token, index) => token.text === '!'
      && !['!', '(', 'true', 'false'].includes(input[index + 1]?.text))) return null;
  let ternaryExpressions = 0;
  const recognized = booleanExpression(input, index => {
    const kind = literal(input[index]);
    if (!kind) return null;
    if (['==', '!='].includes(input[index + 1]?.text)) {
      return literal(input[index + 2]) === kind ? index + 3 : null;
    }
    return kind === 'boolean' ? index + 1 : null;
  }, { limits: LIMITS, retainChoice: () => ++ternaryExpressions <= LIMITS.branches });
  return recognized ? { ternaryExpressions } : null;
}

function isReviewedConditionName(name) {
  return name === 'Conditional' || name === 'Profile' || name === 'ConditionalOnExpression'
    || name === 'ConditionalOnBooleanProperty' || CLASS_NAMES.has(name) || BEAN_NAMES.has(name);
}

function createConditionReviewer({ byName, resolve }) {
  const hasImport = (file, name) => Object.hasOwn(file.imports, name);
  const staticImports = new WeakMap();
  function hasStaticImports(file) {
    if (!staticImports.has(file)) {
      const tokens = lexJava(file.text).tokens;
      staticImports.set(file, tokens.some((token, index) => token.text === 'import' && tokens[index + 1]?.text === 'static'));
    }
    return staticImports.get(file);
  }

  function resolvesTo(raw, expected, file) {
    if (resolve(raw, file) !== expected || byName.has(expected)) return false;
    if (raw.includes('.') || hasImport(file, raw) && file.imports[raw] === expected) return true;
    if (hasStaticImports(file) || byName.has((file.packageName ? file.packageName + '.' : '') + raw)) return false;
    const expectedPackage = expected.slice(0, expected.lastIndexOf('.'));
    return file.wildcards.every(imported => imported === expectedPackage);
  }

  function classLiterals(input, file) {
    const values = splitValues(input);
    if (!values) return null;
    const result = [];
    for (const value of values) {
      const name = spelling(value.slice(0, -2));
      if (value.at(-2)?.text !== '.' || value.at(-1)?.text !== 'class' || !QUALIFIED.test(name)) return null;
      const type = resolve(name, file);
      if (!byName.get(type) && !name.includes('.') && !hasImport(file, name)) return null;
      if (name.includes('.') && hasImport(file, name.split('.')[0])) return null;
      if (byName.has(type) && !byName.get(type)) return null;
      result.push(type);
    }
    return result;
  }

  function typeReferences(values, kind = 'spring.condition-type-reference') {
    return values.map(type => ({ kind, type, name: type.split('.').at(-1) }));
  }

  const sourceConditions = new Map();
  function sourceCondition(fqn) {
    if (sourceConditions.has(fqn)) return sourceConditions.get(fqn);
    const result = inspectSourceCondition(byName.get(fqn));
    sourceConditions.set(fqn, result);
    return result;
  }

  function inspectSourceCondition(type) {
    if (!type || type.kind !== 'class' || !type.final || type.unsupported || type.annotations.length
        || type.members.length !== 1 || type.header[0]?.text !== 'implements'
        || !resolvesTo(spelling(type.header.slice(1)), CONDITION_TYPES.Condition, type.file)) return null;
    const [method] = type.members;
    if (method.name !== 'matches' || spelling(method.head) !== 'publicboolean'
        || method.annotations.length > 1 || method.annotations.some(annotation =>
          !resolvesTo(annotation.rawName, 'java.lang.Override', type.file) || !annotation.attributesComplete
          || Object.keys(annotation.attributes).length)
        || method.parameters.length !== 2 || method.defaultTokens.length || !method.body
        || !resolvesTo(method.parameters[0].rawType, CONDITION_TYPES.ConditionContext, type.file)
        || !resolvesTo(method.parameters[1].rawType, METADATA, type.file)) return null;
    const [context, metadata] = method.parameters.map(parameter => parameter.name);
    if (!IDENTIFIER.test(context) || !IDENTIFIER.test(metadata) || context === metadata || method.body.length > LIMITS.tokens) return null;
    const tokens = joinOperators(method.body);
    const contextEnvironment = [context, '.', 'getEnvironment', '(', ')'];
    const profilesFactoryBound = resolvesTo('Profiles', PROFILES, type.file) && !hasStaticImports(type.file);
    const matches = (input, index, part) => part.every((value, offset) => input[index + offset]?.text === value);
    const queries = [], references = [];

    function call(input, index, prefix) {
      if (!matches(input, index, prefix)) return null;
      const args = [];
      let next = index + prefix.length;
      for (;;) {
        const arg = javaString(input[next++]);
        if (arg === null || args.length >= LIMITS.arguments) return null;
        args.push(arg);
        if (input[next]?.text === ')') return { args, next: next + 1 };
        if (input[next++]?.text !== ',') return null;
      }
    }

    function environment(input, index, scope) {
      return scope.get(input[index]?.text) === 'environment' ? [input[index].text, '.'] : [...contextEnvironment, '.'];
    }

    function atom(input, index, scope) {
      if (/^(?:true|false)$/.test(input[index]?.text)) return index + 1;
      const receiver = environment(input, index, scope);
      const profile = call(input, index, [...receiver, 'matchesProfiles', '(']);
      if (profile) {
        const names = profileNames(profile.args);
        if (!names) return null;
        queries.push({ kind: 'environment-profiles', names });
        return profile.next;
      }
      if (profilesFactoryBound && !scope.has('Profiles')) {
        const accepted = call(input, index, [...receiver, 'acceptsProfiles', '(', 'Profiles', '.', 'of', '(']);
        if (accepted) {
          const names = profileNames(accepted.args);
          if (!names || input[accepted.next]?.text !== ')') return null;
          queries.push({ kind: 'environment-accepted-profiles', names });
          return accepted.next + 1;
        }
      }
      const property = call(input, index, [...receiver, 'containsProperty', '(']);
      if (property) {
        if (property.args.length !== 1 || !PROPERTY.test(property.args[0])) return null;
        queries.push({ kind: 'environment-property-presence', name: property.args[0] });
        return property.next;
      }
      const annotation = call(input, index, [metadata, '.', 'isAnnotated', '(']);
      if (annotation) {
        const [name] = annotation.args;
        if (annotation.args.length !== 1 || !QUALIFIED.test(name) || byName.get(name)?.kind !== 'annotation') return null;
        queries.push({ kind: 'source-annotation-presence', type: name });
        references.push(...typeReferences([name], 'spring.condition-metadata-reference'));
        return annotation.next;
      }
      const expected = javaString(input[index]);
      if (expected === null || !matches(input, index + 1, ['.', 'equals', '('])) return null;
      const comparison = call(input, index + 4, [...environment(input, index + 4, scope), 'getProperty', '(']);
      if (!comparison || comparison.args.length !== 1 || !PROPERTY.test(comparison.args[0])
          || input[comparison.next]?.text !== ')') return null;
      queries.push({ kind: 'environment-string-equality', name: comparison.args[0] });
      return comparison.next + 1;
    }

    const flow = analyzeConditionFlow(tokens, {
      limits: LIMITS, parameterNames: [context, metadata], readAtom: atom,
      isEnvironmentAlias: (declaration, initial) => {
        const raw = spelling(declaration);
        return declaration.every((token, index) => index % 2 ? token.text === '.' : token.kind === 'id')
          && QUALIFIED.test(raw) && resolvesTo(raw, ENVIRONMENT, type.file)
          && initial.length === contextEnvironment.length && matches(initial, 0, contextEnvironment);
      }
    });
    return flow && { type, method, queries, references, flow };
  }

  return function review(annotation, file) {
    const { shortName, attributes } = annotation;
    if (!annotation.attributesComplete || !resolvesTo(annotation.rawName, CONDITION_TYPES[shortName], file)) return null;
    const keys = Object.keys(attributes);
    const supported = allowed => keys.every(key => allowed.includes(key));

    if (shortName === 'Profile') {
      const names = supported(['value']) && profileNames(strings(attributes.value));
      return names ? { kind: 'profile-expression', queries: [{ kind: 'profiles', names }] } : null;
    }
    if (shortName === 'ConditionalOnExpression') {
      const value = attributes.value ? javaString(attributes.value.length === 1 ? attributes.value[0] : null) : 'true';
      const expression = supported(['value']) ? closedSpel(value) : null;
      return expression && { kind: 'closed-spel-expression', queries: [], expression };
    }
    if (shortName === 'ConditionalOnBooleanProperty') {
      if (!supported(['value', 'name', 'prefix', 'havingValue', 'matchIfMissing'])
          || (attributes.value && attributes.name)) return null;
      const names = strings(attributes.name || attributes.value);
      const prefix = attributes.prefix ? javaString(attributes.prefix.length === 1 ? attributes.prefix[0] : null) : '';
      const path = prefix?.replace(/\.$/, '');
      const attributeBoolean = (key, fallback) => {
        if (!attributes[key]) return fallback;
        if (attributes[key].length !== 1 || !['true', 'false'].includes(attributes[key][0].text)) return null;
        return attributes[key][0].text === 'true';
      };
      const expected = attributeBoolean('havingValue', true), matchIfMissing = attributeBoolean('matchIfMissing', false);
      if (path == null || (prefix && !PROPERTY.test(path)) || expected === null || matchIfMissing === null
          || !names?.length || new Set(names).size !== names.length || names.some(name => !PROPERTY.test(name))) return null;
      const fullNames = path ? names.map(name => path + '.' + name) : names;
      if (fullNames.some(name => name.length > LIMITS.characters)) return null;
      return { kind: 'literal-boolean-property-condition',
        queries: fullNames.map(name => ({ kind: 'environment-boolean-property', name, expected, matchIfMissing })) };
    }
    if (shortName === 'Conditional') {
      if (!supported(['value'])) return null;
      const targets = classLiterals(attributes.value, file);
      if (!targets?.length || new Set(targets).size !== targets.length) return null;
      const callbacks = targets.map(sourceCondition);
      if (callbacks.some(callback => !callback)) return null;
      return { kind: 'source-condition', queries: callbacks.flatMap(callback => callback.queries), callbacks,
        references: [...typeReferences(targets, 'spring.condition-callback-type'), ...callbacks.flatMap(callback => callback.references)] };
    }

    const classCondition = CLASS_NAMES.has(shortName);
    const single = shortName === 'ConditionalOnSingleCandidate';
    const allowed = shortName === 'ConditionalOnMissingClass' ? ['value']
      : classCondition ? ['value', 'name'] : single ? ['value', 'type'] : ['value', 'type', 'name'];
    if (!supported(allowed)) return null;
    if (single && keys.some(key => attributes[key][0]?.text === '{')) return null;
    const classValues = key => attributes[key] ? classLiterals(attributes[key], file) : [];
    const stringValues = key => attributes[key] ? strings(attributes[key]) : [];
    const classTypes = shortName === 'ConditionalOnMissingClass' ? stringValues('value') : classValues('value');
    const typeNames = stringValues(classCondition ? 'name' : 'type');
    const beanNames = classCondition ? [] : stringValues('name');
    if (!classTypes || !typeNames || !beanNames || ![...classTypes, ...typeNames].every(name => QUALIFIED.test(name))
        || !beanNames.every(name => BEAN.test(name))) return null;
    const types = [...classTypes, ...typeNames];
    if (types.length + beanNames.length < 1 || single && types.length !== 1) return null;
    const references = [...typeReferences(types), ...beanNames.map(name => ({ kind: 'spring.condition-bean-reference', name }))];
    return { kind: classCondition ? 'literal-class-condition' : 'literal-bean-condition', queries: [], references };
  };
}

module.exports = { createConditionReviewer, isReviewedConditionName, javaString, strings, CONDITION_TYPES, SPRING_CONDITION_LIMITS: LIMITS };
