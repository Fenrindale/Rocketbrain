'use strict';
// Process-local handoff only. JSON/API callers cannot serialize these handlers.
const registrations=new WeakMap();
const phases=new Set(['prepared','published','recovery-prepared','recovery-published']);
const failure=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_COORDINATOR_BINDING'});
function validateBinding(value){
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).sort().join(',')!=='operationId,participantKey'||!/^[a-f0-9]{32}$/.test(value.operationId)||!/^[a-f0-9]{64}$/.test(value.participantKey))throw failure('Use the owned distributed coordinator for this participant operation.');
 return Object.freeze({operationId:value.operationId,participantKey:value.participantKey});
}
function register(input,value,handlers={}){
 if(!input||typeof input!=='object'||registrations.has(input))throw failure('A coordinator request must have one private registration.');
 const binding=validateBinding(value);for(const [phase,handler]of Object.entries(handlers))if(!phases.has(phase)||typeof handler!=='function')throw failure('Unsupported coordinator checkpoint handler.');
 registrations.set(input,{binding,handlers:{...handlers}});return input;
}
function binding(input){const value=registrations.get(input)?.binding;return value?{...value}:undefined;}
function assertBinding(input,expected){
 const registered=binding(input);
 if(!expected&&!registered)return;
 const value=validateBinding(expected);if(!registered||registered.operationId!==value.operationId||registered.participantKey!==value.participantKey)throw failure('Reconnect and use the matching distributed coordinator; standalone participant publication or recovery is refused.');
 return value;
}
async function checkpoint(input,phase,record){
 if(!phases.has(phase))throw failure('Unsupported coordinator checkpoint.');
 const expected=record?.plan?.coordinator;
 assertBinding(input,expected);const registered=registrations.get(input);if(!registered)return;
 const handler=registered.handlers[phase];if(typeof handler!=='function')throw failure('The owned distributed coordinator checkpoint is unavailable.');
 if(!/^[a-f0-9]{32}$/.test(record.id))throw failure('Invalid owned participant journal identity.');
 await handler(Object.freeze({phase,operationId:record.id,coordinator:Object.freeze({...registered.binding})}));
}
function unregister(input){registrations.delete(input);}
module.exports={register,binding,validateBinding,assertBinding,checkpoint,unregister};
