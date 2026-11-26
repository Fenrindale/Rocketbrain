'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const http=require('node:http');
const {execFile,spawn}=require('node:child_process');
const {promisify}=require('node:util');
const {randomUUID}=require('node:crypto');
const {SaxesParser}=require('saxes');
const assert=require('node:assert/strict');
const metadataFixture=require('./spring-project-tools-fixture');
const root=path.resolve(__dirname,'../..');
const output=path.join(root,'test-output');
const run=promisify(execFile);
const boot=metadataFixture.version;
const drivers={mysql:{group:'com.mysql',artifact:'mysql-connector-j',version:'9.7.0'},mariadb:{group:'org.mariadb.jdbc',artifact:'mariadb-java-client',version:'3.5.10'}};
const markerKinds={mysql:'RocketbrainDisposableOracleMysqlFixture-v1',mariadb:'RocketbrainDisposableMariaDbFixture-v1'};

function pomFor(engine){
  const counterpart=drivers[engine==='mysql'?'mariadb':'mysql'];
  const property=engine==='mysql'?'spring-boot.version':null;
  const expression=property?'${'+property+'}':boot;
  return `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>fixture.bom</groupId>
  <artifactId>rocketbrain-maven-bom-fixture</artifactId>
  <version>1.0.0</version>
  <properties>
    <maven.compiler.release>25</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    ${property?'<spring-boot.version>'+boot+'</spring-boot.version>':''}
  </properties>
  <dependencyManagement>
    <dependencies>
      <!-- Preserve the local management override for the other connector. -->
      <dependency>
        <groupId>${counterpart.group}</groupId>
        <artifactId>${counterpart.artifact}</artifactId>
        <version>${counterpart.version}</version>
      </dependency>
      <dependency>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-dependencies</artifactId>
        <version>${expression}</version>
        <type>pom</type>
        <scope>import</scope>
      </dependency>
    </dependencies>
  </dependencyManagement>
  <dependencies>
    <!-- Preserve the existing web dependency. -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-webmvc</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-actuator</artifactId>
    </dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.14.1</version>
      </plugin>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
        <version>${expression}</version>
        <executions><execution><goals><goal>repackage</goal></goals></execution></executions>
      </plugin>
    </plugins>
  </build>
</project>\n`;
}

function starterCatalog(){
  const metadata=metadataFixture.metadata(),catalog=metadataFixture.catalog();
  metadata.dependencies.values[0].values.push({id:'jdbc',name:'JDBC API'});
  catalog.dependencies.jdbc={groupId:'org.springframework.boot',artifactId:'spring-boot-starter-jdbc',scope:'compile'};
  return {metadata,catalog};
}

