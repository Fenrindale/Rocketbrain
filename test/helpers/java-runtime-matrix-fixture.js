'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {execute} = require('../../src/java/testing/provision');
const {probeJavaHome} = require('../../src/java/module-runtimes');

const matrix = [{name:'legacy',major:8,main:'fixture.level8.Legacy'}, {name:'service17',major:17,main:'fixture.level17.Service'},
  {name:'service21',major:21,main:'fixture.level21.Service'}, {name:'service25',major:25,main:'fixture.level25.Service'},
  {name:'preview21',major:21,main:'fixture.preview.PreviewRun',preview:true}];
const tool = (home,name) => path.join(home,'bin',process.platform==='win32'?name+'.exe':name);
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key])=>
  !/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH|GRADLE_OPTS)$/iu.test(key)));

async function readRuntimeMatrix(file) {
  assert.ok(file,'Set ROCKETBRAIN_JAVA_RUNTIME_MATRIX_CONFIG to the provisioned test runtimes.');
  const config=JSON.parse(await fs.readFile(file,'utf8'));
  assert.ok(path.isAbsolute(config.gradleHome||''));
  assert.deepEqual(config.jdks.map(item=>item.major),[8,17,21,25]);
  for (const item of config.jdks) {
    assert.ok(path.isAbsolute(item.home||'')&&!/[,\r\n]/u.test(item.home));
    assert.equal((await probeJavaHome(item.home)).major,item.major);
  }
  return config;
}

function mainSource(module) {
  if (module.major===8) return `package fixture.level8;
public class Legacy {
    public static String tag() { return "legacy"; }
    public static void main(String[] args) {
        java.util.function.Supplier<String> value = Legacy::tag;
        System.out.println("RB_MATRIX:legacy:" + System.getProperty("java.specification.version") + ":" + value.get());
    }
}
`;
  if (module.preview) return String.raw`package fixture.preview;
import static java.lang.StringTemplate.STR;
import java.nio.file.Files;
import java.nio.file.Path;
public class PreviewRun {
    public static void main(String[] args) throws Exception {
        String version = System.getProperty("java.specification.version");
        String value = STR."RB_MATRIX:preview21:\{version}:template";
        System.out.println(value);
        if (args.length == 1) Files.writeString(Path.of(args[0]),value);
    }
}
`;
  return `package ${module.main.split('.').slice(0,-1).join('.')};
import fixture.level8.Legacy;
public class Service {
${module.major===17?'    record Value(String text) {}':module.major===25?'    static final ScopedValue<String> LABEL = ScopedValue.newInstance();':''}
    public static void main(String[] args) throws Exception {
        String marker = "RB_MATRIX:${module.name}:" + System.getProperty("java.specification.version") + ":";
${module.major===17?'        System.out.println(marker + new Value(Legacy.tag()).text());':
    module.major===21?'        Thread.ofVirtual().start(() -> System.out.println(marker + Legacy.tag())).join();':
      '        ScopedValue.where(LABEL,Legacy.tag()).run(() -> System.out.println(marker + LABEL.get()));'}
    }
}
`;
}

function eclipseSource(module) {
  if (module.major===8 || module.preview) return mainSource(module);
  return `package ${module.main.split('.').slice(0,-1).join('.')};
public class Service {
    public static void main(String[] args) throws Exception {
        String report = "RB_MATRIX:${module.name}:" + System.getProperty("java.specification.version") + ":standalone";
${module.major>=21?'        Thread.ofVirtual().start(() -> System.out.println(report)).join();':'        System.out.println(report);'}
        if (args.length == 1) java.nio.file.Files.writeString(java.nio.file.Path.of(args[0]),report + ":" + System.getenv("RB_MATRIX_OWNED"));
    }
}
`;
}

async function writeModule(root,module,{eclipse=false}={}) {
  const source=path.join(root,...(eclipse?['src']:['src','main','java']),...module.main.split('.'))+'.java';
  await fs.mkdir(path.dirname(source),{recursive:true});
  await fs.writeFile(source,eclipse?eclipseSource(module):mainSource(module),{flag:'wx'});
  return source;
}

