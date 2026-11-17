'use strict';
const {createHash}=require('node:crypto');
const LIMITS=Object.freeze({participants:4,reviews:3,reviewMs:120000,operations:100,payloadBytes:256*1024,events:120,operationMs:30*60*1000});
const states=new Set(['reviewed','preparing','prepared','publishing','published','commit-decided','compensate-decided','releasing','applied','recovering','recovered','needs-recovery','needs-decision-reconciliation','not-started']);
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(code,message)=>Object.assign(new Error(message),{code:'ROCKETBRAIN_COORDINATOR_'+code});
const code=error=>/^[A-Z0-9_]{1,80}$/.test(error?.code||'')?error.code:'ROCKETBRAIN_COORDINATOR_PARTICIPANT';
const copy=value=>structuredClone(value);
function keys(value,allowed,label){if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!allowed.includes(k)))throw fail('JOURNAL','Invalid '+label+' fields.');}
function membership(record){return record.participants.map(({key,serverKey,database,engine,operationId,planHash})=>({key,serverKey,database,engine,operationId,planHash}));}
function validateRecord(value,{id,role}={}){
 keys(value,['format','formatVersion','id','role','participantKey','coordinatorKey','planHash','state','decision','createdAt','updatedAt','participants','events','errorCode'],'coordinator record');
 if(value.format!=='RocketbrainSchemaCoordinator'||value.formatVersion!==1||!/^[a-f0-9]{32}$/.test(value.id)||id&&value.id!==id||!['coordinator','participant'].includes(value.role)||role&&role!==value.role||!/^[a-f0-9]{64}$/.test(value.coordinatorKey)||!/^[a-f0-9]{64}$/.test(value.planHash)||!states.has(value.state)||![null,'commit','compensate'].includes(value.decision))throw fail('JOURNAL','Invalid typed coordinator journal.');
 if(!Array.isArray(value.participants)||value.participants.length<2||value.participants.length>LIMITS.participants)throw fail('JOURNAL','Invalid coordinator participant count.');
 for(const item of value.participants){keys(item,['key','serverKey','database','engine','operationId','planHash','state'],'participant');if(!/^[a-f0-9]{64}$/.test(item.key)||!/^[a-f0-9]{64}$/.test(item.serverKey)||!/^[a-f0-9]{32}$/.test(item.operationId)||!/^[a-f0-9]{64}$/.test(item.planHash)||!['mysql','mariadb'].includes(item.engine)||typeof item.database!=='string'||!item.database||item.database.length>64||!states.has(item.state))throw fail('JOURNAL','Invalid typed participant identity.');}
 if(new Set(value.participants.map(p=>p.serverKey)).size!==value.participants.length||new Set(value.participants.map(p=>p.key)).size!==value.participants.length||value.participants.some((p,i)=>i&&value.participants[i-1].serverKey.localeCompare(p.serverKey)>=0)||value.coordinatorKey!==value.participants[0].key)throw fail('JOURNAL','Participant server identity order changed.');
 if(value.role==='participant'&&!value.participants.some(p=>p.key===value.participantKey)||value.role==='coordinator'&&value.participantKey!==undefined)throw fail('JOURNAL','Invalid participant journal ownership.');
 for(const key of ['createdAt','updatedAt'])if(typeof value[key]!=='string'||!/^\d{4}-\d\d-\d\dT/.test(value[key])||!Number.isFinite(Date.parse(value[key])))throw fail('JOURNAL','Invalid journal timestamp.');
 if(!Array.isArray(value.events)||value.events.length>LIMITS.events)throw fail('JOURNAL','Coordinator event limit exceeded.');
 for(const event of value.events){keys(event,['phase','participantKey','at'],'event');if(!states.has(event.phase)||event.participantKey!==undefined&&!value.participants.some(p=>p.key===event.participantKey)||typeof event.at!=='string'||!Number.isFinite(Date.parse(event.at)))throw fail('JOURNAL','Invalid coordinator event.');}
 if(value.errorCode!==undefined&&!/^[A-Z0-9_]{1,80}$/.test(value.errorCode))throw fail('JOURNAL','Invalid redacted error code.');
 if(Buffer.byteLength(JSON.stringify(value))>LIMITS.payloadBytes)throw fail('LIMIT','The coordinator journal exceeds its metadata bound.');return value;
}
function immutable(record){return sha({id:record.id,role:record.role,participantKey:record.participantKey,coordinatorKey:record.coordinatorKey,planHash:record.planHash,participants:membership(record)});}
function event(record,phase,participantKey){if(!states.has(phase))throw fail('STATE','Invalid coordinator transition.');record.updatedAt=new Date().toISOString();record.state=phase;record.events.push({phase,...(participantKey?{participantKey}:{}),at:record.updatedAt});validateRecord(record);}
module.exports={LIMITS,sha,fail,code,copy,validateRecord,immutable,membership,event};
