'use strict';

const { lexJava } = require('../spring/java');
const { CONDITION_TYPES, isReviewedConditionName, javaString, strings } = require('./spring-condition-analysis');

const ALIAS = 'org.springframework.core.annotation.AliasFor';
const ANNOTATION = 'java.lang.annotation.';
const META = new Set(['Retention', 'Target', 'Documented'].map(name => ANNOTATION + name));
const LIMITS = Object.freeze({ depth: 4, directConditions: 8, aliases: 4, alternatives: 32, visits: 128 });
const SHORT_ID = /^[A-Za-z_$][\w$]*$/;
const LEAF_ALIASES = Object.freeze({
  ConditionalOnClass: { name: 'String[]' },
  ConditionalOnMissingClass: { value: 'String[]' },
  ConditionalOnBean: { name: 'String[]', type: 'String[]' },
  ConditionalOnMissingBean: { name: 'String[]', type: 'String[]' },
  ConditionalOnSingleCandidate: { type: 'String' },
  ConditionalOnBooleanProperty: { name: 'String[]', value: 'String[]', prefix: 'String', havingValue: 'boolean', matchIfMissing: 'boolean' }
});

const spelling = tokens => tokens.map(token => token.text).join('');
const conditionName = name => isReviewedConditionName(name) || name.startsWith('ConditionalOn');

function possibleNames(item, file, byName) {
  if (item.rawName.includes('.') || Object.hasOwn(file.imports, item.rawName) || byName.has(item.name)) return [item.name];
  return [item.name, ...file.wildcards.map(pkg => pkg + '.' + item.rawName).filter(name => byName.has(name))];
}

function findCandidates(byName) {
  const parents = new Map(), candidates = new Set();
  for (const type of byName.values()) {
    if (type?.kind !== 'annotation') continue;
    for (const item of type.annotations) {
      if (conditionName(item.shortName)) candidates.add(type.fqn);
      for (const name of possibleNames(item, type.file, byName)) {
        if (!parents.has(name)) parents.set(name, new Set());
        parents.get(name).add(type.fqn);
      }
    }
  }
  const queue = [...candidates];
  for (const name of queue) {
    for (const dependent of parents.get(name) || []) {
      if (candidates.has(dependent)) continue;
      candidates.add(dependent);
      queue.push(dependent);
    }
  }
  return candidates;
}

