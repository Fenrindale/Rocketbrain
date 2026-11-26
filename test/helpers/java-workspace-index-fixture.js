'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSpec } = require('../../src/java/workbench-tasks');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');

function write(root, file, source) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source);
  return target;
}

async function buildIndexFixture(workspace, tools) {
  const maven = path.join(workspace, 'maven'), gradle = path.join(workspace, 'gradle');
  write(maven, 'pom.xml', [
    '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>',
    '<groupId>dev.rocketbrain.fixture</groupId><artifactId>index-maven</artifactId><version>1</version>',
    '<properties><maven.compiler.release>25</maven.compiler.release></properties>',
    '<build><plugins><plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId>',
    '<version>3.14.1</version></plugin></plugins></build></project>'
  ].join('\n'));
  const mavenReader = write(maven, 'src/main/java/index/fixture/maven/MavenReader.java',
    'package index.fixture.maven;\npublic final class MavenReader { public static int value() { return 20; } }\n');
  write(gradle, 'settings.gradle', "rootProject.name = 'index-gradle'\n");
  write(gradle, 'build.gradle', [
    "plugins { id 'java' }",
    "def generatedJava = layout.buildDirectory.dir('generated/sources/indexProbe/java')",
    'sourceSets.main.java.srcDir(generatedJava)',
    "tasks.register('generateIndexProbe') {",
    '    outputs.dir(generatedJava)',
    '    doLast {',
    "        def output = generatedJava.get().file('index/fixture/generated/GeneratedLabel.java').asFile",
    '        output.parentFile.mkdirs()',
    "        output.text = 'package index.fixture.generated; public final class GeneratedLabel { public static int value() { return 22; } }'",
    '    }',
    '}',
    "tasks.named('compileJava') { dependsOn 'generateIndexProbe' }"
  ].join('\n') + '\n');
  const gradleReader = write(gradle, 'src/main/java/index/fixture/gradle/GradleReader.java', [
    'package index.fixture.gradle;', 'import index.fixture.generated.GeneratedLabel;',
    'public final class GradleReader { public static int value() { return GeneratedLabel.value(); } }'
  ].join('\n') + '\n');
  for (const [root, tool, task] of [[maven, 'maven', 'compile'], [gradle, 'gradle', 'classes']]) {
    fs.mkdirSync(path.join(root, 'src/test/java'), { recursive: true });
    const build = buildSpec({ root, tool, name: 'index-' + tool }, tools, [task]);
    const result = await execute(build.command, [...build.args, '--offline'],
      { cwd: root, env: build.env, timeoutMs: 120000 });
    assert.equal(result.code, 0, result.output);
  }
  const generated = path.join(gradle, 'build/generated/sources/indexProbe/java/index/fixture/generated/GeneratedLabel.java');
  assert.ok(fs.statSync(generated).isFile());
  return { maven, gradle, mavenReader, gradleReader, generated,
    outputs: [path.join(maven, 'target/classes'), path.join(gradle, 'build/classes/java/main')] };
}

async function querySpring(scratch, fixture, runtime, engine, classpathFile, config) {
  fs.mkdirSync(scratch, { recursive: true });
  const file = write(scratch, 'IndexSpringProbe.java', [
    'import index.fixture.gradle.GradleReader;', 'import index.fixture.maven.MavenReader;',
    'import org.springframework.jdbc.core.JdbcTemplate;', 'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class IndexSpringProbe {',
    '    public static void main(String[] args) {',
    '        JdbcTemplate jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_INDEX_JDBC_URL"),',
    '            System.getenv("RB_INDEX_JDBC_USER"), System.getenv("RB_INDEX_JDBC_PASSWORD")));',
    '        int value = MavenReader.value() + GradleReader.value();',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '            jdbc.queryForObject("SELECT ?", Integer.class, value));',
    '    }', '}'
  ].join('\n'));
  const classpath = [...fixture.outputs, ...await springJdbcClasspath(classpathFile, engine)];
  const result = await runJavaFixture({ javaHome: runtime.javaHome, file, binaryDirectory: scratch,
    className: 'IndexSpringProbe', classpath, config, engine, jdbcPrefix: 'RB_INDEX' });
  assert.equal(result.output.trim(), '42');
  return { engine, server: result.server, value: Number(result.output.trim()) };
}

module.exports = { buildIndexFixture, querySpring };
