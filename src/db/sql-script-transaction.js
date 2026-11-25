'use strict';

const { tokenize } = require('./sql-policy');

const verbs = new Set(['BEGIN','START','COMMIT','ROLLBACK','SAVEPOINT','RELEASE']);
const points = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const reject = message => Object.assign(Error(message),{code:'ROCKETBRAIN_SCRIPT_TRANSACTION'});

function transactionControl(sql, sqlMode) {
  const tokens=tokenize(sql,false,{sqlMode});
  const first=tokens[0]?.kind==='word'?tokens[0].upper:'';
  if (!verbs.has(first)) return null;
  const keywords=tokens.map(token=>token.kind==='word'?token.upper:'');
  const form=keywords.join(' ');
  const savepoint=(kind,index)=>{
    const token=tokens[index];
    if (tokens.length!==index+1||!['word','identifier'].includes(token?.kind)||!points.test(token.value)) {
      throw reject('Use an explicit savepoint name of at most 64 letters, digits or underscores.');
    }
    return {kind,name:token.value.toLowerCase()};
  };
  let transaction;
  if (['BEGIN','BEGIN WORK','START TRANSACTION','START TRANSACTION READ ONLY','START TRANSACTION READ WRITE'].includes(form)) {
    transaction={kind:'begin',mode:form.endsWith('ONLY')?'read-only':form.endsWith('WRITE')?'read-write':'console'};
  } else if (['COMMIT','COMMIT WORK','ROLLBACK','ROLLBACK WORK'].includes(form)) {
    transaction={kind:first.toLowerCase()};
  } else if (first==='SAVEPOINT') {
    transaction=savepoint('savepoint',1);
  } else if (first==='RELEASE'&&keywords[1]==='SAVEPOINT') {
    transaction=savepoint('release',2);
  } else if (first==='ROLLBACK') {
    const at=keywords[1]==='WORK'?2:1;
    if (keywords[at]==='TO') transaction=savepoint('rollback-to',at+(keywords[at+1]==='SAVEPOINT'?2:1));
  }
  if (!transaction) throw reject('Use a single explicit transaction, a named savepoint, or COMMIT or ROLLBACK without chaining.');
  return {first,mayWrite:false,ddl:false,transaction};
}

function reviewTransactionBlock(statements, readOnly) {
  if (!statements.some(statement=>statement.transaction)) return undefined;
  const begin=statements[0].transaction, end=statements.at(-1).transaction;
  if (statements.length<3||begin?.kind!=='begin'||!['commit','rollback'].includes(end?.kind)) {
    throw reject('Transaction controls require a reviewed script that starts with BEGIN and finishes with COMMIT or ROLLBACK.');
  }
  const mode=begin.mode==='console'?(readOnly?'read-only':'read-write'):begin.mode;
  if (readOnly&&mode!=='read-only') throw reject('Use a read/write console to review a READ WRITE transaction.');
  const contents=statements.slice(1,-1), hasWrites=contents.some(statement=>statement.mayWrite);
  if (contents.some(statement=>statement.ddl||statement.program||statement.call)) {
    throw reject('Run DDL and stored program calls outside this reviewed transaction.');
  }
  if (mode==='read-only'&&hasWrites) throw reject('A READ ONLY transaction cannot contain a write.');
  const savepoints=[];
  for (const {transaction} of contents) {
    if (!transaction) continue;
    const {kind,name}=transaction;
    const at=savepoints.indexOf(name);
    if (kind==='savepoint'&&at<0) savepoints.push(name);
    else if (kind==='release'&&at>=0) savepoints.splice(at,1);
    else if (kind==='rollback-to'&&at>=0) savepoints.splice(at+1);
    else throw reject('Use each savepoint once while active, and reference only a current savepoint without nesting transactions.');
  }
  return {mode,finish:end.kind,requiresCommitApproval:hasWrites&&end.kind==='commit'};
}

function transactionSql(control, block) {
  const name=control.name?'`'+control.name+'`':'';
  switch(control.kind) {
    case 'begin': return 'START TRANSACTION '+(block.mode==='read-only'?'READ ONLY':'READ WRITE');
    case 'commit': return 'COMMIT AND NO CHAIN NO RELEASE';
    case 'rollback': return 'ROLLBACK AND NO CHAIN NO RELEASE';
    case 'savepoint': return 'SAVEPOINT '+name;
    case 'release': return 'RELEASE SAVEPOINT '+name;
    case 'rollback-to': return 'ROLLBACK TO SAVEPOINT '+name;
    default: throw reject('The reviewed transaction control is unavailable.');
  }
}

function assertTransactionStart(session, block) {
  if (!block) return;
  if (!session.connected||!session.autocommit||session.inTransaction||session.transactionState!=='idle'||session.outcomeUnknown||session.needsReconnect) {
    throw reject('Finish existing transactions and use an idle autocommit console before running a reviewed transaction block.');
  }
}

module.exports={transactionControl,reviewTransactionBlock,transactionSql,assertTransactionStart,reject};
