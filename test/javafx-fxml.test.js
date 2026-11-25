'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readFxml, resolveFxmlFile } = require('../src/java/javafx-fxml');

const fxml = `<?xml version="1.0"?>
<!-- comment with #create and fx:controller="Else" -->
<Group xmlns:f="http://javafx.com/fxml/1" f:controller="dev.example.Panel">
  <Group f:id='target' onMouseClicked="#create" stylesheets='@/theme.css'/>
  <f:include source='detail.fxml'/>
  <Group f:id='target'/>
</Group>`;

test('FXML indexes the actual namespaced values and preserves decoded XML spans', () => {
  const result = readFxml(fxml);
  assert.deepEqual(result.references.map(({kind, value, start, end}) => [kind, value, fxml.slice(start, end)]), [
    ['controller', 'dev.example.Panel', 'dev.example.Panel'], ['field', 'target', 'target'], ['handler', 'create', '#create'],
    ['resource', '/theme.css', '@/theme.css'], ['include', 'detail.fxml', 'detail.fxml'], ['field', 'target', 'target']
  ]);
  assert.equal(result.elements[0].start, fxml.indexOf('<Group'));
  assert.equal(result.elements[0].end, fxml.length);
  assert.equal(result.elements[0].children[1].start, fxml.indexOf('<f:include'));
  assert.equal(result.diagnostics.length, 1);
  assert.throws(() => readFxml('<!DOCTYPE Group><Group/>'), /document type/);
  assert.throws(() => readFxml('<Group><Group></X>'), /unexpected close tag/);
});

test('FXML file resolution stays in the observed Maven or Gradle module resources', t => {
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rocketbrain-fxml-')));
  t.after(() => fs.rmSync(workspaceRoot, { recursive: true, force: true }));
  const module = path.join(workspaceRoot, 'module', 'src', 'main');
  const resources = path.join(module, 'resources');
  const folder = path.join(resources, 'views');
  const controllerPath = path.join(module, 'java', 'dev', 'example', 'Panel.java');
  const filename = path.join(folder, 'main.fxml');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.dirname(controllerPath), { recursive: true });
  fs.writeFileSync(filename, fxml);
  fs.writeFileSync(path.join(folder, 'detail.fxml'), '<Group/>');
  fs.writeFileSync(path.join(resources, 'theme.css'), '.root {}');
  fs.writeFileSync(path.join(module, 'private.txt'), 'Outside resources');
  fs.writeFileSync(controllerPath, 'package dev.example; public class Panel {}');
  const result = readFxml(fxml);
  const resolve = reference => resolveFxmlFile({ filename, workspaceRoot, controller: result.controller, reference });
  assert.equal(resolve(result.controller), controllerPath);
  assert.equal(resolve(result.references[3]), path.join(resources, 'theme.css'));
  assert.equal(resolve(result.references[4]), path.join(folder, 'detail.fxml'));
  assert.equal(resolve({ kind: 'include', value: '../../private.txt' }), null);
  assert.equal(resolve({ kind: 'resource', value: 'https://example.com/a.css' }), null);
});
