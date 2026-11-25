'use strict';

const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const mysql=require('mysql2/promise');
const {MysqlService}=require('../src/db/mysql');
const {JOURNAL}=require('../src/db/schema-recovery');
const {jdbcReadback}=require('./java-source-analysis-host');

const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const markers={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};
const q=name=>String.fromCharCode(96)+name+String.fromCharCode(96);
const approvals={allowImplicitCommit:true,allowDestructive:true,allowDependencyChanges:true,allowUnverifiedDependencies:true,autoRecover:true};
const field=(name,options={})=>({name,type:'INT',nullable:true,defaultKind:'none',defaultValue:'',autoIncrement:false,
  comment:'',charset:'',collation:'',srsId:'',generationMode:'none',generationExpression:'',...options});
const index=(name,...columns)=>({name,unique:false,primaryKey:false,type:'BTREE',comment:'',
  columns:columns.map((name,i)=>({name,ordinal:i+1,prefixLength:null,collation:'A'}))});

async function verifyGeneratedCompositeForeignKey(runtime,adapter,readback=jdbcReadback){
  const folder=path.dirname(await fs.realpath(runtime.dbConfigPath)),owner=await read(path.join(folder,'owner.json'));
  assert.equal(owner.kind,markers[runtime.dbEngine]);assert.equal(owner.id,path.basename(folder));
  const config=await read(runtime.dbConfigPath);
  assert.equal(config.host,'127.0.0.1');assert.equal(config.database,'rocketbrain_fixture');
  const c=await mysql.createConnection({...config,supportBigNumbers:true,bigNumberStrings:true});
  const tag=randomBytes(5).toString('hex'),parent='rb_gc_parent_'+tag,direct='rb_gc_direct_'+tag,tail='rb_gc_tail_'+tag,stored='rb_gc_store_'+tag;
  const physical=new Set(),plans=new Set(),maria=runtime.dbEngine==='mariadb';
  const sql=(code,values)=>c.query(code,values);
  const exists=async name=>Number((await sql('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
    [config.database,name]))[0][0].n);
  function setup(model,name,storage,usesGenerated,onDelete,onUpdate){
    const draft=structuredClone(model.draft);
    const fk='fk_'+name;
    draft.name=name;
    draft.columns.push(field('tenant'),field('raw_code'),field('computed',{generationMode:storage,generationExpression:'raw_code * 2'}));
    draft.indexes.push(index('idx_relation','tenant',usesGenerated?'computed':'raw_code',...(!usesGenerated?['computed']:[])));
    draft.foreignKeys.push({name:fk,referencedSchema:config.database,referencedTable:parent,onDelete,onUpdate,
      columns:[{name:'tenant',referencedColumn:'tenant'},{name:usesGenerated?'computed':'raw_code',referencedColumn:'code'}]});
    return {draft};
  }
  async function verifyCatalog(table,columns,deleteRule,updateRule){
    const [indexes]=await sql('SHOW INDEX FROM '+q(table));
    const nonPrimary=indexes.filter(row=>row.Key_name!=='PRIMARY');
    assert.deepEqual(nonPrimary.map(row=>[row.Key_name,Number(row.Seq_in_index),row.Column_name,row.Index_type,row.Collation,row.Sub_part]),
      columns.map((column,i)=>['idx_relation',i+1,column,'BTREE','A',null]));
    const [entries]=await sql('SELECT k.COLUMN_NAME child,k.REFERENCED_COLUMN_NAME parent,r.DELETE_RULE deletion,r.UPDATE_RULE updating '+
      'FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA '+
      'AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA=? AND k.TABLE_NAME=? '+
      'AND k.REFERENCED_TABLE_NAME=? ORDER BY k.ORDINAL_POSITION',[config.database,table,parent]);
    const normalize=value=>value==='NO ACTION'?'RESTRICT':value;
    assert.deepEqual(entries.map(row=>[row.child,row.parent,normalize(row.deletion),normalize(row.updating)]),
      [['tenant','tenant',deleteRule,updateRule],[columns[1],'code',deleteRule,updateRule]]);
  }
  async function review(model,draft,kind){
    const result=await adapter.review(model.modelId,draft);
    assert.equal(result.kind,kind);
    assert.deepEqual(result.validation,{ownedEmptyTableCompiled:true,dataExecuted:false,cleaned:true});
    if(adapter.preview)await adapter.preview(model,result);
    return result;
  }
  async function create(model,draft){
    const reviewed=await review(model,draft,'create');
    assert.equal(await exists(draft.name),0);
    assert.match(reviewed.sql,/FOREIGN KEY \(/u);
    physical.add(draft.name);
    const applied=await adapter.apply(model.modelId,reviewed);
    assert.equal(applied.state,'applied',JSON.stringify(applied.error||applied.originalError||applied));
    return reviewed;
  }
  const directRows=async()=> (await sql('SELECT tenant,raw_code,computed FROM '+q(direct)+' ORDER BY id'))[0]
    .map(row=>[row.tenant,row.raw_code,row.computed]);
  try{
    await sql('CREATE TABLE '+q(parent)+'(tenant INT NOT NULL,code INT NOT NULL,PRIMARY KEY(tenant,code)) ENGINE=InnoDB');
    await sql('INSERT INTO '+q(parent)+' VALUES (1,20),(1,21),(2,20),(4,20),(5,100)');
    await adapter.connect(config);
    const directModel=await adapter.open(),original=setup(directModel,direct,'stored',true,'CASCADE','RESTRICT');
    for(const [change,error] of [
      [draft=>{draft.foreignKeys[0].onUpdate='CASCADE';},/stored generated foreign-key columns require restrictive updates/i],
      [draft=>{draft.foreignKeys[0].onDelete='SET NULL';},/stored generated foreign-key columns require restrictive updates/i],
      [draft=>{draft.columns.at(-1).generationMode='virtual';},/stored generated child columns/i],
      [draft=>{draft.indexes[1].columns.reverse();},/index beginning with the foreign-key columns/i]
    ]){
      const invalid=structuredClone(original.draft);change(invalid);
      await assert.rejects(adapter.review(directModel.modelId,invalid),error);
      assert.equal(await exists(direct),0);
    }
    const directReview=await create(directModel,original.draft);
    assert.match(directReview.sql,maria?/\bPERSISTENT\b/u:/\bSTORED\b/u);
    await verifyCatalog(direct,['tenant','computed'],'CASCADE','RESTRICT');
    await sql('INSERT INTO '+q(direct)+' (tenant,raw_code) VALUES (1,10),(2,10),(1,NULL)');
    await assert.rejects(sql('INSERT INTO '+q(direct)+' (tenant,raw_code) VALUES (1,25)'),{code:'ER_NO_REFERENCED_ROW_2'});
    await sql('DELETE FROM '+q(parent)+' WHERE tenant=2 AND code=20');
    assert.deepEqual(await directRows(),[[1,10,20],[1,null,null]]);

    const alter=await adapter.open(direct),changed=structuredClone(alter.draft);
    assert.equal(changed.columns.find(column=>column.name==='computed').generationMode,'stored');
    changed.columns.find(column=>column.name==='computed').generationExpression='raw_code*2+1';
    changed.foreignKeys[0].onDelete='RESTRICT';
    const reviewed=await review(alter,changed,'rebuild'),step=reviewed.plan.steps[0];
    plans.add(reviewed.plan.id);
    for(const name of [step.shadow,step.backup,step.quarantine])physical.add(name);
    assert.deepEqual(step.common,['id','tenant','raw_code']);
    assert.doesNotMatch(step.copySql,/computed/u);
    const applied=await adapter.apply(alter.modelId,reviewed);
    assert.equal(applied.state,'applied',JSON.stringify(applied.error||applied.originalError||applied));
    assert.deepEqual(await directRows(),[[1,10,21],[1,null,null]]);
    await verifyCatalog(direct,['tenant','computed'],'RESTRICT','RESTRICT');
    await assert.rejects(sql('DELETE FROM '+q(parent)+' WHERE tenant=1 AND code=21'),{code:'ER_ROW_IS_REFERENCED_2'});
    const recovered=await adapter.recover(alter.modelId,reviewed);
    assert.equal(recovered.state,'recovered',JSON.stringify(recovered.error||recovered));
    assert.deepEqual(await directRows(),[[1,10,20],[1,null,null]]);
    await verifyCatalog(direct,['tenant','computed'],'CASCADE','RESTRICT');

    const trailingModel=await adapter.open(),trailing=setup(trailingModel,tail,'virtual',false,'SET NULL','CASCADE');
    await create(trailingModel,trailing.draft);
    await verifyCatalog(tail,['tenant','raw_code','computed'],'SET NULL','CASCADE');
    await sql('INSERT INTO '+q(tail)+' (tenant,raw_code) VALUES (4,20)');
    await sql('UPDATE '+q(parent)+' SET code=40 WHERE tenant=4 AND code=20');
    const [[updated]]=await sql('SELECT tenant,raw_code,computed FROM '+q(tail));
    assert.deepEqual(updated,{tenant:4,raw_code:40,computed:80});
    await sql('DELETE FROM '+q(parent)+' WHERE tenant=4 AND code=40');
    const [[nulls]]=await sql('SELECT tenant,raw_code,computed FROM '+q(tail));
    assert.deepEqual(nulls,{tenant:null,raw_code:null,computed:null});

    const storedModel=await adapter.open(),base=setup(storedModel,stored,'stored',false,'CASCADE','RESTRICT');
    if(maria){
      await create(storedModel,base.draft);
      await verifyCatalog(stored,['tenant','raw_code','computed'],'CASCADE','RESTRICT');
      await sql('INSERT INTO '+q(stored)+' (tenant,raw_code) VALUES (5,100)');
      await sql('DELETE FROM '+q(parent)+' WHERE tenant=5 AND code=100');
      assert.equal(Number((await sql('SELECT COUNT(*) n FROM '+q(stored)))[0][0].n),0);
    }else{
      await assert.rejects(adapter.review(storedModel.modelId,base.draft),/child input used by a stored generated column/);
    }
    base.draft.foreignKeys[0].onDelete='RESTRICT';
    base.draft.foreignKeys[0].onUpdate='CASCADE';
    await assert.rejects(adapter.review(storedModel.modelId,base.draft),/child input used by a stored generated column/);
    const [[{version}]]=await sql('SELECT VERSION() version');
    return {engine:runtime.dbEngine,version,storedCompositeChildVerified:true,trailingGeneratedIndexVerified:true,
      orphanBlocked:true,deleteCascadeVerified:true,updateCascadeAndSetNullRecomputed:true,dialectStoredInputCascade:maria?'verified':'refused',
      unsafeActionsAndOrderRefused:true,inputOnlyCopy:true,generatedValueAndActionRebuilt:true,originalConstraintRestored:true,spring:await readback()};
  }finally{
    try{
      await adapter.disconnect();
      for(const table of physical)if(table){
        assert.match(table,/^rb_gc_[a-z]+_[0-9a-f]{10}$|^__rb_(?:shadow|backup|after)_[0-9a-f]+_0$/u);
        await sql('DROP TABLE IF EXISTS '+q(table));
      }
      await sql('DROP TABLE IF EXISTS '+q(parent));
      if(plans.size&&await exists(JOURNAL))for(const id of plans)await sql('DELETE FROM '+q(JOURNAL)+' WHERE operation_id=?',[id]);
    }finally{await c.end();}
  }
}

async function verifyGeneratedCompositeForeignKeyBackend(readback){
  let db;
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG);
  return verifyGeneratedCompositeForeignKey(runtime,{
    connect:async config=>{db=new MysqlService(config);},
    disconnect:()=>db?.dispose(),
    open:table=>db.openTableDesigner(table?{table}:{}),
    review:(modelId,draft)=>db.previewTableDesign({modelId,draft}),
    apply:(_modelId,review)=>db.applyTableDesign({reviewId:review.reviewId,...approvals}),
    recover:(_modelId,review)=>db.recoverSchemaRebuild({operationId:review.plan.id,...approvals})
  },readback);
}

