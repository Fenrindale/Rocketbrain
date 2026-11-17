'use strict';
const fs=require('node:fs'),path=require('node:path');
async function main(){
  const args=process.argv.slice(2),mode=args.shift();if(!['discover','run','coverage','coverage-by-test'].includes(mode))throw Error('Use discover, run, coverage or coverage-by-test.');let config,framework;const selectors=[];
  for(let index=0;index<args.length;index+=2){const flag=args[index],value=args[index+1];if(!value)throw Error('Missing value for '+flag);if(flag==='--config')config=JSON.parse(fs.readFileSync(path.resolve(value),'utf8').replace(/^\uFEFF/,''));else if(flag==='--framework')framework=value;else if(['--class','--method','--package','--unique-id'].includes(flag))selectors.push({kind:{'--class':'class','--method':'method','--package':'package','--unique-id':'uniqueId'}[flag],value});else throw Error('Unsupported option '+flag);}
  if(!config)throw Error('Use --config <project JSON>.');if(framework)config.framework=framework;const backend=require('../src/java/testing');const result=await (mode==='discover'?backend.discoverTests:backend.runTests)(config,{selectors,coverage:mode==='coverage',perTestCoverage:mode==='coverage-by-test',onOutput:text=>process.stderr.write(text)});console.log(JSON.stringify(result,null,2));if(result.state!=='completed')process.exitCode=2;else if(result.summary.testsFailed||result.summary.containersFailed)process.exitCode=1;
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=2;});
module.exports={main};
