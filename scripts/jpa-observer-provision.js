'use strict';
const path=require('node:path');const {buildObserver,readObserverSources,VERSION}=require('./jpa-observer-build');
async function provisionObserver(options){return buildObserver(options);}
if(require.main===module){const args=process.argv.slice(2),get=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};provisionObserver({target:path.resolve(get('--target')||'test-output/jpa-observer'),javaHome:get('--java-home')}).then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n'),error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});}
module.exports={provisionObserver,buildObserver,readObserverSources,VERSION};
