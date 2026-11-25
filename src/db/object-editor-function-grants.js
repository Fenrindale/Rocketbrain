'use strict';

const {principal}=require('./database-principal-create');
const {q}=require('./schema-designer-ddl');
const fail=message=>Object.assign(Error(message),{code:'ROCKETBRAIN_OBJECT_EDITOR'});
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const owner=(row,server)=>row[2]+'@'+row[0]===server.currentUser;
const guestRows=(grants,server)=>(grants?.rows||[]).filter(row=>!owner(row,server));
const locked=()=>fail('Function EXECUTE replay requires direct global or schema EXECUTE with GRANT OPTION.');

async function requireGrantAuthority(read,server) {
  const grants=await read('SHOW GRANTS');
  if(grants.some(([line])=>/^REVOKE /iu.test(String(line))))throw locked();
  if(!grants.some(([line])=>{
    const match=/^GRANT ([^]+?) ON (\*|(?:\x60(?:[^\x60]|\x60\x60)+\x60)|(?:"(?:[^"]|"")+"))\.\* TO [^]+ WITH GRANT OPTION$/iu.exec(String(line).trimEnd());
    if(!match)return false;
    const schema=match[2]==='*'?'*':match[2].slice(1,-1).replaceAll(match[2][0].repeat(2),match[2][0]);
    return (schema==='*'||schema===server.database)&&match[1].split(',').some(part=>['ALL PRIVILEGES','EXECUTE']
      .includes(part.trim().toUpperCase()));
  }))throw locked();
}

function validateFunctionGrants(grants,server,name) {
  if(grants?.kind!=='function'||grants.automatic!==1||!Array.isArray(grants.rows)||grants.rows.length>33) {
    throw fail('Invalid or oversized retained function grant inventory.');
  }
  const identities=new Set();
  for(const row of grants.rows) {
    if(!Array.isArray(row)||row.length!==6||row[1]!==server.database||row[3]!==name||row[4]!=='FUNCTION'||
       [row[0],row[2],row[5]].some(value=>typeof value!=='string'))throw fail('Function grant identity or scope changed.');
    const key=JSON.stringify([row[2],row[0]]);
    if(identities.has(key))throw fail('The function grant inventory contains conflicting duplicate accounts.');
    identities.add(key);
    const privileges=row[5].toLowerCase().split(',');
    if(owner(row,server)) {
      if(privileges.some(item=>!['execute','alter routine'].includes(item)))throw fail('The function owner has unsupported object grants.');
    }else{
      principal({kind:'account',user:row[2],host:row[0]},server.dialect);
      if(privileges.length!==1||privileges[0]!=='execute')throw fail('Only exact ordinary-account function EXECUTE grants can be preserved.');
    }
  }
  return grants;
}

async function verifyGuests(read,grants,server) {
  const rows=guestRows(grants,server);
  if(!rows.length)return;
  await requireGrantAuthority(read,server);
  for(const [host,,user] of rows) {
    const mysql=server.dialect==='mysql';
    const accounts=await read("SELECT User,Host,plugin,"+(mysql?'account_locked':'is_role')+
      ' FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2',[user,host]);
    if(accounts.length!==1||accounts[0][0]!==user||accounts[0][1]!==host||
       !['caching_sha2_password','mysql_native_password'].includes(accounts[0][2])||accounts[0][3]!=='N') {
      throw fail('A retained EXECUTE grantee does not have a supported exact login identity.');
    }
  }
}

async function observeFunctionGrants(read,name,server) {
  const rows=await read('SELECT Host,Db,User,Routine_name,Routine_type,Proc_priv,Grantor FROM mysql.procs_priv '+
    "WHERE Db=? AND Routine_name=? AND Routine_type='FUNCTION' ORDER BY BINARY Host,BINARY User LIMIT 34",[server.database,name]);
  const automatic=Number((await read('SELECT @@automatic_sp_privileges'))[0]?.[0]);
  if(automatic!==1)throw fail('Routine replacement requires automatic_sp_privileges enabled to recreate the verified own automatic grants.');
  const grants=validateFunctionGrants({kind:'function',automatic,rows:rows.map(row=>row.slice(0,6))},server,name);
  if(rows.some(row=>!owner(row,server)&&row[6]!==server.currentUser)) {
    throw fail('Only function EXECUTE grants issued by the executing owner can be preserved.');
  }
  await verifyGuests(read,grants,server);
  return grants;
}

function grantSql(row,server) {
  return 'GRANT EXECUTE ON FUNCTION '+q(server.database)+'.'+q(row[3])+" TO '"+row[2]+"'@'"+row[0]+"'";
}

function exactSubset(current,expected,server) {
  if(!current||!expected||!same(current.definition,expected.definition)||
     current.grants.automatic!==expected.grants.automatic)return false;
  const actual=current.grants.rows,wanted=expected.grants.rows;
  return same(actual.filter(row=>owner(row,server)),wanted.filter(row=>owner(row,server)))&&
    actual.every(row=>wanted.some(item=>same(row,item)));
}

async function replayExecuteGrants(read,execute,inspect,expected,server) {
  const before=await inspect();
  if(!exactSubset(before,expected,server))throw fail('The function definition or surviving grants changed before EXECUTE replay.');
  await verifyGuests(read,expected.grants,server);
  for(const item of guestRows(expected.grants,server)) {
    if(!before.grants.rows.some(row=>same(row,item)))await execute(grantSql(item,server));
  }
}

module.exports={validateFunctionGrants,observeFunctionGrants,verifyGuests,guestRows,grantSql,exactSubset,replayExecuteGrants};
