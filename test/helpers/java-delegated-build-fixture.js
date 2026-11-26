'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {buildFingerprint,id} = require('../../src/java/workbench-model');

const directory = 'src/main/java/fixture/delegated';
const adjustment = value => [
  'package fixture.delegated;',
  'public final class Adjustment {',
  '    public static int add() { return '+value+'; }',
  '}',''
].join('\n');

const gradle = [
  "plugins { id 'java' }",
  'repositories { mavenCentral() }',
  'java { sourceCompatibility = JavaVersion.VERSION_25; targetCompatibility = JavaVersion.VERSION_25 }',
  'dependencies {',
  "    implementation 'org.springframework:spring-jdbc:7.0.10'",
  "    implementation 'commons-logging:commons-logging:1.3.6'",
  '}',
  ''
].join('\n');
const pom = [
  '<project xmlns="http://maven.apache.org/POM/4.0.0">',
  '  <modelVersion>4.0.0</modelVersion>',
  '  <groupId>fixture.delegated</groupId><artifactId>delegated-probe</artifactId><version>1.0</version>',
  '  <properties><maven.compiler.release>25</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>',
  '  <dependencies>',
  '    <dependency><groupId>org.springframework</groupId><artifactId>spring-jdbc</artifactId><version>7.0.10</version></dependency>',
  '    <dependency><groupId>commons-logging</groupId><artifactId>commons-logging</artifactId><version>1.3.6</version></dependency>',
  '  </dependencies>',
  '  <build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.14.1</version></plugin></plugins></build>',
  '</project>',''
].join('\n');

const probe = [
  'package fixture.delegated;',
  'import org.springframework.jdbc.core.JdbcTemplate;',
  'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
  'public final class Probe {',
  '    public static void main(String[] args) {',
  '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_DELEGATED_JDBC_URL"),',
  '            System.getenv("RB_DELEGATED_JDBC_USER"), System.getenv("RB_DELEGATED_JDBC_PASSWORD")));',
  '        int result = jdbc.queryForObject("SELECT 21", Integer.class) + Adjustment.add();',
  '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + result);',
  '    }',
  '}',''
].join('\n');

async function createProject(root,tool) {
  const sources = path.join(root,directory);
  await fs.mkdir(sources,{recursive:true});
  if (tool==='maven') await fs.writeFile(path.join(root,'pom.xml'),pom);
  else {
    await fs.writeFile(path.join(root,'build.gradle'),gradle);
    await fs.writeFile(path.join(root,'settings.gradle'),"rootProject.name = 'delegated-probe'\n");
  }
  const source = path.join(sources,'Adjustment.java');
  await fs.writeFile(source,adjustment('2'));
  await fs.writeFile(path.join(sources,'Unrelated.java'),'package fixture.delegated; final class Unrelated { int value() { return 63; } }\n');
  await fs.writeFile(path.join(sources,'Probe.java'),probe);
  return {source,model:()=>({id:id('project',root),uri:pathToFileURL(root).href,root,tool,name:path.basename(root),
    buildFingerprint:buildFingerprint(root)})};
}

module.exports = {createProject,adjustment,directory};
