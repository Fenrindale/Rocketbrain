'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {normalizeTransactionTrace}=require('../src/jpa/transaction-trace');
const {registerTransactionTrace,renderTransactionTrace}=require('../src/jpa/transaction-trace-vscode');

const sample=()=>({id:1,managerId:'tx-manager-1',managerType:'spring.JpaTransactionManager',startedAt:'2026-11-26T08:34:00Z',
  durationMs:60,owner:{factoryId:'factory-5',contextKey:'context-2',persistenceUnit:'demo-unit'},readOnly:false,
  stages:{begin:{spring:'returned',provider:'returned'},commit:{spring:'threw',provider:'threw'},
    rollback:{spring:'returned',provider:'not-reached'},cleanup:{spring:'returned'}}});
const report=()=>({enabled:true,state:'ready',factoryHook:true,processId:42,dropped:0,transactions:[sample()]});

test('Spring JPA transaction normalization keeps bounded exact outcomes and hides unrelated values',()=>{
  const raw=report(), record=raw.transactions[0];
  record.exception='private-failure';
  record.owner.dataSource='private-url';
  record.stages.commit.sql='private-query';
  assert.deepEqual(normalizeTransactionTrace(raw),report());
  const html=renderTransactionTrace(normalizeTransactionTrace(raw));
  assert.match(html,/demo-unit[\s\S]*context-2 · factory-5[\s\S]*Threw[\s\S]*Call not reached/u);
  assert.doesNotMatch(html,/private-|<script/u);
  for(const corrupt of [
    data=>data.transactions.push(sample()),
    data=>data.transactions[0].stages={begin:{spring:'returned',provider:'returned'}},
    data=>data.transactions[0].stages.cleanup.spring='success',
    data=>data.transactions[0].stages.commit={spring:'returned',provider:'threw'},
    data=>data.transactions[0].owner.factoryId='database-host',
    data=>data.transactions[0].owner.persistenceUnit='<img>',
    data=>data.transactions=Array.from({length:49},(_,id)=>({...sample(),id:id+1})),
    data=>data.state='disabled'
  ]){
    const broken=report();
    corrupt(broken);
    assert.throws(()=>normalizeTransactionTrace(broken),/Unsupported/);
  }
  const unresolved=report();
  unresolved.transactions[0].owner=null;unresolved.transactions[0].readOnly=null;
  assert.match(renderTransactionTrace(normalizeTransactionTrace(unresolved)),/Ownership unavailable/);
  const failed=report();
  failed.transactions[0].stages={begin:{spring:'threw',provider:'not-reached'}};
  assert.equal(normalizeTransactionTrace(failed).transactions[0].stages.begin.spring,'threw');
});

test('Spring JPA transaction view reads the current observer and rejects stale workbench evidence',async()=>{
  let open, stale=false, created=0, disposed=0;
  const id='rocketbrain.jpa.observer.inspectTransactions';
  const view=registerTransactionTrace({ViewColumn:{Beside:2},window:{createWebviewPanel(type,title,column,options){
    created++;
    assert.deepEqual([type,title,column,options],[id,'Spring JPA Transaction Outcomes',2,
      {enableScripts:false,localResourceRoots:[],enableCommandUris:false}]);
    let onClose;
    return {webview:{},reveal(){},onDidDispose(callback){onClose=callback;},dispose(){disposed++;onClose();}};
  }}},{command(type,action){assert.equal(type,id);open=action;},target:()=>({
    client:{transactions:async()=>report()},assertCurrent(){if(stale)throw Error('Observer is stale');}
  })});
  assert.equal((await open()).view,id);
  assert.equal(created,1);
  view.close();
  assert.equal(disposed,1);
  stale=true;
  await assert.rejects(open,/Observer is stale/);
  assert.equal(created,1);
});