async function prepareGradleMatrix(root,config) {
  await fs.writeFile(path.join(root,'settings.gradle'),"rootProject.name = 'rocketbrain-runtime-matrix'\ninclude "+
    matrix.map(item=>"'"+item.name+"'").join(', ')+'\n',{flag:'wx'});
  const javaProperties=pathValue=>pathValue.replaceAll('\\','/').replace(/[^\x20-\x7e]/g,
    character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
  await fs.writeFile(path.join(root,'gradle.properties'),['org.gradle.java.installations.auto-download=false',
    'org.gradle.java.installations.auto-detect=false','org.gradle.java.installations.paths='+config.jdks.map(item=>javaProperties(item.home)).join(','),''].join('\n'),{flag:'wx'});
  for (const module of matrix) {
    const dir=path.join(root,module.name);
    await writeModule(dir,module);
    await fs.writeFile(path.join(dir,'build.gradle'),[
      'plugins { id "java" }',
      'java { toolchain { languageVersion = JavaLanguageVersion.of('+module.major+') } }',
      ...(module.name.startsWith('service')?[`dependencies { implementation project(':legacy') }`]:[]),
      'tasks.withType(JavaCompile).configureEach {',
      '  options.fork = true',
      '  options.forkOptions.executable = javaCompiler.get().executablePath.asFile.absolutePath',
      "  doFirst { logger.lifecycle('RB_COMPILER:' + project.name + ':' + javaCompiler.get().metadata.languageVersion.asInt()) }",
      '}',
      ...(module.preview?[`tasks.withType(JavaCompile).configureEach { options.release = 21; options.compilerArgs += ['--enable-preview'] }`]:[]),
      "tasks.register('matrixRun', JavaExec) {",
      '  javaLauncher = javaToolchains.launcherFor(java.toolchain)',
      '  classpath = sourceSets.main.runtimeClasspath',
      `  mainClass = '${module.main}'`,
      ...(module.preview?["  jvmArgs '--enable-preview'"]:[]),
      '}',''
    ].join('\n'),{flag:'wx'});
  }
  return matrix.map(item=>({...item,root:path.join(root,item.name),output:path.join(root,item.name,'build','classes','java','main')}));
}

async function runGradleMatrix(root,config,modules) {
  const java=config.jdks.find(item=>item.major===25).home;
  const boot=path.join(config.gradleHome,'lib','gradle-launcher-9.1.0.jar');
  await fs.access(boot);
  const result=await execute(tool(java,'java'),['-Dorg.gradle.java.home='+java,'-cp',boot,'org.gradle.launcher.GradleMain',
    '--offline','--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',path.join(root,'.owned-gradle'),
    ...modules.map(item=>':'+item.name+':matrixRun')],{cwd:root,env:environment(),timeoutMs:155000});
  assert.equal(result.code,0,result.output);
  const compilers=Object.fromEntries([...result.output.matchAll(/^RB_COMPILER:([a-z0-9]+):(\d+)$/gmu)]
    .map(match=>[match[1],Number(match[2])]));
  return Object.fromEntries([...result.output.matchAll(/^RB_MATRIX:([a-z0-9]+):([^:]+):([^\r\n]+)$/gmu)]
    .map(match=>[match[1],{language:match[2],value:match[3],compiler:compilers[match[1]]}]));
}

async function prepareEclipseMatrix(root,modules,config) {
  const result=[];
  for (const module of modules) {
    const dir=path.join(root,module.name),name='rb-runtime-'+module.name+'-'+path.basename(root);
    const source=await writeModule(dir,module,{eclipse:true});
    const release=module.major===8?'1.8':String(module.major);
    await fs.writeFile(path.join(dir,'.project'),`<?xml version="1.0" encoding="UTF-8"?>
<projectDescription><name>${name}</name><comment/><projects/><buildSpec><buildCommand><name>org.eclipse.jdt.core.javabuilder</name><arguments/></buildCommand></buildSpec><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>`,{flag:'wx'});
    await fs.writeFile(path.join(dir,'.classpath'),`<?xml version="1.0" encoding="UTF-8"?>
<classpath><classpathentry kind="src" path="src"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER/org.eclipse.jdt.internal.debug.ui.launcher.StandardVMType/JavaSE-${release}"/><classpathentry kind="output" path="classes"/></classpath>`,{flag:'wx'});
    await fs.mkdir(path.join(dir,'.settings'));
    await fs.writeFile(path.join(dir,'.settings','org.eclipse.jdt.core.prefs'),['eclipse.preferences.version=1',
      'org.eclipse.jdt.core.compiler.source='+release,'org.eclipse.jdt.core.compiler.compliance='+release,
      'org.eclipse.jdt.core.compiler.codegen.targetPlatform='+release,'org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures='+(module.preview?'enabled':'disabled'),
      'org.eclipse.jdt.core.compiler.problem.reportPreviewFeatures=ignore',''].join('\n'),{flag:'wx'});
    const output=path.join(dir,'classes');
    await fs.mkdir(output);
    const home=config.jdks.find(item=>item.major===module.major).home;
    const args=module.major===8?[]:['--release',String(module.major),...(module.preview?['--enable-preview']:[])];
    const compiled=await execute(tool(home,'javac'),['-encoding','UTF-8','-d',output,...args,source],{cwd:dir,env:environment(),timeoutMs:25000});
    assert.equal(compiled.code,0,compiled.output);
    result.push({...module,root:dir,output,name});
  }
  return result;
}

module.exports={matrix,tool,environment,readRuntimeMatrix,prepareGradleMatrix,runGradleMatrix,prepareEclipseMatrix};
