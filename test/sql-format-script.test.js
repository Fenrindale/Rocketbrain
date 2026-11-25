'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { formatSql } = require('../src/db/sql-format');

test('DELIMITER scripts format nested procedural statements without changing separators or literal bytes', () => {
  const source = ["DELIMITER $$", "CREATE PROCEDURE f() lab:BEGIN DECLARE n INT DEFAULT 0; " +
    "IF n < 1 THEN SELECT CASE n WHEN 0 THEN 'a;$$' ELSE 'b' END; ELSEIF n < 3 THEN SET n=3; ELSE SET n=4; END IF; " +
    "REPEAT SET n=n+1; UNTIL n>10 END REPEAT; CASE n WHEN 0 THEN SET n=1; ELSE SET n=2; END CASE; END lab$$",
  "DELIMITER ~rb~", 'CREATE TRIGGER t BEFORE INSERT ON journal FOR EACH ROW BEGIN SET NEW.value = `NEW`.`value`; END~rb~',
  'DELIMITER ;', "SELECT 'single; quoted' FROM dual;"].join('\r\n');
  const output = formatSql(source, { dialect: 'mysql', sqlMode: [], indent: '\t' });
  assert.match(output, /PROCEDURE f\(\)\r\nlab:BEGIN\r\n\tDECLARE/);
  assert.match(output, /\r\n\tIF n < 1 THEN\r\n\t\tSELECT CASE n WHEN 0 THEN 'a;\$\$' ELSE 'b' END;/);
  assert.match(output, /\r\n\tELSEIF.*\r\n\t\tSET n=3;\r\n\tELSE\r\n\t\tSET n=4;\r\n\tEND IF;/);
  assert.match(output, /REPEAT\r\n\t\tSET n=n\+1;\r\n\t\tUNTIL n>10\r\n\tEND REPEAT;/);
  assert.match(output, /CASE n\r\n\t\tWHEN 0 THEN\r\n\t\t\tSET n=1;\r\n\t\tELSE\r\n\t\t\tSET n=2;\r\n\tEND CASE;/);
  assert.match(output, /END lab\$\$\r\nDELIMITER ~rb~\r\n/);
  assert.match(output, /SET NEW\.value = `NEW`\.`value`;\r\nEND~rb~/);
  assert.equal(formatSql(output, { dialect: 'mysql', sqlMode: [], indent: '\t' }), output);
  assert.doesNotMatch(output, /(?<!\r)\n/);
});

test('the formatter preserves strings, client-like text in comments and known quote semantics', () => {
  const source = '/* First comment\nDELIMITER nope\n*/\nDELIMITER //\n' +
    'CREATE PROCEDURE f() BEGIN SELECT "quoted\nDELIMITER nope\n//" FROM `t//`; # //\n END//\nDELIMITER ;\n';
  const formatted = formatSql(source, { sqlMode: ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'] });
  assert.ok(formatted.includes('/* First comment\nDELIMITER nope\n*/'));
  assert.ok(formatted.includes('"quoted\nDELIMITER nope\n//" FROM `t//`; # //\n END//'));
  assert.equal(formatSql(formatted, { sqlMode: ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'] }), formatted);
  assert.throws(() => formatSql(source), /SQL.*ANSI_QUOTES/);
  assert.match(formatSql(String.raw`SELECT 'C:\tmp;raw' FROM dual;`, { sqlMode: ['NO_BACKSLASH_ESCAPES'] }), /C:\\tmp;raw/);
});

test('uses the MariaDB anonymous block dialect and the configured compact query layout', () => {
  const anonymous = 'DELIMITER //\nBEGIN NOT ATOMIC IF 1 THEN SELECT 1; END IF; END//\nDELIMITER ;';
  assert.match(formatSql(anonymous, { dialect: 'mariadb' }), /BEGIN NOT ATOMIC\n  IF 1 THEN\n    SELECT 1;\n  END IF;\nEND\/\//);
  assert.throws(() => formatSql(anonymous, { dialect: 'mysql' }), /MariaDB/);
  const compact = formatSql('SELECT 1,  2\nFROM dual\nWHERE 1=1;', { style: 'compact' });
  assert.equal(compact, 'SELECT 1, 2 FROM dual WHERE 1=1;');
  assert.equal(formatSql(compact, { style: 'compact' }), compact);
  assert.throws(() => formatSql(compact, { style: 'arbitrary' }), /expanded or compact/);
});

test('keyword casing is scoped to syntax and leaves identifiers, expression text and client directives exact', () => {
  const source = 'delimiter $$\ncreate procedure MixedCase() Lab:begin if 1 then SELECT CASE WHEN 1 THEN \'BEGIN\' ELSE \'END\' END AS ExactLabel; end if; end Lab$$\n' +
    'delimiter ;\nselect q.CasedColumn AS ExactColumn from `Company` q group by q.CasedColumn;';
  const upper = formatSql(source, { keywordCase: 'upper' });
  assert.match(upper, /delimiter \$\$\nCREATE PROCEDURE MixedCase\(\)\nLab:BEGIN\n  IF 1 THEN/);
  assert.match(upper, /SELECT CASE WHEN 1 THEN 'BEGIN' ELSE 'END' END AS ExactLabel;/);
  assert.match(upper, /END IF;\nEND Lab\$\$/);
  assert.match(upper, /SELECT q\.CasedColumn AS ExactColumn\nFROM `Company` q\nGROUP BY q\.CasedColumn;/);
  const lower = formatSql(upper, { keywordCase: 'lower' });
  assert.match(lower, /create procedure MixedCase\(\)\nLab:begin\n  if 1 then/);
  assert.match(lower, /SELECT CASE WHEN 1 THEN 'BEGIN' ELSE 'END' END AS ExactLabel;/);
  assert.match(lower, /end if;\nend Lab\$\$/);
  assert.match(lower, /select q\.CasedColumn AS ExactColumn\nfrom `Company` q\ngroup by q\.CasedColumn;/);
  assert.equal(formatSql(lower, { keywordCase: 'lower' }), lower);
});

test('refuses ambiguous directives, executable comments, and malformed routine frames', () => {
  const samples = ['DELIMITER qq\nSELECT 1 qq', 'DELIMITER /*\nSELECT 1;',
    'SELECT 1\nDELIMITER $$\nSELECT 2$$', 'DELIMITER $$\nSELECT 1', 'SELECT 1 /*!80100 + 2 */;',
    'DELIMITER //\nCREATE PROCEDURE f() BEGIN IF 1 THEN SELECT 1; END LOOP; END//',
    'DELIMITER //\nCREATE PROCEDURE f() BEGIN SELECT 1; //', 'DELIMITER //\nCREATE PACKAGE f AS BEGIN x; END//'];
  for (const source of samples) assert.throws(() => formatSql(source));
  assert.throws(() => formatSql('SELECT 1;\n'.repeat(101)), /100 SQL statements/);
});
