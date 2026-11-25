'use strict';

const test=require('node:test'),assert=require('node:assert/strict');
const {validateFunctionGrants,observeFunctionGrants,exactSubset,replayExecuteGrants}=require('../src/db/object-editor-function-grants');

const server={dialect:'mysql',database:'shop',currentUser:'author@127.0.0.1'};
const own=['127.0.0.1','shop','author','metric','FUNCTION','Execute,Alter Routine'];
const guest=['127.0.0.1','shop','guest','metric','FUNCTION','Execute'];
const grants=rows=>({kind:'function',automatic:1,rows});
const observed=rows=>({definition:{name:'metric',source:'RETURN i + 1'},grants:grants(rows)});

test('function EXECUTE replay requires exact ordinary grantees and owner-origin scope',async()=>{
  const dictionary=async(sql,values)=>{
    if(sql.includes('mysql.procs_priv'))return [[...own,server.currentUser],[...guest,server.currentUser]];
    if(sql.includes('automatic_sp_privileges'))return [[1]];
    if(sql==='SHOW GRANTS')return [['GRANT EXECUTE ON '+String.fromCharCode(96)+'shop'+String.fromCharCode(96)+
      ".* TO 'author'@'127.0.0.1' WITH GRANT OPTION"]];
    assert.deepEqual(values,['guest','127.0.0.1']);
    return [['guest','127.0.0.1','caching_sha2_password','N']];
  };
  assert.deepEqual(await observeFunctionGrants(dictionary,'metric',server),grants([own,guest]));
  await assert.rejects(observeFunctionGrants(async(sql,values)=>{
    if(sql.includes('procs_priv'))return [[...guest,'someone-else@127.0.0.1']];
    return dictionary(sql,values);
  },'metric',server),/issued by the executing owner/);
  await assert.rejects(observeFunctionGrants(async(sql,values)=>{
    if(sql==='SHOW GRANTS')return [['GRANT EXECUTE ON *.* TO owner']];
    return dictionary(sql,values);
  },'metric',server),/direct global or schema EXECUTE with GRANT OPTION/);
  for(const row of [
    ['%','shop','guest','metric','FUNCTION','Execute'],
    ['127.0.0.1','shop','guest','different','FUNCTION','Execute'],
    ['127.0.0.1','shop','guest','metric','FUNCTION','Execute,Grant']
  ])assert.throws(()=>validateFunctionGrants(grants([row]),server,'metric'));
});

test('interrupted grants accept only exact-definition subsets with their automatic owner rows',async()=>{
  const current=observed([own]),expected=observed([own,guest]);
  assert.equal(exactSubset(current,expected,server),true);
  assert.equal(exactSubset(observed([guest]),expected,server),false);
  assert.equal(exactSubset({...current,definition:{...current.definition,source:'RETURN i'}},expected,server),false);
  assert.equal(exactSubset(observed([own,[...guest.slice(0,2),'other',...guest.slice(3)]]),expected,server),false);
  const executed=[];
  await replayExecuteGrants(async sql=>sql==='SHOW GRANTS'?[['GRANT EXECUTE ON *.* TO owner WITH GRANT OPTION']]:
    [['guest','127.0.0.1','caching_sha2_password','N']],sql=>executed.push(sql),async()=>current,expected,server);
  assert.equal(executed.length,1);
  assert.match(executed[0],/GRANT EXECUTE ON FUNCTION .* TO 'guest'@'127.0.0.1'$/);
});
