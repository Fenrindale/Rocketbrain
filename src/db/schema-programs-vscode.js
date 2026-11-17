'use strict';
const crypto=require('node:crypto');
function registerSchemaPrograms(context,vscode,{list,analyze,onDidChangeDatabase}={}){
 const reports=new Map(),scheme='rocketbrain-schema-programs';let generation=0,disposed=false;
 const changes=new vscode.EventEmitter();
 const provider=vscode.workspace.registerTextDocumentContentProvider(scheme,{onDidChange:changes.event,provideTextDocumentContent(uri){return reports.get(uri.path.split('/')[1])?.text||JSON.stringify({message:'This observed program report has expired.'},null,2);}});
 const connection=onDidChangeDatabase?.(()=>{generation++;});
 function trusted(){if(disposed||!vscode.workspace.isTrusted)throw Error('Trust the workspace and connect to MySQL or MariaDB before inspecting stored programs.');}
 function parseContext(text){if(Buffer.byteLength(text)>1024*1024)throw Error('Invocation inputs exceed 1 MiB.');let value;try{value=JSON.parse(text);}catch{throw Error('Enter a JSON object with inputs and/or sessionVariables.');}if(!value||Array.isArray(value)||typeof value!=='object'||!Object.keys(value).length||Object.keys(value).some(key=>!['inputs','sessionVariables'].includes(key)))throw Error('Only inputs and sessionVariables are allowed in this invocation context.');return value;}
 async function inspect(request={}){
  trusted();const snapshotRequest=structuredClone({routines:request.routines,connectionEpoch:request.connectionEpoch,...(request.inputs!==undefined?{inputs:request.inputs}:{}),...(request.sessionVariables!==undefined?{sessionVariables:request.sessionVariables}:{})}),promptContext=request.promptContext===true,ticket=generation,available=await list();trusted();if(ticket!==generation)throw Error('The database changed while listing stored programs. Inspect again.');
  let routines=snapshotRequest.routines,context={...(snapshotRequest.inputs!==undefined?{inputs:snapshotRequest.inputs}:{}),...(snapshotRequest.sessionVariables!==undefined?{sessionVariables:snapshotRequest.sessionVariables}:{})};
  if(!routines){const eligible=available.programs.filter(item=>item.definitionVisible&&item.ownedByCurrentUser);if(!eligible.length)throw Error('No supported current-account procedure definitions are visible in the active schema.');
   const selected=await vscode.window.showQuickPick(eligible.map(item=>({label:item.schema+'.'+item.name,description:item.security,program:{schema:item.schema,name:item.name}})),{canPickMany:true,title:'Inspect Stored Program Dependencies',placeHolder:'Select procedures to analyze without executing them'});if(!selected?.length)return null;routines=selected.map(item=>item.program);}
  trusted();if(ticket!==generation)throw Error('The database changed while selecting stored programs. Inspect again.');
  if(promptContext&&!Object.keys(context).length){const text=await vscode.window.showInputBox({title:'Inspect Dynamic SQL with Inputs',prompt:'Enter explicit invocation cases and session values as JSON. Analysis never runs the procedures; the result applies only to these inputs.',placeHolder:'{"inputs":[{"schema":"app","name":"procedure","arguments":[1]}],"sessionVariables":[{"name":"@sql","value":"SELECT id FROM app.people"}]}',ignoreFocusOut:true,validateInput(value){try{parseContext(value);return null;}catch(error){return error.message;}}});if(text===undefined)return null;context=parseContext(text);}
  trusted();if(ticket!==generation)throw Error('The database changed while entering invocation inputs. Inspect again.');
  const report=await analyze({routines,...context,connectionEpoch:snapshotRequest.connectionEpoch??available.connectionEpoch});trusted();if(ticket!==generation)throw Error('The database changed during stored-program analysis. Inspect again.');
  const snapshot=structuredClone(report),text=JSON.stringify(snapshot,null,2);if(Buffer.byteLength(text)>8*1024*1024)throw Error('The observed program report exceeds the display limit. Select fewer procedures.');
  while(reports.size>=10)reports.delete(reports.keys().next().value);const id=crypto.randomUUID(),uri=vscode.Uri.parse(scheme+':/'+id+'/stored-programs.json');reports.set(id,{text,report:snapshot});
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});return{id,uri:uri.toString(),report:structuredClone(snapshot)};
 }
 const command=vscode.commands.registerCommand('rocketbrain.schema.programs',async request=>{try{return await inspect(request);}catch(error){await vscode.window.showErrorMessage('Rocketbrain: '+error.message);return null;}});
 const contextualCommand=vscode.commands.registerCommand('rocketbrain.schema.programsWithInputs',async request=>{try{return await inspect({...request,promptContext:true});}catch(error){await vscode.window.showErrorMessage('Rocketbrain: '+error.message);return null;}});
 return{inspect,inspectWithInputs:request=>inspect({...request,promptContext:true}),list:async()=>{trusted();return list();},getReport:id=>reports.has(id)?structuredClone(reports.get(id).report):null,dispose(){if(disposed)return;disposed=true;generation++;reports.clear();connection?.dispose();command.dispose();contextualCommand.dispose();provider.dispose();changes.dispose();}};
}
module.exports={registerSchemaPrograms};
