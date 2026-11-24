'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { listJavaLiveTemplates, liveCandidates } = require('../src/java/live-templates');
const { inspectClass, emitMembers, materializeMembers, delegateMethods } = require('../src/java/member-generation');

function completion(text, prefix, custom) {
  const cursor = text.indexOf('^');
  const source = text.replace('^', '');
  return liveCandidates(source, cursor, listJavaLiveTemplates(custom)).find(item => item.prefix === prefix);
}

test('workspace live templates override by prefix while retaining native snippet variables', () => {
  const custom = [{ prefix: 'sout', description: 'Debug line', body: '// ${TM_FILENAME_BASE}\nSystem.out.println(${1:probe});$0' }];
  const item = completion('    so^\n', 'sout', custom);
  assert.equal(item.form, 'live');
  assert.deepEqual([item.start,item.end],[4,6]);
  assert.match(item.body, /\$\{TM_FILENAME_BASE\}|\$\{1:probe\}/);
  assert.equal(listJavaLiveTemplates(custom).filter(item => item.prefix === 'sout').length, 1);
  assert.throws(() => listJavaLiveTemplates([{ prefix: '../oops', body: 'anything' }]), /letter-led/);
});

test('Java postfix completion replaces the bounded receiver and preserves expression shape, comments and semicolon ownership', () => {
  const text = '    bean.get("a$}").nn^; // retain';
  const item = completion(text, 'nn');
  assert.deepEqual([item.start,item.end],[4,23]);
  assert.match(item.body, /bean\.get\("a\\\$\\}"\) != null/);
  assert.equal(text.replace('^','').slice(item.end), ' // retain');
  assert.equal(completion('    return (flag && ready).not^;', 'not').body, '!((flag && ready))');
  assert.equal(completion('    values[index].var^;', 'var').body, 'var ${1:value} = values[index];$0');
  assert.equal(completion('    // service.if^;', 'if'), undefined);
  assert.equal(completion('    String value = "service.nn^";', 'nn'), undefined);
  assert.equal(completion('    work(target.nn^);', 'nn'), undefined);
  assert.equal(completion('    new Worker().nn^;', 'nn'), undefined);
  assert.equal(completion('    display.na^me;', 'null'), undefined);
});

const SOURCE = 'package p;\r\nfinal class Model {\r\n'
  + '    @Deprecated private final int[] values;\r\n    private boolean enabled = true;\r\n'
  + '    private double score;\r\n    private java.util.List<String> labels;\r\n'
  + '    private String[][] children;\r\n    private int ignoredA = 1, ignoredB = 2;\r\n'
  + '    private static Object STATUS;\r\n    private final int ready = 3;\r\n}';

test('member generation extracts writable and read-only fields and renders constructor/accessor/equality members beside old source', () => {
  const model = inspectClass(SOURCE, SOURCE.indexOf('values'));
  assert.equal(model.owner,'p.Model');
  assert.equal(model.excluded, 1);
  assert.deepEqual(model.fields.map(field => field.name), ['values','enabled','score','labels','children','ready']);
  assert.throws(() => emitMembers(model, {kind:'constructor', fields:['score']}), /uninitialized final/);
  assert.throws(() => emitMembers(model, {kind:'constructor', fields:['values','ready']}), /initialized final/);
  const ctor = emitMembers(model,{kind:'constructor',fields:['values','labels']});
  assert.equal(ctor[0].declaration,'public Model(int[] values, java.util.List<String> labels)');
  const access = emitMembers(model,{kind:'accessors',fields:['values','enabled']});
  assert.deepEqual(access.map(method => method.name), ['getValues','isEnabled','setEnabled']);
  assert.throws(() => emitMembers(model,{kind:'accessors',accessor:'set',fields:['values']}), /do not have setters/);
  assert.throws(() => emitMembers(model,{kind:'accessors',fields:['enabled']}, [{name:'isEnabled',parameters:[]}]), /collides/);
  const equals = emitMembers(model,{kind:'equalsHashCode',fields:['values','score','children']});
  const edit = materializeMembers(SOURCE,model,[...ctor,...access,...equals]);
  assert.match(edit.insertion,/java\.util\.Arrays\.equals\(this.values, that.values\)/);
  assert.match(edit.insertion,/java\.lang\.Double\.compare\(this.score, that.score\) == 0/);
  assert.match(edit.insertion,/java\.util\.Arrays\.deepHashCode\(this.children\)/);
  assert.equal(edit.insertion.replaceAll('\r\n','').includes('\n'), false);
  assert.equal(edit.text.slice(0, edit.offset) + edit.text.slice(edit.generatedEnd), SOURCE);
});

test('delegate selection uses exact normal compiler signatures and preserves fully qualified forwarding types', () => {
  const model = inspectClass('package p; class Parent { Child child; }', 29);
  const method = { key:'p.Child#consume(java.lang.String)', owner:'p.Child', name:'consume',
    returnType:'int', constructor:false, parameters:[{type:'java.lang.String',name:'value'}], modifiers:['public'], throwsTypes:['java.io.IOException'] };
  assert.deepEqual(delegateMethods({methods:[method,{...method,generic:true}]},'p.Child'), [method]);
  const actual = emitMembers(model,{kind:'delegate',fields:['child'],delegate:method});
  assert.equal(actual[0].declaration,'public int consume(java.lang.String value) throws java.io.IOException');
  assert.deepEqual(actual[0].body,['return this.child.consume(value);']);
  const inherited = inspectClass('class Parent extends Base { int x; }', 31);
  assert.throws(() => emitMembers(inherited,{kind:'equalsHashCode',fields:['x']}), /inherited equality/);
});
