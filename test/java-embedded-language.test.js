'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { checkJavaRegex } = require('../src/java/regex-check');
const { inspectEmbedded, replacementFor, projectionRange } = require('../src/db/embedded-language');
const { javaEmbeddedFixture, runEmbeddedFixture, originalRegex, editedRegex, originalHtml, editedHtml,
  expectedOriginal, expectedEdited } = require('./helpers/java-embedded-fixture');

const javaConfig = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile = process.env.ROCKETBRAIN_JAVA_LITERAL_CLASSPATH;
const dbFiles = ['mysql', 'mariadb'].map(engine => [engine, process.env['ROCKETBRAIN_JAVA_LITERAL_' + engine.toUpperCase() + '_CONFIG']]);
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));

function replace(source, snippet, text) {
  return source.slice(0, snippet.start) + replacementFor(snippet, text) + source.slice(snippet.end);
}

test('regex and HTML project separate Java literal ranges and preserve their respective host forms', () => {
  const source = javaEmbeddedFixture('fixture', 'Choice').replace(/\n/g, '\r\n');
  const regex = inspectEmbedded('java', 'regex', source, source.indexOf('word'));
  assert.equal(regex.text, originalRegex);
  const start = regex.text.indexOf('\\p');
  const mapped = projectionRange(regex, start, start + 2);
  assert.equal(source.slice(mapped.start, mapped.end), '\\\\p');
  assert.throws(() => projectionRange(regex, -1, 4), /valid range/);
  assert.equal(replacementFor(regex, ''), '""');
  assert.equal(replacementFor(regex, ' '), '" "');
  const withRegex = replace(source, regex, editedRegex);
  assert.equal(inspectEmbedded('java', 'regex', withRegex, regex.start).text, editedRegex);
  const html = inspectEmbedded('java', 'html', withRegex, withRegex.indexOf('<article'));
  assert.equal(html.text, originalHtml);
  for (const text of [editedHtml, editedHtml + '\n\n', '\n\t  \n """\\  ', '', '  ', '\n']) {
    const updated = replace(withRegex, html, text);
    const next = inspectEmbedded('java', 'html', updated, html.start);
    assert.equal(next.kind, 'text-block');
    assert.equal(next.text, text);
    assert.equal(updated.slice(0, html.start), withRegex.slice(0, html.start));
    assert.match(next.original, /^"""\r\n/u);
  }
});

test('the real Java regex compiler accepts Unicode properties and rejects invalid Java Pattern grammar', {
  skip: !javaConfig, timeout: 40000
}, async () => {
  const { javaHome } = await read(javaConfig);
  for (const pattern of ['', ' ', originalRegex, editedRegex, String.raw`\Q[\E`]) {
    assert.deepEqual(await checkJavaRegex(javaHome, pattern), { valid: true });
  }
  const invalid = await checkJavaRegex(javaHome, '(?<word>');
  assert.equal(invalid.valid, false);
  assert.match(invalid.description, /Unclosed group/u);
  assert.ok(invalid.index >= 0);
  await assert.rejects(checkJavaRegex(javaHome, 'x'.repeat(16385)), /bounded/u);
  await assert.rejects(checkJavaRegex(javaHome, 'a', AbortSignal.abort()), /aborted/iu);
});

test('re-encoded Java regex and HTML literals render different exact Spring JDBC outputs on both owned database products', {
  skip: !javaConfig || !classpathFile || !dbFiles.every(([, file]) => file), timeout: 100000
}, async t => {
  const { javaHome } = await read(javaConfig);
  const parent = await fs.realpath(os.tmpdir()), directory = await fs.mkdtemp(path.join(parent, 'rb-java-embedded-proof-'));
  t.after(async () => {
    assert.equal(await fs.realpath(directory), directory);
    assert.equal(path.dirname(directory), parent);
    await fs.rm(directory, { recursive: true });
  });
  const fixture = path.join(directory, 'fixture');
  await fs.mkdir(fixture);
  const file = path.join(fixture, 'Choice.java');
  const original = javaEmbeddedFixture('fixture', 'Choice');
  const before = replace(original, inspectEmbedded('java', 'regex', original, original.indexOf('word')), editedRegex);
  const edited = replace(before, inspectEmbedded('java', 'html', before, before.indexOf('<article')), editedHtml);
  const results = [];
  for (const [engine, configFile] of dbFiles) {
    const config = await read(configFile);
    const execute = () => runEmbeddedFixture({ javaHome, classpathFile, file, engine, config });
    await fs.writeFile(file, original);
    const baseline = await execute();
    assert.equal(baseline.html, expectedOriginal);
    await fs.writeFile(file, edited);
    const current = await execute();
    assert.equal(current.html, expectedEdited);
    results.push({ engine: current.engine, server: current.server, baseline: baseline.html, edited: current.html });
  }
  if (process.env.ROCKETBRAIN_JAVA_LITERAL_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_JAVA_LITERAL_RECEIPT,
    JSON.stringify({ springJdbc: '7.0.10', jdk: 'Temurin 25.0.5+8', regexValidation: 'java.util.regex.Pattern', results }) + '\n');
});
