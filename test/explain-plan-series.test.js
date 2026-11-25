'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const { normalizePlan,comparePlans }=require('../src/db/explain-plan');
const { sampleCount,summarizeSeries,compareSeries,serializeSamples }=require('../src/db/explain-plan-series');
const { deserializeSamples,MAX_SAMPLE_FILE_BYTES }=require('../src/db/explain-plan-archive');
const { comparisonHtml,seriesHtml }=require('../src/db/explain-plan-view');

const mysql=raw=>normalizePlan({raw,engine:'mysql',version:'8.4',database:'test',format:'tree',measured:true});
const tree=(root,rows,child='')=>'-> '+root+' (cost=1 rows=7) (actual time=.010..2e-2 rows='+rows+' loops=1)\n'+child;

test('measurement series computes exact server sample distributions and keeps shape changes',()=>{
  const one=mysql(tree('Scan <literal>','9007199254740993'));
  const two=mysql(tree('Scan <literal>','9007199254740994','    -> Later iterator (actual time=0.010..0.020 rows=1 loops=1)\n'));
  const summary=summarizeSeries([one,two]);
  assert.deepEqual(summary.shapes.map(shape=>shape.samples),[[1],[2]]);
  const row=summary.metrics.find(item=>item.name==='Scan <literal>'&&item.key==='actual_rows');
  assert.deepEqual([row.count,row.min,row.median,row.max],[2,'9007199254740993','9007199254740993.5','9007199254740994']);
  const timing=summary.metrics.find(item=>item.name==='Scan <literal>'&&item.key==='first_ms');
  assert.deepEqual([timing.count,timing.min,timing.median,timing.max],[2,'.010','0.01','.010']);
  assert.equal(summary.metrics.find(item=>item.name==='Later iterator').count,1);
  const html=seriesHtml(summary,[one,two],'test');
  assert.match(html,/Scan &lt;literal&gt;/);
  assert.match(html,/2 sequential samples · 2 decoded plan shapes/);
  assert.match(html,/Raw captures/);
  assert.throws(()=>sampleCount(6),/2 to 5/);
});

test('series comparison pairs exact metric paths and labels absent samples without inventing data',()=>{
  const plan=mysql(tree('Index lookup','8'));
  const added=mysql(tree('Different scan','3'));
  const left=summarizeSeries([plan,plan,plan]), right=summarizeSeries([plan,added]);
  const report=compareSeries(left,right);
  assert.ok(report.metrics.some(item=>item.baseline?.key==='actual_rows'&&item.baseline.count===3&&item.candidate.count===1));
  assert.ok(report.metrics.some(item=>!item.baseline&&item.candidate?.name==='Different scan'));
  assert.match(seriesHtml(report,null,'test'),/Baseline · 3 samples.*Candidate · 2 samples/);
  assert.throws(()=>compareSeries(left,{...right,version:'different'}),/same server/);
  assert.throws(()=>summarizeSeries([plan,{...plan,measured:false}]),/inconsistent/);
});

test('plan comparisons pair moved unique operators and leave repeated operators unmatched', () => {
  const source = (name, rows) => '    ' + tree(name, rows);
  const before = mysql(tree('Append', '6', source('Scan A', '1') + source('Scan B', '2') +
    source('Scan B', '2') + source('Scan C', '1')));
  const after = mysql(tree('Append', '9', source('Scan B', '2') + source('Scan C', '3') +
    source('Scan A', '2') + source('Scan B', '2')));
  const comparison = comparePlans(before, after);
  const moves = comparison.rows.filter(row => row.alignment === 'moved');
  assert.equal(comparison.movedCount, 2);
  assert.deepEqual(moves.map(row => [row.before.name, row.state, row.baselinePosition, row.candidatePosition]),
    [['Scan A', 'changed', '1.1', '1.3'], ['Scan C', 'changed', '1.4', '1.2']]);
  assert.equal(comparison.rows.filter(row => row.alignment === 'unmatched').length, 4);
  const series = compareSeries(summarizeSeries([before, before]), summarizeSeries([after, after]));
  assert.equal(series.movedCount, 2);
  assert.match(seriesHtml(series, null, 'test'), /Moved 1\.1 → 1\.3/);
});

