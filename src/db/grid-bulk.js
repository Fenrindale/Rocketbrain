'use strict';
const {typedCell}=require('./grid');
const LIMITS={bytes:1024*1024,rows:500,columns:200,cellBytes:128*1024};
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_GRID_BULK'});
function parseDelimited(text,{delimiter='\t',hasHeader=false}={}){
  if(typeof text!=='string'||text.includes('\0')||Buffer.byteLength(text)>LIMITS.bytes)throw fail('CSV/TSV input must be local text without NUL and at most 1 MiB.');
  if(![',','\t'].includes(delimiter))throw fail('Choose comma CSV or tab TSV.');
  if(text.charCodeAt(0)===0xfeff)text=text.slice(1);
  const rows=[],quoted=[];let row=[],flags=[],cell='',inQuote=false,wasQuoted=false,closedQuote=false;
  const pushCell=()=>{if(Buffer.byteLength(cell)>LIMITS.cellBytes)throw fail('An imported cell exceeds 128 KiB.');row.push(cell);flags.push(wasQuoted);if(row.length>LIMITS.columns)throw fail('Import at most 200 columns.');cell='';wasQuoted=false;closedQuote=false;};
  const pushRow=()=>{pushCell();rows.push(row);quoted.push(flags);row=[];flags=[];if(rows.length>LIMITS.rows+(hasHeader?1:0))throw fail('Stage at most 500 imported rows at a time.');};
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQuote){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{inQuote=false;closedQuote=true;}}else cell+=c;continue;}
    if(c==='"'){if(cell||closedQuote)throw fail('A CSV quote must start a field; quote embedded quotes twice.');inQuote=true;wasQuoted=true;continue;}
    if(c===delimiter){pushCell();continue;}
    if(c==='\r'||c==='\n'){if(c==='\r'&&text[i+1]==='\n')i++;pushRow();continue;}
    if(closedQuote)throw fail('Only a delimiter or line ending may follow a quoted CSV field.');
    cell+=c;
  }
  if(inQuote)throw fail('The CSV quoted field is not closed.');
  if(cell||row.length||wasQuoted||text&&!/[\r\n]$/.test(text))pushRow();
  if(!rows.length)throw fail('Enter at least one row.');
  const width=rows[0].length;if(rows.some(r=>r.length!==width))throw fail('Every imported row must have the same number of fields.');
  let headers=null;if(hasHeader){headers=rows.shift();quoted.shift();if(headers.some(h=>!h)||new Set(headers).size!==headers.length)throw fail('CSV headers must be nonempty and unique.');if(!rows.length)throw fail('The CSV contains headers but no data rows.');}
  return {headers,rows,quoted,width,rowCount:rows.length,delimiter,hasHeader};
}
function cellInput(value,quoted,column,nullToken){
  const cell=nullToken!==undefined&&value===nullToken&&!quoted?{kind:'null'}:{kind:'value',text:value};typedCell(cell,column);return cell;
}
function ready(model){if(!model?.canEdit||!Array.isArray(model.columns)||!Array.isArray(model.rowIds))throw fail('Use an editable table snapshot for bulk changes.');}
function validateSize(changes){if(changes.updates.length+changes.inserts.length+changes.deletes.length>500||Buffer.byteLength(JSON.stringify(changes))>LIMITS.bytes)throw fail('A staged bulk change must fit 500 rows and 1 MiB.');return changes;}
function planPaste(model,parsed,{anchorRowId,anchorColumn,nullToken}={}){
  ready(model);const row=model.rowIds.indexOf(anchorRowId),column=model.columns.findIndex(c=>c.name===anchorColumn);
  if(row<0||column<0||row+parsed.rows.length>model.rowIds.length||column+parsed.width>model.columns.length)throw fail('The paste rectangle must fit the currently loaded rows and columns.');
  const columns=model.columns.slice(column,column+parsed.width);if(columns.some(c=>!c.editable||c.primaryKey||c.generated||c.autoIncrement))throw fail('A paste rectangle cannot include primary-key, generated or other read-only columns.');
  return validateSize({updates:parsed.rows.map((values,index)=>({rowId:model.rowIds[row+index],values:Object.fromEntries(values.map((value,i)=>[columns[i].name,cellInput(value,parsed.quoted[index][i],columns[i],nullToken)]))})),inserts:[],deletes:[]});
}
function planImport(model,parsed,{mapping,nullToken}={}){
  ready(model);if(model.insertable===false)throw fail('This table has a required column that cannot be inserted safely.');
  if(mapping===undefined&&parsed.headers){if(parsed.headers.some(name=>!model.columns.some(c=>c.name===name&&c.insertable)))throw fail('Map or explicitly ignore unknown or protected source headers before importing.');mapping=parsed.headers.map((name,source)=>({source,target:name}));}
  if(!Array.isArray(mapping)||!mapping.length||mapping.length>parsed.width)throw fail('Map source fields to table columns before importing.');
  const sources=new Set(),targets=new Set(),selected=[];
  for(const entry of mapping){if(!entry||!Number.isInteger(entry.source)||entry.source<0||entry.source>=parsed.width||sources.has(entry.source))throw fail('Each source field may be mapped once.');sources.add(entry.source);if(entry.target===null||entry.target==='')continue;const column=model.columns.find(c=>c.name===entry.target);if(!column?.insertable||column.generated||column.autoIncrement||targets.has(column.name))throw fail('Choose distinct insertable columns; generated and auto-increment columns cannot be imported.');targets.add(column.name);selected.push({source:entry.source,column});}
  if(!selected.length)throw fail('Map at least one source field to a table column.');
  for(const column of model.columns)if(column.required&&!targets.has(column.name))throw fail('Map the required column '+column.name+' before importing.');
  return validateSize({updates:[],inserts:parsed.rows.map((row,index)=>({values:Object.fromEntries(selected.map(({source,column})=>{const value=parsed.nulls?.[index]?.[source]?{kind:'null'}:cellInput(row[source],parsed.quoted[index][source],column,nullToken);typedCell(value,column);return[column.name,value];}))})),deletes:[]});
}
function planDuplicate(model,result,rowId){
  ready(model);if(model.insertable===false)throw fail('This table cannot accept a safe inserted row.');const index=model.rowIds.indexOf(rowId);if(index<0||!result.rows[index])throw fail('Select a row from the current table page.');
  const values=Object.create(null);for(let i=0;i<model.columns.length;i++){const column=model.columns[i];if(!column.insertable||column.primaryKey||column.generated||column.autoIncrement)continue;const value=result.rows[index][i],cell=value===null?{kind:'null'}:{kind:'value',text:String(value)};typedCell(cell,column);values[column.name]=cell;}
  return {...validateSize({updates:[],inserts:[{values}],deletes:[]}),requiredColumns:model.columns.filter(c=>c.required&&!Object.hasOwn(values,c.name)).map(c=>c.name)};
}
module.exports={parseDelimited,planPaste,planImport,planDuplicate,LIMITS};
