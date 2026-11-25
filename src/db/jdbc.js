'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { inspectCompilerJar } = require('../java/signature-compiler');
const { validateQuery } = require('./sql-policy');
const source = require('./jdbc-worker-source.json');

const jarLimit = 64 * 1024 * 1024;
const outputLimit = 4 * 1024 * 1024;
const protocol = 'RBJDBC1';
const fail = (code, message) => Object.assign(Error(message), { code: 'ROCKETBRAIN_JDBC_' + code });
const text = (value, maximum) => typeof value === 'string' && Buffer.byteLength(value) <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const classPattern = /^(?:[A-Za-z_$][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/;
const localPath = value => text(value, 4096) && path.isAbsolute(value) && !/^\\\\/.test(value);

async function driverCopy(file, destination, signal) {
  if (!localPath(file) || path.extname(file).toLowerCase() !== '.jar') throw fail('JAR', 'Choose one local JDBC driver JAR.');
  const resolved = await fs.realpath(file);
  if (!localPath(resolved)) throw fail('JAR', 'Choose one local JDBC driver JAR.');
  const handle = await fs.open(resolved, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || !info.size || info.size > jarLimit) throw fail('JAR', 'Choose a JDBC driver JAR of at most 64 MiB.');
    const output = await fs.open(destination, 'wx', 0o600);
    const digest = createHash('sha256');
    let size = 0;
    const meter = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      if (signal?.aborted || size > jarLimit) return done(fail('JAR', 'The JDBC driver copy was cancelled or exceeded 64 MiB.'));
      digest.update(chunk);
      done(null, chunk);
    } });
    try {
      await pipeline(handle.createReadStream(), meter, output.createWriteStream());
      return { sha256: digest.digest('hex'), size };
    } finally { await output.close(); }
  } finally { await handle.close(); }
}

async function scratch(action) {
  const folder = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-jdbc-'));
  const driver = path.join(folder, 'driver.jar'), worker = path.join(folder, 'DriverWorker.java');
  try { return await action({ folder, driver, worker }); }
  finally {
    for (const file of [worker, driver]) await fs.unlink(file).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
    await fs.rmdir(folder);
  }
}

async function inspect(file, destination, signal) {
  const copied = await driverCopy(file, destination, signal);
  await inspectCompilerJar(destination).catch(() => { throw fail('JAR', 'The selected JDBC artifact is not a supported regular JAR.'); });
  return copied;
}

function driverClass(value) {
  if (!text(value, 256) || !classPattern.test(value)) throw fail('CLASS', 'Enter the JDBC driver’s fully qualified Java class name.');
  return value;
}

async function examineJdbcDriver(file, driver, signal) {
  driverClass(driver);
  if (!localPath(file)) throw fail('JAR', 'Choose a local JDBC driver JAR.');
  const jar = await fs.realpath(file);
  const details = await scratch(async ({ driver: destination }) => inspect(jar, destination, signal));
  return { jar, driverClass: driver, ...details };
}

