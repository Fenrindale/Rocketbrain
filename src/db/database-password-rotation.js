'use strict';

const {createHash,randomBytes}=require('node:crypto');
const {currentAccount,allowSchema,fail}=require('./database-admin-metadata');
const {principal,passwordLiteral,passwordProblem}=require('./database-principal-create');
const {explicitRoles,loginDefaults}=require('./database-role-membership');

const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const hex=/^[a-f0-9]{64}$/iu;
const systemAccount=/^(?:root|mysql\.(?:session|sys|infoschema)|mariadb\.sys)$/iu;
const authPlugin={mysql:'caching_sha2_password',mariadb:'mysql_native_password'};
const fields='u.ssl_type,HEX(u.ssl_cipher),HEX(u.x509_issuer),HEX(u.x509_subject),'+
  'u.max_questions,u.max_updates,u.max_connections,u.max_user_connections,u.Create_user_priv,u.Grant_priv,u.Super_priv';
const key='BINARY u.User=BINARY ? AND BINARY u.Host=BINARY ?';
const stamp='IF(OCTET_LENGTH(u.authentication_string)>0,SHA2(CONCAT(?,CAST(u.authentication_string AS BINARY)),256),NULL)';
const mysql='SELECT u.User,u.Host,u.plugin,u.account_locked,u.password_expired,'+
  "COALESCE(JSON_CONTAINS_PATH(u.User_attributes,'one','$.additional_password','$.multi_factor_authentication'),0),"+
  stamp+','+fields+',u.password_lifetime,u.Password_reuse_history,u.Password_reuse_time,u.Password_require_current '+
  'FROM mysql.user u WHERE '+key+' LIMIT 2';
const maria='SELECT u.User,u.Host,u.plugin,'+
  "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(g.Priv,'$.account_locked')),'false'),u.password_expired,"+
  "COALESCE(JSON_LENGTH(JSON_EXTRACT(g.Priv,'$.auth_or')),0),"+stamp+','+fields+
  ",JSON_UNQUOTE(JSON_EXTRACT(g.Priv,'$.password_lifetime')) "+
  'FROM mysql.user u JOIN mysql.global_priv g ON BINARY g.User=BINARY u.User AND BINARY g.Host=BINARY u.Host '+
  "WHERE "+key+" AND u.is_role='N' LIMIT 2";

function accountTarget(input,identity) {
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['user','host'].includes(key))) {
    throw fail('Choose one exact observed account to rotate.');
  }
  const {user}=principal({kind:'account',user:input.user,host:input.host},identity.dialect);
  const target={user,host:input.host},actor=currentAccount(identity.currentUser);
  if(systemAccount.test(user)||user===actor.user&&target.host.toLowerCase()===actor.host.toLowerCase()) {
    throw fail('Choose another ordinary login account. The executing and built-in system accounts are protected.');
  }
  return target;
}

function statement(target,dialect,credential='<password supplied on apply>') {
  const account="'"+target.user+"'@'"+target.host+"'";
  return 'ALTER USER '+account+(dialect==='mysql'
    ?' IDENTIFIED WITH caching_sha2_password BY '+credential
    :' IDENTIFIED VIA mysql_native_password USING PASSWORD('+credential+')');
}

async function loadAccount(read,identity,target,nonce) {
  let rows;
  try {rows=await read(identity.dialect==='mysql'?mysql:maria,[nonce,target.user,target.host]);}
  catch {throw fail('The current account cannot observe the required authentication and policy metadata.');}
  if(rows.length!==1) throw fail('The exact login account is unavailable in the authorization dictionary.');
  const [user,host,plugin,locked,expired,alternate,comparisonTag,...policy]=rows[0];
  if(user!==target.user||host!==target.host||plugin!==authPlugin[identity.dialect]||
     locked!==(identity.dialect==='mysql'?'N':'false')||expired!=='N'||Number(alternate)!==0||!hex.test(comparisonTag||'')||
     policy.slice(8,11).some(value=>value!=='N')) {
    throw fail('Rotation requires an unlocked, unexpired account with one supported password method and ordinary direct privileges.');
  }
  return {plugin,comparisonTag,policy};
}

