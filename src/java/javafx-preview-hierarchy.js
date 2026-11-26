'use strict';

const { readFxml } = require('./javafx-fxml');

const namespace = /^https?:\/\/javafx\.com\/javafx(?:\/[\d.]+)?$/u;
const panes = new Set(['Group', 'Pane', 'AnchorPane', 'StackPane', 'VBox', 'HBox', 'FlowPane', 'TilePane', 'GridPane']);
const palette = Object.freeze({
  Label: '<javafx.scene.control.Label text="Label"/>',
  Button: '<javafx.scene.control.Button text="Button"/>',
  TextField: '<javafx.scene.control.TextField promptText="Text"/>',
  Rectangle: '<javafx.scene.shape.Rectangle width="24" height="16" fill="#4488cc"/>',
  VBox: '<javafx.scene.layout.VBox/>',
  HBox: '<javafx.scene.layout.HBox/>'
});

function typeOf(node) {
  if (!node.namespace || namespace.test(node.namespace)) return node.local.split('.').at(-1);
}

function containerBody(node) {
  const type=typeOf(node);
  const javaType=(type==='Group' ? 'javafx.scene.' : 'javafx.scene.layout.')+type;
  if (!panes.has(type) || (node.local!==type && node.local!==javaType) ||
      node.properties.some(property => property.name === 'children')) return;
  const wrappers = node.children.filter(child => typeOf(child) === 'children');
  if (!wrappers.length) return node;
  if (wrappers.length === 1 && !wrappers[0].properties.length &&
      !node.children.some(child => /^[A-Z]/u.test(typeOf(child) || ''))) return wrappers[0];
}

const nameOf = node => typeOf(node) + (node.id ? ' · ' + node.id : '');
const keyFor = node => String(node.start);

function model(source) {
  const { elements } = readFxml(source, { properties: true });
  const entries = new Map();
  function visit(node, depth) {
    const body = containerBody(node);
    if (body && entries.size < 64) {
      const children = body.children.filter(child => /^[A-Z]/u.test(typeOf(child) || ''));
      const childActions = children.flatMap((child, index) => {
        const before = children[index - 1], after = children[index + 1];
        const relations = [];
        // Move a complete pair of adjacent elements; preserve all text between and around them.
        if (before && /^\s*$/u.test(source.slice(before.end, child.start))) relations.push('earlier');
        if (after && /^\s*$/u.test(source.slice(child.end, after.start))) relations.push('later');
        if (!child.id && !child.children.length && Object.hasOwn(palette,typeOf(child)) &&
            !child.properties.some(property=>/^on[A-Z]/u.test(property.name))) relations.push('remove');
        return relations.length ? [{ key: keyFor(child), label: nameOf(child), index, relations }] : [];
      });
      entries.set(keyFor(node), { node, body, depth, children, childActions });
    }
    for (const child of node.children) visit(child, depth + 1);
  }
  for (const element of elements) visit(element, 0);
  return entries;
}

function hierarchyTargets(source) {
  return [...model(source)].map(([key, entry]) => ({ key, depth: entry.depth, label: nameOf(entry.node),
    children: entry.childActions.map(({ key, label, index, relations }) => ({ key, label, position: index + 1, relations })) }));
}

function lineIndent(text, point) {
  const start = text.lastIndexOf('\n', point - 1) + 1;
  const indentation = text.slice(start, point);
  return /^[\t ]*$/u.test(indentation) ? { start, indentation } : undefined;
}

function insert(source, entry, type) {
  if (!Object.hasOwn(palette, type)) throw Error('Choose a built-in JavaFX node from the palette.');
  const { body } = entry;
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const parentIndent = lineIndent(source, body.start)?.indentation || '';
  const sample = body.children.find(child => lineIndent(source, child.start));
  const siblingIndent = sample && lineIndent(source, sample.start).indentation;
  const childIndent = siblingIndent?.startsWith(parentIndent) && siblingIndent.length > parentIndent.length ?
    siblingIndent : parentIndent + (parentIndent.includes('\t') ? '\t' : '  ');
  const line = childIndent + palette[type] + newline;
  if (body.selfClosing) {
    if (source.slice(body.closeStart, body.openEnd) !== '/>') throw Error('The self-closing FXML element changed.');
    return { start: body.closeStart, end: body.openEnd, encoded: '>' + newline + line + parentIndent + '</' + body.name + '>' };
  }
  if (!source.slice(body.closeStart, body.end).startsWith('</' + body.name)) throw Error('The FXML closing element changed.');
  const close = lineIndent(source, body.closeStart);
  const start = close?.start ?? body.closeStart;
  const encoded = close ? line : newline + line + parentIndent;
  return { start, end: start, encoded };
}

function reorder(source, entry, child, direction) {
  const target = entry.childActions.find(item => item.key === child && item.relations.includes(direction));
  if (!target) throw Error('Choose a direct adjacent JavaFX child and an available direction.');
  const index = direction === 'earlier' ? target.index - 1 : target.index;
  const first = entry.children[index], second = entry.children[index + 1];
  const between = source.slice(first.end, second.start);
  return { start: first.start, end: second.end,
    encoded: source.slice(second.start, second.end) + between + source.slice(first.start, first.end),
    before: nameOf(first) + ' → ' + nameOf(second), after: nameOf(second) + ' → ' + nameOf(first) };
}

function remove(source, entry, child) {
  const target=entry.childActions.find(item=>item.key===child && item.relations.includes('remove'));
  if (!target) throw Error('Choose a built-in leaf without controller or event wiring.');
  const node=entry.children[target.index];
  const line=lineIndent(source,node.start), newline=source.indexOf('\n',node.end);
  const ownedLine=line && newline!==-1 && /^[\t \r]*$/u.test(source.slice(node.end,newline));
  return { start:ownedLine ? line.start : node.start, end:ownedLine ? newline+1 : node.end,
    encoded:'', before:nameOf(node), after:'Remove '+nameOf(node) };
}

function hierarchyReplacement(source, { parent, operation, type, child } = {}) {
  const entry = model(source).get(parent);
  if (!entry) throw Error('Choose a supported JavaFX container from the current preview.');
  let edit;
  switch (operation) {
    case 'insert': edit={ ...insert(source,entry,type),before:nameOf(entry.node),after:'Add '+type };break;
    case 'earlier':
    case 'later': edit=reorder(source,entry,child,operation);break;
    case 'remove': edit=remove(source,entry,child);break;
    default: throw Error('Choose an FXML hierarchy operation.');
  }
  const { start, end, encoded } = edit;
  return { ...edit, scope: 'hierarchy', parent, operation, text: source.slice(0, start) + encoded + source.slice(end) };
}

module.exports = { hierarchyTargets, hierarchyReplacement, paletteTypes: Object.keys(palette) };