async function serveCatalog(){
  const {metadata,catalog}=starterCatalog(),requests=[];
  const server=http.createServer((request,response)=>{
    const url=new URL(request.url,'http://127.0.0.1');
    requests.push({method:request.method,path:url.pathname,bootVersion:url.searchParams.get('bootVersion')});
    const data=request.method==='GET'&&(url.pathname==='/'?metadata:url.pathname==='/dependencies'&&url.searchParams.get('bootVersion')===boot?catalog:null);
    if(!data){response.writeHead(404);response.end();return;}
    response.writeHead(200,{'Content-Type':'application/vnd.initializr.v2.3+json'});
    response.end(JSON.stringify(data));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:'http://127.0.0.1:'+server.address().port+'/',requests,close:()=>new Promise(resolve=>server.close(resolve))};
}

async function buildRuntime(){
  const configured=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
  const profile=configured?JSON.parse(await fs.readFile(configured,'utf8')):{};
  const home=process.env.ROCKETBRAIN_SPRING_JAVA_HOME||profile.javaHome||profile.settings?.['rocketbrain.java.javaHome'];
  const mavenHome=process.env.ROCKETBRAIN_MAVEN_HOME||path.join(root,'research','implementation','runtimes','v0.18-maven-cache','extracted','apache-maven-3.9.11');
  assert.ok(home&&path.isAbsolute(home),'Use the authorized independent JDK25 fixture runtime.');
  assert.ok(path.isAbsolute(mavenHome),'Use an independent Maven distribution.');
  const release=await fs.readFile(path.join(home,'release'),'utf8');
  assert.match(release,/JAVA_VERSION="25\./);
  assert.doesNotMatch(release,/JetBrains|JBR/i);
  const launchers=(await fs.readdir(path.join(mavenHome,'boot'))).filter(name=>/^plexus-classworlds-[\d.]+\.jar$/.test(name));
  assert.equal(launchers.length,1);
  const config=path.join(mavenHome,'bin','m2.conf');
  await fs.access(config);
  const executable=name=>path.join(home,'bin',name+(process.platform==='win32'?'.exe':''));
  return {home,mavenHome,java:executable('java'),jar:executable('jar'),launcher:path.join(mavenHome,'boot',launchers[0]),config};
}

async function readDatabase(config){
  const db=JSON.parse(await fs.readFile(config.dbConfigPath,'utf8'));
  const marker=JSON.parse(await fs.readFile(path.join(path.dirname(config.dbConfigPath),'owner.json'),'utf8'));
  assert.equal(marker.kind,markerKinds[config.dbEngine]);
  assert.ok(['mysql','mariadb'].includes(config.dbEngine)&&db.host==='127.0.0.1'&&Number.isSafeInteger(db.port)&&db.port>=1024&&db.port<=65535&&/^[A-Za-z0-9_]+$/.test(db.database));
  return db;
}

function effectiveDependencies(text){
  const parser=new SaxesParser(),stack=[],dependencies=[];
  let item;
  parser.on('opentag',tag=>{
    stack.push({name:tag.name,value:''});
    if(stack.map(entry=>entry.name).join('/')==='project/dependencies/dependency')item={};
  });
  parser.on('text',value=>{if(stack.length)stack.at(-1).value+=value;});
  parser.on('closetag',()=>{
    const element=stack.pop();
    if(!item)return;
    if(stack.length===3)item[element.name]=element.value.trim();
    if(stack.length===2&&element.name==='dependency'){dependencies.push(item);item=undefined;}
  });
  parser.write(text).close();return dependencies;
}

async function mavenBuild(project,runtime,{profile}={}){
  const settings=path.join(project,'fixture-maven-settings.xml');
  await fs.writeFile(settings,'<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>\n',{flag:'wx'});
  const repository=process.env.ROCKETBRAIN_MAVEN_BOM_TEST_REPOSITORY||path.join(output,'spring-maven-bom-repository');
  assert.ok(path.isAbsolute(repository));
  const env={...process.env,JAVA_HOME:runtime.home};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','MAVEN_OPTS','MAVEN_ARGS'])delete env[key];
  const effective=path.join(project,'target','effective-pom.xml');
  const args=['-Dfile.encoding=UTF-8','-Dmaven.home='+runtime.mavenHome,'-Dclassworlds.conf='+runtime.config,
    '-Dmaven.multiModuleProjectDirectory='+project,'-Dmaven.repo.local='+repository,'-cp',runtime.launcher,'org.codehaus.plexus.classworlds.launcher.Launcher',
    '-B','-ntp','--strict-checksums','--settings',settings,'--global-settings',settings,...(profile?['--activate-profiles',profile]:[]),'package',
    'org.apache.maven.plugins:maven-help-plugin:3.5.1:effective-pom','-Doutput='+effective];
  let result;
  try {result=await run(runtime.java,args,{cwd:project,env,windowsHide:true,maxBuffer:2*1024*1024,timeout:180000});}
  catch(error){
    const tail=[error.stdout,error.stderr].filter(Boolean).join('\n').slice(-3400);
    throw Error('The owned Maven fixture build failed.\n'+tail,{cause:error});
  }
  assert.match(result.stdout,/BUILD SUCCESS/);
  const artifact=path.join(project,'target','rocketbrain-maven-bom-fixture-1.0.0.jar');
  const archive=(await run(runtime.jar,['tf',artifact],{cwd:project,env,windowsHide:true,timeout:10000,maxBuffer:1024*1024})).stdout.split(/\r?\n/);
  return {artifact,archive,dependencies:effectiveDependencies(await fs.readFile(effective,'utf8'))};
}

async function runProbe(artifact,runtime,engine,db){
  const nonce=randomUUID();
  const url='jdbc:'+engine+'://127.0.0.1:'+db.port+'/'+db.database+(engine==='mysql'?'?allowPublicKeyRetrieval=true&sslMode=DISABLED':'');
  const env={...process.env,SERVER_ADDRESS:'127.0.0.1',SERVER_PORT:'0',RB_BOM_FIXTURE_NONCE:nonce,
    SPRING_DATASOURCE_URL:url,SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password};
  for(const key of ['JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS'])delete env[key];
  const child=spawn(runtime.java,['-jar',artifact],{cwd:path.dirname(artifact),env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let recent='',port,ended=false;
  const capture=buffer=>{
    recent=(recent+buffer.toString('utf8').split(db.password).join('[redacted]')).slice(-10000);
    port=Number(/RocketbrainBomFixture listening on (\d+)/.exec(recent)?.[1]||port);
  };
  child.stdout.on('data',capture);child.stderr.on('data',capture);
  const endedPromise=new Promise(resolve=>{
    child.once('exit',()=>{ended=true;resolve();});child.once('error',()=>{ended=true;resolve();});
  });
  try{
    const deadline=Date.now()+35000;
    while(!ended&&Date.now()<deadline){
      if(port){
        const response=await fetch('http://127.0.0.1:'+port+'/bom-probe',{signal:AbortSignal.timeout(1500)}).catch(()=>null);
        if(response?.ok){const data=await response.json();if(data.nonce===nonce)return data;}
      }
      await new Promise(resolve=>setTimeout(resolve,125));
    }
    throw Error('The owned Maven Boot probe did not become ready.\n'+recent.slice(-1800));
  }finally{
    if(!ended)child.kill();
    await endedPromise;
  }
}

module.exports={root,output,boot,drivers,pomFor,starterCatalog,serveCatalog,buildRuntime,readDatabase,mavenBuild,runProbe};
