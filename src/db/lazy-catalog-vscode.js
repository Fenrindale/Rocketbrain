'use strict';

const { randomUUID }=require('node:crypto');
const { listNames,loadDetails }=require('./lazy-catalog');
const { readRows }=require('./database-admin-metadata');

function registerLazyCatalog(context,vscode,{database}){
  const offers=new Map(),documents=new Map();
  const scheme='rocketbrain-object-meta';
  let generation=0,disposed=false;

  function validate(lease,frame){
    if(disposed||!vscode.workspace.isTrusted||generation!==frame||!lease.guard()){
      throw Error('The metadata connection changed. Browse names again.');
    }
  }

  function observed(lease,frame){
    return async (sql,values)=>{
      validate(lease,frame);
      const rows=await readRows(lease.db,sql,values);
      validate(lease,frame);
      return rows;
    };
  }

  async function list(request){
    const frame=generation;
    return database.withDatabaseAdmin(async lease=>{
      const page=await listNames(observed(lease,frame),request);
      while(offers.size>=8)offers.delete(offers.keys().next().value);
      const id=randomUUID();
      offers.set(id,{frame,epoch:lease.epoch,db:lease.db,items:page.items});
      return {...page,id,items:page.items.map(item=>({...item}))};
    });
  }

  async function inspect(id,index){
    const offer=offers.get(id),item=offer?.items[index];
    if(!item)throw Error('Choose an object from the current catalog page.');
    return database.withDatabaseAdmin(lease=>{
      if(offer.db!==lease.db||offer.epoch!==lease.epoch)throw Error('The metadata connection changed. Browse names again.');
      return loadDetails(observed(lease,offer.frame),item);
    });
  }

  function refresh(id, index) {
    const offer = offers.get(id), item = offer?.items[index];
    if (!item || offer.frame !== generation || disposed || !vscode.workspace.isTrusted) {
      throw Error('Choose an object from the current catalog page.');
    }
    return database.refreshObjects({ names: [item.name] });
  }

  async function show(result){
    const uri=vscode.Uri.from({scheme,path:'/object-'+randomUUID()+'.txt'});
    const lines=[result.schema+'.'+result.name,result.kind+(result.engine?' · '+result.engine:''),
      '', 'Columns',...result.columns.map(column=>[
        String(column.position),JSON.stringify(column.name),column.type,column.nullable?'NULL':'NOT NULL',column.key
      ].filter(Boolean).join('  '))];
    if(result.indexColumns.length)lines.push('', 'Indexes',...result.indexColumns.map(column=>[
      JSON.stringify(column.name),'#'+column.position,column.column===null?'expression':JSON.stringify(column.column),
      column.unique?'unique':'non-unique',column.type
    ].join('  ')));
    if(result.truncated.columns||result.truncated.indexColumns)lines.push('','Some metadata exceeds the display limit.');
    while(documents.size>=16)documents.delete(documents.keys().next().value);
    documents.set(uri.toString(),lines.join('\n'));
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:true});
  }

  async function browse(){
    try{
      const prefix=await vscode.window.showInputBox({title:'Browse Database Objects',prompt:'Optional table or view name prefix'});
      if(prefix===undefined)return;
      let after='';
      while(true){
        const frame=generation;
        const page=await list({prefix,after});
        const choices=page.items.map((item,index)=>({label:item.name,description:item.kind,index}));
        if(page.next)choices.push({label:'Next page…',next:true});
        if(!choices.length){await vscode.window.showInformationMessage('No visible table or view matches that prefix.');return;}
        const selected=await vscode.window.showQuickPick(choices,{title:'Database Objects',placeHolder:'Choose a name to load its definition'});
        if(!selected)return;
        if(frame!==generation)throw Error('The metadata connection changed. Browse names again.');
        if(selected.next){after=page.next;continue;}
        await show(await inspect(page.id,selected.index));
        return;
      }
    }catch(error){if(!disposed)await vscode.window.showErrorMessage('Rocketbrain catalog: '+error.message);}
  }
  const subscriptions=[
    vscode.commands.registerCommand('rocketbrain.db.browseObjectNames',browse),
    vscode.workspace.registerTextDocumentContentProvider(scheme,{provideTextDocumentContent:uri=>documents.get(uri.toString())||''}),
    vscode.workspace.onDidCloseTextDocument(doc=>documents.delete(doc.uri.toString())),
    database.onDidChangeDatabase(()=>{generation++;offers.clear();})
  ];
  return {list,inspect,refresh,dispose(){
    if(disposed)return;
    disposed=true;offers.clear();documents.clear();
    for(const subscription of subscriptions)subscription.dispose();
  }};
}

module.exports={registerLazyCatalog};
