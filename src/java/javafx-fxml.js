'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SaxesParser } = require('saxes');
const { inside, workspacePath } = require('./workbench-model');

const fxmlNamespace = /^https?:\/\/javafx\.com\/fxml(?:\/\d+)?$/;
const memberName = /^[A-Za-z_$][\w$]*$/;
const qualifiedName = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const sourceLimit = 512 * 1024;

function readFxml(source, { properties = false } = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > sourceLimit) {
    throw Error('Open an FXML file up to 512 KiB.');
  }
  const parser = new SaxesParser({ xmlns: true });
  const stack = [];
  const elements = [];
  const references = [];
  const ids = new Set();
  const diagnostics = [];
  let controller = null;
  let tagStart = 0;
  let count = 0;

  parser.on('doctype', () => { throw Error('FXML document type declarations are unsupported.'); });
  parser.on('opentagstart', tag => { tagStart = parser.position - tag.name.length - 2; });
  parser.on('opentag', tag => {
    if (++count > 3000 || stack.length >= 64) throw Error('FXML exceeds 3,000 elements or a depth of 64.');
    const start = tagStart;
    const attributes = source.slice(start, parser.position);
    const spans = new Map();
    for (const match of attributes.matchAll(/([^\s=<>/]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const offset = start + match.index + match[0].indexOf(match[2]) + 1;
      spans.set(match[1], { start: offset, end: offset + (match[3] ?? match[4]).length });
    }
    const node = { name: tag.name, start, end: parser.position, children: [] };
    if (properties) {
      node.local = tag.local;
      node.namespace = tag.uri;
      node.properties = [];
      node.openEnd = parser.position;
      node.selfClosing = tag.isSelfClosing;
    }
    const siblings = stack.at(-1)?.children || elements;
    siblings.push(node);
    stack.push(node);
    const include = fxmlNamespace.test(tag.uri) && tag.local === 'include';
    for (const attribute of Object.values(tag.attributes)) {
      const range = spans.get(attribute.name);
      if (!range) continue;
      const { local, value, uri } = attribute;
      if (properties && !uri) node.properties.push({ name: local, value, ...range });
      if (fxmlNamespace.test(uri) && local === 'controller' && stack.length === 1 && qualifiedName.test(value)) {
        controller = { kind: 'controller', value, ...range };
        references.push(controller);
      } else if (fxmlNamespace.test(uri) && local === 'id' && memberName.test(value)) {
        node.id = value;
        if (ids.has(value)) diagnostics.push({ message: 'Duplicate fx:id ' + value, ...range });
        ids.add(value);
        references.push({ kind: 'field', value, ...range });
      } else if (!uri && /^on[A-Z]/.test(local) && value.startsWith('#') && memberName.test(value.slice(1))) {
        references.push({ kind: 'handler', value: value.slice(1), ...range });
      } else if (!uri && include && local === 'source') {
        references.push({ kind: 'include', value, ...range });
      } else if (!uri && value.startsWith('@') && value.length > 1) {
        references.push({ kind: 'resource', value: value.slice(1), ...range });
      }
    }
  });
  parser.on('closetag', () => {
    const node = stack.pop();
    node.end = parser.position;
    if (properties) node.closeStart = node.selfClosing ? node.openEnd - 2 : source.lastIndexOf('</', node.end - 1);
  });
  parser.write(source).close();
  return { elements, references, controller, diagnostics };
}

function moduleOf(file, root) {
  const relative = path.relative(root, file).split(path.sep);
  for (let i = 0; i < relative.length - 3; i++) {
    if (relative[i] === 'src' && relative[i + 1] === 'main' && relative[i + 2] === 'resources') {
      return path.join(root, ...relative.slice(0, i));
    }
  }
  return null;
}

function localCandidate(file, root) {
  try {
    return workspacePath(file, [root], { directory: false });
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ROCKETBRAIN_JAVA_WORKBENCH'].includes(error.code)) return null;
    throw error;
  }
}

function resolveFxmlFile({ filename, workspaceRoot, reference, controller }) {
  const file = workspacePath(filename, [workspaceRoot], { directory: false });
  const project = moduleOf(file, workspaceRoot);
  if (!project) return null;
  if (['controller', 'handler', 'field'].includes(reference.kind) && controller) {
    return localCandidate(path.join(project, 'src', 'main', 'java', ...controller.value.split('.')) + '.java', project);
  }
  if (!['include', 'resource'].includes(reference.kind)) return null;
  const name = reference.value;
  if (!name || /[\\:\x00-\x1f?#]/.test(name) || name.startsWith('//')) return null;
  const resources = path.join(project, 'src', 'main', 'resources');
  const target = name.startsWith('/') ? path.resolve(resources, name.slice(1)) : path.resolve(path.dirname(file), name);
  return inside(resources, target) ? localCandidate(target, resources) : null;
}

module.exports = { readFxml, resolveFxmlFile };