test('sample export keeps raw plan text and exact summarized values', () => {
  const first = mysql(tree('Scan', '9007199254740993'));
  const second = mysql(tree('Scan', '9007199254740994'));
  const summary = summarizeSeries([first, second]);
  const report = JSON.parse(serializeSamples(summary, [first, second], '2026-11-25T00:00:00.000Z'));
  assert.deepEqual(report.samples.map(sample => [sample.number, sample.shape, sample.format, sample.raw]),
    [[1, 1, 'tree', first.raw], [2, 1, 'tree', second.raw]]);
  assert.equal(report.summary.metrics.find(item => item.key === 'actual_rows').median, '9007199254740993.5');
});

test('moved access changes require a unique stable relation and the same access method', () => {
  const branch = (index, predicate) => '    ' + tree('Filter: ' + predicate, '2',
    '        ' + tree('Index range scan on p using ' + index + ' over ' + predicate, '3'));
  const oldBranch = branch('ix_name', '(p.name < 5)'), newBranch = branch('ix_zip', '(p.zip > 8)');
  const other = '    ' + tree('Table scan on d', '1');
  const before = mysql(tree('Append', '3', oldBranch + other));
  const after = mysql(tree('Append', '4', other + newBranch));
  const changes = comparePlans(before, after);
  assert.deepEqual(changes.rows.filter(row => row.changes.length).map(row =>
    [row.alignment, row.baselinePosition, row.candidatePosition, row.changes.map(change => change.label)]),
  [['candidate-move', '1.1', '1.2', ['Predicate']], ['candidate-move', '1.1.1', '1.2.1', ['Index', 'Predicate']]]);
  assert.equal(changes.candidateMoveCount, 2);
  assert.match(comparisonHtml(changes, 'test'), /Changed index <strong>ix_zip/);
  const measured = compareSeries(summarizeSeries([before, before]), summarizeSeries([after, after]));
  assert.equal(measured.changedAccess.length, 2);
  assert.match(seriesHtml(measured, null, 'test'), /Changed access details[\s\S]*ix_name[\s\S]*ix_zip/);

  const repeated = '    ' + tree('Table scan on p', '1');
  const ambiguousBefore = mysql(tree('Append', '5', oldBranch + other + repeated));
  const ambiguousAfter = mysql(tree('Append', '5', other + newBranch + repeated));
  assert.equal(comparePlans(ambiguousBefore, ambiguousAfter).rows.filter(row => row.changes.length).length, 0);
  const differentMethod = mysql(tree('Append', '4', other +
    newBranch.replace('Index range scan', 'Index lookup')));
  assert.equal(comparePlans(before, differentMethod).rows.filter(row => row.changes.length).length, 0);
  const unstable = compareSeries(summarizeSeries([before, ambiguousBefore]), summarizeSeries([after, after]));
  assert.equal(unstable.changedAccess.length, 0);
});

test('JSON table comparison detects a changed index and condition on a uniquely moved alias', () => {
  const table = (name, access, index, condition) => ({table:{table_name:name, access_type:access,
    key:index, attached_condition:condition, r_rows:3, r_loops:1}});
  const maria = children => normalizePlan({ raw:JSON.stringify({query_block:{nested_loop:children}}), engine:'mariadb',
    database:'test', version:'11.4', measured:true });
  const first = table('people', 'range', 'ix_primary', 'people.id <= 10');
  const second = table('people', 'range', 'ix_secondary', 'people.code >= 20');
  const other = table('dept', 'ALL');
  const match = comparePlans(maria([first, other]), maria([other, second])).rows.find(row => row.changes.length);
  assert.equal(match.alignment, 'candidate-move');
  assert.deepEqual(match.changes, [
    {label:'Index', before:'ix_primary', after:'ix_secondary'},
    {label:'Predicate', before:'people.id <= 10', after:'people.code >= 20'}
  ]);
});

