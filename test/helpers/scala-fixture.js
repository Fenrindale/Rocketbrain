'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');

const fixture=path.join(__dirname,'../fixtures/java/scala-sbt');
const scala2='2.13.18';
const scala3='3.9.0';

async function populateScala(root,version) {
  await fs.cp(fixture,root,{recursive:true});
  if (version===scala3) return;
  const build=path.join(root,'build.sbt');
  const descriptor=await fs.readFile(build,'utf8');
  await fs.writeFile(build,descriptor.replace(scala3,scala2)
    .replace('ThisBuild / semanticdbEnabled := true','ThisBuild / semanticdbEnabled := true\nThisBuild / semanticdbVersion := "4.17.4"'));
  for (const relative of ['core/src/main/scala/scalafixture/Message.scala','app/src/main/scala/scalafixture/Application.scala']) {
    const file=path.join(root,relative), source=await fs.readFile(file,'utf8');
    await fs.writeFile(file,source.trimEnd().replace(/^(object [A-Za-z]+):$/m,'$1 {')+'\n}\n');
  }
  await fs.writeFile(path.join(root,'app/src/test/scala/scalafixture/ApplicationSuite.scala'),[
    'package scalafixture','',
    'class ApplicationSuite extends munit.FunSuite {',
    '  test("calls cross-module Scala and Java declarations") {',
    '    assertEquals(Application.greeting, "Scala greets Rocketbrain")',
    '  }',
    '  test("selects the Int overload") {',
    '    assertEquals(Application.count, "Scala counted 3")',
    '  }',
    '}',''
  ].join('\n'));
}

module.exports={populateScala,scala2,scala3};
