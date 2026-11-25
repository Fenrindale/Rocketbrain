'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const principal = require('../src/db/database-principal-create');
const { registerDatabaseAdmin } = require('../src/db/database-admin-vscode');

const target = { kind: 'account', user: 'sample_owner', host: '127.0.0.1' };
const role = { kind: 'role', user: 'sample_reader' };

function fixture({ dialect = 'mysql', mode = '', rows = [], after = [], outcome } = {}) {
  const sql = [], commands = [], session = { connected: true };
  let current = rows, live = true;
  const identity = { dialect, version: dialect === 'mysql' ? '8.4.13' : '11.4.8-MariaDB', currentUser: 'operator@127.0.0.1',
    hostname: 'example.local', port: '3306', database: 'project', sqlMode: mode, serverUniqueId: 'owned' };
  const transport = { _withSession: fn => fn(session), _identity: async () => ({ ...identity }), async _read(_session, statement, input) {
    sql.push([statement, input]);
    if (statement.includes('mysql.roles_mapping')) return [['Y']];
    assert.match(statement, /SELECT User,Host,(?:account_locked|is_role) FROM mysql\.user/u);
    return current;
  } };
  const lease = { epoch: 1, guard: () => live, db: { _schemaRenamer: transport, async _control(_session, statement) {
    commands.push(statement);
    if (outcome === 'lost') { session.connected = false; throw Error('never expose secret'); }
    if (outcome === 'rejected') throw Error('never expose secret');
    current = after;
    return { warningStatus: outcome === 'warning' ? 1 : 0 };
  } } };
  return { sql, commands, lease, identity, replace(rows) { current = rows; }, detach() { live = false; } };
}

test('creation previews retain exact identifiers without accepting or returning a password', async () => {
  const fx = fixture();
  const reviewed = await principal.plan(fx.lease, { ...target, host: 'HOST.Example.Local' });
  assert.equal(reviewed.target.host, 'host.example.local');
  assert.match(reviewed.sql, /IDENTIFIED BY <password supplied on apply>/u);
  assert.equal(fx.commands.length, 0);
  await assert.rejects(principal.plan(fx.lease, { ...target, password: 'should not become a preview option' }), /Choose one/u);
  for (const host of ['%', '10.0.0.0/8', "localhost'@'other", 'fe80::1%eth0', 'unsafe host']) {
    await assert.rejects(principal.plan(fx.lease, { ...target, host }), /explicit account host/u);
  }
  await assert.rejects(principal.plan(fx.lease, { kind: 'role', user: 'none' }), /unreserved role/u);
  await assert.rejects(principal.plan(fx.lease, { ...role, host: 'localhost' }), /server supplies/u);
  fx.replace([[target.user, target.host, 'N']]);
  await assert.rejects(principal.plan(fx.lease, target), /already exists/u);
});

test('quoted secrets stay in the single SQL-mode-aware dispatch and never in a result', async () => {
  const secret = "secret!'\\;끝";
  for (const mode of ['STRICT_TRANS_TABLES', 'NO_BACKSLASH_ESCAPES']) {
    const fx = fixture({ mode, after: [[target.user, target.host, 'N']] });
    const reviewed = await principal.plan(fx.lease, target);
    const result = await principal.apply(fx.lease, reviewed, secret);
    assert.deepEqual(result, { state: 'verified', acknowledged: true, automaticRetry: false, credentialsIncluded: false });
    const quoted = mode.startsWith('NO_BACK') ? "'secret!''\\;끝'" : "'secret!''\\\\;끝'";
    assert.deepEqual(fx.commands, [reviewed.sql.replace('<password supplied on apply>', quoted)]);
    assert.equal(fx.sql.some(entry => JSON.stringify(entry).includes(secret)), false);
    assert.equal(JSON.stringify([reviewed, result]).includes(secret), false);
  }
  for (const invalid of ['', '\n', '\u0000', '\ud800', '가'.repeat(342)]) assert.match(principal.passwordProblem(invalid), /1024 UTF-8/u);
});

