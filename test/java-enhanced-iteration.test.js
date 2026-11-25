'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');
const { analyzeJavaSources } = require('../src/java/signature-compiler');
const { conversionAt,indexedElementAction,reviewConversionEdit,verifyConversion } = require('../src/java/java-conversion');
const { runJavaFixture,springJdbcClasspath } = require('./helpers/instance-inline-fixture');
const { output,arrayLoop,referenceLoop,copiedListLoop,literalListLoop,negativeLoops,enhancedIterationSource } =
  require('./helpers/java-enhanced-iteration-fixture');

const javaRuntime = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const springClasspath = process.env.ROCKETBRAIN_ENHANCED_ITERATION_CLASSPATH;
const configPaths = {
  mysql:process.env.ROCKETBRAIN_ENHANCED_ITERATION_MYSQL_CONFIG,
  mariadb:process.env.ROCKETBRAIN_ENHANCED_ITERATION_MARIADB_CONFIG
};

async function prove(t,{engine,config} = {}) {
  const {javaHome} = JSON.parse(await fs.readFile(javaRuntime,'utf8'));
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()),'rb-enhanced-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  const className = 'EnhancedIteration';
  const file = path.join(root,className+'.java');
  const uri = pathToFileURL(file).href;
  const classpath = engine ? await springJdbcClasspath(springClasspath,engine) : [];
  const original = enhancedIterationSource('fixture',className,{spring:!!engine});
  const inspect = async text => {
    const report = await analyzeJavaSources({javaHome,storagePath:path.join(root,'inspect'),sources:[{uri,text}],classpath,
      inspection:{kind:'conversion',uri}});
    assert.deepEqual(report.errors,[]);
    return report.conversions;
  };
  let text = original;
  let sites = await inspect(text);
  for (const loop of negativeLoops) {
    const offset = text.indexOf(loop);
    assert.ok(offset > 0,loop);
    assert.throws(() => conversionAt(sites,offset),/supported indexed array or immutable List/,loop);
  }

  const conversions = [];
  for (const [loop,header,kind] of [
    [arrayLoop,'for (final var value : values) {','array'],
    [referenceLoop,'for (final CharSequence code : codes) {','array'],
    [copiedListLoop,'for (final String label : entries) {','immutable-list'],
    [literalListLoop,'for (var letter : letters) {','immutable-list']
  ]) {
    const site = conversionAt(sites,text.indexOf(loop));
    assert.equal(site.kind,'indexed-elements');
    const review = action => reviewConversionEdit(action,{text,site,version:1,belongsToSource:value => value === uri});
    const action = indexedElementAction(site,text,uri);
    const rejected = structuredClone(action);
    rejected.edit.changes[uri][0].newText += ' ';
    assert.throws(() => review(rejected),/exact selected syntax/);
    const verified = review(action);
    assert.ok(verified.text.includes(header));
    sites = await inspect(verified.text);
    const length = verified.replacement.newText.length;
    const conversion = verifyConversion(site,sites,length);
    assert.equal(conversion.iteration,kind);
    assert.throws(() => verifyConversion(site,sites.map(next => ({...next,retainedBody:'{}'})),length),/checked Java behavior/);
    conversions.push(conversion);
    text = verified.text;
  }
  for (const evidence of ['traverse: for','// Keep this comment and all control flow.','// Preserve this trailing comment.',
    'values[2] = 7','continue traverse','break traverse','result.append(render(label));']) {
    assert.ok(text.includes(evidence),evidence);
  }

  const execute = async source => {
    await fs.writeFile(file,source);
    const binaryDirectory = await fs.mkdtemp(path.join(root,'classes-'));
    return runJavaFixture({javaHome,file,binaryDirectory,className:'fixture.'+className,classpath,engine,config,jdbcPrefix:'RB_ENHANCED'});
  };
  const before = await execute(original), after = await execute(text);
  assert.equal(before.output,output);
  assert.deepEqual(after,before);
  return {engine,server:after.server,conversions,before:before.output,after:after.output,refused:negativeLoops.length};
}

test('javac converts stable array and immutable-list loops and preserves actual control flow', {
  skip:!javaRuntime && 'Set ROCKETBRAIN_JAVA_TEST_CONFIG for real Javac.',timeout:120000
},async t => { await prove(t); });

test('both Spring JDBC fixtures execute all reviewed enhanced iteration conversions', {
  skip:!(javaRuntime && springClasspath && configPaths.mysql && configPaths.mariadb) && 'Configure both independent Spring JDBC fixtures.',
  timeout:220000
},async t => {
  const results = [];
  for (const [engine,file] of Object.entries(configPaths)) {
    const config = JSON.parse(await fs.readFile(file,'utf8'));
    results.push(await prove(t,{engine,config}));
  }
  const receipt = process.env.ROCKETBRAIN_ENHANCED_ITERATION_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({jdk:'Temurin 25.0.5+8',spring:'7.0.10',results},null,2)+'\n');
});
