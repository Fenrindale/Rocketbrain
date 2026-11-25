'use strict';

const { springJdbcClasspath,runJavaFixture }=require('./instance-inline-fixture');

function callFlowFixture(namespace,name) {
  const callerName=name+'Caller', helperName=name+'Helper', runnerName=name+'Runner';
  const caller=[
    'package '+namespace+';',
    'final class '+callerName+' {',
    '    static int first(int raw) {',
    '        var output = '+helperName+'.scale(raw + 1);',
    '        var ignored = '+helperName+'.scale(99);',
    '        return output + 4;',
    '    }',
    '    static int alternate(int incoming) {',
    '        return '+helperName+'.scale(incoming);',
    '    }',
    '    int receiver(int raw) {',
    '        var converted = this.privateDouble(raw);',
    '        return converted;',
    '    }',
    '    private int privateDouble(int value) { return value * 2; }',
    '    static String maybe(boolean flag, String input) {',
    '        var selected = '+helperName+'.choose(flag, input);',
    '        return selected;',
    '    }',
    '}',''
  ].join('\n');
  const helper=[
    'package '+namespace+';',
    'final class '+helperName+' {',
    '    static int scale(int value) {',
    '        int shifted = value * 2;',
    '        return shifted;',
    '    }',
    '    static String scale(String other) { return other; }',
    '    static String choose(boolean flag, String input) {',
    '        return flag ? input : null;',
    '    }',
    '    static String fixed(String input) { return true ? input : null; }',
    '    static int recursive(int seed) { return recursive(seed); }',
    '    static int external(int seed) { return Math.abs(seed); }',
    '    static int virtual(int seed) { return new '+name+'Virtual().value(seed); }',
    '}',
    'class '+name+'Virtual { int value(int input) { return input; } }',''
  ].join('\n');
  const runner=[
    'package '+namespace+';',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class '+runnerName+' {',
    '    public static void main(String[] args) {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_CALL_FLOW_JDBC_URL"),',
    '            System.getenv("RB_CALL_FLOW_JDBC_USER"), System.getenv("RB_CALL_FLOW_JDBC_PASSWORD")));',
    '        int input = jdbc.queryForObject("SELECT 42", Integer.class);',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + '+callerName+'.first(input)',
    '            + ":" + '+callerName+'.maybe(true, "present") + ":" + ('+callerName+'.maybe(false, "absent") == null));',
    '    }',
    '}',''
  ].join('\n');
  return {callerName,helperName,runnerName,caller,helper,runner,
    scaleKey:namespace+'.'+helperName+'#scale(int)',firstKey:namespace+'.'+callerName+'#first(int)',
    alternateKey:namespace+'.'+callerName+'#alternate(int)',runnerClass:namespace+'.'+runnerName};
}

const runSpringCallFlow=options=>runJavaFixture({...options,jdbcPrefix:'RB_CALL_FLOW'});

module.exports={callFlowFixture,springJdbcClasspath,runSpringCallFlow};
