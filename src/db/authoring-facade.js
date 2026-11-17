'use strict';
// The workbench owns connection epochs. Backend model/review identities stay bound
// to the service that issued them, even if a caller edits the public review DTO.
function authoringFacade({state,assertReady,pendingDraft,sessions,isTrusted,updateStatus,refresh}){
 const models=new Map(),reviews=new Map();
 function guard(){assertReady();if(pendingDraft())throw Error('Apply or discard pending table drafts before reviewing or applying database structure/source changes.');for(const session of sessions()){if(session.inTransaction||session.outcomeUnknown||session.needsReconnect)throw Error('Resolve active or uncertain console transactions before database authoring.');}}
 function live(saved){if(!saved||saved.db!==state.db||saved.epoch!==state.epoch)throw Error('This database authoring model or review belongs to an inactive connection. Open it again.');}
 async function invoke(method,request,{model,review,retainModel=false,retainReview=false,changes=false,wrap}={}){
  guard();const saved=model?models.get(request?.modelId):review?reviews.get(request?.reviewId):null;if(model||review)live(saved);if(request?.connectionEpoch!==undefined&&request.connectionEpoch!==state.epoch)throw Error('The database connection changed. Open the authoring review again.');const db=state.db,epoch=state.epoch,key='schema-migration';state.running.add(key);updateStatus();let result,payload;
  const contextGuard=()=>isTrusted()&&!state.disposed&&!state.switching&&db===state.db&&epoch===state.epoch&&!pendingDraft();
  try{result=await db[method]({...request,guard:contextGuard});if(!contextGuard())throw Error('The workspace trust or database changed while preparing authoring results.');if(retainModel){while(models.size>=64)models.delete(models.keys().next().value);models.set(result.modelId,{db,epoch});}if(retainReview){while(reviews.size>=32){const [id,r]=reviews.entries().next().value;reviews.delete(id);await r.db[r.discard](id);}reviews.set(result.reviewId,{db,epoch,discard:method==='previewTableDesign'?'discardTableDesign':'discardSchemaObject'});}return payload=wrap?{[wrap]:result,connectionEpoch:epoch}:{...result,connectionEpoch:epoch};}
  finally{if(review)reviews.delete(request.reviewId);state.running.delete(key);updateStatus();if(changes)await refresh(db,epoch,payload||result);}
 }
 async function discard(id){const saved=reviews.get(id);reviews.delete(id);if(saved)await saved.db[saved.discard](id);}
 return{
  openTableDesigner:request=>invoke('openTableDesigner',request,{retainModel:true}),
  previewTableDesign:request=>invoke('previewTableDesign',request,{model:true,retainReview:true}),
  applyTableDesign:request=>invoke('applyTableDesign',request,{review:true,changes:true}),
  discardTableDesign:discard,
  listSchemaObjects:()=>invoke('listSchemaObjects',undefined,{wrap:'objects'}),
  inspectSchemaObject:request=>invoke('inspectSchemaObject',request,{retainModel:true}),
  previewSchemaObject:request=>invoke('previewSchemaObject',request,{model:true,retainReview:true}),
  applySchemaObject:request=>invoke('applySchemaObject',request,{review:true,changes:true}),
  discardSchemaObject:discard,
  listSchemaObjectRecoveries:()=>invoke('listSchemaObjectRecoveries',undefined,{wrap:'operations'}),
  recoverSchemaObject:request=>invoke('recoverSchemaObject',request,{changes:true})
 };
}
module.exports={authoringFacade};