async function runGeneratedCompositeForeignKeyChecks(api,vscode,checks){
  const runtime=await read(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG),author=api.dbAuthoring;
  const proof=await verifyGeneratedCompositeForeignKey(runtime,{
    connect:api.connectMysql,disconnect:api.disconnectMysql,
    open:table=>table?vscode.commands.executeCommand('rocketbrain.schema.editTable',{table:{name:table}}):
      vscode.commands.executeCommand('rocketbrain.schema.createTable'),
    review:(id,draft)=>author.reviewDesigner(id,draft),
    apply:id=>author.applyDesigner(id,approvals),
    recover:id=>author.recoverDesigner(id,approvals),
    async preview(model,review){
      assert.ok(author.designerViews().some(view=>view.modelId===model.modelId));
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-designer:/'+model.modelId+'/review.sql'));
      assert.equal(document.getText().replaceAll('\r\n','\n'),review.sql.replaceAll('\r\n','\n'));
      assert.equal(document.isDirty,false);
    }
  });
  checks.push('The installed designer reviewed, created and rebuilt compound foreign keys with supported generated columns and restored the original definition.');
  return {...proof,nativeDesignerReview:true};
}

module.exports={verifyGeneratedCompositeForeignKeyBackend,runGeneratedCompositeForeignKeyChecks};
if(require.main===module)verifyGeneratedCompositeForeignKeyBackend().then(value=>console.log(JSON.stringify(value)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
