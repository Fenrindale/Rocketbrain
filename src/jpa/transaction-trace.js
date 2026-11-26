'use strict';

const SPRING=new Set(['returned','threw']);
const PROVIDER=new Set(['not-reached','returned','threw','unobserved']);
const STAGES=['begin','commit','rollback','cleanup'];
const id=(value,pattern)=>typeof value==='string'&&pattern.test(value);
const number=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const ownerLabel=value=>typeof value==='string'&&/^[A-Za-z0-9_.$:@ -]{1,180}$/.test(value)&&!!value.trim();

function normalizeTransactionTrace(payload){
  const invalid=()=>{throw Error('Unsupported Spring JPA transaction trace.');};
  if(!payload||typeof payload.enabled!=='boolean'||typeof payload.factoryHook!=='boolean'||
    !['ready','waiting','disabled'].includes(payload.state)||(payload.state==='disabled')===payload.enabled||
    !number(payload.processId,1,Number.MAX_SAFE_INTEGER)||!number(payload.dropped,0,Number.MAX_SAFE_INTEGER)||
    !Array.isArray(payload.transactions)||payload.transactions.length>48||
    (payload.state!=='ready'&&payload.transactions.length)||(!payload.enabled&&(payload.factoryHook||payload.dropped)))return invalid();
  const ids=new Set(), managers=new Map();
  const transactions=payload.transactions.map(transaction=>{
    if(!transaction||!number(transaction.id,1,Number.MAX_SAFE_INTEGER)||ids.has(transaction.id)||
      !id(transaction.managerId,/^tx-manager-[1-9][0-9]{0,15}$/u)||
      !id(transaction.managerType,/^[A-Za-z0-9_.$]{1,192}$/u)||
      (managers.has(transaction.managerId)&&managers.get(transaction.managerId)!==transaction.managerType)||
      typeof transaction.startedAt!=='string'||!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/u.test(transaction.startedAt)||
      !Number.isFinite(Date.parse(transaction.startedAt))||!number(transaction.durationMs,0,3600000)||
      (transaction.readOnly!==null&&typeof transaction.readOnly!=='boolean')||!transaction.stages||
      Object.keys(transaction.stages).some(stage=>!STAGES.includes(stage)))return invalid();
    let owner=null;
    if(transaction.owner!==null){
      const value=transaction.owner;
      if(!value||!id(value.factoryId,/^factory-[1-9][0-9]{0,15}$/u)||!id(value.contextKey,/^context-[1-9][0-9]{0,15}$/u)||
        !ownerLabel(value.persistenceUnit))return invalid();
      owner={factoryId:value.factoryId,contextKey:value.contextKey,persistenceUnit:value.persistenceUnit};
    }
    const stages={};
    for(const key of STAGES){
      const stage=transaction.stages[key];
      if(stage===undefined)continue;
      if(!stage||!SPRING.has(stage.spring)||(key!=='cleanup'&&!PROVIDER.has(stage.provider))||
        (stage.provider==='threw'&&stage.spring!=='threw'))return invalid();
      stages[key]=key==='cleanup'?{spring:stage.spring}:{spring:stage.spring,provider:stage.provider};
    }
    if(!stages.begin||(stages.begin.spring==='returned'&&!stages.cleanup)||
      (stages.begin.spring==='threw'&&(stages.cleanup||stages.commit||stages.rollback)))return invalid();
    ids.add(transaction.id);managers.set(transaction.managerId,transaction.managerType);
    return {id:transaction.id,managerId:transaction.managerId,managerType:transaction.managerType,
      startedAt:transaction.startedAt,durationMs:transaction.durationMs,owner,readOnly:transaction.readOnly,stages};
  }).sort((left,right)=>right.id-left.id);
  return {enabled:payload.enabled,state:payload.state,factoryHook:payload.factoryHook,
    processId:payload.processId,dropped:payload.dropped,transactions};
}

module.exports={normalizeTransactionTrace};
