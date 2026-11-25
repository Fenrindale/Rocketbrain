'use strict';

const crypto = require('node:crypto');
const {ObserverError} = require('./observer-client');

const LANGUAGE = 'rocketbrain-jpql';
const ERROR_NAMES = {
  unsupported_select_shape:'Use one SELECT with scalar columns and supported JPQL expressions. Use parameters for string or date values.',
  provider_validation_failed:'The running Hibernate factory could not validate this JPQL selection.',
  scalar_projection_required:'Select scalar attributes or scalar aggregates explicitly.',
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

function htmlForResult(result,query) {
  const nonce=crypto.randomBytes(18).toString('base64');
  const headings=result.columns.map(({alias,javaType},index)=>'<th scope="col"><span>'+escape(alias||'Column '+(index+1))+'</span><small>'+escape(javaType)+'</small></th>').join('');
  const body=result.rows.map(row=>'<tr>'+row.map(value=>value===null?'<td><em>NULL</em></td>':'<td>'+escape(value)+'</td>').join('')+'</tr>').join('');
  const size=result.rowCount+' row'+(result.rowCount===1?'':'s')+(result.hasMore?' · more rows available':'');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><title>JPQL Results</title>
  <style nonce="${nonce}">
  body{padding:1rem 1.25rem;color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family)}
  header{display:flex;gap:1rem;align-items:baseline;flex-wrap:wrap} h1{font-weight:600;font-size:1.25rem;margin:0}
  header p,small,em{color:var(--vscode-descriptionForeground)} .scroll{overflow:auto}
  details{margin:.75rem 0} pre,td{white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--vscode-editor-font-family)}
  table{border-collapse:collapse;min-width:100%} th{text-align:left;background:var(--vscode-editorWidget-background)}
  th,td{border:1px solid var(--vscode-panel-border);padding:.5rem .65rem;vertical-align:top} th small{display:block}
  </style></head><body><header><h1>JPQL Results</h1><p>${escape(result.factoryId)} · ${escape(size)} · read-only transaction rolled back</p></header>
  <details><summary>JPQL selection</summary><pre>${escape(query)}</pre></details>
  <div class="scroll"><table aria-label="JPQL selection results"><thead><tr>${headings}</tr></thead><tbody>${body}</tbody></table></div>
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
        /^\s*select\s/i.test(item.text)).slice(0,40).map(item=>({label:item.text.slice(0,120),query:item.text}));
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
    let values=input?.values, limit=input?.limit??100;
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
      const rows=await vscode.window.showQuickPick(['25','50','100'],{title:'Maximum result rows'});
      if (rows===undefined) return;
      limit=Number(rows);
      const accepted=await vscode.window.showWarningMessage('Run this JPQL selection in '+factoryId+'?',{modal:true,
        detail:'Up to '+limit+' rows in a read-only MySQL or MariaDB transaction. The selected application mapping and provider configuration apply.\n\n'+query},'Run SELECT');
      if (accepted!=='Run SELECT') return;
      if (editor.document.version!==version) throw new ObserverError('STALE','The editor query changed during review. Run again.');
    }
    connection.assertCurrent();
    const result=executable(await connection.client.select(query,factoryId,values,limit));
    return show(result,query,connection);
  }
  command('rocketbrain.jpa.console.open',open);
  command('rocketbrain.jpa.console.run',run);
  return {clear};
}

module.exports={registerJpaConsole,htmlForResult};
