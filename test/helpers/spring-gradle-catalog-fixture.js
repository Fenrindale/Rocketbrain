'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {buildSpec} = require('../../src/java/workbench-tasks');
const {execute} = require('../../src/java/testing/provision');
const {sha} = require('../../src/spring/project-client');
const {temporary} = require('./spring-project-tools-fixture');
const B = require('./spring-maven-bom-fixture');

const catalogName = 'gradle/libs.versions.toml';
const designation = 'rb-gradle-catalog';
const driverAlias = {mysql:'database.mysql',mariadb:'database.mariadb'};
const denied = code=>error=>error.code === 'ROCKETBRAIN_SPRING_PROJECT_'+code;

function inputs(engine) {
  const kotlin = engine === 'mariadb', other = kotlin ? 'mysql' : 'mariadb';
  const selected = B.drivers[engine], protectedDriver = B.drivers[other];
  const versionCatalog = [
    '# Keep project alias spelling, version references and unused bundles.',
    '[versions]',
    'bootRelease = "'+B.boot+'"',
    'pinnedDriver = "'+protectedDriver.version+'"',
    '',
    '[plugins]',
    'spring-boot = { id = "org.springframework.boot", version.ref = "bootRelease" }',
    '',
    '[libraries]',
    'boot-bom = { module = "org.springframework.boot:spring-boot-dependencies", version.ref = "bootRelease" }',
    'ui-web = { module = "org.springframework.boot:spring-boot-starter-webmvc" }',
    'ops-actuator = { module = "org.springframework.boot:spring-boot-starter-actuator" } # Keep this alias.',
    'data-jdbc = { group = "org.springframework.boot", name = "spring-boot-starter-jdbc" }',
    'database-'+engine+' = { module = "'+selected.group+':'+selected.artifact+'" }',
    'database-'+other+' = { module = "'+protectedDriver.group+':'+protectedDriver.artifact+'", version.ref = "pinnedDriver" }',
    '',
    '[bundles]',
    'observability = ["ops-actuator"]',
    ''
  ].join('\n');
  const build = [
    'plugins {',
    kotlin ? '    java' : "    id 'java'",
    '    alias(libs.plugins.spring.boot)',
    '}',
    kotlin ? 'group = "fixture.catalog"' : "group = 'fixture.catalog'",
    kotlin ? 'version = "1.0.0"' : "version = '1.0.0'",
    'repositories { mavenCentral() }',
    'java { sourceCompatibility = JavaVersion.VERSION_25; targetCompatibility = JavaVersion.VERSION_25 }',
    '// Keep this comment and order.',
    'dependencies {',
    '    implementation(platform(libs.boot.bom))',
    '    implementation(libs.ui.web)',
    '    implementation(libs.ops.actuator)',
    '}', ''
  ].join('\n');
  const extension = kotlin ? '.gradle.kts' : '.gradle';
  return {build,versionCatalog,settings:'rootProject.name = "'+designation+'"\n',buildName:'build'+extension,
    settingsName:'settings'+extension,other,selected,protectedDriver};
}

