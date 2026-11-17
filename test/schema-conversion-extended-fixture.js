'use strict';
const C=require('../src/db/schema-conversion');
const pairs=[
 ['year_text','varchar(8)','year','text-year'],['year_number','int','year','number-year'],['year_render','year','varchar(4)','year-text'],['year_value','year','smallint unsigned','year-number'],
 ['hex_text','text','varbinary(128)','hex-decode'],['hex_bytes','varbinary(128)','text','hex-encode'],['b64_text','text','varbinary(128)','base64-decode'],['b64_bytes','varbinary(128)','text','base64-encode'],
 ['utc_text','varchar(40)','timestamp(6)','text-timestamp-utc','UTC'],['utc_calendar','datetime(6)','timestamp(6)','calendar-timestamp-utc','UTC'],['utc_date','timestamp(6)','date','timestamp-calendar-utc','UTC'],['utc_render','timestamp(3)','varchar(40)','timestamp-text-utc','UTC']
];
const bytes=Buffer.from(Array.from({length:120},(_,i)=>i)),short=Buffer.from([0,255,128,65]);
const values=[['0000',0,0,2024,short.toString('hex'),short,bytes.toString('base64'),bytes,'2024-02-29T12:34:56.123456Z','2024-02-29 12:34:56.123456','2024-02-29 00:00:00.000000','2024-02-29 12:34:56.120'],['2155',1901,2155,0,'',Buffer.alloc(0),'',Buffer.alloc(0),'1970-01-01T00:00:01Z','2038-01-19 03:14:07.499999','1970-01-02 00:00:00.000000','2010-01-01 00:00:00.999'],Array(pairs.length).fill(null)];
const rules=pairs.map(([column,,,strategy,timezone])=>({column,strategy,...(timezone?{timezone}:{})}));
const columns=side=>pairs.map(([name,from,to])=>({name,type:side==='from'?from:to,nullable:true,charset:/char|text/.test(side==='from'?from:to)?'utf8mb4':null}));
const descriptors=()=>C.planConversions(columns('from'),columns('to'),rules);
const q=name=>'`'+name.replaceAll('`','``')+'`';
const definition=(name,side)=>'CREATE TABLE '+q(name)+' (id INT PRIMARY KEY,'+pairs.map(([name,from,to])=>q(name)+' '+(side==='from'?from:to)+' NULL').join(',')+(side==='from'?',original_only VARCHAR(30) NULL':'')+') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
async function seed(actor,name){await actor.query("SET SESSION time_zone='+00:00'");await actor.query(definition(name,'from'));for(let i=0;i<values.length;i++)await actor.execute('INSERT INTO '+q(name)+' VALUES ('+Array(pairs.length+2).fill('?').join(',')+')',[i+1,...values[i],'retained '+i]);}
const projection=side=>columns(side).map(column=>C.observationExpression(column,q(column.name))+' AS '+q(column.name)).join(',');
function assertConverted(assert,source,target){for(let i=0;i<source.length;i++)for(const d of descriptors())assert.equal(C.canonicalValue(target[i][d.column],d.to),C.canonicalExpected(source[i][d.column],d),d.column+' row '+i);}
async function state(){if(!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG)return;const fs=require('node:fs'),runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));return(await fetch(runtime.baseUrl+'/probe/testing-state')).json();}
module.exports={pairs,values,rules,columns,descriptors,q,definition,seed,projection,assertConverted,state};
