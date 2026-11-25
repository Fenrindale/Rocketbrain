'use strict';
const crypto=require('node:crypto');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');

function registerSqlScripts(context,vscode,{database}={}) {
  const descriptions=new Map(),reviews=new Map(),runs=new Map(),priorValues=new Map(),operations=new Set(),controllers=new Set(),subscriptions=[];let closed=false;
  const trusted=()=>{if(closed)throw new Error('SQL scripts are closed.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before preparing or running SQL.');};
  function bounded(map,limit=16){while(map.size>=limit)map.delete(map.keys().next().value);}
  function retainRun(id, capture) {
    if (runs.size >= 8) {
      const expired = [...runs.keys()].find(previous => !database.scriptResultRetained?.(previous));
      runs.delete(expired ?? runs.keys().next().value);
    }
    runs.set(id, capture);
  }
  function frame(document,range){
    trusted();if(!document||document.isClosed||document.languageId!=='sql')throw new Error('Open a SQL document first.');
    const text=document.getText(),start=range?document.offsetAt(range.start):0,end=range?document.offsetAt(range.end):text.length,sql=text.slice(start,end);
    if(Buffer.byteLength(sql)>128*1024||Buffer.byteLength(text)>8*1024*1024)throw new Error('Choose a script or selection no larger than 128 KiB.');
    return {document,uri:document.uri.toString(),version:document.version,hash:digest(text),sql,start,end};
  }
  function assertFrame(saved){trusted();if(saved.document.isClosed||saved.document.version!==saved.version||digest(saved.document.getText())!==saved.hash)throw new Error('The SQL source changed after preparation. Prepare it again.');}
  async function describe(document,{range}={}){
    const saved=frame(document,range),value=await database.describeSqlScript(saved.sql,{document});assertFrame(saved);
    const id=crypto.randomUUID();bounded(descriptions);descriptions.set(id,{...saved,description:structuredClone(value),expiresAt:Date.now()+120000});
    return {id,...structuredClone(value),sourceVersion:saved.version,sourceSqlHash:digest(saved.sql)};
  }
  async function preview(descriptionId,parameters,options={}){
    const saved=descriptions.get(descriptionId);if(!saved||saved.expiresAt<Date.now())throw new Error('The script preparation expired. Prepare it again.');assertFrame(saved);
    const value=await database.previewSqlScript(saved.sql,{document:saved.document,parameters,connectionEpoch:saved.description.connectionEpoch,maxRows:options.maxRows,timeoutMs:options.timeoutMs,totalTimeoutMs:options.totalTimeoutMs});assertFrame(saved);
    if(value.connectionId!==saved.description.connectionId||JSON.stringify(value.sqlMode)!==JSON.stringify(saved.description.sqlMode))throw new Error('The SQL console or SQL mode changed while entering parameters. Prepare again.');
    const id=crypto.randomUUID(),review={id,...saved,backend:structuredClone(value),expiresAt:value.expiresAt||Date.now()+120000};bounded(reviews);reviews.set(id,review);descriptions.delete(descriptionId);
    return {id,...structuredClone(value),sourceVersion:saved.version,parameterValuesIncluded:false};
  }
  async function run(id,{allowImplicitCommit=false,allowUnboundedDml=false,cancellation}={}){
    trusted();const review=reviews.get(id);if(!review||review.expiresAt<Date.now())throw new Error('The script review expired or was already consumed. Preview again.');assertFrame(review);
    if(review.backend.requiresImplicitCommitApproval&&!allowImplicitCommit)throw new Error('Review and explicitly acknowledge schema changes that can commit on the server.');
    if (review.backend.unboundedDml?.length && !allowUnboundedDml) {
      throw Error('Review and explicitly acknowledge the statements without an outer WHERE clause.');
    }
    const b=review.backend,source=database.source(),summaryId=database.scriptResultBegin(review.sql,source+' · script',{readOnly:b.readOnly,sessionId:b.sessionId});
    // Reserve a result tab before execution: a full set of protected tabs must not
    // cause an executed batch to lose its visible outcome.
    reviews.delete(id);const abort=new AbortController();controllers.add(abort);let external;
    if(cancellation?.isCancellationRequested||cancellation?.aborted)abort.abort();
    if(cancellation?.onCancellationRequested)external=cancellation.onCancellationRequested(()=>abort.abort());
    else if(cancellation?.addEventListener){const stop=()=>abort.abort();cancellation.addEventListener('abort',stop,{once:true});external={dispose:()=>cancellation.removeEventListener('abort',stop)};}
    try{
      assertFrame(review);
      const report=await database.runSqlScript({reviewId:b.reviewId,sessionId:b.sessionId,connectionEpoch:b.connectionEpoch,
        documentUri:b.documentUri,allowImplicitCommit,allowUnboundedDml,cancellation:abort.signal});
      retainRun(summaryId,{source,report});
      const rows=report.statements.map(statement=>[statement.index+1,statement.status,statement.result?.rowCount??0,statement.result?.affectedRows??0,statement.durationMs??0,statement.error?.message||(statement.result?.resultOmitted?'Result omitted: script result limit reached.':'')]);
      const scriptStatements = report.statements.flatMap(statement =>
        statement.result && !statement.result.resultOmitted ? [{ index: statement.index,
          label: 'Statement ' + (statement.index + 1) + ' · ' + statement.sql.replace(/\s+/g, ' ').slice(0, 88) }] : []);
      const summary={columns:['Statement','Status','Rows','Affected','Milliseconds','Error'],rows,rowCount:rows.length,affectedRows:report.statements.reduce((sum,s)=>sum+(s.result?.affectedRows||0),0),durationMs:report.durationMs,truncated:false,state:report.stateAfter,scriptStatements};
      database.scriptResultFinish(summaryId,summary,undefined,report.stateAfter);
      return {resultId:summaryId,...structuredClone(report)};
    }catch(error){database.scriptResultFinish(summaryId,undefined,error.message,error.state);throw error;}
    finally{external?.dispose();controllers.delete(abort);}
  }
  async function openStatement(resultId,index){
    if (closed) throw new Error('SQL scripts are closed.');
    if (!Number.isInteger(resultId) || !Number.isInteger(index) || index < 0) throw Error('Choose a retained statement result.');
    const existing = database.scriptStatementResult?.(resultId, index);
    if (existing) {
      await database.showResults();
      await database.activateResult?.(existing);
      return { resultId: existing, executedSql: false, index };
    }
    const cached = runs.get(resultId), statement = cached?.report.statements[index];
    if (!statement?.result || statement.result.resultOmitted) throw Error('This statement has no retained result to display.');
    const id = database.scriptResultBegin(statement.sql, cached.source + ' · cached statement ' + (index + 1), {
      readOnly: true, sessionId: cached.report.sessionId, scriptCapture: { resultId, index }
    });
    database.scriptResultFinish(id, structuredClone(statement.result), undefined, statement.stateAfter);
    await database.showResults();
    await database.activateResult?.(id);
    return { resultId: id, executedSql: false, index };
  }
  function reviewText(review){
    const b=review.backend;
    return ['-- Rocketbrain SQL script review','-- '+b.statementCount+' statement(s) · '+b.parameterDefinitions.length+' parameter(s)',
      '-- Console: '+b.sessionId+' · '+(b.readOnly?'read only':'writes enabled')+' · '+(b.autocommit?'auto commit':'manual commit'),
      '-- Statements run in order. A failure stops later statements; completed work is not retried.',
      '-- This script is not one atomic transaction. Earlier successful changes can remain applied.',
      '-- Boundaries, mode, policy and bindings are checked; the server can still reject syntax, permissions or data.',
      ...(b.requiresImplicitCommitApproval?['-- Schema changes can implicitly commit earlier work and cannot be rolled back as a group.']:[]),
      ...(b.unboundedDml || []).map(({ index, command, hasLimit }) => '-- Statement ' + (index + 1) + ' uses ' +
        command + ' without an outer WHERE clause.' + (hasLimit ? ' A LIMIT is present.' : ' It can affect every target row.')),
      ...b.parameterDefinitions.map(p=>'-- Parameter '+(p.name||p.key)+': '+p.valueKind+' (value kept private)'),'',review.sql].join('\n');
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-script-review',{provideTextDocumentContent(uri){const review=reviews.get(uri.path.split('/').filter(Boolean)[0]);return review?reviewText(review):'-- This script review expired.';}}));
  const valueSignature=(description,document)=>JSON.stringify([description.connectionEpoch,description.connectionId,description.sqlMode,description.parameterStyle,description.parameterDefinitions.map(p=>p.key),description.sourceSqlHash,digest(document.getText())]);
  async function values(description,document){
    const definitions=description.parameterDefinitions;if(!definitions.length)return description.parameterStyle==='named'?{}:[];
    const signature=valueSignature(description,document),previous=priorValues.get(document.uri.toString());
    if(previous?.signature===signature){const choice=await vscode.window.showQuickPick(['Enter values','Reuse previous values'],{title:'SQL parameters'});if(!choice)return null;if(choice==='Reuse previous values')return structuredClone(previous.values);}
    const result=description.parameterStyle==='named'?Object.create(null):[],types=[['Text','text'],['Integer (exact)','integer'],['Decimal (exact)','decimal'],['Number','number'],['Boolean','boolean'],['SQL NULL','null'],['Date / timestamp','date'],['JSON text','json'],['Binary (hex)','binary']];
    for(const parameter of definitions){
      const type=await vscode.window.showQuickPick(types.map(([label,kind])=>({label,kind})),{title:'Parameter '+(parameter.name||parameter.key)});if(!type)return null;
      let value;if(type.kind==='boolean'){const selected=await vscode.window.showQuickPick(['true','false'],{title:'Boolean value'});if(selected===undefined)return null;value=selected==='true';}
      else if(type.kind!=='null'){value=await vscode.window.showInputBox({title:'Value for '+(parameter.name||parameter.key),prompt:type.label,placeHolder:type.kind==='binary'?'0x0123ABCD':type.kind==='date'?'YYYY-MM-DD or YYYY-MM-DD HH:mm:ss':undefined,ignoreFocusOut:true,password:/password|secret|token/i.test(parameter.name||'')});if(value===undefined)return null;}
      if(type.kind==='number'){if(!value.trim()||!Number.isFinite(Number(value)))throw new Error('Enter a finite number. Use exact Integer or Decimal for values that must retain precision.');value=Number(value);}
      const descriptor={kind:type.kind,...(type.kind==='null'?{}:{value})};if(Array.isArray(result))result[parameter.index]=descriptor;else result[parameter.name]=descriptor;
    }
    return result;
  }
  async function command(reviewOnly=false){
    try{
      const editor=vscode.window.activeTextEditor;if(!editor||editor.document.languageId!=='sql')throw new Error('Open SQL to execute a script or selection.');
      const description=await api.describe(editor.document,{range:editor.selection.isEmpty?undefined:editor.selection}),parameters=await values(description,editor.document);if(parameters===null)return;
      const plan=await api.preview(description.id,parameters),review=reviews.get(plan.id);
      if(!editor.document.isClosed&&description.parameterDefinitions.length){bounded(priorValues,20);priorValues.set(editor.document.uri.toString(),{signature:valueSignature(description,editor.document),values:structuredClone(parameters)});}
      const allowUnboundedDml = Boolean(plan.unboundedDml?.length);
      if(reviewOnly||plan.requiresImplicitCommitApproval||allowUnboundedDml){const doc=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-script-review:/'+plan.id+'/script.sql'));await vscode.window.showTextDocument(doc,{preview:false});
        const details = ['Earlier completed statements can remain applied if a later one fails.'];
        if (plan.requiresImplicitCommitApproval) details.push('Schema statements can commit earlier changes on the server.');
        if (allowUnboundedDml) details.push('The review contains UPDATE or DELETE statements without an outer WHERE clause.');
        const accepted=await vscode.window.showWarningMessage('Run the reviewed script in its console?',{modal:true,detail:details.join('\n')},'Run Script');if(accepted!=='Run Script')return;
      }
      const report=await api.run(plan.id,{allowImplicitCommit:plan.requiresImplicitCommitApproval===true,allowUnboundedDml});await database.showResults();
      if(report.state!=='completed')await vscode.window.showWarningMessage('Script '+report.state+': '+report.completed+' completed, '+report.failed+' failed, '+report.notRun+' not run. Inspect the summary before retrying.');
      return {resultId:report.resultId,state:report.state,completed:report.completed,failed:report.failed,notRun:report.notRun};
    }catch(error){if(!closed)await vscode.window.showErrorMessage('Rocketbrain SQL: '+error.message);}
  }
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.sql.runScript',()=>command(false)),vscode.commands.registerCommand('rocketbrain.sql.reviewScript',()=>command(true)),vscode.commands.registerCommand('rocketbrain.sql.runWithParameters',()=>command(false)),vscode.commands.registerCommand('rocketbrain.sql.openScriptResult',async selection=>{
    if (selection !== undefined) return api.openStatement(selection?.resultId, selection?.index);
    const choices=[];for(const [id,cached]of runs)for(const statement of cached.report.statements)if(statement.result&&!statement.result.resultOmitted)choices.push({label:'Run '+id+' · statement '+(statement.index+1),description:statement.sql.slice(0,90),id,index:statement.index});
    const selected=await vscode.window.showQuickPick(choices,{title:'Open retained statement result · no SQL rerun'});if(selected)return api.openStatement(selected.id,selected.index);
  }));
  const tracked=fn=>(...args)=>{const work=fn(...args);operations.add(work);void work.finally(()=>operations.delete(work)).catch(()=>{});return work;};
  subscriptions.push(vscode.workspace.onDidCloseTextDocument(document=>{const uri=document.uri.toString();priorValues.delete(uri);for(const [id,value]of descriptions)if(value.uri===uri)descriptions.delete(id);for(const [id,value]of reviews)if(value.uri===uri)reviews.delete(id);}));
  const api={describe:tracked(describe),preview:tracked(preview),run:tracked(run),openStatement:tracked(openStatement),async dispose(){closed=true;for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);descriptions.clear();reviews.clear();runs.clear();priorValues.clear();for(const item of subscriptions)item.dispose();}};return api;
}
module.exports={registerSqlScripts};
