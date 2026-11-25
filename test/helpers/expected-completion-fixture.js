'use strict';

const { springJdbcClasspath,runJavaFixture } = require('./instance-inline-fixture');

function expectedCompletionFixture(namespace,name,{spring=false}={}) {
  const source=[
    'package '+namespace+';',
    'import java.util.List;',
    'import java.util.function.Function;',
    'import java.util.stream.Stream;',
    ...(spring?['import org.springframework.jdbc.core.JdbcTemplate;','import org.springframework.jdbc.datasource.DriverManagerDataSource;']:[]),
    'public final class '+name+' {',
    '    record Value<T>(T text) { }',
    '    static Stream<Value<String>> stream(List<Integer> rows,String label) {',
    '        Value<String> ticketReady = new Value<>(label.toUpperCase(java.util.Locale.ROOT));',
    '        Value<Integer> ticketWrong = new Value<>(42);',
    '        Value<String> ticketChanged = new Value<>("first");',
    '        ticketChanged = new Value<>("changed");',
    '        Value<String> ticketUnassigned;',
    '        Stream<Value<String>> mapped = rows.stream().map(row -> ticketReady);',
    '        Value<String> ticketLater = new Value<>("later");',
    '        return mapped;',
    '    }',
    '    static <T,R> Stream<R> choose(List<T> source,Function<T,R> transform) { return source.stream().map(transform); }',
    '    static <T,R> Stream<R> choose(Stream<T> source,Function<T,R> transform) { return source.map(transform); }',
    '    static Stream<Value<String>> overloaded(List<Integer> rows,Value<String> stable,Value<Integer> wrong) {',
    '        return choose(rows,row -> stable);',
    '    }',
    '    static List<? extends Number> initializer(List<Integer> scores,List<String> scoreNames) {',
    '        List<? extends Number> result = scores;',
    '        return result;',
    '    }',
    '    static List<? extends Number> returned(List<Integer> scores,List<String> scoreNames) { return scores; }',
    '    public static void main(String[] args) {',
    ...(spring?[
      '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_EXPECTED_COMPLETION_JDBC_URL"),',
      '            System.getenv("RB_EXPECTED_COMPLETION_JDBC_USER"), System.getenv("RB_EXPECTED_COMPLETION_JDBC_PASSWORD")));',
      '        String label = jdbc.queryForObject("SELECT ?", String.class, "catalog");',
      '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");'
    ]:['        String label = "catalog";']),
    '        var value = stream(List.of(7),label).findFirst().orElseThrow();',
    '        var selected = overloaded(List.of(7),value,new Value<>(100)).findFirst().orElseThrow();',
    '        System.out.print(selected.text() + ":" + initializer(List.of(7),List.of("not a number")).getFirst());',
    '    }','}',''
  ].join('\n');
  return {source,value:'ticketReady',prefix:'ticket',marker:'row -> ticketReady',type:namespace+'.'+name+'.Value<java.lang.String>',output:'CATALOG:7'};
}

const executeExpectedFixture = options => runJavaFixture({...options,jdbcPrefix:'RB_EXPECTED_COMPLETION'});

module.exports = { expectedCompletionFixture,springJdbcClasspath,executeExpectedFixture };
