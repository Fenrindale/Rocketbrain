'use strict';

const builtins=Object.freeze([
  {prefix:'rb-select',description:'Select visible columns with a row limit',requiresTable:true,
    body:'SELECT ${columns}\nFROM ${relation}\nLIMIT ${1:100};'},
  {prefix:'rb-key',description:'Select by primary key',requiresTable:true,requiresKey:true,
    body:'SELECT ${columns}\nFROM ${relation}\nWHERE ${key} = ${1:0};'},
  {prefix:'rb-explain',description:'Inspect a query plan',requiresTable:true,
    body:'EXPLAIN SELECT ${columns}\nFROM ${relation}\nLIMIT ${1:100};'},
  {prefix:'rb-transaction',description:'Start an explicit transaction script draft',requiresTable:false,
    body:'START TRANSACTION;\n$0\nROLLBACK;'}
]);
const prefixPattern=/^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const quote=value=>'`'+value.replaceAll('`','``')+'`';
const literal=value=>value.replace(/[\\$}]/g,'\\$&');
const validIdentifier=value=>typeof value==='string'&&value.length>0&&value.length<=64&&!/[\x00-\x1f\x7f]/.test(value);
const templateField=/\$\{(relation|table|schema|columns|key)\}/g;

function templates(configured=[]) {
  if (!Array.isArray(configured)||configured.length>32) throw Error('Define at most 32 SQL templates.');
  const byPrefix=new Map(builtins.map(item=>[item.prefix,item]));
  const seen=new Set();
  for (const value of configured) {
    if (!value||!prefixPattern.test(value.prefix)||typeof value.body!=='string'||!value.body.trim()||
        Buffer.byteLength(value.body)>8192||seen.has(value.prefix)||value.body.includes('\0')||
        value.description!==undefined&&typeof value.description!=='string') {
      throw Error('Use a distinct SQL template prefix and a nonempty body under 8 KiB.');
    }
    seen.add(value.prefix);
    const fields=[...value.body.matchAll(templateField)].map(match=>match[1]);
    byPrefix.set(value.prefix,{prefix:value.prefix,description:value.description?.slice(0,180)||'Workspace SQL template',
      body:value.body,requiresTable:fields.length>0,requiresKey:fields.includes('key')});
  }
  return [...byPrefix.values()];
}

function resolveTemplate(template,catalog,selected) {
  if (!template.requiresTable) return template.body;
  if (!validIdentifier(catalog?.database)||catalog.coverage?.tables!=='loaded'||catalog.coverage?.columns!=='loaded') {
    throw Error('Refresh MySQL or MariaDB metadata before using a table template.');
  }
  const table=[...catalog.tables,...(catalog.views||[])].find(item=>item.name===selected);
  if (!table||!validIdentifier(table.name)||!Array.isArray(table.columns)||!table.columns.length||
      table.columns.length>256||table.columns.some(column=>!validIdentifier(column.name))) {
    throw Error('Choose a visible table with one to 256 columns.');
  }
  const primary=table.columns.filter(column=>column.primaryKey);
  if (template.requiresKey&&primary.length!==1) throw Error('This template requires one visible primary-key column.');
  const tableName=quote(table.name),schema=quote(catalog.database);
  const substitutions={relation:schema+'.'+tableName,table:tableName,schema,
    columns:table.columns.map(column=>quote(column.name)).join(', '),key:primary.length===1?quote(primary[0].name):''};
  return template.body.replaceAll(templateField,(_,name)=>literal(substitutions[name]));
}

module.exports={templates,resolveTemplate};
