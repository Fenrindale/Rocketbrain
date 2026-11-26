'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizePerformance } = require('../src/jpa/fetch-performance');

const role = {
  role: 'fixture.boot.Team.members', entity: 'fixture.boot.Team',
  ownerTable: 'teams', childTable: 'members', keyColumn: 'team_id'
};
const root = 'select t.id from teams t';
const child = 'select m.team_id,m.id from members m where m.team_id=?';
const event = (sql, sequence, options={}) => ({ sql, sequence, session:1, durationMicros:30, ...options });
const collection = (key, sequence, options={}) => event(child, sequence, { collection:{...role,key}, ...options });
const sample = (selects, options={}) => ({ id:1, route:'/teams/{team}', method:'GET', complete:true,
  durationMicros:280, omittedSelects:0, selects, ...options });
const snapshot = (requests, options={}) => ({ enabled:true, available:true, rawBindValuesRetained:false, observerExecutedSql:false,
  scope:'synchronous-spring-mvc', requests, ...options });
const summarize = (selects, options) => summarizePerformance(snapshot([sample(selects, options)])).requests[0];

test('bounded fetch evidence reports one parent SELECT plus ordered distinct single-key collection reads', () => {
  const report = summarize([event(root,1),collection(1,2),collection(2,3),collection(3,4)]);
  assert.equal(report.selectCount,4);
  assert.equal(report.coverage,'complete-within-supported-hooks');
  const [finding] = report.suspects;
  assert.equal(finding.collectionRole,role.role);
  assert.deepEqual(finding.parent,{sequence:1,sql:root,durationMicros:30});
  assert.deepEqual(finding.child,{sql:child,sequences:[2,3,4],executions:3,distinctOwnerKeys:3,totalDurationMicros:90});
});

test('direct repeated reads, duplicate keys, unrelated parents and sessions do not establish collection N+1', () => {
  const neutral = [
    [event(root,1),event(child,2),event(child,3)],
    [event(root,1),collection(1,2),collection(1,3)],
    [event(root,1),collection(1,2,{session:2}),collection(2,3,{session:2})],
    [event(root,1),collection(1,2),event(root,3),collection(2,4)],
    [event('select x.id from archive.teams x',1),collection(1,2),collection(2,3)]
  ];
  for (const selects of neutral) assert.deepEqual(summarize(selects).suspects,[]);
  const cross = summarizePerformance(snapshot([
    sample([event(root,1),collection(1,2)]),
    sample([event(root,1),collection(2,2)],{id:2})
  ]));
  assert.ok(cross.requests.every(request => request.suspects.length===0));
});

test('selects with wrong placeholders or data-bearing SQL are withheld and force partial coverage', () => {
  const cases = [
    event("select m.id from members m where m.private = 'synthetic-private-value'",3),
    event('select m.id from members m where m.private = 43905642',3),
    event('select m.id from members m where m.team_id=? /* never-surface-this */',3),
    collection(2,3,{sql:'select m.id from members m where m.id=?'}),
    collection(2,3,{sql:'select m.id from members m where exists (select x.id from teams x where m.team_id=?)'}),
    collection(2,3,{sql:'select m.id from members m where m.team_id=? and m.id=?'})
  ];
  for (const invalid of cases) {
    const result=summarize([event(root,1),collection(1,2),invalid]);
    assert.equal(result.coverage,'partial');
    assert.equal(result.omittedSelects,1);
    assert.deepEqual(result.suspects,[]);
    assert.equal(result.selectCount,2);
    assert.ok(!JSON.stringify(result).includes(invalid.sql));
  }
});

test('older or incomplete observers, truncation and malformed groups never imply complete coverage', () => {
  assert.equal(summarizePerformance(undefined).state,'disabled');
  const notLoaded=summarizePerformance(snapshot([sample([event(root,1)])],{available:false}));
  assert.equal(notLoaded.state,'awaiting-supported-hooks');
  assert.equal(notLoaded.requests[0].coverage,'partial');
  const excluded=summarize([event(root,1),collection(1,2),collection(2,3)],{omittedSelects:2});
  assert.equal(excluded.coverage,'partial');
  assert.deepEqual(excluded.suspects,[]);
  assert.deepEqual(summarizePerformance(snapshot([sample([])],{rawBindValuesRetained:true})).requests,[]);
});

const compositeRole = {
  role:role.role,entity:role.entity,ownerTable:role.ownerTable,childTable:role.childTable,
  keyColumns:['team_id','tenant_id']
};
const composite = (sql,key,sequence) => event(sql,sequence,{collection:{...compositeRole,key}});

test('composite collection reads bind each physical key column for one distinct owner tuple', () => {
  const prefix='select m.id from members m where ';
  const supported = [
    'm.tenant_id=? and m.team_id=?',
    'm.team_id=? and ?=m.tenant_id',
    '(m.tenant_id,m.team_id)=(?,?)',
    '(m.team_id,m.tenant_id) in ((?,?))'
  ];
  for(const predicate of supported) {
    const statement=prefix+predicate;
    const report=summarize([event(root,1),composite(statement,1,2),composite(statement,2,3)]);
    assert.equal(report.coverage,'complete-within-supported-hooks');
    assert.deepEqual(report.suspects[0].keyColumns,compositeRole.keyColumns);
    assert.equal(report.suspects[0].child.distinctOwnerKeys,2);
    const repeated=summarize([event(root,1),composite(statement,1,2),composite(statement,1,3)]);
    assert.deepEqual(repeated.suspects,[]);
  }
});

