'use strict';
const path=require('node:path');
async function main(){
  const args=process.argv.slice(2),options={};for(let index=0;index<args.length;index+=2){if(!['--target','--java-home','--cache-directory'].includes(args[index])||!args[index+1])throw Error('Usage: node scripts/java-test-provision.js --target <absolute> --java-home <independent JDK25> [--cache-directory <absolute>]');options[{'--target':'target','--java-home':'javaHome','--cache-directory':'cacheDirectory'}[args[index]]]=path.resolve(args[index+1]);}
  const result=await require('../src/java/testing').provisionTestingRuntime(options);console.log(JSON.stringify({runtimePath:result.runtimePath,junitVersion:result.junitVersion,testngVersion:result.testngVersion,jacocoVersion:result.jacocoVersion,launcherJar:result.launcherJar,launcherSha256:result.launcherSha256},null,2));
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
