'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const D=require('../src/db/schema-dependencies');
test('dependency renderers preserve local FK rules and reject unsafe identifiers or cross-schema edges',()=>{const fk=D.normalizeFK({table:'child',name:'child_parent',referencedSchema:'db',referencedTable:'parent',onDelete:'CASCADE',onUpdate:'RESTRICT',columns:[{name:'parent_id',referencedColumn:'id'}]},'db');assert.equal(fk.table,'child');assert.throws(()=>D.normalizeFK({...fk,referencedSchema:'other'},'db'),/Cross-schema/);assert.throws(()=>D.normalizeFK({...fk,onDelete:'CASCADE; DROP TABLE x'},'db'),/action/);});
test('trigger AST accepts local audit and normalization bodies without permitting routine or DDL injection',()=>{const parsed=D.parseTrigger('BEGIN SET NEW.note=UPPER(NEW.note); INSERT INTO audit_rows (person_id,note) VALUES (NEW.id, NEW.note); END','db','people');assert.equal(parsed.statements.length,2);assert.deepEqual(parsed.tables,['audit_rows']);const sql=D.renderTrigger({name:'audit_people',table:'people',timing:'BEFORE',event:'INSERT',...parsed},'db');assert.match(sql,/DEFINER=CURRENT_USER/);assert.match(sql,/INSERT INTO `db`.`audit_rows`/);assert.throws(()=>D.parseTrigger('CALL evil()','db','people'),/supported/i);assert.throws(()=>D.parseTrigger('SET NEW.note=LOAD_FILE(\'/etc/passwd\')','db','people'),/functions/i);});
test('view graph parser rewrites only relation references and preserves literals/explicit aliases',()=>{const view={name:'people_view',definition:"select p.id AS id, 'people' AS label from `db`.`people` p join `db`.`dept` d on p.dept_id=d.id",algorithm:'UNDEFINED',security:'INVOKER',checkOption:'NONE'};const rewritten=D.rewriteView(view,'db',{people:'__rb_shadow_x'});assert.match(rewritten,/from `db`.`__rb_shadow_x` p/);assert.ok(rewritten.includes("'people'"));assert.ok(rewritten.includes('p.id'));assert.throws(()=>D.parseView('SELECT LOAD_FILE(\'x\') FROM people','db'),/functions/);assert.throws(()=>D.parseView('SELECT * FROM other.people','db'),/Cross-schema/);});
test('write fences use a durable operation advisory owner and fail closed after disconnect',()=>{const f=D.fence('people','INSERT','a'.repeat(32),'db');assert.match(f.sql,/IS_USED_LOCK\('rocketbrain\.fence\.a{32}'\)/);assert.match(f.sql,/COALESCE/);assert.match(f.sql,/CONNECTION_ID/);assert.match(f.sql,/SIGNAL SQLSTATE '45000'/);assert.throws(()=>D.fence('people','TRUNCATE','a'.repeat(32),'db'),/event/);});

test('metadata preconditions require existing schema visibility and a global FK dictionary',async()=>{
 await assert.rejects(D.verifyMetadataScope(async()=>[['GRANT SELECT ON `db`.`people` TO `u`@`%`']],'db'),/schema-wide/);
 assert.equal((await D.verifyMetadataScope(async()=>[['GRANT ALL PRIVILEGES ON `db`.* TO `u`@`%`']],'db')).directSchemaMetadataVerified,true);
 const bundle={database:'db',lockTables:['parent'],before:{foreignKeys:[]},after:{foreignKeys:[]}};
 await assert.rejects(D.verifyDictionary(bundle,{read:async()=>{throw Error('access denied');},dialect:'mysql'}),/PROCESS/);
 await assert.rejects(D.verifyDictionary(bundle,{read:async()=>[['other/fk','other/hidden_child','db/parent',1]],dialect:'mysql'}),/schema boundary/);
 await assert.rejects(D.verifyDictionary(bundle,{read:async()=>[['db/fk','db/hidden_child','db/parent',1]],dialect:'mariadb'}),/hidden or unreviewed/);
 assert.equal((await D.verifyDictionary(bundle,{read:async()=>[],dialect:'mysql'})).globalVisibilityVerified,true);
});

test('trigger scalar boundaries reject extra VALUES rows, duplicate-key suffixes and extra assignments',()=>{
 for(const body of ['INSERT INTO audit(id) VALUES(NEW.id),(NEW.id)','INSERT INTO audit(id) VALUES(NEW.id) ON DUPLICATE KEY UPDATE id=VALUES(id)','SET NEW.note=NEW.note, NEW.id=0'])assert.throws(()=>D.parseTrigger(body,'db','people'),/scalar|parentheses|comma/);
 assert.equal(D.parseTrigger("SET NEW.note=CONCAT(UPPER(NEW.note),', literal')",'db','people').statements.length,1);
});
