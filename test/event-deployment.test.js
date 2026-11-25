'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {parseEventBody,extractEventBody,alterEvent}=require('../src/db/object-editor-event');

const model={schema:'fixture',name:'night_cleanup',sqlMode:'NO_BACKSLASH_ESCAPES',charset:'utf8mb4'};

test('event body review uses the shared bounded statement model and same-schema target names',()=>{
  const ast=parseEventBody("BEGIN INSERT INTO log(id,label) VALUES(1,'checked'); UPDATE log SET label='updated' WHERE id=1; DELETE FROM pending WHERE id=2; END",model);
  assert.deepEqual(ast.targets,[{schema:'fixture',table:'log'},{schema:'fixture',table:'pending'}]);
  for(const body of ['DELETE FROM log','UPDATE log SET id=1','CALL utility()','PREPARE stmt FROM @sql','SET @x=1',
    'SELECT id FROM log','DROP TABLE log','INSERT INTO foreign_db.log(id) VALUES(1)','DELETE FROM __rb_private WHERE id=1',
    "INSERT INTO log(id) VALUES(1) /* comment */",'BEGIN WHILE 1 DO DELETE FROM log WHERE id=1; END WHILE; END']) {
    assert.throws(()=>parseEventBody(body,model),undefined,body);
  }
  assert.throws(()=>parseEventBody('INSERT INTO log(id) VALUES(1)',{...model,sqlMode:'ORACLE'}),/SQL mode/);
  assert.throws(()=>parseEventBody("INSERT INTO log(label) VALUES('한글')",{...model,charset:'latin1'}),/UTF-8/);
});

test('stored source boundaries ignore DO inside schedule comments and demand equal observed body',()=>{
  const body="INSERT INTO log(id,label) VALUES(1,'DO')";
  const metadata={...model,body};
  const shown="CREATE EVENT night_cleanup ON SCHEDULE EVERY 1 DAY DISABLE COMMENT 'planned DO' DO "+body;
  assert.equal(shown.slice(extractEventBody(shown,metadata)).trim(),body);
  assert.throws(()=>extractEventBody(shown,{...metadata,body:'DELETE FROM log WHERE id=1'}),/do not agree/);
  assert.match(alterEvent(model,body),/^ALTER DEFINER = CURRENT_USER EVENT .fixture.\..night_cleanup. DISABLE DO INSERT INTO log/);
  assert.throws(()=>alterEvent(model,'DROP EVENT night_cleanup'),/INSERT, UPDATE/);
});
