'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const base = path.resolve(__dirname,'../fixtures/java/mixed-jvm');
const JAVAS = 'src/main/java/mixed/fixture';
const KOTLINS = 'src/main/kotlin/mixed/fixture';
const EXPECTED = [
  {source:'JavaApplication.java',marker:'transform(number)',advance:1,target:'KotlinGateway.kt',anchor:'transform',
    member:'transform',descriptor:'(I)Ljava/lang/String;',kind:'call'},
  {source:'JavaApplication.java',marker:'getName()',advance:1,target:'KotlinGateway.kt',anchor:'name',
    member:'getName',descriptor:'()Ljava/lang/String;',kind:'call'},
  {source:'KotlinGateway.kt',marker:'render(number',advance:1,target:'JavaHelper.java',anchor:'render',
    member:'render',descriptor:'(I)Ljava/lang/String;',kind:'call'},
  {source:'KotlinGateway.kt',marker:'render(value)',advance:1,target:'JavaHelper.java',anchor:'render',
    member:'render',descriptor:'(Ljava/lang/String;)Ljava/lang/String;',kind:'call'},
  {source:'KotlinGateway.kt',marker:'this.count',advance:6,target:'JavaHelper.java',anchor:'getCount',
    member:'getCount',descriptor:'()I',kind:'property'},
  {source:'KotlinGateway.kt',marker:'JavaHelper()',advance:1,target:'JavaHelper.java',anchor:'JavaHelper',kind:'supertype'}
];

async function copyMixedProject(root,tool) {
  if (!['gradle','maven'].includes(tool)) throw Error('Select the owned Gradle or Maven fixture.');
  await fs.mkdir(root,{recursive:true});
  await fs.cp(path.join(base,'src'),path.join(root,'src'),{recursive:true});
  for (const file of tool === 'gradle' ? ['build.gradle','settings.gradle','gradle.properties'] : ['pom.xml']) {
    await fs.copyFile(path.join(base,file),path.join(root,file));
  }
  return root;
}

function mixedFile(root,name) {
  if (!EXPECTED.some(item => item.source === name || item.target === name)) throw Error('Choose an owned fixture source.');
  return path.join(root,name.endsWith('.kt') ? KOTLINS : JAVAS,name);
}

module.exports = { copyMixedProject,mixedFile,EXPECTED };
