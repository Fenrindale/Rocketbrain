'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { inspectEmbedded, replacementFor } = require('../src/db/embedded-language');

function replace(source, snippet, value) {
  return source.slice(0, snippet.start) + replacementFor(snippet, value) + source.slice(snippet.end);
}

test('Java SQL extracts a text block with its source spans and re-encodes edited runtime text', () => {
  const source = 'class Run { String sql = """\r\n    SELECT "name"\r\n    FROM person\r\n    """; }';
  const selection = inspectEmbedded('java', 'sql', source, source.indexOf('SELECT'));
  assert.equal(selection.text, 'SELECT "name"\nFROM person\n');
  assert.equal(selection.map[0], source.indexOf('SELECT'));
  assert.equal(selection.ends.at(-1) - selection.map.at(-1), 2);
  assert.equal(replace(source, selection, selection.text), source);
  const edited = 'SELECT \'\\u000a\'\nFROM person\tWHERE id = ?';
  const changed = replace(source, selection, edited);
  assert.equal(inspectEmbedded('java', 'sql', changed, selection.start).text, edited);
  assert.equal(changed.slice(0, selection.start), source.slice(0, selection.start));
  assert.equal(changed.slice(-4), source.slice(-4));
});

test('Java JSON validates edited text and refuses ambiguous or nonliteral source', () => {
  const source = String.raw`class X { String json = "{\"message\":\"one\"}"; }`;
  const snippet = inspectEmbedded('java', 'json', source, source.indexOf('message'));
  const updated = JSON.stringify({ message: '" \\ \u00b7' });
  assert.equal(inspectEmbedded('java', 'json', replace(source, snippet, updated), snippet.start).text, updated);
  assert.throws(() => replacementFor(snippet, '{ broken'), /JSON syntax/);
  assert.throws(() => inspectEmbedded('java', 'json', source, source.indexOf('String')), /inside one Java string/);
  const ambiguous = String.raw`// x \u000a class X { String y = "{}"; }`;
  assert.throws(() => inspectEmbedded('java', 'json', ambiguous, ambiguous.indexOf('{}')), /uncertain/);
});

test('MyBatis XML normalizes physical line endings and preserves literal entities and CDATA boundaries', () => {
  const doctype = '<!DOCTYPE mapper PUBLIC "-//mybatis.org//DTD Mapper 3.0//EN" "https://mybatis.org/dtd/mybatis-3-mapper.dtd">';
  const source = doctype + '<mapper namespace="sample.Users"><select id="find">\r\nSELECT id &lt; 3 AND name &lt;&gt; \'X\'\r\n</select>' +
    '<sql id="fragment">\r\n<![CDATA[SELECT id > 3]]>\r\n</sql></mapper>';
  const snippet = inspectEmbedded('xml', 'sql', source, source.indexOf('SELECT'));
  assert.equal(snippet.text, '\nSELECT id < 3 AND name <> \'X\'\n');
  assert.equal(snippet.ends[0] - snippet.map[0], 2);
  const entityOffset = snippet.text.indexOf('<');
  assert.equal(source.slice(snippet.map[entityOffset], snippet.ends[entityOffset]), '&lt;');
  const updated = '\nSELECT \'A & B\', id * 2 >= 4\n';
  assert.deepEqual(inspectEmbedded('xml', 'sql', replace(source, snippet, updated), snippet.start).text, updated);
  const cdata = inspectEmbedded('xml', 'sql', source, source.indexOf('SELECT', source.indexOf('CDATA')));
  assert.equal(cdata.text, 'SELECT id > 3');
  assert.throws(() => replacementFor(cdata, "SELECT ']]>'"), /one XML CDATA/);
});

test('MyBatis XML rejects dynamic content and any custom entity declaration', () => {
  const first = '<mapper namespace="sample.Users"><select id="find">SELECT id ';
  const last = '</select></mapper>';
  for (const expression of ['<if test="id">WHERE id = 1</if>', 'WHERE id = #{id}', 'FROM ${table}']) {
    const source = first + expression + last;
    assert.throws(() => inspectEmbedded('xml', 'sql', source, source.indexOf('SELECT')), /static MyBatis/);
  }
  const source = '<!DOCTYPE mapper [<!ENTITY example SYSTEM "example.dtd">]>' + first + last;
  assert.throws(() => inspectEmbedded('xml', 'sql', source, source.indexOf('SELECT')), /no external content is loaded/);
});

test('SQL JSON round-trips quotes, backslashes and apostrophes in both SQL string modes', () => {
  for (const sqlMode of [[], ['NO_BACKSLASH_ESCAPES', 'ANSI_QUOTES']]) {
    const value = JSON.stringify({ name: "it's valid", letters: 'a\\b' });
    const escaped = sqlMode.includes('NO_BACKSLASH_ESCAPES') ? value : value.replaceAll('\\', '\\\\');
    const source = "SELECT JSON_VALID('" + escaped.replaceAll("'", "''") + "')";
    const snippet = inspectEmbedded('sql', 'json', source, source.indexOf('name'), sqlMode);
    assert.equal(snippet.text, value);
    const updated = JSON.stringify({ name: "S'ea", path: 'C:\\folder', notes: '\n' });
    const changed = replace(source, snippet, updated);
    assert.equal(inspectEmbedded('sql', 'json', changed, snippet.start, sqlMode).text, updated);
    assert.throws(() => inspectEmbedded('sql', 'json', changed, snippet.start), /SQL string mode/);
  }
  const source = "SELECT '{}' 'others'";
  assert.throws(() => inspectEmbedded('sql', 'json', source, source.indexOf('{}'), []), /one single-quoted/);
});
