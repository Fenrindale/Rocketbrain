'use strict';

const {springJdbcClasspath,runJavaFixture}=require('./instance-inline-fixture');

function springDiagramFixture(namespace,name,{alternate=false}={}) {
  return [
    'package '+namespace+';',
    'import java.'+(alternate?'util':'sql')+'.Date;',
    'import java.sql.SQLException;',
    'import java.util.List;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public final class '+name+' {',
    '    static class Request { '+name+' owner; }',
    '    private Date lastResult;',
    '    private List<? extends Date[]> history;',
    '    private java.util.Date previous;',
    '    '+name+'(Date initial) { lastResult = initial; }',
    '    Date lookup(Request request, JdbcTemplate jdbc) throws SQLException {',
    '        long value = jdbc.queryForObject("SELECT 42", Long.class);',
    '        return new Date(value);',
    '    }',
    '    public static void main(String[] args) throws SQLException {',
    '        var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_UML_JDBC_URL"),',
    '            System.getenv("RB_UML_JDBC_USER"), System.getenv("RB_UML_JDBC_PASSWORD")));',
    '        var value = new '+name+'(new Date(0)).lookup(new Request(),jdbc);',
    '        System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + value.getTime());',
    '    }',
    '}',''
  ].join('\n');
}

const executeSpringDiagram=options=>runJavaFixture({...options,jdbcPrefix:'RB_UML'});

module.exports={springDiagramFixture,springJdbcClasspath,executeSpringDiagram};
