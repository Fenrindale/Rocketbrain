'use strict';

const {randomBytes}=require('node:crypto');
const {currentAccount,allowSchema,fail}=require('./database-admin-metadata');
const {accountTarget,inspectAccountPolicy,accountLockName}=require('./database-password-rotation');

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const inventoryLimit=128;
const fingerprint=/^[0-9a-f]{64}$/iu;
const identifier=value=>typeof value==='string'&&value.length>0&&value.length<=64&&!/[\x00-\x1f\x7f]/u.test(value);
const catalog=[
  {object:'VIEWS',schema:'TABLE_SCHEMA',name:'TABLE_NAME',detail:'SECURITY_TYPE',definition:'VIEW_DEFINITION',kind:'view'},
  {object:'ROUTINES',schema:'ROUTINE_SCHEMA',name:'ROUTINE_NAME',detail:'ROUTINE_TYPE,SECURITY_TYPE',definition:'ROUTINE_DEFINITION',kind:'routine'},
  {object:'TRIGGERS',schema:'TRIGGER_SCHEMA',name:'TRIGGER_NAME',detail:'EVENT_OBJECT_SCHEMA,EVENT_OBJECT_TABLE,ACTION_TIMING,EVENT_MANIPULATION',
    definition:'ACTION_STATEMENT',kind:'trigger'},
  {object:'EVENTS',schema:'EVENT_SCHEMA',name:'EVENT_NAME',detail:'STATUS',definition:'EVENT_DEFINITION',kind:'event'}
];
const coverageError=()=>fail('The executing account must demonstrate direct global SELECT, SHOW VIEW, TRIGGER and EVENT visibility and CREATE USER authority before changing account access.');

async function requireInventory(read,identity) {
  const actor=currentAccount(identity.currentUser);
  const mysql=identity.dialect==='mysql';
  const columns='Select_priv,Show_view_priv,Trigger_priv,Event_priv,Create_user_priv';
  let rows;
  try{
    rows=await read('SELECT '+columns+(mysql?",COALESCE(JSON_LENGTH(JSON_EXTRACT(User_attributes,'$.Restrictions')),0)":'')+
      ' FROM mysql.user WHERE BINARY User=BINARY ? AND BINARY Host=BINARY ? LIMIT 2',[actor.user,actor.host]);
  }catch{throw coverageError();}
  if(rows.length!==1||rows[0].length!==(mysql?6:5)||rows[0].slice(0,5).some(value=>value!=='Y')||
      mysql&&Number(rows[0][5])!==0)throw coverageError();
}

function entry(source,row) {
  const [schema,name,revision,...details]=row;
  if(!identifier(schema)||!identifier(name)||!fingerprint.test(revision||''))throw fail('The exact definer inventory is incomplete.');
  const base={kind:source.kind,schema,name,revision};
  if(source.kind==='view'&&details.length===1&&['DEFINER','INVOKER'].includes(details[0]))return {...base,security:details[0]};
  if(source.kind==='routine'&&details.length===2&&['FUNCTION','PROCEDURE'].includes(details[0])&&
      ['DEFINER','INVOKER'].includes(details[1]))return {...base,routine:details[0],security:details[1]};
  if(source.kind==='trigger'&&details.length===4&&details.slice(0,2).every(identifier)&&
      ['BEFORE','AFTER'].includes(details[2])&&['INSERT','UPDATE','DELETE'].includes(details[3])){
    return {...base,security:'DEFINER',table:{schema:details[0],name:details[1]},timing:details[2],operation:details[3]};
  }
  if(source.kind==='event'&&details.length===1&&['ENABLED','DISABLED','SLAVESIDE_DISABLED','REPLICA_SIDE_DISABLED','DISABLED ON SLAVE']
    .includes(details[0]))return {...base,security:'DEFINER',status:details[0]};
  throw fail('One stored object has unsupported or incomplete definer metadata.');
}

