'use strict';

const includes = (prefix, name) => name === prefix || name.startsWith(prefix + '.');
const candidate = (entry, prefix) => !['requires','exportsTo','opensTo'].includes(entry.role) && includes(prefix, entry.name);

function matches(actual, expected) {
  return actual && ['role', 'name', 'start', 'end'].every(key => actual[key] === expected[key]);
}

function bindModuleDescriptor(unit, descriptor, prefix) {
  const expected = descriptor.declarations;
  const resolved = unit?.module?.declarations;
  if (unit?.module?.name !== descriptor.name || !Array.isArray(resolved) || resolved.length !== expected.length ||
      !expected.every((item, index) => matches(resolved[index], item))) {
    throw Error('Javac did not resolve the exact declared package and service identities in module-info.java.');
  }
  const prefixes = resolved.filter(entry => candidate(entry, prefix));
  if (prefixes.length !== unit.spans.length ||
      !prefixes.every((entry, index) => unit.spans[index].start === entry.start &&
        unit.spans[index].end === entry.start + prefix.length)) {
    throw Error('The module descriptor contains a package token outside the attributed directive review.');
  }
  return { spans: unit.spans, declarations: resolved, name: descriptor.name };
}

function verifyModuleProjection(before, after, oldPackage, newPackage) {
  const delta = newPackage.length - oldPackage.length;
  const offset = point => point + before.spans.filter(span => span.end <= point).length * delta;
  const expected = before.declarations.map(entry => ({
    ...entry, start: offset(entry.start), end: offset(entry.end),
    name: candidate(entry, oldPackage) ? newPackage + entry.name.slice(oldPackage.length) : entry.name
  }));
  const observed = after?.module?.declarations;
  if (after?.module?.name !== before.name || !Array.isArray(observed) || observed.length !== expected.length ||
      !expected.every((item, index) => matches(observed[index], item))) {
    throw Error('Package Rename would change an unrelated module or its directive, package or provider binding.');
  }
}

function reconcileModuleText(before, engineText, spans, oldPackage, newPackage) {
  let original = 0, actual = 0, confirmed = 0;
  const conflict = () => Error('JDT proposed module-info.java edits outside exact attributed package directives.');
  for (const span of spans) {
    const context = before.slice(original, span.start);
    if (!engineText.startsWith(context, actual)) throw conflict();
    actual += context.length;
    if (engineText.startsWith(newPackage, actual)) {
      actual += newPackage.length;
      confirmed++;
    } else if (engineText.startsWith(oldPackage, actual)) {
      actual += oldPackage.length;
    } else throw conflict();
    original = span.end;
  }
  if (before.slice(original) !== engineText.slice(actual)) throw conflict();
  return confirmed;
}

module.exports = { bindModuleDescriptor, verifyModuleProjection, reconcileModuleText };
