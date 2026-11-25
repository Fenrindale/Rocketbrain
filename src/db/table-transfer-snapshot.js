'use strict';

const { identifier } = require('./schema-rename');
const { createRowSpool } = require('./table-transfer-spool');
const { outcomeOf } = require('./activity-log');

const streamLimits = Object.freeze({
  rows: 1000000, bytes: 1024 ** 3, rowBytes: 1024 ** 2, cellBytes: 128 * 1024, wireRowBytes: 512 * 1024,
  bufferedRows: 1, captureMs: 600000, lifetimeMs: 30 * 60 * 1000
});
const fail = (message, code = 'ROCKETBRAIN_TABLE_TRANSFER') => Object.assign(new Error(message), { code });
const quote = (name, table = false) => '`' + identifier(name, { table }).replaceAll('`', '``') + '`';

function boundedProjection(columns, field) {
  const counts = columns.map(column => 'COALESCE(OCTET_LENGTH(' + field(column.name) + '), 0)');
  const sizes = columns.map((column, index) => counts[index] + ' > ' +
    (column.kind === 'binary' ? Math.floor((streamLimits.cellBytes - 2) / 2) : streamLimits.cellBytes));
  const exceeds = '(' + [...sizes, '(' + counts.join(' + ') + ') > ' + streamLimits.wireRowBytes].join(' OR ') + ')';
  let flag = '__rb_source_overflow';
  while (columns.some(column => column.name.toLowerCase() === flag)) flag += '_';
  const value = column => /^bit(?:\(|$)/i.test(column.type) ? 'CAST(CAST(' + field(column.name) + ' AS UNSIGNED) AS CHAR)' : field(column.name);
  const projection = columns.map(column => 'CASE WHEN ' + exceeds + ' THEN NULL ELSE ' + value(column) + ' END AS ' + quote(column.name));
  const fields = [...projection, 'CASE WHEN ' + exceeds + ' THEN 1 ELSE 0 END AS ' + quote(flag)].join(', ');
  return { fields, headers: [...columns.map(column => column.name), flag], flag };
}

function sourceQuery(schema, table, columns, keys) {
  const field = name => 'rb_source.' + quote(name);
  const { fields, headers, flag } = boundedProjection(columns, field);
  const sql = 'SELECT ' + fields + ' FROM ' + quote(schema, true) + '.' + quote(table, true) +
    ' AS rb_source ORDER BY ' + keys.map(key => field(key.name)).join(', ');
  return { sql, headers, flag };
}

async function readSnapshot({ db, session, schema, table, columns, keys, cancellation, onProgress, check, serializeRow, verify, directory }) {
  const { sql, headers } = sourceQuery(schema, table, columns, keys);
  const spool = await createRowSpool({ columns, maxRows: streamLimits.rows, maxRowBytes: streamLimits.rowBytes, maxBytes: streamLimits.bytes, directory });
  let stream, active, retained = false, report, reportedError, stopped;
  const close = error => {
    stopped ||= error;
    if (session.connected) db._lose(session, error);
    else stream?.destroy(error);
  };
  const guard = () => { if (stopped) throw stopped; check(); };
  const cancel = () => close(fail('Table copy cancelled.', 'ROCKETBRAIN_CANCELLED'));
  const timer = setTimeout(() => close(fail('The owned source read timed out.', 'ROCKETBRAIN_TIMEOUT')), streamLimits.captureMs);
  timer.unref?.();
  cancellation?.addEventListener('abort', cancel, { once: true });
  try {
    guard();
    await db._control(session, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db._control(session, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    await db._refreshState(session);
    if (!session.inTransaction) throw fail('The owned read-only snapshot could not be established.');
    guard();

    const query = session.connection.query({ sql, rowsAsArray: true });
    report = db._activity?.(session, { category: 'transfer', operation: 'SELECT' });
    stream = query.stream({ highWaterMark: streamLimits.bufferedRows });
    active = { mayWrite: false, abort: error => stream.destroy(error) };
    session.active = active;
    let fieldsSeen = false, fieldsValid = false;
    stream.on('fields', fields => {
      fieldsValid = !fieldsSeen && fields.length === headers.length && fields.every((field, index) => field.name === headers[index]);
      fieldsSeen = true;
    });
    let rowCount = 0, maxBufferedRows = 0;
    for await (const row of stream) {
      guard();
      if (!fieldsValid || !Array.isArray(row) || row.length !== headers.length) throw fail('The source projection changed during capture.');
      if (String(row.at(-1)) !== '0') throw fail('A source row or cell exceeds its streaming byte bound.');
      maxBufferedRows = Math.max(maxBufferedRows, stream.readableLength);
      await spool.append(serializeRow(row.slice(0, -1), rowCount), cancellation);
      rowCount++;
      if (rowCount % 128 === 0) await onProgress?.({ rows: rowCount });
    }
    if (session.active === active) session.active = null;
    guard();
    if (!fieldsValid || !session.connected) throw fail('The source read did not complete on its owned session.');
    const warnings = await db._stream(session, 'SHOW WARNINGS', [], { maxRows: 1, timeoutMs: 5000 }, false);
    if (warnings.rows.length || warnings.truncated) throw fail('The source read returned server warnings.');
    await db._refreshState(session);
    if (!session.inTransaction) throw fail('The owned source snapshot was lost before capture completed.');
    await verify();
    await db._control(session, 'ROLLBACK');
    await db._refreshState(session);
    if (session.inTransaction) throw fail('The owned source transaction failed to close.');
    guard();
    const sealed = await spool.seal(cancellation);
    await onProgress?.({ rows: sealed.rowCount });
    guard();
    retained = true;
    return { spool, ...sealed, maxBufferedRows };
  } catch (error) {
    reportedError = error?.code || true;
    if (String(error?.code || '').startsWith('ROCKETBRAIN_')) throw error;
    throw fail('The owned source stream could not be read or sealed. No snapshot was retained.');
  } finally {
    clearTimeout(timer);
    cancellation?.removeEventListener('abort', cancel);
    if (session.active === active) session.active = null;
    try { report?.(outcomeOf(reportedError)); } catch { /* Diagnostics are independent of capture. */ }
    if (!retained) {
      if (session.connected) db._lose(session, fail('The owned source session closed.'));
      stream?.destroy();
      await spool.dispose();
    }
  }
}

module.exports = { boundedProjection, readSnapshot, sourceQuery, streamLimits };
