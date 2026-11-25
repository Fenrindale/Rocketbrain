'use strict';

const { formatSql }=require('./sql-format');
const { templates,resolveTemplate }=require('./sql-templates');
const { sqlQuickFixes,missingObjectIntent }=require('./sql-quick-fixes');
const { sqlJoinFixes }=require('./sql-join-fixes');
const { isProfileConsole }=require('./profile-console-files');

function registerSqlEditing(context,vscode,{database,sqlAnalysis,openDesigner}) {
  let disposed=false;
  function open(document) {
    if (disposed||!document||document.languageId!=='sql'||document.isClosed) throw Error('Open a SQL document.');
  }
  function format(document,range,options={}) {
    open(document);
    const catalog=database.catalogSnapshot();
    const indent=options.insertSpaces===false?'\t':' '.repeat(Math.min(8,Math.max(1,Number(options.tabSize)||2)));
    const settings=vscode.workspace.getConfiguration('rocketbrain.sql',document.uri);
    const style=settings.get('formatting.style','expanded');
    const keywordCase=settings.get('formatting.keywordCase','preserve');
    const text=range?document.getText(range):document.getText();
    return formatSql(text,{dialect:catalog?.dialect||'mysql',sqlMode:catalog?.sqlMode,indent,style,keywordCase});
  }
  const whole=document=>new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length));
  function values(document) {
    return templates(vscode.workspace.getConfiguration('rocketbrain.sql',document.uri).get('templates',[]));
  }
  function edits(document,range,options) {
    const text=format(document,range,options);
    return text===document.getText(range)?[]:[vscode.TextEdit.replace(range,text)];
  }
  async function formatEditor() {
    const editor=vscode.window.activeTextEditor;
    open(editor?.document);
    const range=editor.selection.isEmpty?whole(editor.document):editor.selection;
    const changes=edits(editor.document,range,editor.options);
    if (!changes.length)return false;
    return editor.edit(edit=>edit.replace(range,changes[0].newText));
  }
  async function insert(editor,{prefix,table}={}) {
    const document=editor?.document;
    open(document);
    const template=values(document).find(item=>item.prefix===prefix);
    if (!template) throw Error('Choose a known SQL template.');
    const catalog=database.catalogSnapshot();
    const snippet=resolveTemplate(template,catalog,table);
    return editor.insertSnippet(new vscode.SnippetString(snippet),editor.selection);
  }
  async function chooseTemplate() {
    const editor=vscode.window.activeTextEditor,document=editor?.document;
    open(document);
    const version=document.version,selection=editor.selection;
    const choice=await vscode.window.showQuickPick(values(document).map(template=>({
      label:template.prefix,description:template.description,template
    })),{title:'Insert SQL Template'});
    if(!choice)return;
    let table;
    if(choice.template.requiresTable) {
      const catalog=database.catalogSnapshot();
      const candidates=[...(catalog?.tables||[]),...(catalog?.views||[])].filter(item=>
        !choice.template.requiresKey||item.columns?.filter(column=>column.primaryKey).length===1);
      if(!candidates.length)throw Error('Refresh the active schema or choose a template without a table.');
      table=(await vscode.window.showQuickPick(candidates.map(item=>({label:item.name,description:item.kind})),
        {title:'Template Table'}))?.label;
      if(!table)return;
      if(database.catalogSnapshot()?.revision!==catalog.revision)throw Error('Refresh the template after the active metadata changes.');
    }
    if(document.isClosed||document.version!==version||!editor.selection.isEqual(selection)) {
      throw Error('The editor changed. Choose the SQL template again.');
    }
    return insert(editor,{prefix:choice.template.prefix,table});
  }
  const command=(id,operation)=>vscode.commands.registerCommand(id,async()=>{
    try{return await operation();}
    catch(error){if(!disposed)await vscode.window.showErrorMessage('Rocketbrain SQL: '+error.message);}
  });
  const fixCommand='rocketbrain.sql.applyReviewedQuickFix';
  const joinFixCommand='rocketbrain.sql.applyJoinQuickFix';
  const missingCommand='rocketbrain.sql.designMissingObject';
  const joinIdentity=()=>JSON.stringify(database.liveCatalogIdentity());
  function objectAction(document,offset) {
    const catalog=database.liveCatalogSnapshot();
    if (!openDesigner||disposed||!vscode.workspace.isTrusted||!catalog||document.isClosed||
        isProfileConsole(document)||sqlAnalysis?.virtualActive(document)) return null;
    return missingObjectIntent(document.getText(),offset,catalog);
  }
  async function joinActions(document,offset,cancellation) {
    const catalog=database.liveCatalogSnapshot(),identity=joinIdentity(),version=document.version;
    if(!catalog||!identity||identity==='null'||isProfileConsole(document))return [];
    const current=()=>!disposed&&!cancellation?.isCancellationRequested&&vscode.workspace.isTrusted&&
      !document.isClosed&&document.version===version&&joinIdentity()===identity&&!sqlAnalysis?.virtualActive(document);
    if(!current())return [];
    const fixes=await sqlJoinFixes(document.getText(),offset,catalog,database.joinCompletionCatalog);
    return current()?fixes.map(fix=>({...fix,identity,version})):[];
  }
  const subscriptions=[
    command('rocketbrain.sql.format',formatEditor),
    command('rocketbrain.sql.insertTemplate',chooseTemplate),
    vscode.commands.registerCommand(fixCommand,async frame=>{
      if(disposed||!vscode.workspace.isTrusted)return;
      const document=vscode.workspace.textDocuments.find(item=>item.uri.toString()===frame?.uri);
      const catalog=database.catalogSnapshot();
      if(!document||document.isClosed||sqlAnalysis?.virtualActive(document)||document.version!==frame.version||catalog?.revision!==frame.revision)return;
      const fix=sqlQuickFixes(document.getText(),frame.offset,catalog).find(item=>item.replacement===frame.replacement);
      if(!fix)return;
      const change=new vscode.WorkspaceEdit();
      change.replace(document.uri,new vscode.Range(document.positionAt(fix.start),document.positionAt(fix.end)),fix.replacement);
      return vscode.workspace.applyEdit(change);
    }),
    vscode.commands.registerCommand(joinFixCommand,async frame=>{
      const document=vscode.workspace.textDocuments.find(item=>item.uri.toString()===frame?.uri);
      if(!document||!Number.isSafeInteger(frame.offset)||frame.version!==document.version||frame.identity!==joinIdentity())return false;
      const verified=(await joinActions(document,frame.offset)).find(item=>item.title===frame.title&&item.replacement===frame.replacement&&item.start===frame.start);
      if(!verified||verified.version!==frame.version||verified.identity!==frame.identity||document.version!==frame.version)return false;
      const edit=new vscode.WorkspaceEdit(),at=document.positionAt(verified.start);
      edit.insert(document.uri,at,verified.replacement);
      return vscode.workspace.applyEdit(edit);
    }),
    vscode.commands.registerCommand(missingCommand,async frame=>{
      const document=vscode.workspace.textDocuments.find(item=>item.uri.toString()===frame?.uri);
      if (!document||!Number.isSafeInteger(frame.offset)) return false;
      const current=()=>!disposed&&vscode.workspace.isTrusted&&!document.isClosed&&
        document.version===frame.version&&joinIdentity()===frame.identity&&!sqlAnalysis?.virtualActive(document);
      if (!current()) return false;
      const verified=objectAction(document,frame.offset);
      if (!verified||verified.title!==frame.title) return false;
      const {title,...request}=verified;
      return openDesigner({...request, assertSqlSourceCurrent:()=>{
        if (!current()) throw Error('The source or active database changed. Invoke the SQL quick fix again.');
      }});
    }),
    vscode.languages.registerCodeActionsProvider({language:'sql'},
      {async provideCodeActions(document,range,_context,cancellation){
        if(disposed||!vscode.workspace.isTrusted||sqlAnalysis?.virtualActive(document))return [];
        const catalog=database.catalogSnapshot(),offset=document.offsetAt(range.start);
        const nameActions=sqlQuickFixes(document.getText(),offset,catalog).map(fix=>{
          const action=new vscode.CodeAction('Use '+fix.replacement,vscode.CodeActionKind.QuickFix);
          action.command={command:fixCommand,title:action.title,arguments:[{
            uri:document.uri.toString(),version:document.version,revision:catalog.revision,offset,replacement:fix.replacement
          }]};
          return action;
        });
        const joins=await joinActions(document,offset,cancellation);
        const missing=objectAction(document,offset);
        if (missing&&!cancellation?.isCancellationRequested) {
          const action=new vscode.CodeAction(missing.title,vscode.CodeActionKind.QuickFix);
          action.command={command:missingCommand,title:action.title,arguments:[{
            uri:document.uri.toString(),version:document.version,offset,identity:joinIdentity(),title:missing.title
          }]};
          nameActions.push(action);
        }
        return [...nameActions,...joins.map(fix=>{
          const action=new vscode.CodeAction(fix.title,vscode.CodeActionKind.QuickFix);
          action.command={command:joinFixCommand,title:action.title,arguments:[{
            uri:document.uri.toString(),offset,title:fix.title,replacement:fix.replacement,start:fix.start,
            version:fix.version,identity:fix.identity
          }]};
          return action;
        })];
      }},{providedCodeActionKinds:[vscode.CodeActionKind.QuickFix]}),
    vscode.languages.registerDocumentFormattingEditProvider({language:'sql'},{
      provideDocumentFormattingEdits(document,options){try{return edits(document,whole(document),options);}catch{return [];}}
    }),
    vscode.languages.registerDocumentRangeFormattingEditProvider({language:'sql'},{
      provideDocumentRangeFormattingEdits(document,range,options){try{return edits(document,range,options);}catch{return [];}}
    }),
    vscode.languages.registerCompletionItemProvider({language:'sql'},{
      provideCompletionItems(document,position) {
        try{
          const line=document.lineAt(position.line).text.slice(0,position.character);
          const prefix=/^[ \t]*([A-Za-z][A-Za-z0-9-]*)$/.exec(line)?.[1];
          if(!prefix)return [];
          return values(document).filter(item=>!item.requiresTable&&item.prefix.startsWith(prefix)).map(template=>{
            const item=new vscode.CompletionItem(template.prefix,vscode.CompletionItemKind.Snippet);
            item.insertText=new vscode.SnippetString(template.body);
            item.detail=template.description;
            item.range=new vscode.Range(position.translate(0,-prefix.length),position);
            return item;
          });
        }catch{return [];}
      }
    })
  ];
  return {format,insert,dispose(){
    if(disposed)return;
    disposed=true;
    for(const subscription of subscriptions)subscription.dispose();
  }};
}

module.exports={registerSqlEditing};
