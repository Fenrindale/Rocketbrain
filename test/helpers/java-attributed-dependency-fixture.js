'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {buildSpec}=require('../../src/java/workbench-tasks');
const {execute}=require('../../src/java/testing/provision');
const {buildDescriptors,fileKey}=require('../../src/java/dependency-builds');
const {springJdbcClasspath}=require('./instance-inline-fixture');

const tool=(javaHome,name)=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));

function ownedWorkspace(root) {
  const descriptors=[],files=[];
  return {descriptors,files,async write(relative,text,{project,build=false}={}){
    const file=path.join(root,...relative.split('/'));
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,text,{flag:'wx'});
    const row={path:file,uri:pathToFileURL(file).href,text};
    if(build)descriptors.push(row);
    else files.push({...row,projectId:fileKey(path.join(root,project)),projectLabel:project,sourceSet:'main'});
    return row;
  }};
}

async function cyclicMaven(root) {
  const fixture=ownedWorkspace(root);
  const namespace=' xmlns="http://maven.apache.org/POM/4.0.0"';
  const gav=name=>'<groupId>owned.deps</groupId><artifactId>'+name+'</artifactId><version>1</version>';
  const model=(name,body)=>'<project'+namespace+'><modelVersion>4.0.0</modelVersion>'+gav(name)+'\n'+body+'\n</project>\n';
  await fixture.write('pom.xml',model('reactor','<packaging>pom</packaging><modules><module>left</module><module>right</module><module>idle</module></modules>'),{build:true});
  for(const [name,target] of [['left','right'],['right','left'],['idle','left']]) {
    await fixture.write(name+'/pom.xml',model(name,'<dependencies><dependency>'+gav(target)+'</dependency></dependencies>'),{build:true});
  }
  const left=await fixture.write('left/src/main/java/rb/left/Left.java',[
    'package rb.left;',
    'public final class Left {',
    '   public static int value() { return rb.right.Right.pick(41); }',
    '   public static java.util.function.IntUnaryOperator op() { return rb.right.Right::pick; }',
    '   public static rb.right.Right construct() { return new rb.right.Right(); }',
    '   public static int field() { return rb.right.Right.VALUE; }',
    '   public static java.util.List<rb.right.Right.Marker> marker;',
    '   public static void main(String[] args) { System.out.print(value()); }',
    '}',''
  ].join('\n'),{project:'left'});
  const right=await fixture.write('right/src/main/java/rb/right/Right.java',[
    'package rb.right;',
    'public final class Right {',
    '   public static int VALUE = 42;',
    '   public static int pick(int value) { return value + 1; }',
    '   public static String pick(String value) { return value; }',
    '   public static Class<?> peer() { return rb.left.Left.class; }',
    '   public static final class Marker {}',
    '}',''
  ].join('\n'),{project:'right'});
  await fixture.write('idle/src/main/java/rb/idle/Idle.java','package rb.idle; import rb.left.Left; public class Idle {}\n',{project:'idle'});
  return {...fixture,left,right,root};
}

async function gradleSpring(root,classpath) {
  const fixture=ownedWorkspace(root);
  const libraries=classpath.map(file=>JSON.stringify(file.replaceAll('\\','/'))).join(', ');
  await fixture.write('settings.gradle',"rootProject.name = 'owned-dependency-graph'\ninclude('app', 'kernel')\n",{build:true});
  await fixture.write('build.gradle','',{build:true});
  await fixture.write('kernel/build.gradle',"plugins { id 'java-library' }\n",{build:true});
  await fixture.write('app/build.gradle',[
    "plugins { id 'java' }",
    "dependencies {",
    "    implementation project(':kernel')",
    "    implementation files("+libraries+")",
    "}",
    "tasks.register('observedCompileClasspath') {",
    "    doLast { tasks.compileJava.classpath.files.each { println 'RB_DEP_CP|' + it.absolutePath } }",
    "}",''
  ].join('\n'),{build:true});
  await fixture.write('kernel/src/main/java/rb/kernel/Adjuster.java','package rb.kernel; public final class Adjuster { public static int apply(int value) { return value * 2; } }\n',{project:'kernel'});
  await fixture.write('app/src/main/java/rb/app/Probe.java',[
    'package rb.app;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class Probe {',
    '    public static void main(String[] args) {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_DEP_JDBC_URL"),',
    '            System.getenv("RB_DEP_JDBC_USER"), System.getenv("RB_DEP_JDBC_PASSWORD")));',
    '        int number = jdbc.queryForObject("SELECT 21", Integer.class);',
    '        var compute = (java.util.function.IntUnaryOperator) rb.kernel.Adjuster::apply;',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + compute.applyAsInt(number));',
    '    }',
    '}',''
  ].join('\n'),{project:'app'});
  return {...fixture,root,output:role=>path.join(root,role,'build','classes','java','main')};
}

function buildRecords(fixture) {
  const build=buildDescriptors(fixture.descriptors);
  return {projects:build.descriptors.map(row=>({...row,id:row.root,label:path.basename(row.root)})),
    buildEdges:build.links.map(({fromRoot:from,toRoot:to,...evidence})=>({from,to,evidence})),issues:build.issues};
}

async function task(fixture,tools,kind,phases) {
  const spec=buildSpec({root:fixture.root,name:kind,uri:pathToFileURL(fixture.root).href,tool:kind},tools,phases);
  const env={...spec.env};
  if(kind==='gradle')env.GRADLE_USER_HOME=path.join(fixture.root,'owned-gradle-cache');
  return execute(spec.command,[...spec.args,'--offline'],{cwd:fixture.root,env,timeoutMs:120000});
}

module.exports={tool,cyclicMaven,gradleSpring,buildRecords,task,springJdbcClasspath};