test('an incomplete tuple, another alias, or multiple tuple bindings cannot claim a composite collection match', () => {
  const prefix='select m.id from members m where ';
  for(const predicate of [
    'm.team_id=?',
    'm.team_id=? or m.tenant_id=?',
    'm.team_id=? and m.team_id=?',
    'm.team_id=? and x.tenant_id=?',
    '(m.team_id,m.tenant_id) in ((?,?),(?,?))'
  ]) {
    const statement=prefix+predicate;
    const result=summarize([event(root,1),composite(statement,1,2),composite(statement,2,3)]);
    assert.equal(result.coverage,'partial');
    assert.equal(result.omittedSelects,2);
    assert.deepEqual(result.suspects,[]);
  }
});

test('reviewed bind metadata is position-exact, bounded and independent of collection evidence', () => {
  const observation = { bindObservation: 'hibernate-jdbc-setters-v1' };
  const sql = 'select m.id from members m where (m.tenant_id,m.team_id) in ((?,?))';
  const positions = [{ index: 1, jdbcType: 'VARCHAR', source: 'setter', value: 'never-show-this' },
    { index: 2, jdbcType: 'BIGINT', source: 'explicit' }];
  const block = { state: 'complete', placeholders: 2, positions };
  const first = { ...composite(sql,1,2), binds: block };
  const second = { ...composite(sql,2,3), binds: { state: 'partial', placeholders: 2,
    positions: [{ index: 1, source: 'untyped' }] } };
  const report = summarizePerformance(snapshot([sample([event(root,1),first,second])], observation)).requests[0];
  assert.equal(report.suspects.length, 1);
  assert.deepEqual(report.selects[1].binds, { ...block, positions: positions.map(({value,...entry}) => entry) });
  assert.equal(report.selects[2].binds.state, 'partial');
  assert.doesNotMatch(JSON.stringify(report), /never-show-this/);
  for (const binds of [
    { ...block, placeholders: 3 },
    { ...block, positions: [positions[0]] },
    { ...block, positions: [positions[0], {...positions[1], index: 1}] },
    { ...block, positions: [positions[0], {...positions[1], jdbcType: 'invented'}] }
  ]) {
    const invalid = summarizePerformance(snapshot([sample([event(root,1),{...first,binds},second])], observation)).requests[0];
    assert.deepEqual(invalid.selects[1].binds, { state:'unavailable', placeholders: 2, positions: [] });
    assert.equal(invalid.suspects.length, 1);
  }
  const excessive = event('select m.id from members m where m.id in ('+Array(17).fill('?').join(',')+')',1,{
    binds: { state:'partial', placeholders:17, positions:Array.from({length:16},(_,index)=>({index:index+1,jdbcType:'BIGINT',source:'setter'})) }
  });
  assert.equal(summarizePerformance(snapshot([sample([excessive])],observation)).requests[0].selects[0].binds.positions.length,16);
  assert.equal(summarize([event(root,1),first]).selects[1].binds,undefined);
});

test('Callable evidence keeps phase labels and fails closed for unknown or unsupported dispatch', () => {
  const observed = snapshot([], { scope:'spring-mvc', callableObservation:true });
  const phase = (select, label) => ({ ...select, phase:label });
  const selects = [phase(event(root,1),'request'),phase(collection(1,2),'callable-worker'),
    phase(collection(2,3),'callable-worker')];
  const callable = sample(selects, { dispatch:'spring-mvc-callable' });
  const complete = summarizePerformance({ ...observed, requests:[callable] });
  assert.equal(complete.scope,'spring-mvc-hibernate-selects');
  assert.equal(complete.requests[0].coverage,'complete-within-supported-hooks');
  assert.equal(complete.requests[0].suspects.length,1);
  assert.deepEqual(complete.requests[0].selects.map(select=>select.phase),['request','callable-worker','callable-worker']);

  const transitions = [
    summarizePerformance({ ...observed, callableObservation:false, requests:[callable] }),
    summarizePerformance({ ...observed, requests:[{ ...callable, complete:false }] }),
    summarizePerformance({ ...observed, requests:[{ ...callable, selects:[...selects.slice(0,2), phase(selects[2],'executor-work')] }] }),
    summarizePerformance({ ...observed, requests:[sample([selects[0]],{dispatch:'unattributed'})] })
  ];
  for(const report of transitions){
    assert.equal(report.requests[0].coverage,'partial');
    assert.equal(report.requests[0].suspects.length,0);
  }
  assert.equal(transitions[2].requests[0].omittedSelects,1);
  assert.equal(summarizePerformance({ ...observed, requests:[sample(selects,{dispatch:'arbitrary'})] }).requests.length,0);
});
