'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execute } = require('../../src/java/testing/provision');
const { springJdbcClasspath, runJavaFixture } = require('./instance-inline-fixture');
const { populateSignatureReferences } = require('./java-signature-references-fixture');

const sourceFolder = 'src/main/java/fixture/constructor';
const target = path.join(sourceFolder, 'AdjustedCounter.java');
const fixtureSources = new Map();
const source = (className, body) => fixtureSources.set(path.join(sourceFolder, className + '.java'),
  'package fixture.constructor;\n' + body.join('\n') + '\n');

source('AdjustedCounter', [
  'final class AdjustedCounter {',
  '    private static String trace = "";',
  '    private final int value;',
  '    private AdjustedCounter(int left, int discardedSlot, int right) { value = left + right; }',
  '    private static int count(String token, int number) { trace += token; return number; }',
  '    static String observe() {',
  '        int ignoredLocal = 48;',
  '        var left = new AdjustedCounter(count("A", 11), 15, count("B", 9));',
  '        var right = new AdjustedCounter(count("C", 12), ignoredLocal, count("D", 10));',
  '        return (left.value + right.value) + ":" + trace;',
  '    }',
  '}'
]);
source('UsedCounter', [
  'final class UsedCounter {',
  '    private UsedCounter(int usedSlot) {',
  '        Runnable reader = new Runnable() { public void run() { System.out.print(usedSlot); } };',
  '        reader.run();',
  '    }',
  '}'
]);
source('EffectCounter', [
  'final class EffectCounter {',
  '    private EffectCounter(int effectSlot) {}',
  '    static int effect() { throw new IllegalStateException(); }',
  '    static Object allocate() { return new EffectCounter(effect()); }',
  '}'
]);
source('BoxedCounter', [
  'final class BoxedCounter {',
  '    private BoxedCounter(int unboxedSlot) {}',
  '    static Object allocate(Integer value) { return new BoxedCounter(value); }',
  '}'
]);
source('OverloadedCounter', [
  'final class OverloadedCounter {',
  '    private OverloadedCounter(int overloadedSlot) {}',
  '    private OverloadedCounter() {}',
  '}'
]);
source('ReferencedCounter', [
  'final class ReferencedCounter {',
  '    private ReferencedCounter(int referenceSlot) {}',
  '    static java.util.function.IntFunction<ReferencedCounter> factory() { return ReferencedCounter::new; }',
  '}'
]);
source('ExplicitCounter', [
  'import org.springframework.beans.factory.annotation.Autowired;',
  'final class ExplicitCounter {',
  '    @Autowired private ExplicitCounter(Integer explicitInjectionSlot) {}',
  '}'
]);
source('ImplicitCounter', [
  'final class ImplicitCounter {',
  '    private ImplicitCounter(Integer implicitInjectionSlot) {}',
  '}'
]);
source('FixtureConfig', [
  'import org.springframework.context.annotation.Bean;',
  'import org.springframework.context.annotation.Configuration;',
  'import org.springframework.context.annotation.Import;',
  '@Configuration(proxyBeanMethods = false)',
  '@Import({ExplicitCounter.class, ImplicitCounter.class})',
  'class FixtureConfig {',
  '    @Bean Integer suppliedNumber() { return 42; }',
  '    @Bean String auditedResult() { return AdjustedCounter.observe(); }',
  '}'
]);

const negatives = [
  ['UsedCounter', 'usedSlot', /parameter is used/u],
  ['EffectCounter', 'effectSlot', /side effects or a throwing conversion/u],
  ['BoxedCounter', 'unboxedSlot', /side effects or a throwing conversion/u],
  ['OverloadedCounter', 'overloadedSlot', /Overloaded constructors/u],
  ['ReferencedCounter', 'referenceSlot', /Constructor method references/u],
  ['ExplicitCounter', 'explicitInjectionSlot', /annotated constructor/u],
  ['ImplicitCounter', 'implicitInjectionSlot', /class literal can register/u]
];

async function frameworkClasspath(classpathFile, engine) {
  const framework = ['spring-context-7.0.10.jar', 'spring-aop-7.0.10.jar', 'spring-expression-7.0.10.jar',
    'micrometer-observation-1.17.2.jar', 'micrometer-commons-1.17.2.jar'];
  const configured = (await fs.readFile(classpathFile, 'utf8')).trim().split(path.delimiter);
  const jars = framework.map(name => configured.find(file => path.basename(file) === name));
  assert.ok(jars.every(Boolean));
  return [...await springJdbcClasspath(classpathFile, engine), ...jars];
}

async function populateConstructorDelete(root, classpathFile, engine) {
  await populateSignatureReferences(root, await frameworkClasspath(classpathFile, engine), fixtureSources);
}

async function runConstructorSpring({ root, work, javaHome, classpathFile, engine, database }) {
  const jars = await frameworkClasspath(classpathFile, engine);
  await fs.mkdir(work, { recursive: true });
  const name = 'ConstructorQueryProbe';
  const main = path.join(work, name + '.java');
  await fs.writeFile(main, [
    'package fixture.constructor;',
    'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class ConstructorQueryProbe {',
    '   public static void main(String[] args) {',
    '       try (var context = new AnnotationConfigApplicationContext(FixtureConfig.class)) {',
    '           if (context.getBean(ExplicitCounter.class) == null || context.getBean(ImplicitCounter.class) == null) {',
    '               throw new AssertionError("Missing constructor injection");',
    '           }',
    '           String bean = context.getBean(String.class);',
    '           var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_CTOR_JDBC_URL"),',
    '               System.getenv("RB_CTOR_JDBC_USER"), System.getenv("RB_CTOR_JDBC_PASSWORD")));',
    '           String server = jdbc.queryForObject("SELECT VERSION()", String.class);',
    '           int value = jdbc.queryForObject("SELECT ?", Integer.class, Integer.parseInt(bean.substring(0, 2)));',
    '           System.out.print(server + "|" + value + bean.substring(2));',
    '       }',
    '   }', '}'
  ].join('\n'));
  const binary = name => path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const compiled = await execute(binary('javac'), ['-proc:none','-encoding','UTF-8','-classpath',jars.join(path.delimiter),
    '-d', work, ...[...fixtureSources.keys()].map(relative => path.join(root, relative))],
    { cwd: work, timeoutMs: 30000 });
  assert.equal(compiled.code, 0, compiled.output);
  const result = await runJavaFixture({ javaHome, file: main, binaryDirectory: work, className: 'fixture.constructor.' + name,
    classpath: [work,...jars], config: database, engine, jdbcPrefix: 'RB_CTOR' });
  assert.equal(result.output.trim(), '42:ABCD');
  return { engine, server: result.server, result: result.output.trim(), explicitAndImplicitConstructorInjection: true };
}

module.exports = { target, fixtureSources, sourceFolder, negatives, populateConstructorDelete, runConstructorSpring };
