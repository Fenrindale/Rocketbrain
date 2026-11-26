'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {springTypeRenameClasspath} = require('./java-type-rename-fixture');
const {runJavaFixture} = require('./instance-inline-fixture');

function innerMoveFixture(pkg,prefix) {
  const owner = prefix + 'Owner', inner = prefix + 'Report', caller = prefix + 'Caller';
  const ownerText = [
    'package ' + pkg + ';',
    'public class ' + owner + ' {',
    '    int score;',
    '    int delta(int value) { return value + 1; }',
    '    public class ' + inner + ' {',
    '        private final int input;',
    '        public ' + inner + '(int input) { this.input = input; }',
    '        public int read() { return ' + owner + '.this.score + delta(input); }',
    '    }',
    '    ' + inner + ' implicit(int value) { return new ' + inner + '(value); }',
    '    public static class ' + prefix + 'Static { public ' + prefix + 'Static() {} }',
    '}', ''
  ].join('\n');
  const callerText = [
    'package ' + pkg + ';',
    'import org.springframework.context.support.GenericApplicationContext;',
    'import org.springframework.jdbc.core.JdbcTemplate;',
    'import org.springframework.jdbc.datasource.DriverManagerDataSource;',
    'public class ' + caller + ' {',
    '    static int trace;',
    '    static ' + owner + ' owner(' + owner + ' selected) { trace = trace * 10 + 1; return selected; }',
    '    static int value(int input) { trace = trace * 10 + 2; return input; }',
    '    static ' + owner + '.' + inner + ' call(' + owner + ' selected, int input) {',
    '        return owner(selected).new ' + inner + '(value(input));',
    '    }',
    '    public static void main(String[] args) {',
    '        try (var context = new GenericApplicationContext()) {',
    '            context.registerBean("first", ' + owner + '.class);',
    '            context.registerBean("second", ' + owner + '.class);',
    '            context.refresh();',
    '            var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_INNER_JDBC_URL"),',
    '                System.getenv("RB_INNER_JDBC_USER"), System.getenv("RB_INNER_JDBC_PASSWORD")));',
    '            int input = jdbc.queryForObject("SELECT 4", Integer.class);',
    '            var first = context.getBean("first", ' + owner + '.class);',
    '            var second = context.getBean("second", ' + owner + '.class);',
    '            first.score = 20;',
    '            second.score = 50;',
    '            var report = call(first, input);',
    '            int successOrder = trace;',
    '            first.score = 25;',
    '            trace = 0;',
    '            int nullOrder = -1;',
    '            try { call(null, input); } catch (NullPointerException absent) { nullOrder = trace; }',
    '            System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|");',
    '            System.out.print(report.read() + ":" + second.implicit(input).read() + ":" + successOrder + ":" + nullOrder);',
    '        }',
    '    }',
    '}', ''
  ].join('\n');
  return {owner,inner,caller,ownerText,callerText,className:pkg+'.'+caller,expected:'30:55:12:1'};
}

async function innerMoveRuntime({javaHome,classpathFile,configFile,engine,files,fixture,workspace}) {
  const config = JSON.parse(await fs.readFile(configFile,'utf8'));
  const marker = JSON.parse(await fs.readFile(path.join(path.dirname(configFile),'owner.json'),'utf8'));
  assert.equal(marker.kind,engine === 'mysql' ? 'RocketbrainDisposableOracleMysqlFixture-v1' : 'RocketbrainDisposableMariaDbFixture-v1');
  const classpath = await springTypeRenameClasspath(classpathFile,engine);
  const binaryDirectory = await fs.mkdtemp(path.join(workspace,'classes-'));
  const result = await runJavaFixture({javaHome,files,binaryDirectory,className:fixture.className,classpath,config,engine,jdbcPrefix:'RB_INNER'});
  assert.equal(result.output,fixture.expected);
  return result;
}

module.exports = {innerMoveFixture,innerMoveRuntime};