test('ambiguous operators keep their automatic classifications until explicitly paired', () => {
  const branch = (index, predicate) => '    ' + tree('Index range scan on repeated_access using ' + index + ' over ' + predicate, '2');
  const filler = '    ' + tree('Table scan on other', '1') + '    ' + tree('Table scan on dept', '1');
  const before = mysql(tree('Append', '6', branch('ix_first', '(a < 5)') + branch('ix_first', '(a < 7)') + filler));
  const after = mysql(tree('Append', '6', filler + branch('ix_second', '(b > 9)') + branch('ix_second', '(b > 12)')));
  const compare = (decisions) => comparePlans(before, after, decisions);
  const initial = compare();
  assert.equal(initial.candidateMoveCount, 0);
  const [chosen, ignored, taken] = initial.candidateReview.pairs;
  assert.equal(initial.candidateReview.pairs.length, 4);
  assert.ok(initial.candidateReview.pairs.every(pair => pair.status === 'pending' && pair.matching === 'access'));
  assert.deepEqual([chosen.baseline.position, chosen.candidate.position, chosen.baseline.index, chosen.candidate.index],
    ['1.1', '1.3', 'ix_first', 'ix_second']);
  const decisions = new Map([[chosen.id, 'accepted'], [ignored.id, 'ignored']]);
  const reviewed = compare(decisions);
  assert.equal(reviewed.reviewedPairCount, 1);
  assert.equal(reviewed.movedCount, initial.movedCount);
  assert.deepEqual(reviewed.candidateReview.pairs.map(pair => pair.status), ['accepted', 'ignored', 'unavailable', 'pending']);
  const paired = reviewed.rows.find(row => row.alignment === 'reviewed');
  assert.deepEqual([paired.baselinePosition, paired.candidatePosition], ['1.1', '1.3']);
  assert.deepEqual(paired.changes.map(change => change.label), ['Index', 'Predicate']);
  const series = compareSeries(summarizeSeries([before, before]), summarizeSeries([after, after]), decisions);
  assert.equal(series.reviewedPairCount, 1);
  assert.ok(series.metrics.some(metric => metric.alignment === 'reviewed' && metric.baseline && metric.candidate));
  const html = seriesHtml({ ...series, reviewId:'test' }, null, 'test');
  assert.match(html, /Review alternative operator pairs \(4\)/);
  assert.match(html, /Reset review/);
  assert.match(html, /An operator is paired elsewhere/);
  assert.equal(series.candidateReview.pairs[2].id, taken.id);
  assert.deepEqual(compare(), initial);
});

test('ambiguous review limits options and excludes unstable series positions', () => {
  const repeat = Array.from({ length:12 }, () => '    ' + tree('Table scan on p', '1')).join('');
  const fillers = Array.from({ length:12 }, (_, index) => '    ' + tree('Table scan on d' + index, '1')).join('');
  const before = mysql(tree('Append', '24', repeat + fillers));
  const after = mysql(tree('Append', '24', fillers + repeat));
  const { candidateReview } = comparePlans(before, after);
  assert.equal(candidateReview.limited, true);
  assert.equal(candidateReview.pairs.length, 60);
  assert.equal(candidateReview.pairs.filter(pair => pair.baseline.position === '1.1').length, 8);
  assert.ok(candidateReview.pairs.every(pair => pair.matching === 'details'));
  const partial = mysql(tree('Append', '12', fillers));
  const report = compareSeries(summarizeSeries([before, partial]), summarizeSeries([after, after]));
  assert.equal(report.candidateReview.pairs.length, 0);
});

test('reopening v1 plan archives recomputes untrusted summaries without dispatching SQL', () => {
  const first = mysql(tree('Scan <script>', '9007199254740993'));
  const second = mysql(tree('Scan <script>', '9007199254740994'));
  const expected = summarizeSeries([first, second]);
  const capturedAt = '2026-11-25T00:00:00.000Z';
  const archive = JSON.parse(serializeSamples(expected, [first, second], capturedAt));
  archive.summary.metrics = [{ count:99, median:'forged' }];
  archive.summary.shapes = [];
  archive.samples[0].warnings = ['forged'];
  const encode = value => Buffer.from(JSON.stringify(value));
  const opened = deserializeSamples(encode(archive));
  assert.deepEqual(opened, {series:expected, plans:[first, second], capturedAt});
  const html = seriesHtml({ ...opened.series, saved:true }, opened.plans, 'test');
  assert.match(html, /Confirm their origin/);
  assert.match(html, /Scan &lt;script&gt;/);
  assert.doesNotMatch(html, /forged|<script>/);
  assert.throws(() => deserializeSamples(encode({ ...archive, version:2 })), /version 1/);
  assert.throws(() => deserializeSamples(encode({ ...archive, capturedAt:'2026-11-31T00:00:00.000Z' })), /timestamp/);
  assert.throws(() => deserializeSamples(encode({ ...archive, samples:[...archive.samples].reverse() })), /out of order/);
  assert.throws(() => deserializeSamples(encode({ ...archive, summary:{ ...archive.summary, format:'json' } })), /inconsistent/);
  assert.throws(() => deserializeSamples(Buffer.from([0xff, 0xfe])), /UTF-8/);
  assert.throws(() => deserializeSamples(Buffer.alloc(MAX_SAMPLE_FILE_BYTES + 1)), /32 MiB/);
});
