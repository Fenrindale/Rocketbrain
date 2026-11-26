'use strict';

const { readFxml } = require('./javafx-fxml');

const maximumNodes = 128;
const decimal = /^[+-]?(?:\d+(?:\.\d{1,4})?|\.\d{1,4})$/u;
const color = /^(?:#[a-fA-F0-9]{3}|#[a-fA-F0-9]{4}|#[a-fA-F0-9]{6}|#[a-fA-F0-9]{8}|transparent|black|white|red|green|blue)$/u;
const namespace = /^https?:\/\/javafx\.com\/javafx(?:\/[\d.]+)?$/u;
const groups = new Map(Object.entries({
  Group: {}, Pane: {}, AnchorPane: {}, BorderPane: {}, StackPane: {},
  HBox: { spacing: 'size' }, VBox: { spacing: 'size' },
  FlowPane: { hgap: 'size', vgap: 'size' }, GridPane: { hgap: 'size', vgap: 'size' },
  TilePane: { hgap: 'size', vgap: 'size' },
  Rectangle: { x: 'coordinate', y: 'coordinate', width: 'size', height: 'size',
    arcWidth: 'size', arcHeight: 'size', fill: 'color', strokeWidth: 'size' },
  Text: { text: 'text', x: 'coordinate', y: 'coordinate', fill: 'color' },
  Label: { text: 'text', wrapText: 'boolean' }, Button: { text: 'text' },
  CheckBox: { text: 'text', selected: 'boolean' }, RadioButton: { text: 'text', selected: 'boolean' },
  Hyperlink: { text: 'text' }, ToggleButton: { text: 'text', selected: 'boolean' },
  TextField: { text: 'text', promptText: 'text' }, TextArea: { text: 'text', promptText: 'text', wrapText: 'boolean' }
}));
const common = new Map(Object.entries({
  layoutX: 'coordinate', layoutY: 'coordinate', visible: 'boolean', opacity: 'opacity'
}));
const resizable = new Set(['Pane','AnchorPane','BorderPane','StackPane','HBox','VBox','FlowPane','GridPane','TilePane',
  'Label','Button','CheckBox','RadioButton','Hyperlink','ToggleButton','TextField','TextArea']);
const sizes = new Set(['prefWidth','prefHeight','minWidth','minHeight','maxWidth','maxHeight']);

function kind(node, property) {
  const group = groups.get(node);
  return Object.hasOwn(group, property) ? group[property] :
    resizable.has(node) && sizes.has(property) ? 'size' : common.get(property);
}

function accepts(type, value) {
  if (typeof value !== 'string' || value.length > 512 || /[\0-\x1f\x7f]|^\s*[$%@\\]/u.test(value)) return false;
  if (type === 'text') return true;
  if (type === 'boolean') return value === 'true' || value === 'false';
  if (type === 'color') return color.test(value);
  if (!decimal.test(value)) return false;
  const minimum = type === 'coordinate' ? -4096 : 0;
  const maximum = type === 'opacity' ? 1 : 4096;
  return Number(value) >= minimum && Number(value) <= maximum;
}

function targetsIn(source) {
  const { elements, diagnostics } = readFxml(source, { properties: true });
  const duplicates = new Set(diagnostics.map(item => item.message.slice('Duplicate fx:id '.length)));
  const targets = [];
  const visit = node => {
    const type = node.local.split('.').at(-1);
    if (targets.length < maximumNodes && node.id && !duplicates.has(node.id) && groups.has(type) &&
        (!node.namespace || namespace.test(node.namespace))) {
      const properties = node.properties.flatMap(attribute => {
        const typeOfValue = kind(type, attribute.name);
        return typeOfValue && accepts(typeOfValue, attribute.value) ? [{ ...attribute, kind: typeOfValue }] : [];
      });
      if (properties.length) targets.push({ id: node.id, type, properties });
    }
    for (const child of node.children) visit(child);
  };
  for (const element of elements) visit(element);
  return targets;
}

function propertyReplacement(source, { id, property, value } = {}) {
  const target = targetsIn(source).find(item => item.id === id);
  const field = target?.properties.find(item => item.name === property);
  if (!field || !accepts(field.kind, value)) throw Error('Choose a supported existing static FXML property and literal value.');
  if (value === field.value) throw Error('Enter a changed FXML property value.');
  const quote = source[field.start - 1];
  if ((quote !== '"' && quote !== "'") || source[field.end] !== quote) throw Error('The quoted FXML property changed.');
  const encoded = value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(quote, quote === '"' ? '&quot;' : '&apos;');
  return { id: target.id, type: target.type, property, before: field.value, after: value,
    start: field.start, end: field.end, encoded, text: source.slice(0, field.start) + encoded + source.slice(field.end) };
}

module.exports = { targetsIn, propertyReplacement, maximumNodes };