async function definerInventory(read,identity,target) {
  await requireInventory(read,identity);
  const entries=[];
  for(const source of catalog) {
    let rows;
    try{
      rows=await read('SELECT '+source.schema+','+source.name+',SHA2(CAST('+source.definition+' AS BINARY),256),'+source.detail+
        ' FROM information_schema.'+source.object+
        " WHERE BINARY LEFT(DEFINER,CHAR_LENGTH(?)+1)=BINARY CONCAT(?,'@')"+
        ' AND BINARY LOWER(SUBSTRING(DEFINER,CHAR_LENGTH(?)+2))=BINARY LOWER(?)'+
        ' ORDER BY BINARY '+source.schema+',BINARY '+source.name+(source.kind==='routine'?',ROUTINE_TYPE':'')+' LIMIT '+(inventoryLimit+1),
      [target.user,target.user,target.user,target.host]);
    }catch{throw fail('The server did not expose the complete '+source.object.toLowerCase()+' definer inventory.');}
    if(entries.length+rows.length>inventoryLimit)throw fail('The exact definer inventory exceeds 128 stored objects.');
    entries.push(...rows.map(row=>entry(source,row)));
  }
  await requireInventory(read,identity);
  return entries;
}

function statement(target,locked) {
  return "ALTER USER '"+target.user+"'@'"+target.host+"' ACCOUNT "+(locked?'LOCK':'UNLOCK');
}

async function snapshot(transport,session,identity,target,nonce) {
  const account=await inspectAccountPolicy(transport,session,identity,target,nonce,{access:true});
  const definers=await definerInventory((sql,values)=>transport._read(session,sql,values),identity,target);
  return {account,definers};
}

function plan(lease,input) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['account','locked'].includes(key))||
      typeof input.locked!=='boolean')throw fail('Choose an exact account and lock or unlock action.');
  const transport=lease.db._schemaRenamer;
  return transport._withSession(async session=>{
    const identity=await transport._identity(session);
    if(allowSchema(identity.database.toLowerCase()))throw fail('Open an application schema before reviewing account access.');
    const target=accountTarget(input.account,identity),nonce=randomBytes(32).toString('hex');
    const before=await snapshot(transport,session,identity,target,nonce);
    if(before.account.locked===input.locked)throw fail('The account already has the requested lock state.');
    if(!lease.guard())throw fail('The administrator connection changed. Prepare a new account review.');
    return {identity,target,before,nonce,locked:input.locked,sql:statement(target,input.locked)};
  });
}

function publicReview(review) {
  const {target,identity,before,locked,sql}=review;
  const [tls,,,,queriesPerHour,updatesPerHour,connectionsPerHour,concurrentConnections]=before.account.policy;
  return {target:{...target},server:{dialect:identity.dialect,version:identity.version,account:identity.currentUser},
    state:{locked:before.account.locked,passwordExpired:before.account.expired,plugin:before.account.plugin,
      hasPassword:before.account.comparisonTag!=='empty',roles:before.account.roles.length,defaultRoles:before.account.defaults.length,
      tls:tls||'none',limits:{queriesPerHour,updatesPerHour,connectionsPerHour,concurrentConnections}},
    desiredLocked:locked,definerCoverage:'server-wide-observed',definers:before.definers.map(({revision,...object})=>object),
    sql,existingSessionsTerminated:false,automaticRetry:false};
}

function result(state,acknowledged) {
  return {state,acknowledged,automaticRetry:false,existingSessionsTerminated:false,
    ...(state==='verified'&&{observedAccountPolicyAndDefinersPreserved:true})};
}

function apply(lease,review) {
  const transport=lease.db._schemaRenamer;
  return transport._withSession(async session=>{
    const identity=await transport._identity(session);
    if(!same(identity,review.identity)||!lease.guard())throw fail('The administrator identity or SQL context changed after review.');
    const lock=accountLockName(review.target);
    if(Number((await transport._read(session,'SELECT GET_LOCK(?,0)',[lock]))[0]?.[0])!==1)throw fail('Another account change holds this account review.');
    const observe=()=>snapshot(transport,session,identity,review.target,review.nonce);
    const fresh=await observe();
    if(!same(fresh,review.before)||!lease.guard())throw fail('The exact account policy or definer inventory changed after review.');
    try{
      const header=await lease.db._control(session,review.sql,10000,true);
      if(header?.warningStatus)return result('uncertain',true);
    }catch{
      if(session.connected&&lease.guard()){
        try{if(same(await observe(),review.before))return result('rejected',false);}
        catch{ /* Require a new readback to establish the outcome. */ }
      }
      return result('uncertain',false);
    }
    try{
      const afterIdentity=await transport._identity(session),after=await observe();
      const expected={...review.before,account:{...review.before.account,locked:review.locked}};
      if(!same(identity,afterIdentity)||!same(after,expected)||!lease.guard())return result('uncertain',true);
      return {...result('verified',true),locked:review.locked};
    }catch{ return result('uncertain',true); }
  });
}

module.exports={plan,apply,publicReview,definerInventory};
