'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { MysqlService } = require('../src/db/mysql');
const { JOURNAL } = require('../src/db/object-editor');

const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const flags = { allowImplicitCommit:true, allowRoutineReplacement:true, allowViewPolicyChange:true };
const quote = name => String.fromCharCode(96) + name + String.fromCharCode(96);
const springState = { people:2, departments:1, rolledBackNames:0 };

async function usingFixture(runtimePath, makeAdapter) {
  const runtime = await read(runtimePath);
  const folder = path.dirname(await fs.realpath(runtime.dbConfigPath));
  const owner = await read(path.join(folder, 'owner.json'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(owner.id, path.basename(folder));
  assert.equal(path.dirname(await fs.realpath(runtime.viewCheckFixturePath)), folder);
  const fixture = await read(runtime.viewCheckFixturePath);
  assert.equal(fixture.fixtureId, owner.id);
  const config = await read(runtime.dbConfigPath);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.database, 'rocketbrain_fixture');
  assert.equal(new URL(runtime.baseUrl).hostname, '127.0.0.1');
  for (const account of [fixture.writer, fixture.reader, fixture.drift]) {
    assert.equal(account.host, config.host);
    assert.equal(account.port, config.port);
    assert.equal(account.database, config.database);
  }
  for (const name of Object.values(fixture.names)) assert.match(name, /^rb_check_[a-z]+_[a-f0-9]{10}$/);
  const author = await mysql.createConnection(config);
  let writer, reader, adapter;
  const operations = [];
  const { base, inner, target, alternate, aggregate } = fixture.names;
  const name = table => quote(config.database) + '.' + quote(table);
  const innerDdl = threshold => 'ALTER ALGORITHM=MERGE SQL SECURITY DEFINER VIEW ' + name(inner) +
    ' AS SELECT id,score FROM ' + name(base) + ' WHERE score>' + threshold;
  const grant = yes => author.query((yes ? 'GRANT SELECT ON ' : 'REVOKE SELECT ON ') + name(target) +
    (yes ? ' TO ?@?' : ' FROM ?@?'), [fixture.drift.user, fixture.drift.host]);
  const policy = async () => (await author.execute('SELECT CHECK_OPTION,SECURITY_TYPE,DEFINER,CHARACTER_SET_CLIENT,COLLATION_CONNECTION ' +
    'FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [target]))[0][0];
  const source = async () => (await author.query('SHOW CREATE VIEW ' + name(target)))[0][0]['Create View'];
  const grants = async connection => (await connection.query('SHOW GRANTS'))[0].map(row => Object.values(row)[0]).sort();
  const changedScore = value => writer.query('UPDATE ' + name(target) + ' SET score=? WHERE id=1', [value]);
  const score = async () => (await author.query('SELECT score FROM ' + name(base) + ' WHERE id=1'))[0][0].score;
  const reset = () => author.query('UPDATE ' + name(base) + ' SET score=10 WHERE id=1');

  try {
    await author.query('SET NAMES utf8mb4 COLLATE utf8mb4_bin');
    writer = await mysql.createConnection(fixture.writer);
    reader = await mysql.createConnection(fixture.reader);
    adapter = await makeAdapter(config);
    const initial = await policy(), initialSql = await source();
    assert.equal(initial.CHECK_OPTION, 'LOCAL');
    assert.equal(initial.SECURITY_TYPE, 'DEFINER');
    assert.equal(initial.DEFINER, config.user + '@' + config.host);
    assert.equal(initial.COLLATION_CONNECTION, 'utf8mb4_bin');
    const grantSnapshot = [await grants(writer), await grants(reader)];
    const assertGrants = async () => {
      assert.deepEqual([await grants(writer), await grants(reader)], grantSnapshot);
      assert.deepEqual((await reader.query('SELECT id FROM ' + name(target)))[0], [{ id:1 }]);
      await assert.rejects(reader.query('SELECT score FROM ' + name(target)), /denied/i);
      await assert.rejects(writer.query('SELECT score FROM ' + name(base)), /denied/i);
      await assert.rejects(writer.query('UPDATE ' + name(target) + ' SET id=3 WHERE id=1'), /denied/i);
    };

    const inspect = relation => adapter.inspect(relation);
    const preview = async (checkOption, relation = target, body) => {
      const model = await inspect(relation);
      const result = await adapter.preview(model, checkOption, body);
      operations.push(result.operationId);
      assert.deepEqual(result.validation, { compiled:true, executed:false, cleaned:true });
      if (relation === target) assert.deepEqual(result.viewPolicy, { from:'LOCAL', to:checkOption, relations:2, tableGrantEntries:3, columnGrantEntries:2 });
      return { model, result };
    };
    await assertGrants();
    await changedScore(-10);
    assert.equal(await score(), -10);
    await reset();
    await assert.rejects(adapter.preview(await inspect(aggregate), 'CASCADED'), /updatable|single-relation/);
    if (adapter.rewriteBody) {
      await assert.rejects(adapter.preview(await inspect(target), 'CASCADED', 'SELECT id,score FROM ' + name(alternate)),
        /preserving its observed input relation/);
    }

    let review = await preview('CASCADED');
    assert.match(review.result.sql, /ALTER ALGORITHM=MERGE/);
    assert.match(review.result.sql, /WITH CASCADED CHECK OPTION;/);
    assert.match(review.result.sql, /LOCAL to CASCADED/);
    assert.equal(review.result.requiresViewPolicyApproval, true);
    assert.equal(await source(), initialSql);
    await assert.rejects(adapter.apply(review, { allowImplicitCommit:true }), /Approve the reviewed change/);
    assert.equal((await policy()).CHECK_OPTION, 'LOCAL');

    review = await preview('CASCADED');
    await grant(true);
    try { await assert.rejects(adapter.apply(review, flags), /grants changed after review/); }
    finally { await grant(false); }
    review = await preview('CASCADED');
    await author.query(innerDdl(1));
    try { await assert.rejects(adapter.apply(review, flags), /dependencies changed/); }
    finally { await author.query(innerDdl(0)); }
    assert.equal(await source(), initialSql);

    review = await preview('CASCADED');
    const published = await adapter.apply(review, flags);
    assert.equal(published.state, 'applied', JSON.stringify(published));
    assert.equal(published.viewPolicyVerified, true);
    assert.equal(published.grantsPreserved, true);
    assert.deepEqual(await policy(), { ...initial, CHECK_OPTION:'CASCADED' });
    await assertGrants();
    await assert.rejects(changedScore(-10), { code:'ER_VIEW_CHECK_FAILED' });
    assert.equal(await score(), 10);
    await changedScore(20);
    await reset();

    await adapter.reconnect();
    await author.query(innerDdl(1));
    try { await assert.rejects(adapter.recover(review.result.operationId, flags), /dependencies changed/); }
    finally { await author.query(innerDdl(0)); }
    await grant(true);
    try { await assert.rejects(adapter.recover(review.result.operationId, flags), /grants changed/); }
    finally { await grant(false); }

    const restored = await adapter.recover(review.result.operationId, flags);
    assert.equal(restored.state, 'recovered');
    assert.equal(restored.originalDefinitionContextGrantsVerified, true);
    assert.equal(await source(), initialSql);
    assert.deepEqual(await policy(), initial);
    await assertGrants();
    await changedScore(-10);
    assert.equal(await score(), -10);
    await reset();
    await assert.rejects(changedScore(110), { code:'ER_VIEW_CHECK_FAILED' });

    const none = await preview('NONE');
    assert.doesNotMatch(none.result.sql.split('\n').at(-1), /WITH .* CHECK OPTION/);
    assert.equal((await adapter.apply(none, flags)).state, 'applied');
    assert.equal((await policy()).CHECK_OPTION, 'NONE');
    await changedScore(110);
    assert.equal(await score(), 110);
    await reset();
    assert.equal((await adapter.recover(none.result.operationId, flags)).state, 'recovered');
    await assertGrants();
    const missingLiveGuard = Boolean(adapter.loseAcknowledgment);
    if(missingLiveGuard){
      const interrupted=await preview('CASCADED');
      const result=await adapter.loseAcknowledgment(interrupted,flags);
      assert.equal(result.state,'needs-inspection');
      assert.equal(result.autoRetried,false);
      assert.equal((await policy()).CHECK_OPTION,'CASCADED');
      await author.query('DROP VIEW '+name(target));
      await adapter.reconnect();
      await assert.rejects(adapter.recover(interrupted.result.operationId,flags),/live object disappeared/);
      assert.equal(await policy(),undefined);
    }
    const [[{ version }]] = await author.query('SELECT VERSION() AS version');
    const response = await fetch(runtime.baseUrl + '/probe/testing-state', { signal:AbortSignal.timeout(9000) });
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), springState);
    return { engine:runtime.dbEngine, version, original:'LOCAL', changed:['CASCADED','NONE'], directGrantRightsPreserved:true,
      nestedWritesObserved:true, definerAndCharacterContextPreserved:true, changedGrantOrDependencyBlocked:true,
      durableRestoration:true, ...(missingLiveGuard&&{missingLiveGuard}), spring:springState };
  } finally {
    try {
      await adapter?.close();
      for (const table of [aggregate,target,inner]) await author.query('DROP VIEW IF EXISTS ' + name(table));
      for (const table of [base,alternate]) await author.query('DROP TABLE IF EXISTS ' + name(table));
      for (const operation of operations) await author.execute('DELETE FROM ' + name(JOURNAL) + ' WHERE operation_id=?', [operation]);
    } finally { await Promise.allSettled([reader?.end(), writer?.end(), author.end()]); }
  }
}

async function verifyViewCheckPolicyBackend(runtimePath = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG) {
  return usingFixture(runtimePath, config => {
    let db = new MysqlService(config);
    return { inspect:name => db.inspectSchemaObject({ kind:'view', name }), rewriteBody:true,
      preview:(model, checkOption, source = model.source) => db.previewSchemaObject({ modelId:model.modelId, source, checkOption }),
      apply:({result}, opts) => db.applySchemaObject({ reviewId:result.reviewId, ...opts }),
      async loseAcknowledgment({result},opts){
        const stream=db._stream;let submitted=0;
        db._stream=async function(session,sql,...rest){
          const response=await stream.call(this,session,sql,...rest);
          if(sql.startsWith('ALTER ALGORITHM=MERGE')){
            submitted++;
            const lost=Object.assign(Error('Lost acknowledgment after owned ALTER VIEW'),{code:'ROCKETBRAIN_TEST_VIEW_ACK_LOSS'});
            db._lose(session,lost,true);
            throw lost;
          }
          return response;
        };
        try{
          const reply=await db.applySchemaObject({reviewId:result.reviewId,...opts});
          assert.equal(submitted,1);
          return reply;
        }finally{db._stream=stream;}
      },
      async reconnect() { await db.dispose(); db = new MysqlService(config); },
      recover:(operationId, opts) => db.recoverSchemaObject({ operationId, ...opts }),
      close:() => db.dispose()
    };
  });
}

async function runViewCheckPolicyChecks(api, vscode, checks) {
  assert.ok((await vscode.commands.getCommands(true)).includes('rocketbrain.schema.reviewViewCheckOption'));
  const result = await usingFixture(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, async config => {
    await api.connectMysql(config);
    const editor = api.dbAuthoring, docs = new Set();
    return { async inspect(name){ const model=await editor.openObject({ kind:'view', name }); docs.add(model.uri); return model; },
      async preview(model, checkOption) {
        const review = await editor.reviewObject(model.modelId, { checkOption });
        const uri = vscode.Uri.parse(review.reviewUri);
        assert.ok(uri.path.endsWith('/' + review.reviewId + '/review.sql'));
        docs.add(uri.toString());
        const document = await vscode.workspace.openTextDocument(uri);
        assert.equal(document.getText(), review.sql);
        assert.equal(document.isDirty, false);
        return review;
      },
      apply:({model}, opts) => editor.deployObject(model.modelId, opts),
      async reconnect(){ await api.disconnectMysql(); await api.connectMysql(config); },
      recover:(operationId, opts) => editor.recoverObject(operationId, opts),
      async close(){
        const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>docs.has(tab.input?.uri?.toString()));
        if(tabs.length)await vscode.window.tabGroups.close(tabs);
        await api.disconnectMysql();
      }
    };
  });
  checks.push('Native view CHECK OPTION policy review preserved direct grants and original definer while actual nested writes followed LOCAL, CASCADED and NONE.');
  return { ...result, nativePolicyReview:true };
}

module.exports = { runViewCheckPolicyChecks, verifyViewCheckPolicyBackend };
if (require.main === module) verifyViewCheckPolicyBackend().then(report => console.log(JSON.stringify(report)))
  .catch(error => { console.error(error.stack); process.exitCode=1; });
