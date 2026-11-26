'use strict';

function inspectVarargsFamily(family, calls, references) {
  if (!family.some(method => method.varargs)) return undefined;
  const method = family[0];
  const fixedCount = method.parameters.length - 1;
  if (family.length !== 1 || !method.varargs || method.generic || method.constructor || fixedCount < 2 ||
      method.ownerKind !== 'CLASS' || !method.modifiers.some(value => ['private', 'static', 'final'].includes(value))) {
    throw Error('Varargs Change Signature requires one non-generic private, static or final method with at least two fixed parameters.');
  }
  if (references.length) throw Error('Varargs method references require a separate signature review.');
  if (calls.some(call => call.varargs?.fixedCount !== fixedCount || !['fixed-array', 'spread'].includes(call.varargs.mode))) {
    throw Error('The varargs caller has an effectful or boxing fixed argument, or the compiler could not verify its trailing invocation mode.');
  }
  return { fixedCount, fixedArrayCalls: calls.filter(call => call.varargs.mode === 'fixed-array').length,
    spreadCalls: calls.filter(call => call.varargs.mode === 'spread').length };
}

function verifyVarargsPermutation(facts, parameters) {
  if (!facts) return;
  const expected = facts.fixedCount + 1;
  if (parameters.length !== expected || parameters.at(-1)?.originalIndex !== facts.fixedCount ||
      new Set(parameters.map(value => value.originalIndex)).size !== expected ||
      parameters.slice(0, -1).some(value => value.originalIndex < 0 || value.originalIndex >= facts.fixedCount)) {
    throw Error('Reorder only the existing fixed parameters and keep the original varargs parameter last.');
  }
}

function verifyVarargsCalls(semantic, after, parameters, mapping) {
  const facts = semantic.varargs;
  if (!facts) return;
  const binding = key => mapping.get(key) || key;
  const identity = (call, project) => JSON.stringify([call.uri, project(call.enclosingKey), call.ordinal, project(call.methodKey)]);
  const prospective = new Map(after.map(call => [identity(call, value => value), call]));
  for (const call of semantic.calls) {
    const prior = call.varargs, current = prospective.get(identity(call, binding))?.varargs;
    if (!current || current.selector !== prior.selector || current.fixedCount !== prior.fixedCount || current.mode !== prior.mode) {
      throw Error('The signature edit changes the reviewed varargs receiver or fixed-array versus spread invocation.');
    }
    const reordered = parameters.slice(0, -1).map(parameter => prior.arguments[parameter.originalIndex]);
    const expected = [...reordered, ...prior.arguments.slice(facts.fixedCount)];
    if (JSON.stringify(expected) !== JSON.stringify(current.arguments)) {
      throw Error('The signature edit does not preserve the reviewed varargs argument sequence and trailing expressions.');
    }
  }
}

module.exports = { inspectVarargsFamily, verifyVarargsPermutation, verifyVarargsCalls };
