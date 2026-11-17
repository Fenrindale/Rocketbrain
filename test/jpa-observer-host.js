'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
async function runObserverChecks(api,vscode,checks){
  const config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG,'utf8'));
  assert.ok(config.observerUrl);assert.equal(api.jpa.observer.snapshot().state,'disconnected');
  const preparation=await vscode.commands.executeCommand('rocketbrain.jpa.observer.prepare');
  assert.equal(preparation.requiresJava,25);assert.equal(preparation.queryCaptureEnabled,false);assert.ok(fs.existsSync(preparation.jar));assert.match(preparation.jvmArguments[0],/=config=file:/);
  const crypto=require('node:crypto');assert.equal(crypto.createHash('sha256').update(fs.readFileSync(preparation.jar)).digest('hex'),preparation.sha256);
  checks.push('The packaged observer preparation command builds its embedded independent Java source with JDK25 and creates a private, explicitly enabled agent configuration.');
  const response=await fetch(config.baseUrl+'/probe/provider');assert.equal(response.status,200);const probe=await response.json();assert.deepEqual(probe.opaqueValues,['ALEX','MINA']);
  const token=fs.readFileSync(config.observerTokenFile,'utf8').trim();
  try{
    let observed=await api.jpa.observer.connect({url:config.observerUrl,token});assert.ok(observed.factories.length);assert.equal(observed.sameSourceRevisionVerified,false);
    const factory=observed.factories.find(f=>f.entities?.some(e=>e.javaType==='fixture.boot.Person'));assert.ok(factory,JSON.stringify(observed.factories).slice(0,600));assert.ok(factory.functions.some(f=>f.name==='rb_upper'));
    const roots=await api.analysis.snapshot();assert.ok(roots.entities>=15);
    checks.push('Native provider observation reads actual Hibernate entity mappings and the registered custom function without requiring the original IDE or other extensions.');
    const valid=await api.jpa.observer.validate(probe.opaqueQuery,factory.id);assert.equal(valid.state,'known',JSON.stringify(valid));assert.equal(valid.selectionTypes[0].javaType,'java.lang.String');assert.equal(valid.sqlExecuted,false);
    const cte=await api.jpa.observer.validate(probe.cteQuery,factory.id);assert.equal(cte.state,'known',JSON.stringify(cte));
    const invalid=await api.jpa.observer.validate('select rb_upper(p.id) from Person p',factory.id);assert.equal(invalid.state,'invalid',JSON.stringify(invalid));
    const comparison=await api.jpa.observer.compareSource();assert.equal(comparison.sameSourceRevisionVerified,false);assert.ok(comparison.entities.some(e=>e.fqn==='fixture.boot.Person'&&e.observations.length));
    checks.push('The native provider command compiles opaque dynamic/custom-function and CTE queries, rejects the wrong argument type, and keeps runtime results separate from source evidence.');
    observed=await api.jpa.observer.refresh();assert.ok(observed.events.some(e=>e.query===probe.opaqueQuery&&e.origin==='application'));assert.ok(observed.events.some(e=>e.origin==='explicit-semantic-validation'));
    checks.push('Bounded runtime events include the actually observed arbitrary SpEL-generated query while omitting bound parameter values.');
  }finally{api.jpa.observer.disconnect();assert.equal(api.jpa.observer.snapshot().state,'disconnected');}
}
module.exports={runObserverChecks};
