'use strict';

const { parseArgs }=require('node:util');
const { analyzeQuality,readQualityProfile,writeQualitySarif,encodeQualitySarif }=require('../src/java/quality-gate');

const usage=`Usage: node java-quality-gate.js [--repo DIRECTORY] [--revision SHA_OR_REF]
  [--profile PROFILE.json] [--baseline BASELINE.sarif | --baseline-revision SHA_OR_REF]
  [--fail-on warning|error|information|hint|never] [--output NEW_FILE.sarif|-]

Reads committed Java source in a local Git worktree and writes SARIF 2.1.0.
Exit codes: 0 passed, 1 new findings at threshold, 2 scan or input failed.`;
const optionKeys=['repo','revision','profile','baseline','baseline-revision','fail-on','output'];

async function main() {
  const options=Object.fromEntries(optionKeys.map(name=>[name,{type:'string'}]));
  options.help={type:'boolean',short:'h'};
  const {values}=parseArgs({options,strict:true,allowPositionals:false});
  if (values.help) { console.log(usage); return; }
  const profile=values.profile?await readQualityProfile(values.profile):undefined;
  const {summary,sarif}=await analyzeQuality({directory:values.repo ?? process.cwd(),ref:values.revision,
    profile,baselinePath:values.baseline,baselineRef:values['baseline-revision'],failOn:values['fail-on']});
  if (values.output && values.output!=='-') await writeQualitySarif(values.output,sarif);
  else process.stdout.write(encodeQualitySarif(sarif));
  console.error('Rocketbrain Java '+summary.revision+': '+summary.files+' files, '+summary.new+' new, '+
    summary.unchanged+' unchanged, '+summary.fixed+' fixed, '+summary.blocking+' blocking at '+summary.failOn+'.');
  process.exitCode=summary.blocking?1:0;
}

main().catch(error=>{console.error('Rocketbrain Java quality gate: '+error.message);process.exitCode=2;});
