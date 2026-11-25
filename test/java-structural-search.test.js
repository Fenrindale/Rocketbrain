'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { structuralQuery,parseCaptureConstraints,reviewedStructuralMatches,structuralEdits } = require('../src/java/structural-search');

test('structural templates validate type constraints and bound edit ranges', () => {
  assert.deepEqual(parseCaptureConstraints('value = int, other <: java.lang.Number[]'),[
    { name:'value',type:'int',relation:'exact' },
    { name:'other',type:'java.lang.Number[]',relation:'assignable' }
  ]);
  assert.throws(() => parseCaptureConstraints('other java.lang.Number'), /Use name=Type/);
  assert.throws(() => structuralQuery({pattern:'x',constraints:[{name:'arg',type:'T'},{name:'arg',type:'String'}]}), /distinct/);
  const sources = [{uri:'file:///Example.java',text:'int n = 10;\r\nMath.max(n, 0);'}];
  const result = reviewedStructuralMatches({truncated:false,matches:[
    {uri:sources[0].uri,start:13,end:27,captures:[],replacement:'Math.min(n, 0)'},
    {uri:sources[0].uri,start:22,end:23,captures:[],replacement:'m'}
  ]},sources);
  assert.deepEqual(result.matches[0].range,{ start:{line:1,character:0},end:{line:1,character:14} });
  assert.throws(() => structuralEdits(result.matches,[1,2],sources), /Overlapping structural matches/);
  assert.throws(() => structuralEdits(result.matches,[1,1],sources), /distinct matches/);
  assert.equal(structuralEdits(result.matches,[1],sources).sources[0].text,'int n = 10;\r\nMath.min(n, 0);');
});

const configuration = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
test('Javac finds typed Java structures and checks only reviewed replacements', {
  skip:configuration ? false : 'Independent JDK25 runtime is not configured.', timeout:85000
}, async t => {
  const { javaHome } = JSON.parse(await fs.readFile(configuration,'utf8'));
  const workspace = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-structural-search-'));
  t.after(() => fs.rm(workspace,{recursive:true,force:true}));
  const unit = (name,text) => ({ uri:pathToFileURL(path.join(workspace,name+'.java')).href,text });
  const source = unit('Example',[
    'final class Example {',
    '  int selected(int n) { return Math.min(/* operator context */ n, 0); }',
    '  int nested(int n) { return Math.min(Integer.parseInt("7"), 0); }',
    '  long untouched(long n) { return Math.min(n, 0); }',
    '  String quoted() { return "Math.min(n, 0)"; }',
    '  int repeated(int n, int m) { return n + n + (n + m); }',
    '  CharSequence text(String value) { return value; }',
    '  String typeOnly(String value) { return value; }',
    '}'
  ].join('\n'));
  const other = unit('Other', 'class Other { int f(int n) { return Math.min(n, 0); } }');
  const runtime = { javaHome,storagePath:path.join(workspace,'inspections'),sources:[source,other] };
  const run = async inspection => {
    const result = await analyzeJavaSources({...runtime,inspection:{kind:'structural',...inspection}});
    assert.deepEqual(result.errors,[]);
    return result.structural;
  };
  const result = await run({pattern:'Math.min($n$,0)',replacement:'Math.max($n$,0)',
    constraints:[{name:'n',type:'int'}],uri:source.uri});
  const report = reviewedStructuralMatches(result,runtime.sources);
  assert.equal(report.matches.length,2);
  assert.equal(report.matches[0].snippet,'Math.min(/* operator context */ n, 0)');
  assert.deepEqual(report.matches[0].captures,[{name:'n',type:'int'}]);
  assert.equal(report.matches[0].replacement,'(Math.max((n),0))');
  assert.match(report.matches[1].blocked,/captured literals/);
  const candidate = structuralEdits(report.matches,[1],runtime.sources);
  assert.match(candidate.sources[0].text,/return \(Math\.max\(\(n\),0\)\)/);
  assert.equal(candidate.sources[1].text,other.text);
  const checked = await analyzeJavaSources({...runtime,sources:candidate.sources,inspection:{kind:'check'}});
  assert.deepEqual(checked.errors,[]);
  const invalid = await analyzeJavaSources({...runtime,sources:[
    {...source,text:source.text.replace('Math.min(/* operator context */ n, 0)','"incompatible"')},other
  ],inspection:{kind:'check'}});
  assert.equal(invalid.errors.length,1);
  assert.throws(() => structuralEdits(report.matches,[2],runtime.sources), /replaceable matches/);

  const repeated = reviewedStructuralMatches(await run({pattern:'$x$ + $x$',uri:source.uri}),runtime.sources);
  assert.deepEqual(repeated.matches.map(match => match.snippet),['n + n']);
  const assignable = reviewedStructuralMatches(await run({mode:'statement',pattern:'return $text$;',
    constraints:[{name:'text',type:'java.lang.CharSequence',relation:'assignable'}],uri:source.uri}),runtime.sources);
  assert.deepEqual(assignable.matches.map(match => match.captures[0].type),
    ['java.lang.String','java.lang.String','java.lang.String']);
  const typeOnly = await run({pattern:'String',uri:source.uri});
  assert.deepEqual(typeOnly.matches,[]);
  const unknown = await run({pattern:'Math.min($x$,0)',replacement:'Math.max($missing$,0)'});
  assert.match(unknown.error,/absent from the search template/);
  const missingType = await run({pattern:'Math.min($x$,0)',constraints:[{name:'x',type:'fake.Missing'}]});
  assert.match(missingType.error,/Unresolved Java capture type/);
  const incomplete = await run({mode:'statement',pattern:'return 0; return 1;'});
  assert.match(incomplete.error,/one valid Java statement/);
});
