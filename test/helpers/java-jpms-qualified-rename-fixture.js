'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execute} = require('../../src/java/testing/provision');
const {packageClasspath} = require('./java-package-rename-fixture');

const provider = 'fixture.provider', consumer = 'fixture.consumer', outsider = 'fixture.outsider';
const oldPackage = provider + '.ledger', newPackage = provider + '.settlement';
const main = path.join('src','main','java'), output = path.join('bin','main');
const parent = path.join('producer',main,'fixture','provider');
const sourceFolder = path.join(parent,'ledger'), targetFolder = path.join(parent,'settlement');
const owner = path.join(sourceFolder,'Ledger.java'), independent = path.join(parent,'ledgers','Separate.java');
const providerDescriptor = path.join('producer',main,'module-info.java');
const consumerDescriptor = path.join('consumer',main,'module-info.java');
const caller = path.join('consumer',main,'fixture','consumer','Probe.java');
const projects = [['producer',provider],['consumer',consumer]];

const sources = new Map([
  [providerDescriptor, [
    'module '+provider+' {',
    '    exports '+oldPackage+' to '+consumer+'; // qualified provider API',
    '    opens '+oldPackage+' to '+consumer+'; // qualified reflection',
    '    exports '+provider+'.ledgers;',
    '}',''
  ].join('\n')],
  [owner, [
    'package '+oldPackage+';',
    'public final class Ledger {',
    '    private final int amount = 19;',
    '    public int read() { return amount; }',
    '}',''
  ].join('\n')],
  [independent,'package '+provider+'.ledgers; public final class Separate {}\n'],
  [consumerDescriptor,'module '+consumer+' { requires '+provider+'; exports '+consumer+'; }\n'],
  [caller, [
    'package '+consumer+';',
    'import '+oldPackage+'.Ledger;',
    'public final class Probe {',
    '    public static Class<?> providerType() { return Ledger.class; }',
    '    public static String read() throws Exception {',
    '        var ledger = new Ledger();',
    '        var amount = Ledger.class.getDeclaredField("amount");',
    '        amount.setAccessible(true);',
    '        return ledger.read() + ":" + amount.getInt(ledger);',
    '    }',
    '    public static void main(String[] args) throws Exception { System.out.println(read()); }',
    '}',''
  ].join('\n')]
]);

async function populate(root,{projectPrefix=''}={}) {
  for (const [folder] of projects) {
    const directory = path.join(root,folder);
    const isClient = folder === 'consumer';
    const name = projectPrefix + folder, dependency = projectPrefix + 'producer';
    const moduleAttribute = '<attributes><attribute name="module" value="true"/></attributes>';
    await fs.mkdir(path.join(directory,output),{recursive:true});
    await fs.mkdir(path.join(directory,'.settings'));
    await fs.writeFile(path.join(directory,'.project'),'<projectDescription><name>'+name+'</name><projects>'+
      (isClient?'<project>'+dependency+'</project>':'')+'</projects><buildSpec>'+
      '<buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec>'+
      '<natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>',{flag:'wx'});
    await fs.writeFile(path.join(directory,'.classpath'),'<classpath><classpathentry kind="src" path="src/main/java"/>'+
      '<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER">'+moduleAttribute+'</classpathentry>'+
      (isClient?'<classpathentry combineaccessrules="false" kind="src" path="/'+dependency+'">'+moduleAttribute+'</classpathentry>':'')+
      '<classpathentry kind="output" path="bin/main"/></classpath>',{flag:'wx'});
    await fs.writeFile(path.join(directory,'.settings','org.eclipse.jdt.core.prefs'),[
      'eclipse.preferences.version=1','org.eclipse.jdt.core.compiler.compliance=25',
      'org.eclipse.jdt.core.compiler.source=25','org.eclipse.jdt.core.compiler.codegen.targetPlatform=25',''
    ].join('\n'),{flag:'wx'});
  }
  for (const [relative,text] of sources) {
    const file = path.join(root,relative);
    await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,text,{flag:'wx'});
  }
}

function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS)$/iu.test(key)));
}

function run(javaHome,tool,args,options={}) {
  const binary = path.join(javaHome,'bin',tool+(process.platform === 'win32' ? '.exe' : ''));
  return execute(binary,args,{env:cleanEnv(),timeoutMs:34000,...options});
}

