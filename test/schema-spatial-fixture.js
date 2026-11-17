'use strict';
const C=require('../src/db/schema-conversion'),S=require('../src/db/schema-conversion-spatial');
const shapes=['POINT(1.5 -2.25)','LINESTRING(0 0,1 2)','POLYGON((0 0,2 0,2 2,0 0))','MULTIPOINT((1 2),(3 4))','MULTILINESTRING((0 0,1 1),(2 2,3 3))','MULTIPOLYGON(((0 0,2 0,2 2,0 0)))','GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))'];
const names=['wkt_point','wkt_line','wkt_polygon','wkt_mpoint','wkt_mline','wkt_mpolygon','wkt_collection'];
const pairs=shapes.map((_,index)=>({name:names[index],from:'text',to:S.FAMILIES[index].toLowerCase(),strategy:'wkt-geometry',srid:0})).concat([
 {name:'wkb_geo',from:'blob',to:'point',strategy:'wkb-geometry',srid:4326},
 {name:'wkb_line',from:'blob',to:'linestring',strategy:'wkb-geometry',srid:0},
 {name:'export_plain',from:'geometry',to:'blob',strategy:'geometry-wkb',srid:0},
 {name:'export_geo',from:'geometry',to:'blob',strategy:'geometry-wkb',srid:4326},
 {name:'narrow_geo',from:'geometry',to:'point',strategy:'geometry-family',srid:4326,unrestrictedFrom:true},
 {name:'widen_point',from:'point',to:'geometry',strategy:'geometry-family',srid:0},
 {name:'rounded_geo',from:'text',to:'point',strategy:'wkt-geometry',srid:4326,coordinatePolicy:'nearest-even'},
 {name:'wkt_geo',from:'text',to:'point',strategy:'wkt-geometry',srid:4326},
 {name:'untouched',from:'geometry',to:'geometry',strategy:'exact',srid:0}
]);
const q=name=>'`'+name.replaceAll('`','``')+'`';
const parse=(value,srid=0)=>S.fromWkt(value,{srid,coordinatePolicy:'exact'},{decimal:C.decimal,exactFloat:C.exactFloat}).node;
const wkb=(value,srid=0)=>S.toWkb(parse(value,srid));
function pointBytes(x,y,bigEndian=false){const bytes=Buffer.alloc(21);bytes[0]=bigEndian?0:1;if(bigEndian){bytes.writeUInt32BE(1,1);bytes.writeDoubleBE(x,5);bytes.writeDoubleBE(y,13);}else{bytes.writeUInt32LE(1,1);bytes.writeDoubleLE(x,5);bytes.writeDoubleLE(y,13);}return bytes;}
const values=[
 [...shapes,pointBytes(127.5,37.5,true),wkb('LINESTRING(0 0,1 1)'),pointBytes(0.1,0.2),pointBytes(127.5,37.5),pointBytes(127.5,37.5),pointBytes(1.5,2.5),'POINT(127.1 37.2)','POINT(127.5 37.5)',pointBytes(0.5,0.25)],
 [...shapes,pointBytes(180,-90),wkb('LINESTRING(-1 -1,2 2)'),pointBytes(1.25,-2.5),pointBytes(1.5,-2.5),pointBytes(1.5,-2.5),pointBytes(3.5,4.5),'POINT(0.5 0.25)','POINT(180 -90)',pointBytes(1,2)],
 Array(pairs.length).fill(null)
];
const rules=pairs.filter(pair=>pair.strategy!=='exact').map(pair=>({column:pair.name,strategy:pair.strategy,srid:pair.srid,axisOrder:pair.srid===0?'xy':'long-lat',coordinatePolicy:pair.coordinatePolicy||'exact'}));
function columns(side,dialect){return pairs.map(pair=>({name:pair.name,type:pair[side],nullable:true,...(S.describe(pair[side])?{srsId:dialect==='mysql'&&!(side==='from'&&pair.unrestrictedFrom)?pair.srid:null}:{})}));}
function descriptors(dialect){return C.planConversions(columns('from',dialect),columns('to',dialect),rules,{dialect});}
function definition(name,side,dialect){return 'CREATE TABLE '+q(name)+' (id INT PRIMARY KEY,'+pairs.map(pair=>q(pair.name)+' '+pair[side]+(S.describe(pair[side])&&dialect==='mysql'&&!(side==='from'&&pair.unrestrictedFrom)?' SRID '+pair.srid:'')+' NULL').join(',')+(side==='from'?',original_only VARCHAR(30) NULL':'')+') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';}
function constructor(source,srid,dialect){return 'ST_GeomFromWKB('+source+','+srid+(srid===4326&&dialect==='mysql'?",'axis-order=long-lat'":'')+')';}
async function seed(actor,name,dialect){await actor.query(definition(name,'from',dialect));for(let i=0;i<values.length;i++){const sql=pairs.map(pair=>S.describe(pair.from)?constructor('?',pair.srid,dialect):'?').join(',');await actor.execute('INSERT INTO '+q(name)+' VALUES (?,'+sql+',?)',[i+1,...values[i],'retained spatial '+i]);}}
function projection(side,dialect){return columns(side,dialect).map(column=>C.observationExpression(column,q(column.name),{dialect})+' AS '+q(column.name)).join(',');}
function assertConverted(assert,source,target,dialect){for(let i=0;i<source.length;i++)for(const d of descriptors(dialect))assert.equal(C.canonicalValue(target[i][d.column],d.to),C.canonicalExpected(source[i][d.column],d),d.column+' row '+i);}
async function state(){if(!process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG)return;const fs=require('node:fs'),runtime=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG));return(await fetch(runtime.baseUrl+'/probe/testing-state')).json();}
module.exports={pairs,shapes,values,rules,q,columns,descriptors,definition,constructor,seed,projection,assertConverted,state,parse,wkb,pointBytes};
