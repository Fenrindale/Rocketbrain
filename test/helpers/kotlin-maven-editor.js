'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('../../src/java/workbench-tasks');

const execute = promisify(execFile);
const fixture = path.join(__dirname,'../fixtures/java/kotlin-maven-editor');
const source = path.join('src/main/kotlin/editormaven/fixture','OrderSummary.kt');
const definition = path.join('src/main/kotlin/editormaven/fixture','Invoice.kt');
const completeText = 'jdbc.queryForObjec';
const partial = text => text.replace('jdbc.queryForObject("SELECT 42"',completeText+'("SELECT 42"');
const invalid = text => text.replace('val amount: Int','val amount: String');
const isTypedCompletion = item => /^queryForObject(?:\(|$)/u.test(item?.label?.label||item?.label) &&
  /String/u.test(item.detail||'') && /requiredType: Class<T>\): T\?/u.test(item.detail||'');
const findMismatch = item => /MISMATCH/u.test(String(typeof item?.code==='object'?item.code?.value:item?.code)) &&
  /String/u.test(item.message) && /Int/u.test(item.message);

async function build(root, {javaHome,mavenHome}) {
  const spec=buildSpec({root,name:'Kotlin Maven editor fixture',tool:'maven',uri:pathToFileURL(root).href},
    {javaHome,mavenHome},['compile','dependency:build-classpath']);
  const versionArgs=spec.args.slice(0,-2);
  const check=await execute(spec.command,[...versionArgs,'--version'],{cwd:root,env:spec.env,windowsHide:true,timeout:15000});
  const mavenVersion=/Apache Maven (\d+\.\d+\.\d+)/u.exec(check.stdout)?.[1];
  assert.equal(mavenVersion,'3.9.11');
  const built=await execute(spec.command,[...spec.args,'-Dmdep.outputFile=target/runtime-classpath.txt'],
    {cwd:root,env:spec.env,windowsHide:true,timeout:140000,maxBuffer:3*1024*1024});
  assert.match(built.stdout,/kotlin:2\.2\.21:compile/u);
  assert.match(built.stdout,/BUILD SUCCESS/u);
  for (const name of ['OrderSummaryKt','Invoice']) assert.ok((await fs.stat(path.join(root,'target/classes/editormaven/fixture',name+'.class'))).size>200);
  return {...spec,mavenVersion};
}

async function jdbc(root, spec, engine, configFile) {
  const classpath=(await fs.readFile(path.join(root,'target/runtime-classpath.txt'),'utf8')).trim();
  assert.match(classpath,/spring-jdbc-7\.0\.10\.jar/u);
  assert.match(classpath,/mysql-connector-j-9\.7\.0\.jar/u);
  assert.match(classpath,/mariadb-java-client-3\.5\.10\.jar/u);
  const config=JSON.parse(await fs.readFile(configFile,'utf8'));
  assert.ok(['mysql','mariadb'].includes(engine));
  assert.equal(config.host,'127.0.0.1');
  assert.ok(Number.isInteger(config.port)&&config.port>0&&config.port<65536);
  assert.match(config.database,/^[a-z_]+$/u);
  const url='jdbc:'+engine+'://127.0.0.1:'+config.port+'/'+config.database+
    (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  const result=await execute(spec.command,['-cp',path.join(root,'target/classes')+path.delimiter+classpath,
    'editormaven.fixture.OrderSummaryKt'],{cwd:root,env:{...spec.env,RB_KOTLIN_MAVEN_JDBC_URL:url,
      RB_KOTLIN_MAVEN_JDBC_USER:config.user,RB_KOTLIN_MAVEN_JDBC_PASSWORD:config.password},windowsHide:true,timeout:20000,maxBuffer:1024*1024});
  const row=/Rocketbrain Kotlin Maven JDBC\|([^|\r\n]+)\|([^|\r\n]+)/u.exec(result.stdout);
  assert.ok(row,'The compiled Kotlin Spring context did not report a JDBC result.');
  assert.match(row[1],engine==='mysql'?/^8\.4\.13$/u:/^11\.4\.8.*MariaDB/u);
  assert.equal(row[2],'invoice/42');
  return {engine,server:row[1],result:row[2]};
}

module.exports = {fixture,source,definition,completeText,partial,invalid,isTypedCompletion,findMismatch,build,jdbc};
