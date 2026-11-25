'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');

async function verifyExtractor(configPath, adapter) {
  const folder = path.dirname(configPath);
  const owner = JSON.parse(await fs.readFile(path.join(folder, 'owner.json'), 'utf8'));
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.ok(['RocketbrainDisposableMariaDbFixture-v1', 'RocketbrainDisposableOracleMysqlFixture-v1'].includes(owner.kind));
  assert.equal(config.host, '127.0.0.1');
  const suffix = randomBytes(5).toString('hex');
  const table = 'rb_extractor_' + suffix;
  const file = path.join(folder, 'rb-extractor-' + suffix + '.jsonl');
  const actor = await mysql.createConnection(config);
  try {
    await actor.query(`CREATE TABLE ${table} (id BIGINT NOT NULL PRIMARY KEY, amount DECIMAL(22,6), payload VARBINARY(8), note VARCHAR(80))`);
    await actor.query(`INSERT INTO ${table} VALUES (?, ?, UNHEX(?), ?), (?, ?, UNHEX(?), ?)`,
      ['9007199254740994', '10000000000000.000001', '000AFF', '테스트', '9007199254740995', '-10000000000000.000000', 'FAFE', null]);
    const { api, id, show } = await adapter(config, `SELECT id, amount, payload, note FROM ${table} ORDER BY id`);
    const source = JSON.stringify({ version: 1, name: 'Fixture typed rows', extension: 'jsonl',
      header: ['{"schema":', { meta: 'source.schema', as: 'json' }, ',"columns": [',
        { columns: { template: ['{"name":', { meta: 'column.name', as: 'json' }, ',"kind":', { meta: 'column.kind', as: 'json' }, '}'], separator: ',' } }, ']}\n'],
      row: ['[', { cell: 'id', as: 'json' }, ',', { cell: 'amount', as: 'json' }, ',', { cell: 'payload', as: 'json' }, ',', { cell: 'note', as: 'json' }, ']\n'],
      footer: ['{"total":', { aggregate: { operation: 'sum', cell: 'amount' }, as: 'json' }, ',"rows":', { meta: 'rows.emitted' }, '}\n'] });
    const review = await api.prepare(id, source);
    assert.equal(review.schema, config.database);
    assert.equal(review.table, table);
    assert.equal(review.previewClipped, false);
    assert.equal(review.partial, false);
    await show?.(review);
    const report = await api.write(review.id, file, { confirmed: true });
    assert.equal(report.sha256, review.sha256);
    const byteStream = await fs.readFile(file);
    assert.equal(byteStream.length, review.bytes);
    assert.equal(createHash('sha256').update(byteStream).digest('hex'), review.sha256);
    const [header, first, second, footer] = byteStream.toString('utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(header.schema, config.database);
    assert.deepEqual(header.columns, [{ name: 'id', kind: 'integer' }, { name: 'amount', kind: 'decimal' },
      { name: 'payload', kind: 'binary-hex' }, { name: 'note', kind: 'text' }]);
    assert.deepEqual(first, ['9007199254740994', '10000000000000.000001', '0x000aff', '테스트']);
    assert.deepEqual(second, ['9007199254740995', '-10000000000000.000000', '0xfafe', null]);
    assert.deepEqual(footer, { total: '0.000001', rows: 2 });
    return { typedColumns: true, exactAggregate: true, sameReviewedBytes: true, rows: 2, bytes: report.bytes, nativePreview: Boolean(show) };
  } finally {
    try { await actor.query('DROP TABLE IF EXISTS ' + table); }
    finally {
      await actor.end();
      await fs.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}

async function runDataExtractorChecks(api, vscode, checks) {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('rocketbrain.db.newDataExtractor') && commands.includes('rocketbrain.db.exportWithExtractor'));
  try {
    const proof = await verifyExtractor(runtime.dbConfigPath, async (config, sql) => {
      await api.connectMysql(config);
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ language: 'sql', content: sql }));
      const id = await vscode.commands.executeCommand('rocketbrain.runQuery');
      assert.ok(Number.isInteger(id));
      return { api: api.dataExtractors, id, async show(review) {
        const uri = vscode.Uri.from({ scheme: 'rocketbrain-extractor-preview', path: '/' + review.id });
        const document = await vscode.workspace.openTextDocument(uri);
        assert.ok(document.getText().includes('Output SHA-256 ' + review.sha256));
        assert.ok(document.getText().includes('9007199254740994'));
      } };
    });
    checks.push('custom extractor program, typed native result, read-only preview, reviewed streamed bytes');
    return proof;
  } finally { await api.disconnectMysql(); }
}

module.exports = { runDataExtractorChecks, verifyExtractor };