test('role review accounts for locked MySQL identifiers and MariaDB creator administration', async () => {
  for (const dialect of ['mysql', 'mariadb']) {
    const fx = fixture({ dialect, after: [[role.user, dialect === 'mysql' ? '%' : '', 'Y']] });
    const reviewed = await principal.plan(fx.lease, role);
    assert.equal(reviewed.roleAdministrator, dialect === 'mysql' ? null : fx.identity.currentUser);
    assert.equal(reviewed.sql, dialect === 'mysql' ? "CREATE ROLE 'sample_reader'@'%'" : 'CREATE ROLE `sample_reader` WITH ADMIN CURRENT_USER');
    await assert.rejects(principal.apply(fx.lease, reviewed, 'extra input'), /does not accept/u);
    assert.equal(fx.commands.length, 0);
    assert.equal((await principal.apply(fx.lease, reviewed)).state, 'verified');
    assert.equal(fx.sql.some(([statement]) => statement.includes('mysql.roles_mapping')), dialect === 'mariadb');
  }
  const maria = fixture({ dialect: 'mariadb', rows: [[role.user, 'localhost', 'N']] });
  await assert.rejects(principal.plan(maria.lease, role), /already exists/u);
});

test('preflight stops identity drift and stale authorization names before credential dispatch', async () => {
  const fx = fixture();
  const reviewed = await principal.plan(fx.lease, target);
  fx.identity.serverUniqueId = 'different-server';
  await assert.rejects(principal.apply(fx.lease, reviewed, 'password'), /identity or SQL context changed/u);
  fx.identity.serverUniqueId = 'owned';
  fx.replace([[target.user, target.host, 'N']]);
  await assert.rejects(principal.apply(fx.lease, reviewed, 'password'), /authorization name or connection changed/u);
  assert.deepEqual(fx.commands, []);
});

test('missing or rejected acknowledgements are redacted and never authorize a retry', async () => {
  for (const outcome of ['warning', 'lost', 'rejected', 'mismatched']) {
    const fx = fixture({ outcome });
    const reviewed = await principal.plan(fx.lease, target);
    const result = await principal.apply(fx.lease, reviewed, 'test-ephemeral-secret');
    assert.equal(result.state, outcome === 'rejected' ? 'rejected' : 'uncertain');
    assert.equal(fx.commands.length, 1);
    assert.equal(result.automaticRetry, false);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('create GUI opens the review before explicit approval and masks credential input', async () => {
  for (const approved of [false, true]) {
    const fx = fixture({ after: [[target.user, target.host, 'N']] }), calls = [];
    const commands = new Map();
    let provider, display;
    const vscode = {
      Uri: { parse(value) { return { path: value.slice(value.indexOf(':') + 1), toString: () => value }; } },
      workspace: { isTrusted: true, registerTextDocumentContentProvider(_scheme, value) { provider = value; return { dispose() {} }; },
        async openTextDocument(uri) { return { uri, content: provider.provideTextDocumentContent(uri) }; } },
      commands: { registerCommand(name, action) { commands.set(name, action); return { dispose() {} }; } },
      window: {
        async showQuickPick(items) { calls.push('kind'); return items[0]; },
        async showInputBox(options) {
          if (options.title.startsWith('New')) { calls.push('name'); return target.user; }
          if (options.title.startsWith('Exact')) { calls.push('host'); return target.host; }
          calls.push('password');
          assert.equal(options.password, true);
          assert.equal(options.validateInput('ephemeral secret'), undefined);
          return 'ephemeral secret';
        },
        async showTextDocument(document) { calls.push('review'); display = document.content; },
        async showWarningMessage(_message, options, confirm) { calls.push('approve'); assert.equal(options.modal, true); return approved ? confirm : undefined; },
        async showInformationMessage() { calls.push('result'); }
      }
    };
    const database = { onDidChangeDatabase() { return { dispose() {} }; },
      async withDatabaseAdmin(action) { return action(fx.lease); } };
    const api = registerDatabaseAdmin({ subscriptions: [] }, vscode, { database });
    try {
      const result = await commands.get('rocketbrain.db.reviewCreatePrincipal')();
      assert.deepEqual(calls, ['kind', 'name', 'host', 'review', 'approve', ...(approved ? ['password', 'result'] : [])]);
      assert.equal(fx.commands.length, approved ? 1 : 0);
      assert.equal(result?.state, approved ? 'verified' : undefined);
      assert.match(display, /password supplied on apply/u);
      assert.doesNotMatch(display, /ephemeral secret/u);
    } finally { api.dispose(); }
  }
});
