'use strict';
const fs=require('node:fs'),path=require('node:path');
function fixtureTestingConfig(runtime){
  const workspace=runtime.projectPath,db=JSON.parse(fs.readFileSync(runtime.dbConfigPath,'utf8'));
  const javaFile=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG||path.resolve(__dirname,'../test-output/v0.4-java-host-runtime.json');
  const javaHome=JSON.parse(fs.readFileSync(javaFile,'utf8')).javaHome;
  const runtimePath=process.env.ROCKETBRAIN_JAVA_TESTING_RUNTIME||path.resolve(__dirname,'../test-output/java-testing-runtime/java-testing-runtime.json');
  return {id:'actual-spring-'+runtime.dbEngine,label:'Actual Spring · '+runtime.dbEngine,workspace,javaHome,runtimePath,classPath:fs.readFileSync(path.join(workspace,'build/test-runtime-classpath.txt'),'utf8').split(path.delimiter).filter(file=>fs.existsSync(file)||path.extname(file).toLowerCase()==='.jar'),testClassPaths:[path.join(workspace,'build/classes/java/test')],sourceRoots:[path.join(workspace,'src/main/java'),path.join(workspace,'src/test/java')],classDirectories:[path.join(workspace,'build/classes/java/main')],outputRoot:path.resolve('test-output/v0.9-java-test-runs'),timeoutMs:90000,
    env:{SPRING_DATASOURCE_URL:runtime.dbEngine==='mariadb'?'jdbc:mariadb://127.0.0.1:'+db.port+'/'+db.database:'jdbc:mysql://127.0.0.1:'+db.port+'/'+db.database+'?allowPublicKeyRetrieval=true&sslMode=DISABLED',SPRING_DATASOURCE_USERNAME:db.user,SPRING_DATASOURCE_PASSWORD:db.password,SPRING_DATASOURCE_DRIVER_CLASS_NAME:runtime.dbEngine==='mariadb'?'org.mariadb.jdbc.Driver':'com.mysql.cj.jdbc.Driver',FIXTURE_SEED_ENABLED:'false',SPRING_JPA_HIBERNATE_DDL_AUTO:'none',SPRING_JPA_HIBERNATE_NAMING_PHYSICAL_STRATEGY:runtime.namingStrategy?.physical||'org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl',SPRING_JPA_HIBERNATE_NAMING_IMPLICIT_STRATEGY:runtime.namingStrategy?.implicit||'org.hibernate.boot.model.naming.ImplicitNamingStrategyJpaCompliantImpl'}};
}
module.exports={fixtureTestingConfig};
