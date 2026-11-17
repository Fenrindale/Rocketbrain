'use strict';
const {normalizeSnapshot}=require('../../src/db/schema-diff');
function fixture({database='one',dialect='mysql',tables}={}){
 const c={name:'id',type:'int',nullable:false,defaultValue:null,key:'PRI',extra:'',ordinal:1,comment:'',charset:null,collation:null,generationExpression:''};
 const t={name:'people',kind:'table',engine:'InnoDB',charset:'utf8mb4',collation:'utf8mb4_bin',comment:'',rowFormat:'Dynamic',createOptions:'',createSql:'CREATE TABLE `people` (`id` int NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB',columns:[c],indexes:[{name:'PRIMARY',unique:true,primaryKey:true,type:'BTREE',comment:'',columns:[{name:'id',ordinal:1,prefixLength:null,collation:'A'}]}],foreignKeys:[],checks:[],partitions:[]};
 return normalizeSnapshot({format:'RocketbrainSchemaSnapshot',formatVersion:1,capturedAt:'2026-11-16',database,server:{dialect,version:dialect==='mysql'?'8.4.13':'11.4.8-MariaDB',serverUniqueId:'owned-server',hostname:'local',port:'3306',serverId:'1',currentUser:'fixture@localhost',database,sqlMode:'STRICT_TRANS_TABLES',tableNameCaseSensitive:true},scope:{kind:'database',tables:[]},coverage:{tables:'loaded',columns:'loaded',indexes:'loaded',foreignKeys:'loaded',checks:'loaded',partitions:'loaded',definitions:'loaded'},tables:tables||[t],warnings:[]},{verifyFingerprint:false});
}
function addColumn(snapshot,name='note',properties={}){snapshot.tables[0].columns.push({...snapshot.tables[0].columns[0],name,type:'varchar(30)',nullable:true,key:'',ordinal:snapshot.tables[0].columns.length+1,charset:'utf8mb4',collation:'utf8mb4_bin',...properties});return normalizeSnapshot(snapshot,{verifyFingerprint:false});}
module.exports={fixture,addColumn};
