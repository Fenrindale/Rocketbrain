'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execute} = require('../../src/java/testing/provision');

const archives = {
  base:'67fb8b827c0baf9ad14a2436a041498eed26134b35f1b019c300fc46014c3892',
  controls:'33d9640f1db1ef8792b5fc270f08153411465d18ad49819d88543dff958675a8',
  fxml:'0a06affc0e71bcd265552e40da33e62bf842c44ce61af952d3b6a9342b1c7630',
  graphics:'bdbca2dd440b5f0151172597a5de8ada83a1375dce249ca600ecfc380eee2ba7'
};
const custom = `package owned.controls;
import javafx.scene.control.Label;
public final class RocketLabel extends Label {
  static { if (!Boolean.getBoolean("rb.fxml.fixture.approved")) throw new IllegalStateException("Fixture execution was not requested."); }
  private String caption;
  public String getCaption() { return caption; }
  public void setCaption(String value) { caption = value; }
  public void setWriteOnly(String value) { caption = value; }
}`;
const fxImported = '<?import javafx.scene.control.*?>\n';
const customImported = '<?import owned.controls.RocketLabel?>\n';
const variants = [
  ['opened-import','<?import owned.controls.Roc| ?>','owned.controls.RocketLabel'],
  ['builtin-tag',fxImported+'<La|bel/>','Label'],
  ['custom-tag',customImported+'<Rock|etLabel/>','RocketLabel'],
  ['qualified-tag','<owned.controls.Rock|etLabel/>','owned.controls.RocketLabel'],
  ['custom-property',customImported+'<RocketLabel cap|tion/>','caption'],
  ['inherited-property',customImported+'<RocketLabel te|xt="" />','text'],
  ['boolean-value',customImported+'<RocketLabel wrapText="t|r"/>','true'],
  ['duplicate-property',customImported+'<RocketLabel cap| caption="present"/>'],
  ['write-only',customImported+'<RocketLabel write|/>'],
  ['comment',fxImported+'<!-- <Lab| -->'],
  ['value-expression',fxImported+'<Label wrapText="${t|}"/>'],
  ['illegal-child',fxImported+'<Label><But|></Label>'],
  ['child','<?import javafx.scene.layout.*?>\n'+fxImported+'<VBox><children><But|/></children></VBox>','Button']
];

async function createFixture(root, libraryRoot) {
  const pkg = path.join(root,'src/main/java/owned/controls'), resources = path.join(root,'src/main/resources');
  const library = path.join(root,'libs');
  await Promise.all([pkg,resources,library].map(directory=>fs.mkdir(directory,{recursive:true})));
  const jars=[];
  for (const [name,sha] of Object.entries(archives)) {
    const filename='javafx-'+name+'-26.0.2-win.jar';
    const bytes=await fs.readFile(path.join(libraryRoot,filename));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),sha);
    const file=path.join(library,filename);
    await fs.writeFile(file,bytes,{flag:'wx'});
    jars.push(file);
  }
  const source=path.join(pkg,'RocketLabel.java');
  await fs.writeFile(source,custom,{flag:'wx'});
  await fs.writeFile(path.join(root,'settings.gradle'),"rootProject.name = '"+path.basename(root)+"'\n",{flag:'wx'});
  await fs.writeFile(path.join(root,'build.gradle'),
    "plugins { id 'java' ; id 'eclipse' }\ndependencies { implementation fileTree('libs') { include '*.jar' } }\n",
    {flag:'wx'});
  const files = new Map();
  for (const [key,value,expected] of variants) {
    const offset=value.indexOf('|'),text=value.replace('|',''), file=path.join(resources,key+'.fxml');
    await fs.writeFile(file,text,{flag:'wx'});
    files.set(key,{file,text,offset,expected});
  }
  return {root,jars,resources,files,source};
}

