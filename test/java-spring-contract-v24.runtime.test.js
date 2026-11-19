'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const enabled=process.env.ROCKETBRAIN_SPRING_V24_COMPILER_TEST==='1';
test('actual Spring metadata and registry execute v24 String-attribute ternary and class-name switch routes',{skip:!enabled,timeout:60000},()=>{
 const root=path.resolve(__dirname,'..'),config=JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG||path.join(root,'test-output/v0.4-java-host-runtime.json'))),classpathFile=process.env.ROCKETBRAIN_SPRING_V24_CLASSPATH||path.join(root,'test/fixtures/refactoring-v23-spring/build/runtime-classpath.txt'),cp=fs.readFileSync(classpathFile,'utf8').trim().split(path.delimiter).filter(file=>!/[\\/]test[\\/]fixtures[\\/]refactoring-v2[34]-spring[\\/](?:build|bin)[\\/]/i.test(file)).join(path.delimiter),output=fs.mkdtempSync(path.join(root,'test-output/v24-spring-metadata-')),classes=path.join(output,'classes'),oracle=path.join(output,'MetadataOracle.java');fs.mkdirSync(classes);
 fs.writeFileSync(oracle,`import fixture.dynamicv24.configuration.BlueConfiguration;
import fixture.dynamicv24.configuration.GreenConfiguration;
import fixture.dynamicv24.extensions.V24FiniteSelector;
import fixture.dynamicv24.extensions.V24FiniteRegistrar;
import fixture.dynamicv24.selected.V24BlueBean;
import fixture.dynamicv24.selected.V24GreenBean;
import org.springframework.core.type.AnnotationMetadata;
import org.springframework.beans.factory.support.DefaultListableBeanFactory;
public final class MetadataOracle {
 public static void main(String[] args) {
  var blue=AnnotationMetadata.introspect(BlueConfiguration.class);
  var green=AnnotationMetadata.introspect(GreenConfiguration.class);
  if(!"blue".equals(blue.getAnnotationAttributes("fixture.dynamicv24.annotations.V24Choice").get("route")))throw new AssertionError("blue attr");
  if(!"green".equals(green.getAnnotationAttributes("fixture.dynamicv24.annotations.V24Choice").get("route")))throw new AssertionError("green attr");
  var selector=new V24FiniteSelector();
  if(!java.util.Arrays.equals(selector.selectImports(blue),new String[]{"fixture.dynamicv24.selected.V24BlueSelected"}))throw new AssertionError("blue ternary");
  if(!java.util.Arrays.equals(selector.selectImports(green),new String[]{"fixture.dynamicv24.selected.V24GreenSelected"}))throw new AssertionError("green ternary");
  var registry=new DefaultListableBeanFactory();var registrar=new V24FiniteRegistrar();registrar.registerBeanDefinitions(blue,registry);registrar.registerBeanDefinitions(green,registry);
  if(registry.getBeanDefinitionCount()!=2)throw new AssertionError("switch count");
  if(!"blue".equals(registry.getBean("finiteBlue",V24BlueBean.class).value())||!"green".equals(registry.getBean("finiteGreen",V24GreenBean.class).value()))throw new AssertionError("switch values");
  if(registry.getBean("finiteBlue")!=registry.getBean("finiteBlueAlias")||registry.getBean("finiteGreen")!=registry.getBean("finiteGreenAlias"))throw new AssertionError("aliases");
  var unknown=AnnotationMetadata.introspect(MetadataOracle.class);var empty=new DefaultListableBeanFactory();registrar.registerBeanDefinitions(unknown,empty);
  if(empty.getBeanDefinitionCount()!=0)throw new AssertionError("default effects");
  if(!java.util.Arrays.equals(selector.selectImports(unknown),new String[]{"fixture.dynamicv24.selected.V24GreenSelected"}))throw new AssertionError("missing annotation guard");
  System.out.println("V24_METADATA_OK blue green aliases default-empty missing-annotation");
 }
}
`);
 const walk=folder=>fs.readdirSync(folder,{withFileTypes:true}).flatMap(item=>item.isDirectory()?walk(path.join(folder,item.name)):item.name.endsWith('.java')?[path.join(folder,item.name)]:[]),files=[...walk(path.join(root,'test/fixtures/refactoring-v24-spring/src/main/java')),oracle],args=['-proc:none','-encoding','UTF-8','-cp',cp,'-d',classes,...files],argfile=path.join(output,'javac.args');fs.writeFileSync(argfile,args.map(value=>JSON.stringify(value)).join('\n'));const compile=spawnSync(path.join(config.javaHome,'bin',process.platform==='win32'?'javac.exe':'javac'),['@'+argfile],{windowsHide:true,encoding:'utf8',timeout:45000});fs.writeFileSync(path.join(output,'javac.log'),(compile.stdout||'')+(compile.stderr||''));assert.equal(compile.status,0,compile.stderr+'\n'+compile.stdout);const run=spawnSync(path.join(config.javaHome,'bin',process.platform==='win32'?'java.exe':'java'),['-cp',classes+path.delimiter+cp,'MetadataOracle'],{windowsHide:true,encoding:'utf8',timeout:15000});fs.writeFileSync(path.join(output,'runtime.log'),(run.stdout||'')+(run.stderr||''));assert.equal(run.status,0,run.stderr+'\n'+run.stdout);assert.match(run.stdout,/V24_METADATA_OK blue green aliases default-empty missing-annotation/);fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({state:'passed',freshAllJavaClasses:true,annotationProcessorsDisabled:true,ordinaryExplicitRuntimeValidation:true,sharedDatabaseStarted:false,sharedJdtStarted:false,positiveRoutes:2,aliasesPreserved:true,unknownClassDefaultAddsNoDefinitions:true,missingAnnotationGuardReturnsGreen:true},null,2)+'\n');
});
