'use strict';

const path=require('node:path');
const fixture=path.join(__dirname,'../fixtures/java/kotlin-maven-reactor');
const receiver='contract.displayLab';
const partial=text=>text.replace('contract.displayLabel',receiver);
const invalid=text=>text.replace('val number = contract.displayLabel','val number: Int = contract.displayLabel');
const completion=item=>(item?.label?.label||item?.label)==='displayLabel'&&/displayLabel: String/u.test(item.detail||'');
const mismatch=item=>String(typeof item?.code==='object'?item.code.value:item?.code)==='TYPE_MISMATCH'&&
  /String/u.test(item.message)&&/Int/u.test(item.message);
const moduleSource=path.join('contract','src/main/kotlin/editormaven/contract/CatalogContract.kt');

module.exports={fixture,receiver,partial,invalid,completion,mismatch,moduleSource};
