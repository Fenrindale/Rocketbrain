'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { springJdbcClasspath,runJavaFixture } = require('./instance-inline-fixture');
const { normalizeEndpoint } = require('../../src/spring/runtime-client');

function qualifierFixture(namespace,name) {
  const names={ mysql:name+'Mysql', maria:name+'Maria', alias:name+'Alias', observed:name+'Observed', component:name+'Component',
    wrong:name+'Wrong', hidden:name+'Hidden', repeated:name+'Repeated', explicit:name+'Read', draft:name+'Draft' };
  const reader=name+'Reader', actual=name+'JdbcReader', consumer=name+'Consumer', component=name+'ComponentReader', condition=name+'Available';
  const source=[
    'package '+namespace+';',
    'import org.springframework.beans.factory.annotation.Autowired;',
    'import org.springframework.beans.factory.annotation.Qualifier;',
    'import org.springframework.boot.actuate.beans.BeansEndpoint;',
    'import org.springframework.context.annotation.*;',
    'import org.springframework.core.type.AnnotatedTypeMetadata;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'import org.springframework.stereotype.Component;',
    '@Configuration(proxyBeanMethods = false)',
    'public class '+name+' {',
    '    @Bean JdbcTemplate jdbc() {',
    '        return new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_QUALIFIER_JDBC_URL"),',
    '            System.getenv("RB_QUALIFIER_JDBC_USER"), System.getenv("RB_QUALIFIER_JDBC_PASSWORD")));',
    '    }',
    '    @Bean(name = {"'+names.mysql+'", "'+names.alias+'"}) @Profile("mysql") @Qualifier("'+names.explicit+'")',
    '    '+actual+' mysql(JdbcTemplate jdbc) { return new '+actual+'(jdbc); }',
    '    @Bean(name = "'+names.maria+'") @Profile("mariadb") @Qualifier("'+names.explicit+'")',
    '    '+actual+' maria(JdbcTemplate jdbc) { return new '+actual+'(jdbc); }',
    '    @Bean(name = "'+names.observed+'") @Conditional('+condition+'.class)',
    '    '+actual+' observed(JdbcTemplate jdbc) { return new '+actual+'(jdbc, 1); }',
    '    @Bean(name = "'+names.wrong+'") String wrong() { return "wrong type"; }',
    '    @Bean(name = "'+names.hidden+'", autowireCandidate = false)',
    '    '+actual+' hidden(JdbcTemplate jdbc) { return new '+actual+'(jdbc); }',
    '    @Bean @Qualifier("'+names.repeated+'") '+actual+' '+name+'First(JdbcTemplate jdbc) { return new '+actual+'(jdbc); }',
    '    @Bean @Qualifier("'+names.repeated+'") '+actual+' '+name+'Second(JdbcTemplate jdbc) { return new '+actual+'(jdbc); }',
    '    @Bean Runnable '+name+'Check(@Qualifier("'+names.explicit+'") '+reader+' checked) { return () -> {}; }',
    '    public static void main(String[] args) {',
    '        String engine = System.getenv("RB_QUALIFIER_JDBC_URL").startsWith("jdbc:mysql:") ? "mysql" : "mariadb";',
    '        try (var context = new AnnotationConfigApplicationContext()) {',
    '            context.getEnvironment().setActiveProfiles(engine);',
    '            context.register('+name+'.class, '+consumer+'.class, '+component+'.class);',
    '            context.refresh();',
    '            var jdbc = context.getBean(JdbcTemplate.class);',
    '            var endpoint = new BeansEndpoint(context).beans().getContexts().values().iterator().next().getBeans();',
    '            var conditional = endpoint.get("'+names.observed+'");',
    '            System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" +',
    '                context.getBean('+consumer+'.class).read() + ";" + context.getEnvironment().getActiveProfiles()[0] +',
    '                ";" + conditional.getType().getName());',
    '        }',
    '    }',
    '}',
    'interface '+reader+' { long read(); }',
    'final class '+actual+' implements '+reader+' {',
    '    private final JdbcTemplate jdbc;',
    '    private final int increment;',
    '    '+actual+'(JdbcTemplate jdbc) { this(jdbc, 0); }',
    '    '+actual+'(JdbcTemplate jdbc, int increment) { this.jdbc = jdbc; this.increment = increment; }',
    '    public long read() { return jdbc.queryForObject("SELECT 42", Long.class) + increment; }',
    '}',
    '@Component("'+names.component+'") final class '+component+' implements '+reader+' {',
    '    public long read() { return 0; }',
    '}',
    '@Component final class '+consumer+' {',
    '    private final '+reader+' reader;',
    '    @Autowired @Qualifier("'+names.explicit+'") private '+reader+' field;',
    '    @Autowired void initialize(@Qualifier("'+names.explicit+'") '+reader+' candidate) {}',
    '    '+consumer+'(@Qualifier(value = "'+names.draft+'") '+reader+' reader) { this.reader = reader; }',
    '    long read() { return field.read() + reader.read(); }',
    '}',
    'final class '+condition+' implements Condition {',
    '    public boolean matches(ConditionContext context, AnnotatedTypeMetadata metadata) { return true; }',
    '}',''
  ].join('\n');
  return {source,names,reader:namespace+'.'+reader,actual:namespace+'.'+actual,className:namespace+'.'+name};
}

async function qualifierClasspath(file,engine) {
  const common=await springJdbcClasspath(file,engine);
  const extraNames=new Set(['spring-context-7.0.10.jar','spring-aop-7.0.10.jar','spring-expression-7.0.10.jar',
    'spring-boot-actuator-4.1.2.jar','spring-boot-4.1.2.jar','micrometer-observation-1.17.2.jar','micrometer-commons-1.17.2.jar']);
  const extra=(await fs.readFile(file,'utf8')).trim().split(path.delimiter).filter(entry=>extraNames.has(path.basename(entry)));
  assert.deepEqual(new Set(extra.map(name=>path.basename(name))),extraNames);
  return [...common,...extra];
}

async function runQualifierFixture(options) {
  return runJavaFixture({...options,jdbcPrefix:'RB_QUALIFIER'});
}

function runtimeObservation(name,type,profile) {
  return {endpoints:{beans:{state:'available'},env:{state:'available'}},
    contexts:normalizeEndpoint('beans',{contexts:{application:{beans:{[name]:{type,aliases:[]}}}}}),
    environment:normalizeEndpoint('env',{activeProfiles:[profile],defaultProfiles:['default'],propertySources:[]})};
}

module.exports={qualifierFixture,qualifierClasspath,runQualifierFixture,runtimeObservation};
