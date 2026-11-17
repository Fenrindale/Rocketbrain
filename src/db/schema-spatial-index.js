'use strict';
const Spatial=require('./schema-conversion-spatial');
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_DIFF_UNSUPPORTED'});
function render(index,table,server,{quote,quoteLiteral}){
 if(!['SPATIAL','RTREE'].includes(index.type))return null;
 if(String(table.engine).toUpperCase()!=='INNODB'||index.unique||index.primaryKey||index.columns.length!==1)throw fail('SPATIAL indexes require one ordinary non-unique InnoDB geometry column.');
 const key=index.columns[0],column=table.columns.find(column=>column.name===key.name);
 if(!column||!Spatial.describe(column)||column.nullable!==false||column.generationExpression)throw fail('A SPATIAL index requires a resolved nonnullable non-generated geometry column.');
 // Both supported engines report SUB_PART=32 for the internal 2D MBR. It is
 // not a requested SQL prefix: SPATIAL INDEX(g(32)) is prohibited.
 if(![null,32].includes(key.prefixLength)||![null,'A'].includes(key.collation))throw fail('SPATIAL prefix lengths, descending keys and expressions are unsupported.');
 if(server?.dialect==='mysql'&&(!Number.isInteger(column.srsId)||![0,4326,3857].includes(column.srsId)))throw fail('MySQL SPATIAL indexes require an explicit supported column SRID restriction.');
 return 'SPATIAL KEY '+quote(index.name)+' ('+quote(column.name)+')'+(index.comment?' COMMENT '+quoteLiteral(index.comment,server):'');
}
module.exports={render};
