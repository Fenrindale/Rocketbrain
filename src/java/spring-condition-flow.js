'use strict';

const LOCAL_NAME = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set(('abstract assert boolean break byte case catch char class const continue default do double else enum '
  + 'extends false final finally float for goto if implements import instanceof int interface long native new null package '
  + 'private protected public return short static strictfp super switch synchronized this throw throws transient true try void '
  + 'volatile while _').split(' '));

function matching(tokens, open) {
  const start = tokens[open]?.text;
  const close = { '(': ')', '{': '}' }[start];
  if (!close) return -1;
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (tokens[index].text === start) depth++;
    if (tokens[index].text === close && --depth === 0) return index;
  }
  return -1;
}

function booleanExpression(tokens, readAtom, { limits, compareBooleans = false, retainChoice = () => true }) {
  if (!tokens.length || tokens.length > limits.tokens) return false;
  let cursor = 0;
  function unary(depth) {
    if (depth > limits.depth) return false;
    if (tokens[cursor]?.text === '!') {
      cursor++;
      return unary(depth + 1);
    }
    if (tokens[cursor]?.text === '(') {
      cursor++;
      return conditional(depth + 1) && tokens[cursor++]?.text === ')';
    }
    const next = readAtom(cursor);
    if (next === null) return false;
    cursor = next;
    return true;
  }
  function sequence(operators, depth, read) {
    if (!read(depth)) return false;
    while (operators.includes(tokens[cursor]?.text)) {
      cursor++;
      if (!read(depth)) return false;
    }
    return true;
  }
  const equality = depth => compareBooleans ? sequence(['==', '!='], depth, unary) : unary(depth);
  const conjunction = depth => sequence(['&&'], depth, equality);
  function conditional(depth) {
    if (depth > limits.depth || !sequence(['||'], depth, conjunction)) return false;
    if (tokens[cursor]?.text !== '?') return true;
    cursor++;
    return retainChoice() && conditional(depth + 1) && tokens[cursor++]?.text === ':' && conditional(depth + 1);
  }
  return conditional(0) && cursor === tokens.length;
}

function analyzeConditionFlow(tokens, { limits, parameterNames, readAtom, isEnvironmentAlias }) {
  let booleanLocals = 0, environmentAliases = 0, branchStatements = 0, ternaryExpressions = 0, returns = 0;
  const withinBranches = () => branchStatements + ternaryExpressions <= limits.branches;
  const expression = (start, end, scope) => {
    const input = tokens.slice(start, end);
    return booleanExpression(input, index => scope.get(input[index]?.text) === 'boolean'
      ? index + 1 : readAtom(input, index, scope), {
      limits, compareBooleans: true,
      retainChoice: () => { ternaryExpressions++; return withinBranches(); }
    });
  };

  function branch(start, limit, scope, depth) {
    if (depth > limits.depth || ++branchStatements + ternaryExpressions > limits.branches || tokens[start + 1]?.text !== '(') return null;
    const conditionEnd = matching(tokens, start + 1);
    const thenEnd = matching(tokens, conditionEnd + 1);
    if (conditionEnd < 0 || tokens[conditionEnd + 1]?.text !== '{' || thenEnd < 0 || thenEnd >= limit
        || !expression(start + 2, conditionEnd, scope)) return null;
    const consequent = block(conditionEnd + 2, thenEnd, scope, depth + 1);
    if (consequent === null) return null;
    const afterThen = thenEnd + 1;
    if (tokens[afterThen]?.text !== 'else') return { next: afterThen, returns: false };
    const next = afterThen + 1;
    if (tokens[next]?.text === 'if') {
      const alternate = branch(next, limit, scope, depth + 1);
      return alternate && { next: alternate.next, returns: consequent && alternate.returns };
    }
    const alternateEnd = matching(tokens, next);
    if (tokens[next]?.text !== '{' || alternateEnd < 0 || alternateEnd >= limit) return null;
    const alternate = block(next + 1, alternateEnd, scope, depth + 1);
    return alternate === null ? null : { next: alternateEnd + 1, returns: consequent && alternate };
  }

  function block(start, limit, inherited, depth) {
    if (depth > limits.depth) return null;
    const scope = new Map(inherited);
    let cursor = start, terminates = false;
    while (cursor < limit) {
      if (terminates) return null;
      const statement = tokens[cursor].text;
      if (statement === 'if') {
        const result = branch(cursor, limit, scope, depth);
        if (!result) return null;
        cursor = result.next;
        terminates = result.returns;
        continue;
      }
      let end = cursor;
      while (end < limit && tokens[end].text !== ';') end++;
      if (end === limit) return null;
      if (statement === 'return') {
        if (!expression(cursor + 1, end, scope)) return null;
        returns++;
        terminates = true;
      } else if (statement === 'final') {
        const assignment = tokens.findIndex((token, index) => index >= cursor + 3 && index < end && token.text === '=');
        if (assignment < 0 || booleanLocals + environmentAliases >= limits.locals) return null;
        const name = tokens[assignment - 1];
        if (name.kind !== 'id' || !LOCAL_NAME.test(name.text) || RESERVED.has(name.text) || scope.has(name.text)) return null;
        const type = tokens.slice(cursor + 1, assignment - 1);
        if (type.length === 1 && type[0].text === 'boolean') {
          if (!expression(assignment + 1, end, scope)) return null;
          scope.set(name.text, 'boolean');
          booleanLocals++;
        } else {
          if (!isEnvironmentAlias(type, tokens.slice(assignment + 1, end))) return null;
          scope.set(name.text, 'environment');
          environmentAliases++;
        }
      } else return null;
      cursor = end + 1;
    }
    return terminates;
  }

  const parameters = new Map(parameterNames.map(name => [name, 'parameter']));
  if (block(0, tokens.length, parameters, 0) !== true) return null;
  return { booleanLocals, environmentAliases, branchStatements, ternaryExpressions, returns };
}

module.exports = { booleanExpression, analyzeConditionFlow };
