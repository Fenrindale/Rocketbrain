'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');
const assert=require('node:assert/strict');
const {buildRuntime,readDatabase}=require('./spring-maven-bom-fixture');

const root=path.resolve(__dirname,'../..'), output=path.join(root,'test-output');
const boot=process.env.ROCKETBRAIN_INITIALIZR_TEST_BOOT||'4.1.3', revision='0.0.1-SNAPSHOT';
const styles=[
  {type:'maven-project',language:'java',packaging:'war',configurationFileFormat:'yaml'},
  {type:'gradle-project-kotlin',language:'kotlin',packaging:'jar',configurationFileFormat:'properties'},
  {type:'gradle-project',language:'groovy',packaging:'jar',configurationFileFormat:'yaml'}
];
const run=promisify(execFile);
const packageName='fixture.initializr';

function projectSelection(style){
  const artifactId='rb-initializr-'+style.language+'-'+style.packaging;
  return {...style,bootVersion:boot,javaVersion:'25',version:revision,groupId:'fixture',packageName,artifactId,name:artifactId,
    description:'Owned Rocketbrain Initializr JDBC fixture',dependencies:['web','jdbc','mysql','mariadb']};
}

const javaProbe=`package fixture.initializr;

import java.util.Map;
import org.springframework.boot.web.server.context.WebServerInitializedEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class RocketbrainProbe {
    private final JdbcClient jdbc;
    private final Environment environment;
    public RocketbrainProbe(JdbcClient jdbc, Environment environment) {
        this.jdbc = jdbc;
        this.environment = environment;
    }
    @GetMapping("/initializr-probe")
    Map<String, Object> read() {
        return Map.of("nonce", environment.getRequiredProperty("RB_INITIALIZR_NONCE"),
            "boot", org.springframework.boot.SpringBootVersion.getVersion(),
            "version", jdbc.sql("SELECT VERSION()").query(String.class).single(),
            "people", jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Long.class).single());
    }
    @EventListener
    void reportPort(WebServerInitializedEvent event) {
        System.out.println("RocketbrainInitializrFixture listening on " + event.getWebServer().getPort());
    }
}
`;
const kotlinProbe=`package fixture.initializr

import org.springframework.boot.SpringBootVersion
import org.springframework.boot.web.server.context.WebServerInitializedEvent
import org.springframework.context.event.EventListener
import org.springframework.core.env.Environment
import org.springframework.jdbc.core.simple.JdbcClient
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RestController

@RestController
class RocketbrainProbe(private val jdbc: JdbcClient, private val environment: Environment) {
    @GetMapping("/initializr-probe")
    fun read(): Map<String, Any?> = mapOf(
        "nonce" to environment.getRequiredProperty("RB_INITIALIZR_NONCE"),
        "boot" to SpringBootVersion.getVersion(),
        "version" to jdbc.sql("SELECT VERSION()").query(String::class.java).single(),
        "people" to jdbc.sql("SELECT COUNT(*) FROM rb_spring_person").query(Long::class.javaObjectType).single()
    )
    @EventListener
    fun reportPort(event: WebServerInitializedEvent) {
        println("RocketbrainInitializrFixture listening on " + event.webServer.port)
    }
}
`;
const groovyProbe=javaProbe;

async function addProbe(project,style){
  const source=path.join(project,'src','main',style.language,...packageName.split('.'));
  const name='RocketbrainProbe.'+{java:'java',kotlin:'kt',groovy:'groovy'}[style.language];
  await fs.writeFile(path.join(source,name),{java:javaProbe,kotlin:kotlinProbe,groovy:groovyProbe}[style.language],{flag:'wx'});
}

function buildEnv(runtime){
  const env={...process.env,JAVA_HOME:runtime.home};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','MAVEN_OPTS','MAVEN_ARGS','GRADLE_OPTS'])
    delete env[key];
  return env;
}

async function mavenArgs(project,runtime){
  const settings=path.join(project,'fixture-maven-settings.xml');
  await fs.writeFile(settings,'<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n',{flag:'wx'});
  const repo=process.env.ROCKETBRAIN_INITIALIZR_MAVEN_CACHE||path.join(output,'spring-initializr-maven-cache');
  assert.ok(path.isAbsolute(repo));
  return ['-Dfile.encoding=UTF-8','-Dmaven.home='+runtime.mavenHome,'-Dclassworlds.conf='+runtime.config,
    '-Dmaven.multiModuleProjectDirectory='+project,'-Dmaven.repo.local='+repo,'-cp',runtime.launcher,
    'org.codehaus.plexus.classworlds.launcher.Launcher','-B','-ntp','--strict-checksums','--settings',settings,
    '--global-settings',settings,'-DskipTests','package'];
}

