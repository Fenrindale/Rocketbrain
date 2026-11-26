'use strict';
const C=require('./schema-conversion');
const columnMapping=require('./schema-column-mappings');
const UTC=require('./schema-conversion-extended').UTC_STRATEGIES;
const SPATIAL=require('./schema-conversion-spatial').STRATEGIES;
const PROJECT=require('./schema-reprojection').STRATEGIES;
const SPECIAL=[{strategy:'decimal-quantize',onLoss:'half-even',label:'Half-even decimal rounding · explicit value change'},{strategy:'decimal-quantize',onLoss:'truncate',label:'Truncate decimal digits · explicit value change'}];
function logicalColumn(table,column){if(!/^longtext$/i.test(column.type))return column;const name=column.name.toLowerCase(),json=(table.checks||[]).some(check=>String(check.expression).replace(/`/g,'').replace(/\s+/g,'').toLowerCase()==='json_valid('+name+')');return json?{...column,semanticType:'json'}:column;}
function candidates(before,after,{dialect,exactOnly=false}={}){const spatial=SPATIAL.flatMap(strategy=>[0,4326,3857].flatMap(srid=>(strategy==='wkt-geometry'?['exact','nearest-even']:['exact']).map(coordinatePolicy=>({strategy,srid,axisOrder:srid===0?'xy':srid===4326?'long-lat':'east-north',coordinatePolicy,label:strategy+' · SRID '+srid+' '+(srid===0?'Cartesian xy':srid===4326?'longitude-latitude':'easting-northing')+' · '+(coordinatePolicy==='exact'?'exact coordinates':'nearest-even rounding · explicit value change')})))),project=PROJECT.map(strategy=>{const forward=strategy==='web-mercator-forward';return{strategy,fromSrid:forward?4326:3857,toSrid:forward?3857:4326,axisOrder:forward?'long-lat-to-east-north':'east-north-to-long-lat',accuracy:'roundtrip-1um',label:(forward?'EPSG4326 longitude-latitude → EPSG3857 metres':'EPSG3857 metres → EPSG4326 longitude-latitude')+' · owned vertex projection · explicit value change'};}),rules=C.STRATEGIES.filter(strategy=>strategy!=='decimal-quantize'&&!SPATIAL.includes(strategy)&&!PROJECT.includes(strategy)).map(strategy=>({strategy,label:strategy==='exact'?'Preserve exact values · reject any loss':UTC.includes(strategy)?strategy+' · explicitly interpret and observe in UTC':strategy})).concat(SPECIAL,spatial,project),result=[];for(const rule of rules){try{const canonical={column:after.name,strategy:rule.strategy,...(rule.onLoss?{onLoss:rule.onLoss}:{}),...(UTC.includes(rule.strategy)?{timezone:'UTC'}:{}),...(SPATIAL.includes(rule.strategy)?{srid:rule.srid,axisOrder:rule.axisOrder,coordinatePolicy:rule.coordinatePolicy}:{}),...(PROJECT.includes(rule.strategy)?{fromSrid:rule.fromSrid,toSrid:rule.toSrid,axisOrder:rule.axisOrder,accuracy:rule.accuracy}:{})},descriptor=C.planConversions([before],[after],[canonical],{dialect})[0];if(exactOnly&&descriptor.lossy)continue;result.push({label:rule.label,description:descriptor.lossy?'Requires separate loss approval':UTC.includes(rule.strategy)?'UTC session is verified; no local timezone inference':SPATIAL.includes(rule.strategy)?'Explicit SRID and axis order; no reprojection':descriptor.explicit&&rule.strategy!=='exact'?'Explicit finite conversion':'Default preservation',detail:descriptor.effect,rule:canonical});}catch{}}return result;}

async function chooseColumnMappings(vscode, current, desired, tables) {
 const check=()=>{if(vscode.workspace?.isTrusted===false)throw Error('Trust the workspace before mapping columns.');};
 const choices=new Map();
 for(const table of tables){
  const before=current.tables.find(item=>item.name===table),after=desired.tables.find(item=>item.name===table);
  const {from,to}=columnMapping.candidates(before,after),pairs=[];
  let removed=[...from],added=[...to];
  while(removed.length&&added.length&&pairs.length<columnMapping.LIMIT){
   check();
   const sources=[{label:pairs.length?'Finish mapping columns':'Do not map columns',skip:true},
    ...removed.map(column=>({label:column.name,description:column.type,column}))];
   const source=await vscode.window.showQuickPick(sources,{title:'Map a renamed column in '+table,ignoreFocusOut:true,
    placeHolder:'Choose a removed source column whose values belong in an added column'});
   check();if(!source)return null;
   const selected=sources.find(choice=>choice===source);
   if(!selected)throw Error('Choose an offered source column.');
   if(selected.skip)break;
   const targets=added.map(column=>({label:column.name,description:column.type,column}));
   const target=await vscode.window.showQuickPick(targets,{title:'Destination for '+table+'.'+selected.column.name,
    ignoreFocusOut:true,placeHolder:'Values from the source will be copied and verified under the new column name'});
   check();if(!target)return null;
   const destination=targets.find(choice=>choice===target);
   if(!destination)throw Error('Choose an offered destination column.');
   pairs.push({from:selected.column.name,to:destination.column.name});
   removed=removed.filter(column=>column!==selected.column);
   added=added.filter(column=>column!==destination.column);
  }
  if(pairs.length)choices.set(table,pairs);
 }
 return Object.fromEntries(choices);
}

async function chooseConversions(vscode,current,desired,tables,{columnMappings={},selectedColumns}={}){
 const trusted=()=>{if(vscode.workspace?.isTrusted===false)throw Error('Trust the workspace before selecting schema conversions.');};trusted();
 if(!Array.isArray(tables)||!tables.length||tables.length>10)throw Error('Select 1 to 10 rebuild tables.');const changes=[];
 for(const name of tables){
  const before=current.tables.find(table=>table.name===name),after=desired.tables.find(table=>table.name===name);
  if(!before||!after)continue;
  for(const target of after.columns){
   if(selectedColumns&&!selectedColumns.get(name)?.has(target.name))continue;
   const alias=Object.hasOwn(columnMappings,name)&&columnMappings[name].find(pair=>pair.to===target.name);
   const source=before.columns.find(column=>column.name===(alias?.from||target.name));
   if(!source)continue;
   const captured=logicalColumn(before,source),from=alias?{...captured,name:target.name}:captured,to=logicalColumn(after,target);
   const a=C.describeType(from),b=C.describeType(to);
   if(a.type===b.type&&a.category===b.category&&a.srsId===b.srsId&&(a.category!=='geometry'||selectedColumns))continue;
   const options=candidates(from,to,{dialect:current.server?.dialect,exactOnly:Boolean(alias)});
   if(!options.length)throw Error('No supported reviewed conversion exists for '+name+'.'+target.name+' ('+source.type+' to '+target.type+').');
   changes.push({table:name,column:target.name,from:source.type,to:target.type,options});
  }
 }
 if(changes.length>200)throw Error('The conversion dialog supports at most 200 changed columns per review.');const result={};
 for(const change of changes){trusted();const choice=await vscode.window.showQuickPick(change.options,{title:'Conversion for '+change.table+'.'+change.column,placeHolder:change.from+' → '+change.to+' · original values remain in the retained backup',ignoreFocusOut:true});trusted();if(!choice)return null;const canonical=change.options.find(option=>option===choice||option.label===choice.label);if(!canonical)throw Error('Choose an offered finite conversion policy.');(result[change.table]||=[]).push({...canonical.rule});}
 return result;
}
module.exports={chooseConversions,chooseColumnMappings,candidates,logicalColumn};
