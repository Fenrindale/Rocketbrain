'use strict';

const CODE='ROCKETBRAIN_COORDINATOR_ATOMIC_UNSUPPORTED';
const REFERENCES=Object.freeze([
 {title:'MySQL 8.4 atomic DDL',url:'https://dev.mysql.com/doc/refman/8.4/en/atomic-ddl.html'},
 {title:'MySQL implicit commits and ACTIVE XA restrictions',url:'https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html'},
 {title:'MariaDB atomic and crash-safe DDL',url:'https://mariadb.com/docs/server/reference/sql-statements/data-definition/atomic-ddl'},
 {title:'MariaDB XA restrictions',url:'https://mariadb.com/docs/server/reference/sql-statements/transactions/xa-transactions'},
]);
function assertSupportedMode(input={}){
 if(input?.mode==='atomic'||input?.requireAtomic===true||input?.atomicDistributedDDL===true){
  const error=Error('Atomic cross-server DDL is unavailable for MySQL/MariaDB. No connection, review or DDL was started for this atomic request. Choose the explicitly reviewed sequential saga separately; it cannot provide atomic distributed DDL.');
  error.code=CODE;throw error;
 }
 if(input?.mode!==undefined&&input.mode!=='saga'||input?.requireAtomic!==undefined&&input.requireAtomic!==false||input?.atomicDistributedDDL!==undefined&&input.atomicDistributedDDL!==false){
  const error=Error('Use mode "saga" or omit it. Atomic-mode flags must be explicit booleans; unsupported or ambiguous modes cannot fall back to sequential publication.');error.code='ROCKETBRAIN_COORDINATOR_MODE';throw error;
 }
}
function capabilities(observations=[]){
 return{
  format:'RocketbrainSchemaDdlCapabilities',formatVersion:1,
  supportedModes:['saga'],requestedAtomicMode:'rejected-before-connections-and-review',
  guarantees:{atomicDistributedDDL:false,transactionalDDL:false,xaForDDL:false,sequentialSaga:true,automaticAtomicFallback:false},
  sameServerStatement:{atomicity:'conditional-per-supported-statement',scope:'One supported DDL statement on one server; engine, operation and version restrictions apply.',mysql:'MySQL 8.4 documents supported atomic DDL, including InnoDB table operations. DDL ends an active ordinary transaction implicitly; it is not transactional DDL.',mariadb:'MariaDB documents atomic or crash-safe DDL by operation from 10.6.1. This does not provide a transaction across DDL statements or servers.',rollback:'ROLLBACK cannot undo ordinary implicitly committed CREATE/ALTER/RENAME TABLE operations.',xa:'Implicit-commit DDL cannot execute inside an ACTIVE XA transaction.',crashRecovery:'Vendor-documented conditional behavior; this extension does not infer or experimentally certify crash atomicity.'},
  boundary:{crossServerAtomicity:'Unsupported: inference from documented per-statement atomicity and implicit-commit/XA restrictions; no native MySQL/MariaDB cross-server DDL transaction is exposed.',saga:'Sequential reviewed publication with durable decisions, participant fences and guarded recovery. Intermediate physical states remain possible; this is not an atomic transaction.',allDdlFormsSupported:false,crashAtomicityTested:false,wanPartitionProof:false},
  observation:{performed:observations.length>0,readOnly:true,ddlSubmitted:false,servers:observations.map(value=>({...value}))},
  references:REFERENCES.map(value=>({...value})),
 };
}
function markdown(report){
 return['# Schema DDL capabilities','',
 'Atomic cross-server DDL: **unavailable**. An explicit atomic request is rejected before participant connection, review lookup or DDL. It never falls back to a saga.','',
 '## Available publication','',report.boundary.saga,'',
 '## One server and one statement','',report.sameServerStatement.scope,'',report.sameServerStatement.mysql,'',report.sameServerStatement.mariadb,'',report.sameServerStatement.rollback,'',report.sameServerStatement.xa,'',report.sameServerStatement.crashRecovery,'',
 '## Observed servers','',report.observation.performed?report.observation.servers.map(value=>'- '+value.engine+' '+value.version+' · '+value.database+' · identity '+value.serverIdentityHash).join('\n'):'Offline report. No connection was created and no server was probed.','',
 'Observations only read identity/version metadata. No DDL, XA experiment or crash test runs through this capability command.','',
 '## Primary sources','',...report.references.map(value=>'- ['+value.title+']('+value.url+')'),'','Cross-server limitation: '+report.boundary.crossServerAtomicity,''].join('\n');
}
module.exports={CODE,REFERENCES,assertSupportedMode,capabilities,markdown};