async function runtime() {
  const config = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  const profile = config ? JSON.parse(await fs.readFile(config,'utf8')) : {};
  const javaHome = process.env.ROCKETBRAIN_SPRING_JAVA_HOME || profile.javaHome || profile.settings?.['rocketbrain.java.javaHome'];
  const gradleHome = process.env.ROCKETBRAIN_GRADLE_CATALOG_HOME || process.env.ROCKETBRAIN_GRADLE_HOME ||
    profile.settings?.['rocketbrain.java.gradleHome'];
  const gradleUserHome = process.env.ROCKETBRAIN_GRADLE_CATALOG_USER_HOME || process.env.GRADLE_USER_HOME;
  assert.ok(javaHome && gradleHome && gradleUserHome && [javaHome,gradleHome,gradleUserHome].every(path.isAbsolute),
    'Configure an independent JDK25, Gradle 9.1.0 and a prewarmed Gradle user home.');
  const release = await fs.readFile(path.join(javaHome,'release'),'utf8');
  assert.match(release,/JAVA_VERSION="25\./u);
  assert.doesNotMatch(release,/JetBrains|JBR/iu);
  assert.ok((await fs.stat(path.join(gradleHome,'lib','gradle-launcher-9.1.0.jar'))).isFile());
  const javaTool = name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  return {javaHome,gradleHome,gradleUserHome,java:javaTool('java'),jar:javaTool('jar')};
}

async function buildAndRun(project,inputs,runtime,engine,db) {
  const spec = buildSpec({tool:'gradle',root:project,name:designation,uri:pathToFileURL(project).href},runtime,['bootJar','dependencies']);
  const env = {...spec.env,GRADLE_USER_HOME:runtime.gradleUserHome};
  const result = await execute(spec.command,[...spec.args,'--offline','--configuration','runtimeClasspath'],
    {cwd:project,env,timeoutMs:180000});
  assert.equal(result.code,0,result.output.slice(-4200));
  assert.match(result.output,/BUILD SUCCESSFUL/u);
  const {group,artifact,version} = inputs.selected;
  assert.ok(result.output.includes(group+':'+artifact+' -> '+version),result.output.slice(-4200));
  assert.ok(result.output.includes('org.springframework.boot:spring-boot-starter-jdbc -> '+B.boot));
  assert.ok(result.output.includes('org.springframework.boot:spring-boot-dependencies:'+B.boot));
  assert.ok(!result.output.includes(inputs.protectedDriver.group+':'+inputs.protectedDriver.artifact));
  const file = path.join(project,'build','libs',designation+'-1.0.0.jar');
  const zip = await execute(runtime.jar,['tf',file],{cwd:project,env,timeoutMs:10000});
  assert.equal(zip.code,0,zip.output);
  assert.ok(zip.output.includes('BOOT-INF/lib/'+artifact+'-'+version+'.jar'));
  assert.ok(zip.output.includes('BOOT-INF/lib/spring-boot-jdbc-'+B.boot+'.jar'));
  assert.ok(!zip.output.includes(inputs.protectedDriver.artifact) && !zip.output.includes('spring-boot-actuator'));
  const probe = await B.runProbe(file,runtime,engine,db);
  assert.equal(probe.boot,B.boot);
  assert.match(probe.version,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
  assert.deepEqual({people:probe.people,departments:probe.departments},{people:2,departments:1});
  return {gradle:'9.1.0',boot:probe.boot,version:probe.version,driver:artifact,driverVersion:version,people:probe.people,
    departments:probe.departments,bootJarExecuted:true};
}

async function verify(service,config,{onReview,onSaved,runBuild = true} = {}) {
  const engine = config.dbEngine, model = inputs(engine);
  assert.ok(['mysql','mariadb'].includes(engine));
  const toolchain = runBuild ? await runtime() : undefined;
  const db = runBuild ? await B.readDatabase(config) : undefined;
  await fs.mkdir(B.output,{recursive:true});
  const owned = temporary();
  let metadata;
  try {
    const project = path.join(owned.root,designation), source = path.join(project,'src/main/java/fixture/bom');
    await fs.mkdir(source,{recursive:true});
    await fs.mkdir(path.join(project,'gradle'));
    await fs.copyFile(path.join(B.root,'test/fixtures/spring-maven-bom/BomProbeApplication.java'),path.join(source,'BomProbeApplication.java'));
    const build = path.join(project,model.buildName), settings = path.join(project,model.settingsName), catalog = path.join(project,catalogName);
    await Promise.all([fs.writeFile(build,model.build,{flag:'wx'}),fs.writeFile(catalog,model.versionCatalog,{flag:'wx'}),
      fs.writeFile(settings,model.settings,{flag:'wx'})]);
    metadata = await B.serveCatalog();
    const input = {endpoint:metadata.url,projectUri:pathToFileURL(project).href};
    const request = {...input,add:['jdbc',engine],remove:['actuator']};
    const state = await service.inspectDependencies(input);
    assert.deepEqual(state.sources.map(item=>item.name),[catalogName,model.settingsName]);
    assert.equal(state.bootVersion,B.boot);
    assert.deepEqual(state.management,{kind:'gradle-catalog-bom',coordinate:'org.springframework.boot:spring-boot-dependencies',
      version:B.boot,property:'bootRelease',pluginAlias:'spring-boot',platformAlias:'boot-bom',overrides:[]});
    assert.equal(state.choices.find(item=>item.id==='jdbc').catalogAlias,'data-jdbc');
    assert.equal(state.choices.find(item=>item.id===engine).editable,true);
    assert.equal(state.choices.find(item=>item.id===model.other).editable,false);
    await assert.rejects(service.previewDependencies({...input,add:[model.other]}),denied('DEPENDENCY'));
    for (const [file,before,comment] of [[catalog,model.versionCatalog,'# changed catalog\n'],[settings,model.settings,'// changed settings\n']]) {
      const stale = await service.previewDependencies(request);
      await fs.appendFile(file,comment);
      await assert.rejects(service.apply({reviewId:stale.reviewId,allowWrite:true,allowProjectExecution:true}),denied('STALE'));
      assert.equal(await fs.readFile(build,'utf8'),model.build);
      await fs.writeFile(file,before);
      service.discard(stale.reviewId);
    }

    const review = await service.previewDependencies(request);
    assert.equal(review.before,model.build);
    assert.ok(review.after.includes('implementation(libs.data.jdbc)'));
    assert.ok(review.after.includes('runtimeOnly(libs.'+driverAlias[engine]+')'));
    assert.ok(review.after.includes('implementation(platform(libs.boot.bom))'));
    assert.ok(review.after.includes('implementation(libs.ui.web)'));
    assert.ok(!review.after.includes('implementation(libs.ops.actuator)'));
    assert.ok(review.after.includes('// Keep this comment and order.'));
    assert.equal(await fs.readFile(build,'utf8'),model.build);
    assert.equal(await fs.readFile(catalog,'utf8'),model.versionCatalog);
    assert.equal(review.automaticBuildStartedByTool,false);
    if (onReview) await onReview(review,catalog);
    const applied = await service.apply({reviewId:review.reviewId,allowWrite:true,allowProjectExecution:review.requiresProjectExecutionApproval});
    assert.equal(applied.state,'applied');
    assert.equal(applied.explicitBuildStarted,false);
    if (onSaved) await onSaved(build,review);
    assert.equal(sha(await fs.readFile(build)),review.afterSha256);
    assert.equal(await fs.readFile(catalog,'utf8'),model.versionCatalog);
    assert.equal(await fs.readFile(settings,'utf8'),model.settings);
    await assert.rejects(fs.access(path.join(project,'build')));
    const verified = runBuild ? await buildAndRun(project,model,toolchain,engine,db) : {};
    return {engine,dialect:state.kind,preservedCatalog:true,preservedSettings:true,guardedInputs:review.sources.length,
      protectedVersionReference:true,staleCatalogAndSettingsRefused:true,selectedAliases:['data-jdbc',driverAlias[engine]],
      nativeUndo:applied.nativeUndo,...verified};
  } finally {
    await metadata?.close();
    owned.close();
  }
}

module.exports = {inputs,verify};
