'use strict';

const { SaxesParser } = require('saxes');
const { rangeAt } = require('../spring/java');

const BEANS = 'http://www.springframework.org/schema/beans';
const classAttributes = new Set(['class', 'type', 'target-type', 'value-type', 'key-type']);
const configuredValue = new Set(['mainClass', 'implementation', 'provider', 'class', 'value']);

function beanClassEdits(source, oldFqn, newFqn) {
  const { text } = source;
  const oldName = oldFqn.split('.').at(-1);
  if (!text.includes(oldName) && !text.includes('&#')) return [];
  if (Buffer.byteLength(text) > 256 * 1024) throw Error('Spring XML class reference review requires XML files up to 256 KiB.');
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const changes = [];
  parser.on('doctype', () => {
    throw Error('Spring XML class reference review requires XML without DTDs.');
  });
  parser.on('error', () => {
    throw Error('Resolve malformed XML before reviewing its Java class references.');
  });
  parser.on('opentag', tag => {
    stack.push(tag);
    for (const attribute of Object.values(tag.attributes)) {
      if ((!classAttributes.has(attribute.local) && !(tag.uri === BEANS && attribute.local === 'value')) ||
          (attribute.value !== oldFqn && !attribute.value.startsWith(oldFqn + '$'))) continue;
      const root = stack[0];
      if (tag.uri !== BEANS || tag.local !== 'bean' || root.uri !== BEANS || root.local !== 'beans' ||
          attribute.uri || attribute.local !== 'class' || attribute.value !== oldFqn) {
        throw Error('A Java type reference uses an unsupported XML class contract.');
      }
      const tagStart = text.lastIndexOf('<', parser.position - 1);
      const openingTag = text.slice(tagStart, parser.position);
      const attributes = openingTag.slice(tag.name.length + 1);
      const tokens = [...attributes.matchAll(/\s+([^\s=\/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)];
      const token = tokens.find(match => match[1] === 'class');
      if (!token || (token[2] ?? token[3]) !== oldFqn) {
        throw Error('Review bean classes with ordinary literal XML attributes.');
      }
      const start = tagStart + tag.name.length + 1 + token.index + token[0].length - oldFqn.length - 1;
      if (text.slice(start, start + oldFqn.length) !== oldFqn) throw Error('Cannot locate the exact XML bean class attribute.');
      changes.push({ range: rangeAt(text, start, start + oldFqn.length), newText: newFqn });
    }
  });
  const checkValue = value => {
    if (configuredValue.has(stack.at(-1)?.local) && (value.trim() === oldFqn || value.trim().startsWith(oldFqn + '$'))) {
      throw Error('A Java type reference uses an unsupported XML class contract.');
    }
  };
  parser.on('text', checkValue);
  parser.on('cdata', checkValue);
  parser.on('closetag', () => stack.pop());
  parser.write(text).close();
  if (changes.length > 100) throw Error('The XML bean class edit count exceeds its review bound.');
  return changes;
}

module.exports = { beanClassEdits };
