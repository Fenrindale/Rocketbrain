'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const { springJdbcClasspath } = require('./instance-inline-fixture');

const REQUEST = 'rocketbrain/watchKotlinCoroutine';
const EVENT = 'rocketbrainCoroutineFrame';

function watchTarget(snapshot) {
  const reference = parent => snapshot.coroutines.findIndex(item =>
    item.name === 'same-name' && snapshot.coroutines[item.parentOrdinal]?.name === parent);
  const ordinal = reference('selected-parent'), sibling = reference('sibling-parent');
  assert.ok(ordinal >= 0 && sibling >= 0);
  const selected = snapshot.coroutines[ordinal], other = snapshot.coroutines[sibling];
  assert.equal(selected.state, 'SUSPENDED');
  assert.equal(other.state, 'SUSPENDED');
  assert.ok(selected.debugFrame?.sequence && other.debugFrame?.sequence);
  assert.notEqual(selected.debugFrame.sequence, other.debugFrame.sequence);
  assert.equal(selected.debugFrame.className, other.debugFrame.className);
  assert.equal(selected.debugFrame.line, other.debugFrame.line);
  return { ordinal, selected: selected.debugFrame, sibling: other.debugFrame };
}

function watchRequest(descriptor, snapshot, target) {
  return { action: 'watch', pid: String(descriptor.pid), session: descriptor.session,
    capture: snapshot.debugCapture, ordinal: target.ordinal, watch: randomUUID(), ...target.selected };
}

async function jdbcOptions({ engine, classpathFile, configFile }) {
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  assert.ok(['mysql', 'mariadb'].includes(engine));
  assert.equal(config.host, '127.0.0.1');
  assert.ok(Number.isInteger(config.port) && config.port > 0 && config.port < 65536);
  assert.match(config.database, /^[a-z_]+$/u);
  const classpath = await springJdbcClasspath(classpathFile, engine);
  const env = {
    RB_COROUTINE_JDBC_URL: 'jdbc:' + engine + '://127.0.0.1:' + config.port + '/' + config.database +
      (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''),
    RB_COROUTINE_JDBC_USER: config.user,
    RB_COROUTINE_JDBC_PASSWORD: config.password
  };
  return { classpath, env, mainClass: 'coroutinesfixture.CoroutineWatch' };
}

function jdbcResult(output, engine) {
  const match = /Rocketbrain coroutine JDBC\|([^|\r\n]+)\|(\d+)/u.exec(output);
  assert.ok(match, 'Spring JDBC did not report its server and selected value.');
  assert.match(match[1], engine === 'mysql' ? /^8\.4\./u : /^11\.4\..*MariaDB/u);
  assert.equal(match[2], '42');
  return { engine, server: match[1], amount: Number(match[2]) };
}

module.exports = { watchTarget, watchRequest, jdbcOptions, jdbcResult, REQUEST, EVENT };
