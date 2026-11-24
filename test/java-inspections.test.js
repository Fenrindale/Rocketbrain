'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectionProfile,inspectionProfiles } = require('../src/java/inspection-profiles');
const { inspectSources } = require('../src/java/inspection-analysis');

const source = (name,text) => ({ uri:'file:///test-project/' + name + '.java',text });
const profile = values => inspectionProfile({ name:'Saved Java',...values });

test('inspection profiles validate and match explicit saved source scopes and severity overrides',() => {
  const custom = profile({
    include:['**/src/main/java/**/*.java'],exclude:['**/generated/**','src/main/java/.../Old?.java'],
    rules:{ emptyCatch:'error',emptyFinally:'off' },duplicateMode:'ignore-literals',minDuplicateTokens:40
  });
  assert.ok(custom.matches('src/main/java/Entry.java'));
  assert.ok(custom.matches('project/src/main/java/example/service/Entry.java'));
  assert.equal(custom.matches('project/src/test/java/example/Test.java'),false);
  assert.equal(custom.matches('project/src/main/java/generated/Code.java'),false);
  assert.equal(custom.rules.emptyCatch,'error');
  assert.equal(custom.rules.emptyFinally,'off');
  assert.equal(custom.rules.emptyIf,'warning');
  assert.throws(() => profile({include:['../escape.java']}), /no traversal/);
  assert.throws(() => profile({rules:{missingRule:'hint'}}), /known Java inspection/);
  assert.throws(() => profile({duplicateMode:'unsafe',minDuplicateTokens:8}), /exact or ignore-literals/);
  assert.equal(inspectionProfiles([{name:'Java workspace',rules:{emptyCatch:'off'}}]).length,2);
  assert.throws(() => inspectionProfiles([{name:'Custom'},{name:'Custom'}]), /unique/);
});

test('precise Java rules produce ranges and trust inline/next-line suppression outside strings and block comments',() => {
  const java = source('Rules',[
    '// rocketbrain-ignore-file: emptyFinally',
    'package example;',
    'import java.util.List;',
    'import java.util.List;',
    'import static java.util.Collections.emptyList;',
    'import static java.util.Collections.emptyList; // rocketbrain-ignore: duplicateImport',
    'class Rules {',
    '    void run(boolean pass) {',
    '        if (pass);',
    '        if (pass) /* intentional */ ;',
    '        // rocketbrain-ignore: emptyIf',
    '        if (pass);',
    '        String sample = "if (pass); // rocketbrain-ignore: emptyCatch";',
    '        /*',
    '          // rocketbrain-ignore: emptyCatch',
    '        */',
    '        try { sample.trim(); } catch (IllegalArgumentException error) { }',
    '        try { sample.trim(); } catch (IllegalArgumentException error) { /* documented */ }',
    '        try { sample.trim(); } finally { }',
    '    }',
    '}'
  ].join('\r\n'));
  const result = inspectSources([java],profile({rules:{ emptyCatch:'error',duplicateImport:'hint' }}),{duplicates:false});
  assert.equal(result.scannedFiles,1);
  assert.deepEqual(result.findings.map(value => [value.id,value.severity,value.range.start.line]),[
    ['duplicateImport','hint',3], ['emptyIf','warning',8], ['emptyCatch','error',16]
  ]);
  const empty = result.findings.at(-1).range;
  assert.equal(java.text.split('\r\n')[empty.start.line].slice(empty.start.character,empty.end.character),
    'catch (IllegalArgumentException error) { }');
  const disabled = inspectSources([java],profile({rules:{ emptyCatch:'off',emptyIf:'off',duplicateImport:'off' }}),{duplicates:false});
  assert.deepEqual(disabled.findings,[]);
});

function body(name,constant,rename = 'total') {
  return source(name,[
    'package example;', 'class ' + name + ' {',
    '    int count(int input) {',
    '        int ' + rename + ' = input + ' + constant + ';',
    '        ' + rename + ' = ' + rename + ' * ' + constant + ';',
    '        ' + rename + ' = ' + rename + ' - ' + constant + ';',
    '        if (' + rename + ' > ' + constant + ') {',
    '            ' + rename + ' += ' + constant + ';',
    '        }',
    '        return ' + rename + ';',
    '    }',
    '}'
  ].join('\n'));
}

test('statement-aligned duplicates merge exact spans, normalize literals narrowly and preserve original ranges',() => {
  const left = body('Left',3), right = body('Right',3), changed = body('Changed',8), renamed = body('Renamed',3,'amount');
  const extraComment = { ...right,text:right.text.replace('int total','/* ordinary comment */ int total') };
  const all = [left,extraComment,changed,renamed];
  const exact = inspectSources(all,profile({minDuplicateTokens:24}));
  assert.equal(exact.duplicateMode,'exact');
  assert.deepEqual(exact.duplicateGroups[0].occurrences.map(item => item.method),['Left.count','Right.count']);
  const normalized = inspectSources(all,profile({minDuplicateTokens:24,duplicateMode:'ignore-literals'}));
  assert.equal(normalized.duplicateGroups.length,1);
  const group = normalized.duplicateGroups[0];
  assert.deepEqual(group.occurrences.map(item => item.method),['Changed.count','Left.count','Right.count']);
  for (const item of group.occurrences) {
    const original = all.find(file => file.uri === item.uri).text;
    assert.match(original.slice(item.start,item.end),/^int total = input \+ (3|8);[\s\S]*return total;$/);
    assert.equal(item.range.start.line,3);
  }
  assert.equal(normalized.duplicateSearchTruncated,false);
});

test('source scan skips unbalanced files and does not report one overlapping span as its own duplicate',() => {
  const broken = source('Invalid','class Invalid { void bad() { if (value); ');
  const one = source('One','class One { void run() {\n a();\n a();\n a();\n a();\n a();\n a();\n a();\n } }');
  const result = inspectSources([broken,one],profile({minDuplicateTokens:20}));
  assert.equal(result.skipped.length,1);
  assert.equal(result.scannedFiles,1);
  assert.deepEqual(result.duplicateGroups,[]);
});
