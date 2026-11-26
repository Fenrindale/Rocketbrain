'use strict';

const crypto = require('node:crypto');
const {ObserverError} = require('./observer-client');

const LANGUAGE = 'rocketbrain-jpql';
const ERROR_NAMES = {
  unsupported_select_shape:'Use one SELECT with scalar columns and supported JPQL expressions. Use parameters for string or date values.',
  provider_validation_failed:'The running Hibernate factory could not validate this JPQL selection.',
  unsupported_provider_query_graph:'The running Hibernate version could not describe every SELECT branch.',
  set_projection_mismatch:'Every set-operation arm must project the same scalar types in the same order.',
  named_projection_required:'Give each result of a CTE or derived relation an explicit, unique alias.',
  fetch_snapshot_disabled:'Enable consoleFetchSnapshots in the observer configuration and reconnect to capture FETCH JOIN results.',
  unsupported_fetch_shape:'Select one entity alias and fetch up to three distinct direct associations with INNER or LEFT JOIN FETCH.',
  unsupported_fetch_provider:'Managed fetch snapshots require the supported Hibernate 7.4 runtime.',
  unsupported_fetch_mapping:'The selected entity or association uses mappings outside the supported field snapshot scope.',
  custom_fetch_lifecycle:'The selected managed types or provider use load callbacks outside the fetch snapshot scope.',
  additional_eager_fetch:'The mapped entity requests another eager association outside the reviewed fetch paths.',
  fetch_parallel_collections:'Fetch one collection, or two associations that Hibernate maps as sets. Fetch bags or lists separately.',
  fetch_set_identity:'The parallel set members do not have distinct supported entity identifiers. Fetch each set separately.',
  fetch_not_initialized:'Hibernate did not return an initialized value for the exact requested field.',
  fetch_root_limit:'Use at most 25 root rows for a fetch snapshot.',
  fetch_joined_row_limit:'The fetch join exceeded the 512 joined-row limit. Narrow its filter.',
  scalar_projection_required:'Select scalar attributes or aggregates, or enable consoleEntityProjections for reviewed Hibernate entity fields.',
  unsupported_entity_projection_provider:'Reviewing entity fields requires the supported Hibernate 7.4 runtime.',
  unsupported_entity_projection_shape:'Select one root or to-one joined entity alias without grouping, collection joins or fetches.',
  unsupported_entity_projection_mapping:'The selected entity needs one basic identifier and supported scalar column mappings.',
  entity_projection_parameter_changed:'The scalar field preview would change the Hibernate parameter types.',
  entity_review_required:'Review the entity fields in the current Hibernate factory before running the selection.',
  entity_projection_changed:'The entity mapping, factory or selection changed after review. Describe it again.',
  unsupported_parameter_type:'Use scalar parameters whose types Hibernate can infer.',
  invalid_parameter_value:'A parameter does not match its Hibernate type.',
  parameter_keys_mismatch:'Provide each typed parameter exactly once.',
  unsupported_factory_scope:'The selected persistence factory requires a context this console cannot reproduce.',
  unsupported_database:'This console execution path supports the bundled MySQL or MariaDB Hibernate dialect.',
  rendered_sql_not_allowed:'The provider rendered SQL outside the supported read-only scope.',
  console_execution_failed:'The read-only execution could not be completed.',
  factory_unavailable:'The persistence factory is no longer available.'
};

