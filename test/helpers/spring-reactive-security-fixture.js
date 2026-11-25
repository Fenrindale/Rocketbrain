'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes, randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { setTimeout: delay } = require('node:timers/promises');
const { javaRuntime } = require('./spring-security-fixture');

const run = promisify(execFile);
const root = path.resolve(__dirname, '../..');
const project = path.join(root, 'test', 'fixtures', 'spring-reactive-security-app');
const jar = path.join(project, 'build', 'libs', 'spring-reactive-security-fixture-1.0.0.jar');

async function buildReactiveSecurityFixture() {
  const { home, java } = await javaRuntime();
  const gradle = process.env.ROCKETBRAIN_GRADLE_HOME ??
    path.join(root, 'research', 'implementation', 'runtimes', 'gradle-9.1.0', 'extracted', 'gradle-9.1.0');
  const cache = process.env.ROCKETBRAIN_SPRING_SECURITY_GRADLE_CACHE ?? path.join(root, 'test-output', 'java-gradle-user-home');
  await run(java, ['-Dorg.gradle.java.home=' + home, '-cp', path.join(gradle, 'lib', 'gradle-launcher-9.1.0.jar'),
    'org.gradle.launcher.GradleMain', '--no-daemon', '--console=plain', '--max-workers=2', '--gradle-user-home', cache, 'bootJar'],
  { cwd: project, windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
  await fs.access(jar);
  return jar;
}

async function databaseEnvironment(config) {
  if (!config) return {};
  const file = config.dbConfigPath;
  const db = JSON.parse(await fs.readFile(file, 'utf8'));
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'owner.json'), 'utf8'));
  const engine = config.dbEngine;
  const kind = { mysql: 'RocketbrainDisposableOracleMysqlFixture-v1', mariadb: 'RocketbrainDisposableMariaDbFixture-v1' }[engine];
  if (!kind || owner.kind !== kind || db.host !== '127.0.0.1' || !/^[A-Za-z0-9_]+$/.test(db.database) ||
      !Number.isSafeInteger(db.port) || db.port < 1024 || db.port > 65535) throw Error('Choose an owned loopback Spring database fixture.');
  return {
    RB_JDBC_URL: 'jdbc:' + engine + '://127.0.0.1:' + db.port + '/' + db.database +
      (engine === 'mysql' ? '?allowPublicKeyRetrieval=true&sslMode=DISABLED' : ''),
    RB_JDBC_USER: db.user, RB_JDBC_PASSWORD: db.password
  };
}

async function startReactiveSecurityFixture(config, { enabled = true, observerJar } = {}) {
  const { home, java } = await javaRuntime();
  const app = process.env.ROCKETBRAIN_SPRING_REACTIVE_SECURITY_JAR ?? jar;
  await fs.access(app);
  const db = await databaseEnvironment(config);
  const account = () => ({ name: 'fixture-' + randomUUID(), password: randomUUID() });
  const ops = account(), viewer = account();
  const authorization = credentials => 'Basic ' + Buffer.from(credentials.name + ':' + credentials.password).toString('base64');
  const env = { ...process.env, RB_JDBC_URL: undefined, RB_JDBC_USER: undefined, RB_JDBC_PASSWORD: undefined, ...db,
    RB_OPS: ops.name, RB_OPS_PASSWORD: ops.password, RB_VIEWER: viewer.name, RB_VIEWER_PASSWORD: viewer.password };
  const agent = observerJar ?? (await require('../../scripts/jpa-observer-build')
    .buildObserver({ target: path.join(root, 'test-output', 'reactive-security-observer'), javaHome: home })).jarPath;
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rb-reactive-security-'));
  const token = randomBytes(32).toString('hex'), tokenFile = path.join(directory, 'token');
  const descriptorFile = path.join(directory, 'connection.json'), configFile = path.join(directory, 'observer.json');
  const files = [tokenFile, descriptorFile, configFile];
  let child, exited, stopping;
  function close() {
    return stopping ??= (async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
      for (const file of files) await fs.rm(file, { force: true });
      await fs.rmdir(directory);
    })();
  }
  try {
    await fs.writeFile(tokenFile, token, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(configFile, JSON.stringify({ tokenFile, descriptorFile, securityReactiveTrace: enabled }), { flag: 'wx', mode: 0o600 });
    child = spawn(java, ['--add-modules=jdk.httpserver', '-javaagent:' + agent + '=config=' + pathToFileURL(configFile).href,
      '-jar', app, '--server.port=0', '--server.address=127.0.0.1', '--spring.output.ansi.enabled=never'],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let ended = false, output = '', port;
    exited = new Promise(resolve => {
      child.once('error', () => { ended = true; resolve(); });
      child.once('exit', () => { ended = true; resolve(); });
    });
    const collect = chunk => {
      output = (output + chunk.toString('utf8')).slice(-12000);
      port = Number(/Netty started on port (\d+)/.exec(output)?.[1]) || port;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const deadline = Date.now() + 45000;
    while (!ended && Date.now() < deadline) {
      if (port) {
        const baseUrl = 'http://127.0.0.1:' + port;
        const result = await fetch(baseUrl + '/ready', { signal: AbortSignal.timeout(1000) }).catch(() => null);
        if (result?.ok && (await result.json()).ready === true) {
          const descriptor = JSON.parse(await fs.readFile(descriptorFile, 'utf8'));
          if (descriptor.securityReactiveTraceEnabled !== enabled || descriptor.securityTraceEnabled !== false)
            throw Error('The fixture observer did not honor its scoped opt-in.');
          return { baseUrl, ops, viewer, authorization, close, observer: { url: descriptor.baseUrl, token } };
        }
      }
      await delay(80);
    }
    for (const secret of [token, db.RB_JDBC_URL, db.RB_JDBC_USER, db.RB_JDBC_PASSWORD,
      ops.name, ops.password, viewer.name, viewer.password].filter(Boolean)) output = output.replaceAll(secret, '[private]');
    throw Error('The isolated WebFlux fixture did not start. ' + output.slice(-2200));
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { buildReactiveSecurityFixture, startReactiveSecurityFixture };
if (require.main === module) buildReactiveSecurityFixture().then(console.log, error => {
  console.error(error.stderr || error.message);
  process.exitCode = 1;
});