async function buildFixture(fixture, {javaHome,gradleHome,gradleCache}) {
  const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
  const engines=(await fs.readdir(path.join(gradleHome,'lib'))).filter(file=>/^gradle-launcher-.*\.jar$/u.test(file));
  assert.equal(engines.length,1);
  const run=await execute(java,['-Dorg.gradle.java.home='+javaHome,'-cp',path.join(gradleHome,'lib',engines[0]),
    'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--offline','--max-workers=2',
    '--gradle-user-home',gradleCache,'classes','eclipse'],
  {cwd:fixture.root,timeoutMs:100000,env:{...process.env,JAVA_HOME:javaHome}});
  assert.equal(run.code,0,run.output);
  const compiled=path.join(fixture.root,'build/classes/java/main');
  assert.ok((await fs.stat(path.join(compiled,'owned/controls/RocketLabel.class'))).isFile());
  return compiled;
}

async function exerciseCompletion(fixture, complete) {
  let builtinTag, caption;
  for (const [key,item] of fixture.files) {
    const options=await complete(item,key);
    if (!item.expected) {
      assert.deepEqual(options,[],key);
      continue;
    }
    const selected=options.find(entry=>entry.name===item.expected);
    assert.ok(selected, `Missing ${item.expected} at ${key}. Received ${JSON.stringify(options.map(option=>option.name))}`);
    assert.ok(selected.start<=item.offset&&item.offset<=selected.end);
    if (key==='opened-import') assert.equal(item.text.slice(selected.start,selected.end),'owned.controls.Roc');
    if (key==='builtin-tag') {
      assert.equal(item.text.slice(selected.start,selected.end),'Label');
      builtinTag=item.text.slice(0,selected.start)+selected.text+item.text.slice(selected.end);
    }
    if (key==='custom-property') {
      assert.equal(item.text.slice(selected.start,selected.end),'caption');
      assert.equal(selected.text,'caption="${1}"');
      caption=item.text.slice(0,selected.start)+selected.text.replace('${1}','Observed FXML')+item.text.slice(selected.end);
    }
    if (key==='inherited-property') assert.equal(selected.text,'text');
  }
  return {builtinTag,caption};
}

async function runtimeLoad(hydrated, fixture, compiled, javaHome) {
  const file=path.join(fixture.root,'VerifyFxml.java'), builtin=path.join(fixture.resources,'completed-builtin.fxml');
  const caption=path.join(fixture.resources,'completed-project.fxml');
  await fs.writeFile(builtin,hydrated.builtinTag,{flag:'wx'});
  await fs.writeFile(caption,hydrated.caption,{flag:'wx'});
  await fs.writeFile(file,`import javafx.application.Platform;
import javafx.fxml.FXMLLoader;
import javafx.scene.control.Label;
import owned.controls.RocketLabel;
import java.nio.file.Path;
public class VerifyFxml {
  public static void main(String[] paths) throws Exception {
    Platform.startup(() -> {});
    try {
      var label = new FXMLLoader(Path.of(paths[0]).toUri().toURL()).load();
      var rocket = new FXMLLoader(Path.of(paths[1]).toUri().toURL()).load();
      if (label.getClass() != Label.class || rocket.getClass() != RocketLabel.class ||
        !((RocketLabel) rocket).getCaption().equals("Observed FXML")) throw new AssertionError("Unexpected FXML load");
      System.out.println("FXML_COMPLETION_OK " + System.getProperty("javafx.runtime.version"));
    } finally { Platform.exit(); }
  }
}`,{flag:'wx'});
  const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
  const report=await execute(java,['-Dglass.platform=headless','-Dprism.order=sw','-Djava.awt.headless=true',
    '-Drb.fxml.fixture.approved=true','--enable-native-access=ALL-UNNAMED',
    '-cp',[compiled,...fixture.jars].join(path.delimiter),file,builtin,caption],{cwd:fixture.root,timeoutMs:25000});
  assert.equal(report.code,0,report.output);
  assert.match(report.output,/^FXML_COMPLETION_OK 26\.0\.2\+3$/mu);
}

module.exports = { createFixture, buildFixture, exerciseCompletion, runtimeLoad };