async function javaExecutable(home) {
  if (!localPath(home)) throw fail('JAVA', 'Configure the independent Rocketbrain Java JDK before using a JDBC driver.');
  try {
    const root = await fs.realpath(home);
    const descriptor = path.join(root, 'release');
    if ((await fs.stat(descriptor)).size > 65536) throw Error('release descriptor too large');
    const release = await fs.readFile(descriptor, 'utf8');
    const major = Number(/(?:^|\n)JAVA_VERSION="(\d+)/.exec(release)?.[1]);
    if (!Number.isInteger(major) || major < 25 || /JetBrains/i.test(release) || /(?:^|[\\/])(?:JetBrains|jbr)(?:[\\/]|$)/i.test(root)) {
      throw Error('unsupported java distribution');
    }
    for (const name of ['java', 'javac']) {
      if (!(await fs.stat(path.join(root, 'bin', name + (process.platform === 'win32' ? '.exe' : '')))).isFile()) throw Error('JDK is incomplete');
    }
    return { root, executable: path.join(root, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') };
  } catch { throw fail('JAVA', 'Use a complete independent JDK 25 or newer for JDBC.'); }
}

function credentials(value) {
  if (!text(value?.url, 4096) || !/^jdbc:[a-z][a-z0-9_-]{0,63}:/i.test(value.url) || !text(value.user, 1024) ||
      typeof value.password !== 'string' || Buffer.byteLength(value.password) > 16384 || value.password.includes('\0')) {
    throw fail('CONNECTION', 'Enter a bounded JDBC URL, user name and password.');
  }
  return { url: value.url, user: value.user, password: value.password };
}

function wire(value) { return Buffer.from(String(value), 'utf8').toString('base64'); }

function response(output, operation) {
  const lines = output.trimEnd().split(/\r?\n/);
  const columns = [], rows = [], objects = [];
  let connection, truncated;
  for (const line of lines) {
    const [marker, type, ...encoded] = line.split('\t');
    if (marker !== protocol) throw fail('PROTOCOL', 'The JDBC driver returned an unsupported response.');
    const fields = encoded.map(item => item === '-' ? null : Buffer.from(item, 'base64').toString('utf8'));
    if (type === 'E' && fields.length === 1 && /^[A-Z0-9]{5}$/.test(fields[0])) {
      if (fields[0] === 'RB001') throw fail('LIMIT', 'The JDBC result has a column or value above the supported limit.');
      if (fields[0] === 'RB002') throw fail('JAR', 'The JDBC driver bytes changed after approval.');
      if (fields[0] === 'RB003') throw fail('READ_ONLY', 'The JDBC driver did not accept a read-only connection.');
      if (fields[0] === 'JDBC0') throw fail('DRIVER', 'The JDBC driver could not be initialized. Check its class and separate dependencies.');
      throw fail('SERVER', 'The JDBC operation failed (SQLSTATE ' + fields[0] + ').');
    }
    if (type === 'I' && operation === 'catalog' && fields.length === 6) {
      const [product, version, driver, driverVersion, catalog, schema] = fields;
      connection = { product, version, driver, driverVersion, catalog, schema };
    } else if (type === 'T' && operation === 'catalog' && fields.length === 4 && objects.length < 500) {
      const [catalog, schema, name, kind] = fields;
      objects.push({ catalog, schema, name, kind });
    } else if (type === 'C' && operation !== 'catalog' && fields.length === 6 && columns.length < 250) {
      const [name, jdbcType, typeName, nullable, precision, scale] = fields;
      columns.push({ name, jdbcType: Number(jdbcType), typeName, nullable: nullable === '1' || nullable === 'YES' ? true :
        nullable === '0' || nullable === 'NO' ? false : null,
      precision: precision === null ? null : Number(precision), scale: scale === null ? null : Number(scale) });
    } else if (type === 'R' && operation === 'query' && rows.length < 500 && fields.length === columns.length) rows.push(fields);
    else if (type === 'D' && fields.length === 1 && ['true', 'false'].includes(fields[0]) && truncated === undefined) truncated = fields[0] === 'true';
    else throw fail('PROTOCOL', 'The JDBC driver returned an unsupported response.');
  }
  if (truncated === undefined || operation === 'catalog' && !connection || operation === 'query' && !columns.length) {
    throw fail('PROTOCOL', 'The JDBC driver response is incomplete.');
  }
  if (operation === 'catalog') return { connection, objects, truncated };
  return operation === 'query' ? { columns, rows, truncated } : { columns, truncated };
}

function execute(java, operation, directory, args, signal) {
  if (signal?.aborted) return Promise.reject(fail('CANCELLED', 'JDBC operation cancelled.'));
  const allowed = new Set(['SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => allowed.has(name.toUpperCase())));
  const child = spawn(java.executable, ['-Xmx256m', '-XX:ActiveProcessorCount=2', '-Duser.home=.', '-Djava.io.tmpdir=.',
    '--class-path', '.', '--source', '25', 'DriverWorker.java'], { cwd: directory, windowsHide: true, shell: false,
    env, stdio: ['pipe', 'pipe', 'ignore'] });
  const parts = [];
  let bytes = 0, interrupted, grace;
  const stop = reason => {
    if (interrupted) return;
    interrupted = reason;
    try { child.stdin.write('CANCEL\n'); } catch { }
    grace = setTimeout(() => child.kill('SIGKILL'), 700);
    grace.unref();
  };
  const cancel = () => stop(fail('CANCELLED', 'JDBC operation cancelled.'));
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => stop(fail('TIMEOUT', 'The JDBC operation reached its time limit.')), 18000);
  timer.unref();
  return new Promise((resolve, reject) => {
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > outputLimit) stop(fail('LIMIT', 'The JDBC output exceeded 4 MiB. Select fewer columns or rows.'));
      else parts.push(chunk);
    });
    child.once('error', () => reject(fail('JAVA', 'The independent JDBC JVM could not start.')));
    child.once('close', code => {
      if (interrupted) return reject(interrupted);
      try {
        const result = response(Buffer.concat(parts).toString('utf8'), operation);
        if (code) throw fail('DRIVER', 'The JDBC JVM did not complete this operation.');
        resolve(result);
      } catch (cause) { reject(cause); }
    });
    child.stdin.write(protocol + '\n' + args.map(wire).join('\n') + '\n');
  }).finally(() => { clearTimeout(timer); clearTimeout(grace); signal?.removeEventListener('abort', cancel); });
}

async function runJdbc({ javaHome, profile, credential, operation, sql = '', object = {}, maxRows = 200, signal }) {
  if (!['catalog', 'describe', 'query'].includes(operation)) throw fail('OPERATION', 'Select a supported JDBC operation.');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 500) throw fail('LIMIT', 'Choose a JDBC result size between one and 500 rows.');
  if (!isHash(profile?.sha256)) throw fail('JAR', 'Review the JDBC driver and its exact SHA-256 before connecting.');
  const driver = driverClass(profile.driverClass), auth = credentials(credential);
  if (operation === 'query') validateQuery(sql, { readOnly: true, allowOptimizerHints: false });
  const names = [object.catalog ?? '', object.schema ?? '', object.name ?? ''];
  if (names.some(name => !text(name, 1024)) || operation === 'describe' && !names[2]) throw fail('OBJECT', 'Choose an observed JDBC table or view.');
  const java = await javaExecutable(javaHome);
  return scratch(async ({ folder, driver: destination, worker }) => {
    const observed = await inspect(profile.jar, destination, signal);
    if (observed.sha256 !== profile.sha256) throw fail('JAR', 'The JDBC JAR bytes changed. Review the new driver before launching it.');
    await fs.writeFile(worker, source, { flag: 'wx', mode: 0o600 });
    return execute(java, operation, folder, [profile.sha256, driver, auth.url, auth.user, auth.password, operation, sql, ...names, maxRows], signal);
  });
}

module.exports = { examineJdbcDriver, runJdbc, credentials };