async function requireSecureRoute(db,transport,session,identity) {
  const {endpoint}=identity;
  if(endpoint?.transport==='unix-socket'||endpoint?.transport==='named-pipe')return;
  const options=db._options;
  if(!options?.stream&&['127.0.0.1','::1'].includes(endpoint?.host))return;
  const ssl=options?.ssl;
  if(ssl?.rejectUnauthorized===true&&ssl.verifyIdentity===true) {
    const rows=await transport._read(session,"SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    if(rows.length===1&&rows[0][0]==='Ssl_cipher'&&typeof rows[0][1]==='string'&&rows[0][1])return;
  }
  throw fail('Connect over a local socket, a direct numeric loopback address or verified TLS to rotate a password.');
}

async function inspect(transport,session,identity,target,nonce) {
  const read=(sql,values)=>transport._read(session,sql,values);
  const first=await loadAccount(read,identity,target,nonce);
  const roles=await explicitRoles(read,identity,target),defaults=await loginDefaults(read,identity,target);
  const second=await loadAccount(read,identity,target,nonce);
  if(!same(first,second))throw fail('The account changed during inspection. Prepare a new password rotation review.');
  return {...first,roles,defaults};
}

function plan(lease,input) {
  const transport=lease.db._schemaRenamer;
  return transport._withSession(async session=>{
    const identity=await transport._identity(session);
    if(allowSchema(identity.database.toLowerCase()))throw fail('Open an application schema before reviewing account rotation.');
    await requireSecureRoute(lease.db,transport,session,identity);
    const target=accountTarget(input,identity),nonce=randomBytes(32).toString('hex');
    const before=await inspect(transport,session,identity,target,nonce);
    if(!lease.guard())throw fail('The administrator connection changed. Prepare the review again.');
    return {identity,target,before,nonce,sql:statement(target,identity.dialect)};
  });
}

function outcome(state,acknowledged) {
  return {state,acknowledged,automaticRetry:false,credentialsIncluded:false,
    ...(state==='verified'&&{pluginAndObservedRolePolicyPreserved:true})};
}

function apply(lease,reviewed,password) {
  const problem=passwordProblem(password);
  if(problem)throw fail(problem);
  const transport=lease.db._schemaRenamer;
  return transport._withSession(async session=>{
    const identity=await transport._identity(session),{target,before,nonce}=reviewed;
    if(!same(identity,reviewed.identity)||!lease.guard())throw fail('The administrator identity or SQL context changed after review.');
    const read=(sql,values)=>transport._read(session,sql,values);
    await requireSecureRoute(lease.db,transport,session,identity);
    const lock='rocketbrain.rotate.'+createHash('sha256').update(JSON.stringify([target.user,target.host.toLowerCase()])).digest('hex').slice(0,40);
    if(Number((await read('SELECT GET_LOCK(?,0)',[lock]))[0]?.[0])!==1)throw fail('Another password rotation holds this account review.');
    const fresh=await inspect(transport,session,identity,target,nonce);
    if(!same(fresh,before)||!lease.guard())throw fail('The exact account credential, roles or connection changed after review.');
    let acknowledged=false;
    try {
      const credential=passwordLiteral(password,identity.sqlMode);
      const header=await lease.db._control(session,statement(target,identity.dialect,credential),10000,true);
      acknowledged=true;
      if(header?.warningStatus)return outcome('uncertain',true);
    }catch {
      // Server errors can contain submitted authentication syntax. Return only a verified state.
      if(session.connected&&lease.guard()){
        try {if(same(await inspect(transport,session,identity,target,nonce),before))return outcome('rejected',false);}
        catch { /* Leave an unconfirmed outcome for the operator to inspect. */ }
      }
      return outcome('uncertain',false);
    }
    try {
      const afterIdentity=await transport._identity(session);
      if(!same(identity,afterIdentity)||!lease.guard())return outcome('uncertain',acknowledged);
      const after=await inspect(transport,session,identity,target,nonce);
      const {comparisonTag:oldTag,...oldPolicy}=before,{comparisonTag:newTag,...newPolicy}=after;
      if(!same(oldPolicy,newPolicy)||!lease.guard())return outcome('uncertain',acknowledged);
      return outcome(oldTag===newTag?'unchanged':'verified',acknowledged);
    }catch {
      return outcome('uncertain',acknowledged);
    }
  });
}

module.exports={plan,apply,accountTarget,statement};
