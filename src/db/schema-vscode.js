'use strict';
const crypto=require('node:crypto');

function registerSchemaRename(context,vscode,{database,sqlAnalysis}={}) {
  const plans=new Map(),operations=new Set(),subscriptions=[];let closed=false;
  const trusted=()=>{if(closed)throw new Error('Schema renaming is closed.');if(!vscode.workspace.isTrusted)throw new Error('Trust the workspace before changing a database schema.');};
  async function preview(request,{scope,cancellation,includeEmbeddedJava}={}){
    trusted();const ddl=await database.previewSchemaRename(request);trusted();
    const target={kind:ddl.kind,database:ddl.schema,table:ddl.table,...(ddl.kind==='column'?{column:ddl.column}:{})};
    const sourceOptions={scope,includeEmbeddedJava:includeEmbeddedJava??vscode.workspace.getConfiguration?.('rocketbrain.sql.project')?.get('renameEmbeddedJava',false)};
    let references,sourcePlan,sourceError;
    try{
      references=await sqlAnalysis.findCatalogReferences(target,cancellation,sourceOptions);
      if(references.coverage?.complete)sourcePlan=await sqlAnalysis.planCatalogRename(target,ddl.newName,cancellation,sourceOptions);
    }catch(error){sourceError=error.message;}
    trusted();if(cancellation?.isCancellationRequested)throw new Error('Schema rename preview was cancelled.');
    for(const [id,p]of plans)if(p.expiresAt<Date.now())plans.delete(id);
    while(plans.size>=10)plans.delete(plans.keys().next().value);
    const sourcePreviews=[];
    for(const file of sourcePlan?.documents||[]){
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse(file.uri)),before=document.getText();let after=before;
      for(const edit of [...(file.edits||[])].sort((a,b)=>b.start-a.start))after=after.slice(0,edit.start)+edit.newText+after.slice(edit.end);
      if(before!==after)sourcePreviews.push({uri:file.uri,before,after,language:file.language??'sql'});
    }
    if(sourcePlan)await sqlAnalysis.validateCatalogRename(sourcePlan.id,cancellation);
    trusted();
    const id=crypto.randomUUID(),plan={id,ddl,target,references,sourcePlanId:sourcePlan?.id,sourceDocuments:sourcePlan?.documents||[],sourcePreviews,sourceError,expiresAt:Math.min(ddl.expiresAt||Date.now()+120000,Date.now()+120000)};
    plans.set(id,plan);return structuredClone(plan);
  }
  async function apply(id,{updateSql=false,allowUnverifiedDependencies=false,cancellation}={}){
    trusted();const plan=plans.get(id);
    if(!plan||Date.now()>plan.expiresAt)throw new Error('The schema rename preview expired. Preview again.');
    if(cancellation?.isCancellationRequested)throw new Error('Schema rename was cancelled before applying changes.');
    if(plan.ddl.requiresUnverifiedDependencyApproval&&!allowUnverifiedDependencies)throw new Error('Some stored dependency definitions are not visible. Review and explicitly acknowledge unverified dependencies before applying.');
    if(updateSql&&!plan.sourcePlanId)throw new Error('SQL source references are incomplete. Review the unknown files or use a database-only rename.');
    if(updateSql)await sqlAnalysis.validateCatalogRename(plan.sourcePlanId,cancellation);
    trusted();plans.delete(id);
    let outcome;
    try{outcome=await database.applySchemaRename({reviewId:plan.ddl.reviewId,connectionEpoch:plan.ddl.connectionEpoch,allowUnverifiedDependencies});}
    catch(error){if(!['unknown','rejected'].includes(error.state))throw error;outcome={state:error.state,applied:error.applied,acknowledged:error.acknowledged,outcomeUnknown:error.outcomeUnknown,message:error.message,reviewId:plan.ddl.reviewId};}
    const result={...outcome,sourceState:updateSql?'pending':'not-requested',sqlReferencesComplete:Boolean(plan.references?.coverage?.complete),atomicAcrossDatabaseAndFiles:false};
    if(outcome.state==='applied'&&outcome.verified!==true){result.state='unknown';result.outcomeUnknown=true;result.sourceError='The database change was not verified. SQL files were not changed.';}
    if(outcome.state==='applied'&&outcome.verified===true&&updateSql){
      try{
        trusted();const edit=await sqlAnalysis.catalogRenameEdit(plan.sourcePlanId,cancellation,{reviewed:true});
        // The database DDL and editor changes are separate systems. A changed source
        // after DDL leaves an explicit pending source update, never a claimed rollback.
        const changed=await vscode.workspace.applyEdit(edit);result.sourceState=changed?'applied':'pending';
        if(!changed)result.sourceError='The editor rejected the SQL source edits. The database rename was already applied.';
      }catch(error){result.sourceState='pending';result.sourceError=error.message;}
    }
    try{await database.refreshSchema();}catch(error){result.metadataError=error.message;}
    return result;
  }
  function reviewText(plan){
    const ddl=plan.ddl,files=plan.sourceDocuments.map(file=>file.uri),coverage=plan.references?.coverage;
    return ['-- Rocketbrain schema rename review','-- '+ddl.kind+': '+ddl.table+(ddl.column?'.'+ddl.column:'')+' → '+ddl.newName,
      '-- This DDL commits on the server. It cannot be rolled back with a console transaction.',
      '-- It uses a separate connection; existing console work is never committed automatically.',
      '-- SQL source files and the database cannot be changed atomically.',
      '-- SQL references cover SELECT/WITH statements in the selected local query folders.',
      ...(coverage?.java?.renameEnabled?['-- Selected native Java SQL literals are included when their exact identifier ranges can be verified.']:
        ['-- To include native Java queries, configure Java roots and enable embedded Java rename.']),
      '-- Dynamic queries and external application references require separate review.',
      '-- Source scan complete in its declared scope: '+Boolean(coverage?.complete),
      '-- SQL files inspected: '+files.length,...plan.sourceDocuments.map(file=>'-- '+file.uri+' · '+(file.edits?.length||0)+' reference change(s)'),
      ...((coverage?.unknownFiles||[]).map(file=>'-- Unresolved SQL file: '+(file.uri||file.file||file.reason||String(file)))),
      ...(plan.sourceError?['-- Source planning: '+plan.sourceError]:[]),
      ...(ddl.warnings||[]).map(warning=>'-- '+(typeof warning==='string'?warning:warning.message||JSON.stringify(warning))),
      '',ddl.sql+';','', '-- Reverse DDL is a separate future change requiring a new review.',ddl.reverseSql?'-- '+ddl.reverseSql+';':''].join('\n');
  }
  subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('rocketbrain-schema-review',{provideTextDocumentContent(uri){const parts=uri.path.split('/').filter(Boolean),plan=plans.get(parts[0]);if(!plan)return '-- This schema rename review expired.';if(parts.length===3){const file=plan.sourcePreviews[Number(parts[1])];return file?(/^before\.(?:sql|java)$/.test(parts[2])?file.before:file.after):'-- Source preview unavailable.';}return reviewText(plan);}}));
  async function command(kind,item){
    try{
      trusted();const catalog=database.catalogSnapshot();if(!catalog)throw new Error('Connect to MySQL or MariaDB first.');
      const tables=(catalog.tables||[]).filter(table=>table.kind==='table'||!table.kind);
      const selected=item?.table?.name?tables.find(table=>table.name===item.table.name):await vscode.window.showQuickPick(tables.map(table=>({label:table.name,table})),{title:'Choose a table to rename'}).then(value=>value?.table);
      if(!selected)return;
      let column;if(kind==='column'){column=await vscode.window.showQuickPick(selected.columns.map(c=>c.name),{title:'Choose a column to rename'});if(!column)return;}
      const newName=await vscode.window.showInputBox({title:kind==='table'?'New table name':'New column name',value:column||selected.name,ignoreFocusOut:true});if(!newName||newName===(column||selected.name))return;
      const plan=await api.preview({kind,table:selected.name,column,newName});
      const document=await vscode.workspace.openTextDocument(vscode.Uri.parse('rocketbrain-schema-review:/'+plan.id+'/rename.sql'));await vscode.window.showTextDocument(document,{preview:false});
      const java=plan.sourcePreviews.some(file=>file.language==='java');
      const suffix=plan.ddl.requiresUnverifiedDependencyApproval?' (Unverified Dependencies)':'',databaseOnly='Rename Database Object'+suffix,
        withSources='Rename and Update '+(java?'Source Files':'SQL Files')+suffix,choices=plan.sourcePlanId?[withSources,databaseOnly]:[databaseOnly];
      let choice;
      do{
        choice=await vscode.window.showWarningMessage('Apply the reviewed '+kind+' rename? This commits the schema change on the database server. SQL files are a separate update.',{modal:true},...(plan.sourcePreviews.length?['Review SQL Changes']:[]),...choices);
        if(choice==='Review SQL Changes')for(let index=0;index<plan.sourcePreviews.length;index++){
          const file=plan.sourcePreviews[index],base='rocketbrain-schema-review:/'+plan.id+'/'+index+'/';
          await vscode.commands.executeCommand('vscode.diff',vscode.Uri.parse(base+'before.'+file.language),vscode.Uri.parse(base+'after.'+file.language),'SQL reference rename · '+file.uri);
        }
      }while(choice==='Review SQL Changes');
      if(!choice)return;
      const result=await api.apply(plan.id,{updateSql:choice===withSources,allowUnverifiedDependencies:plan.ddl.requiresUnverifiedDependencyApproval===true});
      if(result.state!=='applied'||result.sourceState==='pending')await vscode.window.showWarningMessage('Database rename: '+result.state+'. SQL file update: '+result.sourceState+'. '+(result.sourceError||result.message||'Inspect the observed result before retrying.'));
      else await vscode.window.showInformationMessage('Database '+kind+' renamed.'+(result.sourceState==='applied'?' SQL editor changes are ready to review and save.':''));
      return result;
    }catch(error){if(!closed)await vscode.window.showErrorMessage('Rocketbrain: '+error.message);}
  }
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.schema.renameTable',item=>command('table',item)),vscode.commands.registerCommand('rocketbrain.schema.renameColumn',item=>command('column',item)));
  const tracked=fn=>(...args)=>{const work=fn(...args);operations.add(work);void work.finally(()=>operations.delete(work)).catch(()=>{});return work;};
  const api={preview:tracked(preview),apply:tracked(apply),async dispose(){closed=true;plans.clear();await Promise.allSettled([...operations]);for(const sub of subscriptions)sub.dispose();}};return api;
}
module.exports={registerSchemaRename};
