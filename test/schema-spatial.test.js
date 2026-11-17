'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../src/db/schema-conversion'),S=require('../src/db/schema-conversion-spatial'),{candidates,chooseConversions}=require('../src/db/schema-conversion-vscode');
const col=(type,extra={})=>({name:'shape',type,nullable:true,...extra});
const rule=(from,to,strategy='wkt-geometry',extra={})=>C.planConversions([col(from)],[col(to)],[{column:'shape',strategy,srid:0,axisOrder:'xy',coordinatePolicy:'exact',...extra}],{dialect:'mysql'})[0];
const parse=(wkt,srid=0,coordinatePolicy='exact')=>S.fromWkt(wkt,{srid,coordinatePolicy},{decimal:C.decimal,exactFloat:C.exactFloat});
test('spatial policies require explicit compatible SRID/axis/dialect and never accept raw SQL',()=>{
 assert.equal(C.typeSql('geomcollection'),'GEOMETRYCOLLECTION');
 assert.throws(()=>C.planConversions([col('text')],[col('point')],[{column:'shape',strategy:'wkt-geometry'}],{dialect:'mysql'}),/SRID/);
 assert.throws(()=>rule('text','point','wkt-geometry',{srid:4326}),/longitude-latitude/);assert.throws(()=>rule('text','point','wkt-geometry',{srid:27700}),/0.*4326/);
 assert.throws(()=>C.planConversions([col('text')],[col('point')],[{column:'shape',strategy:'wkt-geometry',srid:0,axisOrder:'xy'}]),/dialect/);
 assert.throws(()=>rule('text','point','wkt-geometry',{sql:'ST_Transform(shape,4326)'}),/finite/);
 assert.throws(()=>C.planConversions([col('point',{srsId:0})],[col('point',{srsId:4326})],[{column:'shape',strategy:'geometry-family',srid:4326,axisOrder:'long-lat'}],{dialect:'mysql'}),/restriction/);
 assert.throws(()=>C.planConversions([col('geometry')],[col('point')]),/Cross-category/);
});
test('all seven bounded 2D geometry families round-trip WKT and both WKB byte orders',()=>{
 const shapes=['POINT(1.5 -2.25)','LINESTRING(0 0,1 2)','POLYGON((0 0,2 0,2 2,0 0))','MULTIPOINT((1 2),(3 4))','MULTILINESTRING((0 0,1 1),(2 2,3 3))','MULTIPOLYGON(((0 0,2 0,2 2,0 0)))','GEOMETRYCOLLECTION(POINT(1 2),LINESTRING(0 0,1 1))'];
 shapes.forEach((wkt,index)=>{const node=parse(wkt).node,bytes=S.toWkb(node);assert.equal(node.type,index+1);assert.deepEqual(S.fromWkb(bytes,0),node);assert.equal(C.canonicalExpected(wkt,rule('text',S.FAMILIES[index])),'RBGEOM:0:'+bytes.toString('hex'));});
 const big=Buffer.alloc(21);big[0]=0;big.writeUInt32BE(1,1);big.writeDoubleBE(1.5,5);big.writeDoubleBE(-2.25,13);assert.deepEqual(S.fromWkb(big,0),parse('POINT(1.5 -2.25)').node);
});
test('exact WKT refuses coordinate rounding; approved nearest-even reports counts without values',()=>{
 const exact=rule('text','point');assert.throws(()=>C.convertValue('POINT(0.1 0.2)',exact),/round/);
 const rounded=rule('text','point','wkt-geometry',{coordinatePolicy:'nearest-even'});assert.equal(rounded.lossy,true);const value=C.canonicalExpected('POINT(0.1 0.5)',rounded),observed=S.observed(value);assert.equal(observed.node.coordinates[0],0.1);assert.equal(observed.node.coordinates[1],0.5);
 assert.deepEqual(C.diagnostic('POINT(0.1 0.5)',rounded),{column:'shape',strategy:'wkt-geometry',coordinatePolicy:'nearest-even',changed:true,changedCoordinates:1});assert.equal(JSON.stringify(C.diagnostic('POINT(0.1 0.5)',rounded)).includes('0.1'),false);assert.equal(C.diagnostic(null,rounded).changedCoordinates,0);
 assert.deepEqual(S.observed(C.canonicalExpected('POINT(9007199254740993 9007199254740995)',rounded)).node.coordinates,[9007199254740992,9007199254740996]);
 assert.throws(()=>rule('blob','point','wkb-geometry',{coordinatePolicy:'nearest-even'}),/Only WKT/);assert.throws(()=>C.convertValue('POINT(1e999 0)',rounded),/infinity/);
});
test('geographic longitude/latitude policies reject source out-of-range values before rounding',()=>{
 const d=rule('text','point','wkt-geometry',{srid:4326,axisOrder:'long-lat',coordinatePolicy:'nearest-even'});
 for(const wkt of ['POINT(180 90)','POINT(-179.5 -90)'])assert.match(C.canonicalExpected(wkt,d),/^RBGEOM:4326:/);
 for(const wkt of ['POINT(-180 0)','POINT(180.00000000000000000001 0)','POINT(0 -90.00000000000000001)','POINT(0 90.5)'])assert.throws(()=>C.convertValue(wkt,d),/range|longitude/);
});
test('malformed WKT, implicit dimensions, empty shapes and unclosed rings cannot silently normalize',()=>{
 for(const wkt of ['POINT EMPTY','POINT(1-2)','POINT(1,2)','POINT Z(1 2 3)','SRID=4326;POINT(1 2)','LINESTRING(1 2)','POLYGON((0 0,1 0,1 1,0 1))','GEOMETRYCOLLECTION()','POINT(NaN 1)','POINT(1 2)DROP TABLE x'])assert.throws(()=>parse(wkt),error=>error.code==='ROCKETBRAIN_CONVERSION');
 const tooMany='LINESTRING('+Array.from({length:4097},(_,i)=>i+' 0').join(',')+')';assert.throws(()=>parse(tooMany),/bound|4096/);
});
test('WKB refuses truncated/trailing/malformed counts, EWKB, dimensions, nonfinite and negative-zero bits',()=>{
 const point=S.toWkb(parse('POINT(1 2)').node);assert.throws(()=>S.fromWkb(point.subarray(0,20),0),/truncated/);assert.throws(()=>S.fromWkb(Buffer.concat([point,Buffer.from([0])]),0),/Trailing/);
 for(const type of [1001,0x20000001,0x80000001]){const invalid=Buffer.from(point);invalid.writeUInt32LE(type,1);assert.throws(()=>S.fromWkb(invalid,0),/EWKB|unknown/);}
 for(const value of [NaN,Infinity,-0]){const invalid=Buffer.from(point);invalid.writeDoubleLE(value,5);assert.throws(()=>S.fromWkb(invalid,0),/finite|Negative-zero/);}
 const malformed=Buffer.from([1,2,0,0,0,255,255,255,255]);assert.throws(()=>S.fromWkb(malformed,0),/count/);
});
test('driver objects cannot lose SRID and geometry family/SRID changes refuse relabeling',()=>{
 assert.throws(()=>C.canonicalValue('RBGEOM:0:'+'00'.repeat(128*1024+20),col('geometry')),/before hex decoding/);
 assert.throws(()=>C.canonicalValue({x:1,y:2},col('point')),/envelope/);const source=S.envelope(4326,parse('POINT(1 2)',4326).node);
 assert.throws(()=>C.canonicalExpected(source,rule('point','blob','geometry-wkb')),/SRID differs/);
 const d=rule('geometry','point','geometry-family',{srid:4326,axisOrder:'long-lat'});assert.equal(C.canonicalExpected(source,d),source);assert.throws(()=>C.canonicalExpected(S.envelope(4326,parse('LINESTRING(0 0,1 1)',4326).node),d),/family/);
 assert.throws(()=>C.canonicalValue(source,col('point',{srsId:0})),/restriction/);assert.equal(C.canonicalExpected(null,d),null);
});
test('spatial SQL selects explicit engine axis options and observations always include SRID plus WKB',()=>{
 const d=rule('text','point','wkt-geometry',{srid:4326,axisOrder:'long-lat'});assert.equal(C.expression(d,'`shape`'),"ST_GeomFromText(`shape`,4326,'axis-order=long-lat')");assert.match(C.expression({...d,dialect:'mariadb'},'`shape`'),/^ST_GeomFromText\(CASE WHEN/);assert.doesNotMatch(C.expression({...d,dialect:'mariadb'},'`shape`'),/axis-order/);
 assert.match(C.observationExpression(col('point'),'`shape`',{dialect:'mysql'}),/ST_SRID.*ST_AsWKB.*axis-order=long-lat/);assert.doesNotMatch(C.observationExpression(col('point'),'`shape`',{dialect:'mariadb'}),/axis-order/);assert.throws(()=>C.observationExpression(col('point'),'`shape`'),/dialect/);
 assert.throws(()=>C.canonicalExpected('GEOMETRYCOLLECTION(MULTIPOINT((1 2),(3 4)))',{...rule('text','geometry'),dialect:'mariadb'}),/Nested parenthesized/);
});
test('spatial picker exposes explicit SRID/axis/exact or approved-rounding choices and honors restrictions',async()=>{
 const options=candidates(col('text'),col('point',{srsId:4326}),{dialect:'mysql'});assert.equal(options.length,2);assert.ok(options.every(option=>option.rule.srid===4326&&option.rule.axisOrder==='long-lat'));assert.ok(options.some(option=>option.rule.coordinatePolicy==='nearest-even'&&/loss approval/.test(option.description)));
 const current={server:{dialect:'mysql'},tables:[{name:'geo',columns:[col('text')]}]},desired={tables:[{name:'geo',columns:[col('point',{srsId:4326})]}]},vscode={workspace:{isTrusted:true},window:{showQuickPick:async options=>options.find(option=>option.rule.coordinatePolicy==='exact')}};assert.deepEqual(await chooseConversions(vscode,current,desired,['geo']),{geo:[{column:'shape',strategy:'wkt-geometry',srid:4326,axisOrder:'long-lat',coordinatePolicy:'exact'}]});
});
