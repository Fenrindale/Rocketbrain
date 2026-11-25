'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createExtensionManager } = require('./duckdb-extensions');

const timeoutMs = 12000;
const resultLimit = 4 * 1024 * 1024;
const diagnosticLimit = 8192;
const maxQueryBytes = 64 * 1024;
const maxColumns = 80;
const maxCellCharacters = 2048;
const maxExternalFileBytes = 1024n * 1024n * 1024n;
const fail = (code, message) => Object.assign(new Error(message), { code: 'ROCKETBRAIN_DUCKDB_' + code });
const sqlText = value => "decode(from_hex('" + Buffer.from(value, 'utf8').toString('hex') + "'))";

function nativeEnvironment() {
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
}

function collect(stream, limit, exceeded) {
  const parts = [];
  let size = 0;
  stream.on('data', data => {
    size += data.length;
    if (size > limit) exceeded();
    else parts.push(data);
  });
  return () => Buffer.concat(parts).toString('utf8');
}

function run(executable, args, source, { signal, limit = timeoutMs } = {}) {
  if (signal?.aborted) return Promise.reject(fail('CANCELLED', 'The DuckDB operation was cancelled.'));
  const child = spawn(executable, args, { env: nativeEnvironment(), windowsHide: true, shell: false,
    stdio: ['pipe', 'pipe', 'pipe'] });
  let interrupted;
  const stop = reason => {
    if (interrupted) return;
    interrupted = reason;
    child.kill('SIGKILL');
  };
  const abort = () => stop(fail('CANCELLED', 'The DuckDB operation was cancelled.'));
  const overflow = () => stop(fail('OUTPUT', 'The DuckDB output exceeded its size limit. Select fewer columns or reduce the sample.'));
  const output = collect(child.stdout, resultLimit, overflow);
  const diagnostic = collect(child.stderr, diagnosticLimit, overflow);
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(fail('TIMEOUT', 'The DuckDB operation reached its time limit.')), limit);
  timer.unref();
  const completed = new Promise((resolve, reject) => {
    child.once('error', () => reject(fail('LAUNCH', 'The selected DuckDB client could not be started.')));
    child.stdin.once('error', () => {});
    child.once('close', code => {
      if (interrupted) return reject(interrupted);
      if (code !== 0) {
        const firstLine = diagnostic().replace(/\x1b\[[\d;]*m/g, '').trim().split(/\r?\n/)[0] || '';
        const message = firstLine.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 360);
        return reject(fail('QUERY', message || 'DuckDB could not read this local database or query.'));
      }
      resolve(output());
    });
    child.stdin.end(source);
  });
  return completed.finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
}

function versionOf(output) {
  const fields = /^v?(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\s|$)/.exec(output.trim());
  if (!fields || Number(fields[1]) < 1 || fields[1] === '1' && (Number(fields[2]) < 5 || fields[2] === '5' && Number(fields[3]) < 6)) {
    throw fail('VERSION', 'Choose the official DuckDB CLI version 1.5.6 or later.');
  }
  return fields.slice(1, 4).join('.');
}

async function localFile(file, description) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^\\\\/.test(file)) {
    throw fail('PATH', 'Choose an absolute local ' + description + ' file.');
  }
  try {
    const real = await fs.realpath(file);
    if (/^\\\\/.test(real) || !(await fs.stat(real)).isFile()) throw Error('not a local file');
    return real;
  } catch { throw fail('PATH', 'The selected local ' + description + ' file is unavailable.'); }
}

async function fileStamp(file) {
  const info = await fs.stat(file, { bigint: true });
  return stamp(info);
}
const stamp = info => [info.dev, info.ino, info.size, info.mtimeNs].join(':');

async function readRows(client, args, sql, options) {
  const text = await run(client, args, sql + ';\n', options);
  try {
    const data = JSON.parse(text.trim());
    if (!Array.isArray(data)) throw Error('not an array');
    return data;
  } catch { throw fail('PROTOCOL', 'The DuckDB client returned an unexpected result.'); }
}