async function checkVisibility(javaHome,classes,packageName,work) {
  const source = path.join(work,'outsider'), out = path.join(work,'compiled');
  await fs.mkdir(source);
  const moduleFile = path.join(source,'module-info.java'), attempt = path.join(source,'Attempt.java');
  await fs.writeFile(moduleFile,'module '+outsider+' { requires '+provider+'; requires '+consumer+'; }');
  await fs.writeFile(attempt,'package '+outsider+'; import '+packageName+'.Ledger; public class Attempt { Ledger field; }');
  const denied = await run(javaHome,'javac',['-proc:none','-XDrawDiagnostics','--module-path',classes,
    '-d',out,moduleFile,attempt]);
  assert.notEqual(denied.code,0);
  assert.match(denied.output,/compiler\.err\.package\.not\.visible/);
  await fs.writeFile(attempt,[
    'package '+outsider+';',
    'public class Attempt {',
    '    public static void main(String[] args) throws Exception {',
    '        var ledger = '+consumer+'.Probe.providerType();',
    '        var amount = ledger.getDeclaredField("amount");',
    '        System.out.println(amount.trySetAccessible());',
    '    }',
    '}',''
  ].join('\n'));
  const compiled = await run(javaHome,'javac',['-proc:none','--module-path',classes,'-d',out,moduleFile,attempt]);
  assert.equal(compiled.code,0,compiled.output);
  const check = await run(javaHome,'java',['--module-path',[classes,out].join(path.delimiter),'-m',outsider+'/'+outsider+'.Attempt']);
  assert.equal(check.code,0,check.output);
  assert.equal(check.output.trim(),'false');
  return {unlistedPublicAccessRefused:true,unlistedReflectiveAccessRefused:true};
}

async function compileModules(root,classes,javaHome,{renamed=false,install=false,visibilityRoot}={}) {
  const sourcePath = projects.flatMap(([folder,name]) => ['--module-source-path',name+'='+path.join(root,folder,main)]);
  const compiled = await run(javaHome,'javac',['-proc:none','-encoding','UTF-8',...sourcePath,
    '-d',classes,'--module',projects.map(([,name])=>name).join(',')]);
  assert.equal(compiled.code,0,compiled.output);
  const launch = await run(javaHome,'java',['--module-path',classes,'-m',consumer+'/'+consumer+'.Probe']);
  assert.equal(launch.code,0,launch.output);
  assert.equal(launch.output.trim(),'19:19');
  const packageName = renamed ? newPackage : oldPackage;
  const opposite = renamed ? oldPackage : newPackage;
  await fs.stat(path.join(classes,provider,...packageName.split('.'),'Ledger.class'));
  await assert.rejects(fs.stat(path.join(classes,provider,...opposite.split('.'),'Ledger.class')),{code:'ENOENT'});
  if (install) for (const [folder,name] of projects) {
    await fs.cp(path.join(classes,name),path.join(root,folder,output),{recursive:true});
  }
  return {namedPublicAndPrivate:launch.output.trim(),...visibilityRoot &&
    await checkVisibility(javaHome,classes,packageName,visibilityRoot)};
}

async function runSpring({root,classes,javaHome,cpFile,configFile,engine}) {
  const data = JSON.parse(await fs.readFile(configFile,'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(configFile),'owner.json'),'utf8'));
  assert.equal(owner.kind,engine==='mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  assert.equal(data.host,'127.0.0.1');
  assert.ok(Number.isInteger(data.port) && data.port>0 && data.port<65536);
  assert.match(data.database,/^[a-z_]+$/u);
  const bridge = path.join(root,'QualifiedSpring.java');
  await fs.writeFile(bridge,[
    'import '+consumer+'.Probe;',
    'import org.springframework.beans.factory.support.DefaultListableBeanFactory;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class QualifiedSpring {',
    '    public static void main(String[] args) throws Exception {',
    '        var spring = new DefaultListableBeanFactory();',
    '        spring.registerSingleton("probe", Probe.read());',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_QUALIFIED_URL"),',
    '            System.getenv("RB_QUALIFIED_USER"), System.getenv("RB_QUALIFIED_PASSWORD")));',
    '        System.out.println("RB_QUALIFIED=" + jdbc.queryForObject("SELECT VERSION()",String.class) + "|"',
    '            + spring.getBean("probe",String.class) + "|" + jdbc.queryForObject("SELECT 42",Integer.class));',
    '    }',
    '}',''
  ].join('\n'),{flag:'wx'});
  const cp = await packageClasspath(cpFile,engine);
  const modulePath = ['--module-path',classes,'--add-modules',consumer];
  const result = await run(javaHome,'javac',['-proc:none',...modulePath,'-classpath',cp.join(path.delimiter),'-d',root,bridge]);
  assert.equal(result.code,0,result.output);
  const env = {...cleanEnv(),RB_QUALIFIED_URL:'jdbc:'+engine+'://127.0.0.1:'+data.port+'/'+data.database+
    (engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),RB_QUALIFIED_USER:data.user,RB_QUALIFIED_PASSWORD:data.password};
  const actual=await run(javaHome,'java',[...modulePath,'-classpath',[root,...cp].join(path.delimiter),'QualifiedSpring'],{env});
  assert.equal(actual.code,0,actual.output);
  const match=/^RB_QUALIFIED=([^|\r\n]+)\|19:19\|42$/mu.exec(actual.output);
  assert.ok(match,actual.output);
  assert.match(match[1],engine==='mysql' ? /^8\.4\.13$/u : /^11\.4\.8.*MariaDB/u);
  return {engine,server:match[1],qualifiedSpringBean:'19:19',jdbc:42};
}

module.exports = {provider,consumer,oldPackage,newPackage,sourceFolder,targetFolder,owner,independent,
  providerDescriptor,consumerDescriptor,caller,projects,main,output,sources,populate,compileModules,runSpring};