const escape = value => String(value).replace(/[&<>"'\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,
  character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[character]||'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));

function fetchScope(report) {
  const value=report.fetchSnapshots||report.fetchSnapshot;
  return value?{...value,associations:value.associations||[value]}:null;
}

function fetchSignature(report) {
  const scope=fetchScope(report);
  return scope?JSON.stringify([scope.rootType,scope.maxRoots,scope.maxChildren,report.columns.map(column=>[column.alias,column.javaType]),scope.associations.map(item=>
    [item.path,item.targetType,item.toMany,item.collection,item.columns.map(column=>[column.alias,column.javaType])])]):null;
}

function entitySignature(report) {
  const entity=report.entityProjection;
  return entity?JSON.stringify([entity,report.columns.map(column=>[column.alias,column.javaType])]):null;
}

function htmlForResult(result,query) {
  const nonce=crypto.randomBytes(18).toString('base64');
  const headings=columns=>columns.map(({alias,javaType},index)=>'<th scope="col"><span>'+escape(alias||'Column '+(index+1))+'</span><small>'+escape(javaType)+'</small></th>').join('');
  const cells=row=>row.map(value=>value===null?'<td><em>NULL</em></td>':'<td>'+escape(value)+'</td>').join('');
  const fetch=fetchScope(result);
  const entity=result.entityProjection;
  function association(path,item){
    if(item.state==='null')return '<td><em>NULL</em></td>';
    if(!item.rows.length)return '<td><em>Empty collection</em></td>';
    const note=path.toMany?item.rows.length+' loaded record'+(item.rows.length===1?'':'s')+(item.hasMore?' · preview limited':''):'Loaded record';
    return '<td><details><summary>'+note+'</summary><table aria-label="'+escape(path.association)+'"><thead><tr>'+headings(path.columns)+
      '</tr></thead><tbody>'+item.rows.map(row=>'<tr>'+cells(row)+'</tr>').join('')+'</tbody></table></details></td>';
  }
  const body=result.rows.map((row,index)=>entity&&row[0]===null
    ?'<tr><td colspan="'+result.columns.length+'"><em>No matching entity</em></td></tr>'
    :'<tr>'+cells(row)+(fetch?fetch.associations.map(path=>association(path,path.linked[index])).join(''):'')+'</tr>').join('');
  const columns=headings(result.columns)+(fetch?fetch.associations.map(path=>'<th scope="col"><span>'+escape(path.association)+'</span><small>'+
    escape(path.targetType+(path.toMany?'[]':''))+'</small></th>').join(''):'');
  const size=result.rowCount+' row'+(result.rowCount===1?'':'s')+(result.hasMore?' · more rows available':'');
  const scope=fetch?' · '+fetch.rootType+' · '+fetch.joinedRows+' joined rows'
    :entity?' · '+entity.javaType+' scalar fields':'';
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>JPQL Results</title>
  <style nonce="${nonce}">
  body{padding:1rem 1.25rem;color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
  header{display:flex;gap:1rem;align-items:baseline;flex-wrap:wrap} h1{font-weight:600;font-size:1.25rem;margin:0}
  header p,small,em{color:var(--vscode-descriptionForeground)} .scroll{overflow:auto}
  details{margin:.75rem 0} pre,td{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family)}
  table{border-collapse:collapse;min-width:100%} th{text-align:left;background:var(--vscode-editorWidget-background)}
  th,td{border:1px solid var(--vscode-panel-border);padding:.5rem .65rem;vertical-align:top} th small{display:block}
  </style></head><body><header><h1>JPQL Results</h1><p>${escape(result.factoryId)} · ${escape(size+scope)} · read-only transaction rolled back</p></header>
  <details><summary>JPQL selection</summary><pre>${escape(query)}</pre></details>
  <div class="scroll"><table aria-label="JPQL selection results"><thead><tr>${columns}</tr></thead><tbody>${body}</tbody></table></div>
  ${result.rows.length?'':'<p>The selection returned no rows.</p>'}</body></html>`;
}

function registerJpaConsole(vscode,{source,target,command}) {
  let panel;
  const clear=()=>{panel?.dispose();panel=undefined;};
  const show=async (result,query,connection)=>{
    connection.assertCurrent();
    if (!panel) {
      const current=vscode.window.createWebviewPanel('rocketbrain.jpql.result','JPQL Results',vscode.ViewColumn.Beside,{
        enableScripts:false,localResourceRoots:[],enableCommandUris:false
      });
      panel=current;
      current.onDidDispose(()=>{if(panel===current)panel=undefined;});
    } else panel.reveal(vscode.ViewColumn.Beside);
    panel.webview.html=htmlForResult(result,query);
    return {...result,view:'rocketbrain.jpql.result'};
  };
  function executable(result) {
    if (result.state==='described' || result.state==='executed') return result;
    throw new ObserverError(result.code,ERROR_NAMES[result.code]||'This query or provider is outside the supported JPQL console scope.');
  }
  async function chooseFactory(connection,input) {
    if (input) {
      if (!connection.factories.some(factory=>factory.id===input))
        throw new ObserverError('INVALID_FACTORY','Choose a currently observed Hibernate factory.');
      return input;
    }
    const selection=await vscode.window.showQuickPick(connection.factories.map(factory=>({label:factory.id,
      description:[factory.provider,factory.version].filter(Boolean).join(' ')})),{title:'Choose the Hibernate factory for this JPQL selection'});
    return selection?.label;
  }
  async function open() {
    const editor=vscode.window.activeTextEditor;
    let query=editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : null;
    if (query===null) {
      const model=await source();
      const extracted=model.queries.filter(item=>item.text && !item.symbolicParameters?.length &&
        /^\s*(?:select\b|with\b|\()/i.test(item.text)).slice(0,40).map(item=>({label:item.text.slice(0,120),query:item.text}));
      const choice=await vscode.window.showQuickPick([{label:'Open a blank JPQL console',query:''},...extracted],{title:'JPQL console · workspace source'});
      if (!choice) return;
      query=choice.query;
    }
    const document=await vscode.workspace.openTextDocument({language:LANGUAGE,content:query});
    await vscode.window.showTextDocument(document,{preview:false});
  }
  async function run(input) {
    if (input && input.approved!==true) throw new ObserverError('REVIEW_REQUIRED','Review the query and authorize its exact execution.');
    const editor=vscode.window.activeTextEditor;
    const query=input?.query ?? (editor && (!editor.selection.isEmpty ? editor.document.getText(editor.selection) :
      editor.document.languageId===LANGUAGE ? editor.document.getText() : undefined));
    if (typeof query!=='string' || !query.trim()) throw new ObserverError('QUERY_REQUIRED','Open a JPQL console or select an exact JPQL SELECT in the editor.');
    const version=editor?.document.version;
    const connection=target(), factoryId=await chooseFactory(connection,input?.factoryId);
    if (!factoryId) return;
    connection.assertCurrent();
    const description=executable(await connection.client.describeSelect(query,factoryId));
    connection.assertCurrent();
    const fetch=fetchScope(description);
    const entity=description.entityProjection;
    let values=input?.values, limit=input?.limit??(fetch?fetch.maxRoots:100);
    if (!input) {
      values=Object.create(null);
      for (const parameter of description.parameters) {
        const choice=await vscode.window.showQuickPick(['Enter value','NULL'],{
          title:parameter.key+' · '+parameter.javaType,placeHolder:'Supply the typed value for this execution'
        });
        if (choice===undefined) return;
        const value=choice==='NULL'?null:await vscode.window.showInputBox({title:parameter.key+' · '+parameter.javaType,
          prompt:'Enter a value for this run. Date and time values use ISO formatting.',ignoreFocusOut:true,password:true,
          validateInput:text=>text.length>1024?'Use at most 1,024 code units.':null});
        if (value===undefined) return;
        values[parameter.key]=value;
      }
      const rows=await vscode.window.showQuickPick(fetch?['5','10','25']:['25','50','100'],{title:fetch?'Maximum root snapshots':'Maximum result rows'});
      if (rows===undefined) return;
      limit=Number(rows);
      const accepted=await vscode.window.showWarningMessage('Run this JPQL selection in '+factoryId+'?',{modal:true,
        detail:'Up to '+limit+' rows in a read-only MySQL or MariaDB transaction. The selected application mapping and provider configuration apply.'+
          (fetch?'\nFetched associations\n'+fetch.associations.map(item=>item.path).join('\n')+'\nOnly initialized managed fields are shown.':'')+
          (entity?'\n'+entity.javaType+' scalar fields\n'+description.columns.map(column=>entity.alias+'.'+column.alias+' · '+column.javaType).join('\n'):'')+
          '\n\n'+query},'Run SELECT');
      if (accepted!=='Run SELECT') return;
      if (editor.document.version!==version) throw new ObserverError('STALE','The editor query changed during review. Run again.');
    }
    connection.assertCurrent();
    const result=executable(await (entity?connection.client.select(query,factoryId,values,limit,entity.review):
      connection.client.select(query,factoryId,values,limit)));
    if(fetchSignature(result)!==fetchSignature(description))throw new ObserverError('STALE','The fetched associations changed after review. Describe the selection again.');
    if(entitySignature(result)!==entitySignature(description))throw new ObserverError('STALE','The selected Hibernate entity mapping changed after review.');
    return show(result,query,connection);
  }
  command('rocketbrain.jpa.console.open',open);
  command('rocketbrain.jpa.console.run',run);
  return {clear};
}

module.exports={registerJpaConsole,htmlForResult};