function gradleArgs(runtime,style){
  const gradle=process.env.ROCKETBRAIN_GRADLE_HOME, cache=process.env.ROCKETBRAIN_INITIALIZR_GRADLE_CACHE||path.join(output,'spring-initializr-gradle-cache');
  assert.ok(path.isAbsolute(gradle||''));assert.ok(path.isAbsolute(cache));
  return ['-Dorg.gradle.java.home='+runtime.home,'-cp',path.join(gradle,'lib','gradle-launcher-9.1.0.jar'),
    'org.gradle.launcher.GradleMain','--no-daemon','--console=plain','--max-workers=2','--gradle-user-home',cache,style.packaging==='war'?'bootWar':'bootJar'];
}

async function build(project,selection,runtime){
  const maven=selection.type==='maven-project', env=buildEnv(runtime);
  const args=maven?await mavenArgs(project,runtime):gradleArgs(runtime,selection);
  let result;
  try{result=await run(runtime.java,args,{cwd:project,env,windowsHide:true,timeout:240000,maxBuffer:2*1024*1024});}
  catch(error){throw Error('The owned Initializr build failed. '+[error.stdout,error.stderr].filter(Boolean).join('\n').slice(-3900),{cause:error});}
  assert.match(result.stdout,maven?/BUILD SUCCESS/:/BUILD SUCCESSFUL/);
  const built=path.join(project,maven?'target':path.join('build','libs'),selection.artifactId+'-'+revision+'.'+selection.packaging);
  const listing=(await run(runtime.jar,['tf',built],{cwd:project,env,windowsHide:true,timeout:10000,maxBuffer:1024*1024})).stdout.split(/\r?\n/);
  const prefix=selection.packaging==='war'?'WEB-INF':'BOOT-INF';
  assert.ok(listing.includes(prefix+'/classes/fixture/initializr/RocketbrainProbe.class'));
  assert.ok(listing.some(entry=>entry.startsWith(prefix+'/lib/mysql-connector-j-')));
  assert.ok(listing.some(entry=>entry.startsWith(prefix+'/lib/mariadb-java-client-')));
  if(selection.packaging==='war'){
    assert.ok(listing.some(entry=>entry.startsWith('WEB-INF/lib-provided/tomcat-embed-core-')));
    assert.ok(listing.includes('WEB-INF/classes/fixture/initializr/ServletInitializer.class'));
  }
  return built;
}

async function bootAndRead(built,runtime,config){
  const db=await readDatabase(config),engine=config.dbEngine,nonce=randomUUID();
  const env={...buildEnv(runtime),SERVER_ADDRESS:'127.0.0.1',SERVER_PORT:'0',RB_INITIALIZR_NONCE:nonce,
    SPRING_DATASOURCE_URL:'jdbc:'+engine+'://127.0.0.1:'+db.port+'/'+db.database+(engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':''),
    SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password};
  const child=spawn(runtime.java,['-jar',built],{cwd:path.dirname(built),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let recent='',port,ended=false;
  const capture=buffer=>{
    recent=(recent+buffer.toString('utf8').split(db.password).join('[redacted]')).slice(-6000);
    port=Number(/RocketbrainInitializrFixture listening on (\d+)/.exec(recent)?.[1])||port;
  };
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const exit=new Promise(resolve=>{
    child.once('exit',()=>{ended=true;resolve();});
    child.once('error',()=>{ended=true;resolve();});
  });
  try{
    const deadline=Date.now()+40000;
    while(!ended&&Date.now()<deadline){
      if(port){
        const response=await fetch('http://127.0.0.1:'+port+'/initializr-probe',{signal:AbortSignal.timeout(1500)}).catch(()=>null);
        if(response?.ok){
          const observation=await response.json();
          assert.equal(observation.nonce,nonce);
          assert.equal(observation.boot,boot);
          assert.equal(observation.people,2);
          assert.equal(/mariadb/i.test(observation.version),engine==='mariadb');
          return {version:observation.version,boot:observation.boot,people:observation.people};
        }
      }
      await delay(100);
    }
    throw Error('The owned Initializr artifact did not respond.\n'+recent);
  }finally{if(!ended)child.kill();await exit;}
}

module.exports={boot,root,output,styles,projectSelection,addProbe,build,bootAndRead,buildRuntime};