function resultLimitFor(options) {
  const maxRows = options.maxRows ?? 200;
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) {
    throw fail('ROWS', 'Use a DuckDB result limit between one and 500 rows.');
  }
  return maxRows;
}

async function sampleRelation(engine, expression, opts) {
  const maxRows = resultLimitFor(opts);
  const schema = await engine('DESCRIBE ' + expression, opts);
  if (!schema.length || schema.length > maxColumns) throw fail('COLUMNS', 'Select a query with between one and 80 result columns.');
  const names = schema.map((value, index) => 'c' + index);
  const expressions = names.map(name => `LEFT(CAST(${name} AS VARCHAR), ${maxCellCharacters + 1}) AS ${name}`);
  const data = await engine(`WITH rb_result(${names.join(',')}) AS (${expression})
    SELECT ${expressions.join(',')} FROM rb_result LIMIT ${maxRows + 1}`, opts);
  let clippedCells = 0;
  const rows = data.slice(0, maxRows).map(row => names.map(name => {
    const value = row[name];
    if (value === null || value === undefined) return null;
    if (value.length <= maxCellCharacters) return value;
    const codepoints = Array.from(value);
    if (codepoints.length <= maxCellCharacters) return value;
    clippedCells++;
    return codepoints.slice(0, maxCellCharacters).join('') + '…';
  }));
  return { columns: schema.map(column => ({ name: column.column_name, type: column.column_type })),
    rows, clippedCells, truncated: data.length > maxRows };
}

