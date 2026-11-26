'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { COMMANDS } = require('../src/java/micronaut-vscode');
const { micronautMavenProject } = require('../src/java/micronaut-model');
const { createMicronautNative, buildFlags, goals } = require('../src/java/micronaut-native');
const manifest = require('../package.json');

test('Micronaut Native Image targets the saved Maven artifact ID and projects only fixed packaging flags', () => {
  const root=path.join(__dirname,'fixtures/java/micronaut-native-linux');
  const project={tool:'maven',root,uri:pathToFileURL(root).href};
  assert.equal(micronautMavenProject(project).jarName,'micronaut-native-linux-1.0.0.jar');
  const selected=micronautMavenProject(project,{native:true});
  assert.equal(selected.imageName,'micronaut-native-linux');
  assert.equal(selected.platformVersion,'5.2.8');
  assert.throws(()=>micronautMavenProject({...project,tool:'gradle'},{native:true}),/Maven Micronaut application/u);
  assert.deepEqual(goals,['package','org.graalvm.buildtools:native-maven-plugin:compile-no-fork']);
  assert.deepEqual(buildFlags('/local workspace/target/native-a'),['--non-recursive','-DskipTests',
    '-DoutputDir=/local workspace/target/native-a','-DnativeDryRun=false','-DsharedLibrary=false']);
  for (const name of [COMMANDS.buildNative,COMMANDS.runNative]) {
    assert.equal(manifest.contributes.commands.find(command=>command.command===name).enablement,'isWorkspaceTrusted');
  }
});

test('Micronaut rejects unsupported environment and host before executing project code',{skip:process.platform==='linux'}, async () => {
  const service=createMicronautNative();
  try {
    await assert.rejects(service.start({environment:'dev,other'}),/literal Micronaut environment/u);
    await assert.rejects(service.build({}),/Linux x64 or arm64 extension host/u);
    assert.equal(service.getState(),undefined);
    assert.deepEqual(await service.stop(),{state:'stopped'});
  } finally { await service.dispose(); }
});
