'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {test}=require('node:test');
const {zip,temporary}=require('./helpers/spring-project-tools-fixture');
const {inspectWar,inspectWildFlyRuntime,createWildFlyDeployment}=require('../src/java/jakarta-wildfly');

test('WildFly accepts ordinary WAR entries and refuses an overridden or ambiguous context',async ()=>{
  await fs.mkdir(path.join(__dirname,'../test-output'),{recursive:true});
  const temp=temporary();
  try {
    const ordinary=path.join(temp.root,'ordinary.war');
    await fs.writeFile(ordinary,zip([{name:'WEB-INF/web.xml',data:'<web-app/>'}]));
    await inspectWar(ordinary);
    for (const entries of [
      [{name:'WEB-INF/JBOSS-WEB.XML',data:'<jboss-web/>'}],
      [{name:'WEB-INF/web.xml'},{name:'web-inf/WEB.XML'}],
      [{name:'WEB-INF/placeholder',mode:0o120777}],
      [{name:'WEB-INF/content',flags:1}]
    ]) {
      await fs.writeFile(ordinary,zip(entries));
      await assert.rejects(inspectWar(ordinary),/unsafe ZIP entries or a WildFly context override/u);
    }
  } finally {temp.close();}
});

test('WildFly validates approval and reviewed runtime before starting a server',async ()=>{
  const service=createWildFlyDeployment();
  try {
    await assert.rejects(inspectWildFlyRuntime('relative-distribution'),/extracted stock WildFly 42/u);
    await assert.rejects(service.deploy({workspaceTrusted:true}),/Approve the local/u);
    await assert.rejects(service.deploy({workspaceTrusted:true,allowDeploy:true,context:'../outside'}),
      /Review a physical Maven WAR/u);
    assert.deepEqual(await service.stop(),{state:'stopped'});
  } finally {await service.dispose();}
});
