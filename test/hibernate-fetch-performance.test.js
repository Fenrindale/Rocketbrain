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