async function openDuckDb(clientPath, databasePath, options = {}) {
  const client = await localFile(clientPath, 'DuckDB executable');
  if (path.basename(clientPath).toLowerCase() !== (process.platform === 'win32' ? 'duckdb.exe' : 'duckdb')) {
    throw fail('VERSION', 'Choose the official DuckDB command line executable.');
  }
  const database = await localFile(databasePath, 'DuckDB database');
  const executableStamp = await fileStamp(client);
  const version = versionOf(await run(client, ['-version'], undefined, { ...options, limit: 5000 }));
  const checkClient = async () => {
    if (executableStamp !== await fileStamp(client)) throw fail('VERSION', 'The selected DuckDB client changed. Open the database again.');
  };
  const extensions = createExtensionManager({ directory: options.extensionDirectory, version, read: async (args, sql, opts) => {
    await checkClient();
    return readRows(client, args, sql, opts);
  } });
  const engine = async (sql, opts) => {
    await checkClient();
    const before = await fileStamp(database);
    const load = extensions.load();
    const args = ['-batch', '-bail', '-no-init', '-readonly'];
    if (!load) args.push('-safe');
    const statement = load ? load + ' SET enable_external_access=false; SET lock_configuration=true;\n' + sql : sql;
    const rows = await readRows(client, [...args, '-json', database], statement, opts);
    if (before !== await fileStamp(database)) throw fail('CHANGED', 'The DuckDB database changed during this inspection. Refresh the query or catalog.');
    return rows;
  };
  const [observed] = await engine("SELECT current_database() AS database, version() AS version, current_setting('enable_external_access') AS external", options);
  if (!observed || observed.external !== false || typeof observed.database !== 'string' || versionOf(observed.version) !== version) {
    throw fail('PROTOCOL', 'The selected DuckDB binary did not open this database with the required safe configuration.');
  }

  async function catalog(opts = {}) {
    const objects = await engine(`SELECT * FROM (
      SELECT schema_name AS schema, table_name AS name, 'table' AS kind, estimated_size::VARCHAR AS estimated_rows
      FROM duckdb_tables() WHERE NOT internal AND database_name = current_database()
      UNION ALL
      SELECT schema_name AS schema, view_name AS name, 'view' AS kind, NULL AS estimated_rows
      FROM duckdb_views() WHERE NOT internal AND database_name = current_database()
    ) t ORDER BY schema, name, kind LIMIT 501`, opts);
    return { objects: objects.slice(0, 500), truncated: objects.length > 500 };
  }

  async function describe(object, opts = {}) {
    if (!object || typeof object.schema !== 'string' || typeof object.name !== 'string' ||
        !object.schema || !object.name || object.schema.length > 512 || object.name.length > 512) {
      throw fail('OBJECT', 'Choose an observed DuckDB table or view.');
    }
    const predicate = `database_name = current_database() AND schema_name = ${sqlText(object.schema)} AND table_name = ${sqlText(object.name)}`;
    const columns = await engine(`SELECT column_name AS name, data_type AS type, is_nullable AS nullable,
      LEFT(column_default, 256) AS default_value, LEFT(comment, 256) AS comment
      FROM duckdb_columns() WHERE NOT internal AND ${predicate} ORDER BY column_index LIMIT 201`, opts);
    return { columns: columns.slice(0, 200), truncated: columns.length > 200 };
  }

  async function functions(search, opts = {}) {
    if (typeof search !== 'string' || search.length > 96) throw fail('FUNCTION', 'Enter up to 96 characters for a DuckDB function name.');
    const term = `lower(${sqlText(search)})`;
    const match = opts.exact ? `lower(function_name) = ${term}` : opts.prefix ?
      `starts_with(lower(function_name), ${term})` : `contains(lower(function_name), ${term})`;
    const matches = await engine(`SELECT function_name AS name, function_type AS kind, return_type,
      LEFT(parameter_types::VARCHAR, 512) AS parameters, LEFT(description, 512) AS description,
      LEFT(examples::VARCHAR, 512) AS examples, internal FROM duckdb_functions()
      WHERE ${match} ORDER BY (lower(function_name) = ${term}) DESC, name, kind, parameters LIMIT 101`, opts);
    return { matches: matches.slice(0, 100), truncated: matches.length > 100 };
  }

  async function query(sql, opts = {}) {
    if (typeof sql !== 'string' || !sql.trim() || sql.includes('\0') || Buffer.byteLength(sql) > maxQueryBytes) {
      throw fail('INPUT', 'Enter a single DuckDB query up to 64 KiB.');
    }
    const before = await fileStamp(database);
    const expression = `SELECT * FROM query(${sqlText(sql)})`;
    const result = await sampleRelation(engine, expression, opts);
    if (before !== await fileStamp(database)) throw fail('CHANGED', 'The DuckDB schema changed during the query. Run it again.');
    return result;
  }

  async function previewFile(file, opts = {}) {
    const selected = await localFile(file, 'CSV or Parquet');
    const kind = path.extname(selected).toLowerCase().slice(1);
    if (!['csv', 'parquet'].includes(kind) || /[*?\[\]{}]/.test(selected)) {
      throw fail('PATH', 'Choose one CSV or Parquet file with a path that contains no glob characters.');
    }
    const stat = await fs.stat(selected, { bigint: true });
    if (stat.size === 0n || stat.size > maxExternalFileBytes) throw fail('INPUT', 'Choose a nonempty file up to 1 GiB.');
    const before = stamp(stat);
    const fileValue = sqlText(process.platform === 'win32' ? selected.replaceAll('\\', '/') : selected);
    const setup = `SET autoload_known_extensions=false; SET autoinstall_known_extensions=false;
      SET threads=2; SET memory_limit='256MB'; SET max_temp_directory_size='0B';
      SET allowed_paths=[${fileValue}]; SET enable_external_access=false; SET lock_configuration=true;\n`;
    const isolated = async (sql, options) => {
      await checkClient();
      if (before !== await fileStamp(selected)) throw fail('CHANGED', 'The selected data file changed. Choose it again.');
      return readRows(client, ['-batch', '-bail', '-no-init', '-json', ':memory:'], setup + sql, options);
    };
    const relation = kind === 'csv' ? `read_csv(${fileValue}, sample_size=2048)` : `read_parquet(${fileValue})`;
    const result = await sampleRelation(isolated, 'SELECT * FROM ' + relation, opts);
    if (before !== await fileStamp(selected)) throw fail('CHANGED', 'The selected data file changed. Choose it again.');
    return { ...result, name: path.basename(selected), kind };
  }

  return { source: { client, path: database, name: observed.database, version }, catalog, describe, functions, query, previewFile,
    extensions: extensions.inventory, manageExtension: extensions.manage };
}

module.exports = { openDuckDb };