function createComposedConditionReviewer({ byName, resolve, reviewCondition }) {
  const candidates = findCandidates(byName), declarations = new Map(), staticImports = new WeakMap();
  const isCandidate = name => candidates.has(name);
  function binds(rawName, expected, file, local = false) {
    if (resolve(rawName, file) !== expected || (!local && byName.has(expected))) return false;
    const samePackage = name => byName.has((file.packageName ? file.packageName + '.' : '') + name);
    if (rawName.includes('.')) {
      const root = rawName.split('.')[0];
      return !Object.hasOwn(file.imports, root) && !samePackage(root);
    }
    if (Object.hasOwn(file.imports, rawName)) return file.imports[rawName] === expected;
    if (!staticImports.has(file)) {
      const tokens = lexJava(file.text).tokens;
      staticImports.set(file, tokens.some((token, index) => token.text === 'import' && tokens[index + 1]?.text === 'static'));
    }
    return (local || !samePackage(rawName)) && !staticImports.get(file) && !file.wildcards.length;
  }

  function enumToken(tokens, enumType, value, file) {
    if (tokens.length < 3 || !tokens.every((token, index) => index % 2 ? token.text === '.' : token.kind === 'id')
        || tokens.at(-2).text !== '.' || tokens.at(-1).text !== value) return false;
    const type = spelling(tokens.slice(0, -2));
    const name = ANNOTATION + enumType;
    return (type === name || file.imports[type] === name) && !byName.has(name)
      && !byName.has((file.packageName ? file.packageName + '.' : '') + type)
      && (!type.includes('.') || !Object.hasOwn(file.imports, type.split('.')[0]));
  }

  function knownDecorator(item, file) {
    if (!item.attributesComplete || !binds(item.rawName, item.name, file)) return false;
    const keys = Object.keys(item.attributes);
    if (item.shortName === 'Documented') return !keys.length;
    if (keys.length !== 1 || keys[0] !== 'value') return false;
    let tokens = item.attributes.value;
    if (item.shortName === 'Retention') return enumToken(tokens, 'RetentionPolicy', 'RUNTIME', file);
    if (tokens[0]?.text === '{' && tokens.at(-1)?.text === '}') tokens = tokens.slice(1, -1);
    const values = [[]];
    for (const token of tokens) {
      if (token.text === ',') values.push([]);
      else values.at(-1).push(token);
    }
    const lastNames = values.map(value => value.at(-1)?.text);
    return values.length <= 3 && new Set(lastNames).size === lastNames.length
      && values.every((value, index) => ['TYPE', 'METHOD', 'ANNOTATION_TYPE'].includes(lastNames[index])
        && enumToken(value, 'ElementType', lastNames[index], file));
  }

  function memberType(member, file) {
    if (member.parameters.length || member.body || !SHORT_ID.test(member.name)) return null;
    const tokens = member.head;
    if (tokens.length === 1 && tokens[0].text === 'boolean') return 'boolean';
    const array = tokens.at(-2)?.text === '[' && tokens.at(-1)?.text === ']';
    const raw = array ? tokens.slice(0, -2) : tokens;
    const type = spelling(raw);
    return raw.every((token, index) => index % 2 ? token.text === '.' : token.kind === 'id')
      && binds(type, 'java.lang.String', file) ? array ? 'String[]' : 'String' : null;
  }

  function literal(tokens, type) {
    if (!tokens?.length) return false;
    if (type === 'String[]') return strings(tokens) !== null;
    if (tokens.length !== 1) return false;
    return type === 'String' ? javaString(tokens[0]) !== null : ['true', 'false'].includes(tokens[0].text);
  }

  function readDeclaration(type) {
    if (declarations.has(type.fqn)) return declarations.get(type.fqn);
    const result = inspectDeclaration(type);
    declarations.set(type.fqn, result);
    return result;
  }

  function inspectDeclaration(type) {
    if (type.kind !== 'annotation' || type.header.length || type.unsupported || type.members.length > LIMITS.aliases
        || new Set(type.annotations.map(item => item.name)).size !== type.annotations.length) return null;
    const decorations = type.annotations.filter(item => META.has(item.name));
    if (!decorations.some(item => item.name === ANNOTATION + 'Retention')
        || !decorations.every(item => knownDecorator(item, type.file))) return null;
    const edges = type.annotations.filter(item => !META.has(item.name));
    if (!edges.length || edges.length > LIMITS.directConditions) return null;
    for (const edge of edges) {
      if (!edge.attributesComplete) return null;
      if (isCandidate(edge.name)) {
        if (!binds(edge.rawName, edge.name, type.file, true)) return null;
      } else {
        // Spring Boot composed class/bean conditions use string type names.
        const classValuedBoot = /^(?:ConditionalOnClass|ConditionalOnBean|ConditionalOnMissingBean|ConditionalOnSingleCandidate)$/.test(edge.shortName);
        if (edge.name !== CONDITION_TYPES[edge.shortName] || !conditionName(edge.shortName)
            || !binds(edge.rawName, edge.name, type.file) || classValuedBoot && edge.attributes.value) return null;
      }
    }
    const aliases = [];
    const used = new Set();
    for (const member of type.members) {
      const kind = memberType(member, type.file);
      const [alias] = member.annotations;
      if (!kind || member.annotations.length !== 1 || !alias.attributesComplete
          || !binds(alias.rawName, ALIAS, type.file)) return null;
      const { annotation, attribute, value } = alias.attributes;
      if (!annotation || (attribute && value) || Object.keys(alias.attributes).some(key => !['annotation', 'attribute', 'value'].includes(key))
          || annotation.at(-2)?.text !== '.' || annotation.at(-1)?.text !== 'class'
          || !annotation.slice(0, -2).every((token, index) => index % 2 ? token.text === '.' : token.kind === 'id')) return null;
      const target = spelling(annotation.slice(0, -2));
      const edge = edges.find(item => binds(target, item.name, type.file, isCandidate(item.name)));
      const keyTokens = attribute || value;
      const key = keyTokens ? keyTokens.length === 1 && javaString(keyTokens[0]) : member.name;
      if (!edge || !key || !SHORT_ID.test(key)) return null;
      const next = byName.get(edge.name);
      const targetMember = next?.members.find(item => item.name === key);
      const targetType = next ? targetMember && memberType(targetMember, next.file) : LEAF_ALIASES[edge.shortName]?.[key];
      const mirrorKey = edge.shortName === 'ConditionalOnBooleanProperty' && key === 'value' ? 'name' : key;
      const identity = edge.name + '#' + mirrorKey;
      if (targetType !== kind || used.has(identity)) return null;
      const defaults = member.defaultTokens.length ? member.defaultTokens.slice(1) : null;
      if (defaults && (member.defaultTokens[0].text !== 'default' || !literal(defaults, kind))) return null;
      aliases.push({ member: member.name, target: edge.name, attribute: key, kind, defaults });
      used.add(identity);
    }
    return { edges, aliases };
  }

  function review(use, file) {
    const leaves = [], references = new Set(), aliasReport = new Map(), projected = new Set(), leafPaths = new Map();
    let visits = 0;
    function collect(item, source, chain) {
      if (++visits > LIMITS.visits) return false;
      if (!isCandidate(item.name)) {
        const reviewed = reviewCondition(item, source);
        if (!reviewed) return false;
        const path = chain.join('>');
        if (leafPaths.has(item.name) && leafPaths.get(item.name) !== path) return false;
        leafPaths.set(item.name, path);
        const entries = Object.entries(item.attributes).map(([key, tokens]) => [key, spelling(tokens)]);
        const key = JSON.stringify([chain, item.name, entries]);
        if (projected.has(key)) return true;
        if (leaves.length === LIMITS.alternatives) return false;
        projected.add(key);
        leaves.push({ ...reviewed, leaf: item.name, chain });
        return true;
      }
      if (chain.length === LIMITS.depth || chain.includes(item.name) || !item.attributesComplete
          || !binds(item.rawName, item.name, source, true)) return false;
      const type = byName.get(item.name);
      const declaration = type && readDeclaration(type);
      if (!declaration || Object.keys(item.attributes).some(key => !declaration.aliases.some(alias => alias.member === key))) return false;
      references.add(type.fqn);
      const values = new Map();
      for (const alias of declaration.aliases) {
        const tokens = item.attributes[alias.member] || alias.defaults;
        if (!literal(tokens, alias.kind)) return false;
        values.set(alias, alias.defaults && spelling(alias.defaults) !== spelling(tokens) ? [tokens, alias.defaults] : [tokens]);
        const identity = type.fqn + '#' + alias.member;
        aliasReport.set(identity, { owner: type.fqn, member: alias.member, target: alias.target, attribute: alias.attribute });
      }
      for (const edge of declaration.edges) {
        let alternatives = [edge.attributes];
        for (const [alias, options] of values) {
          if (alias.target !== edge.name) continue;
          const additions = alternatives.flatMap(attributes => options
            .filter(tokens => spelling(attributes[alias.attribute] || []) !== spelling(tokens))
            .map(tokens => ({ ...attributes, [alias.attribute]: tokens })));
          alternatives = alternatives.concat(additions);
          if (alternatives.length > LIMITS.alternatives) return false;
        }
        for (const attributes of alternatives) {
          if (!collect({ ...edge, attributes }, type.file, [...chain, item.name])) return false;
        }
      }
      return true;
    }
    if (!collect(use, file, [])) return null;
    return { leaves, references: [...references], aliases: [...aliasReport.values()] };
  }

  const hasConditionUse = (item, file) => possibleNames(item, file, byName).some(isCandidate);
  return { isCandidate, hasConditionUse, review };
}

module.exports = { createComposedConditionReviewer };
