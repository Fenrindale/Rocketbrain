'use strict';

const PAGE_SIZE=100;
const kinds=new Map([['BASE TABLE','table'],['VIEW','view']]);

function name(value,{optional=false}={}){
  if(typeof value!=='string'||(!optional&&!value)||value.length>64||/[\x00-\x1f\x7f]/.test(value)){
    throw Error('Use a bounded database object name.');
  }
  return value;
}

async function listNames(read,{prefix='',after=''}={}){
  name(prefix,{optional:true});name(after,{optional:true});
  const like=prefix.replace(/[=%_]/g,value=>'='+value)+'%';
  const rows=await read(
    "SELECT TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES "+
    "WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE IN ('BASE TABLE','VIEW') "+
    "AND TABLE_NAME LIKE ? ESCAPE '=' AND CAST(TABLE_NAME AS BINARY)>CAST(? AS BINARY) "+
    "ORDER BY CAST(TABLE_NAME AS BINARY) LIMIT 101",[like,after]);
  const items=rows.slice(0,PAGE_SIZE).map(([schema,table,type])=>{
    const kind=kinds.get(type);
    if(!kind)throw Error('The database returned an unexpected object type.');
    return {schema:name(schema),name:name(table),kind};
  });
  return {items,next:rows.length>PAGE_SIZE?items.at(-1).name:null,detailQueries:0};
}

async function loadDetails(read,item){
  const schema=name(item?.schema),table=name(item?.name);
  if(!['table','view'].includes(item.kind))throw Error('Choose a listed table or view.');
  const filter='WHERE TABLE_SCHEMA=DATABASE() AND CAST(TABLE_SCHEMA AS BINARY)=CAST(? AS BINARY) '+
    'AND CAST(TABLE_NAME AS BINARY)=CAST(? AS BINARY) ';
  const exact=[schema,table];
  const [object]=await read('SELECT TABLE_TYPE,ENGINE FROM information_schema.TABLES '+filter+'LIMIT 1',exact);
  if(kinds.get(object?.[0])!==item.kind)throw Error('The database object changed. Browse names again.');
  const allColumns=await read('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE,ORDINAL_POSITION,COLUMN_KEY '+
    'FROM information_schema.COLUMNS '+filter+'ORDER BY ORDINAL_POSITION LIMIT 257',exact);
  const allIndexes=item.kind==='table'?await read('SELECT INDEX_NAME,SEQ_IN_INDEX,COLUMN_NAME,NON_UNIQUE,INDEX_TYPE '+
    'FROM information_schema.STATISTICS '+filter+'ORDER BY INDEX_NAME,SEQ_IN_INDEX LIMIT 513',exact):[];
  if(!allColumns.length)throw Error('The object columns are unavailable. Browse names again.');
  return {...item,engine:object[1]??null,
    columns:allColumns.slice(0,256).map(([column,type,nullable,position,key])=>({
      name:name(column),type:String(type),nullable:nullable==='YES',position:Number(position),key:key||null
    })),
    indexColumns:allIndexes.slice(0,512).map(([index,position,column,notUnique,type])=>({
      name:name(index),position:Number(position),column:column===null?null:name(column),unique:Number(notUnique)===0,type:String(type)
    })),
    truncated:{columns:allColumns.length>256,indexColumns:allIndexes.length>512},rowDataIncluded:false};
}

module.exports={listNames,loadDetails};
