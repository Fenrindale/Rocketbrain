'use strict';

const PROFILE_EXPRESSION_LIMITS = Object.freeze({ characters: 512, tokens: 128, depth: 16 });

function parseProfileExpression(expression) {
  if (typeof expression !== 'string' || expression.length > PROFILE_EXPRESSION_LIMITS.characters) {
    throw new Error('Profile expression exceeds the review limit');
  }
  const tokens = expression.match(/[!&|()]|[^\s!&|()]+/g) || [];
  if (tokens.length > PROFILE_EXPRESSION_LIMITS.tokens) throw new Error('Profile expression has too many tokens');
  const names = new Set();
  let cursor = 0;

  function primary(depth) {
    if (depth > PROFILE_EXPRESSION_LIMITS.depth) throw new Error('Profile expression nesting exceeds the review limit');
    const next = tokens[cursor++];
    if (next === '!') return { operator: '!', child: primary(depth + 1) };
    if (next === '(') {
      const value = group(depth + 1);
      if (tokens[cursor++] !== ')') throw new Error('Unbalanced profile expression');
      return value;
    }
    if (!next || !/^[\w.-]+$/.test(next)) throw new Error('Unsupported profile expression');
    names.add(next);
    return { name: next };
  }

  function group(depth) {
    const children = [primary(depth)];
    let operator;
    while (tokens[cursor] === '&' || tokens[cursor] === '|') {
      const next = tokens[cursor++];
      if (operator && operator !== next) throw new Error('Mixed profile operators require parentheses');
      operator = next;
      children.push(primary(depth));
    }
    return operator ? { operator, children } : children[0];
  }

  const tree = group(0);
  if (cursor !== tokens.length) throw new Error('Trailing profile expression');
  return { tree, names: [...names] };
}

function matchesProfileTree(tree, profiles) {
  if (tree.name) return profiles.includes(tree.name);
  if (tree.operator === '!') return !matchesProfileTree(tree.child, profiles);
  return tree.operator === '&' ? tree.children.every(child => matchesProfileTree(child, profiles))
    : tree.children.some(child => matchesProfileTree(child, profiles));
}

module.exports = { parseProfileExpression, matchesProfileTree, PROFILE_EXPRESSION_LIMITS };
