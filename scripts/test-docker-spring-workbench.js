'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createDockerWorkbench, dockerEnvironment } = require('../src/docker/workbench');

const engines = {
  mysql: { image: 'docker.io/library/mysql:8.4.13@sha256:8c233bad33d520a7aae1c1e619c3a9775f4a1ba2d463d692fada04ec7f40be00',
    env: 'MYSQL', admin: 'mysqladmin', driver: 'com.mysql.cj.jdbc.Driver' },
  mariadb: { image: 'docker.io/library/mariadb:11.4.8@sha256:bc474f00629f0123c10f9e1bca193a45d18af15a274cf0656acda64f1086c3b6',
    env: 'MARIADB', admin: 'mariadb-admin', driver: 'org.mariadb.jdbc.Driver' }
};

async function ready(base) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const response = await fetch(base + '/probe/ready', { signal: AbortSignal.timeout(1500) }).catch(() => null);
    if (response?.ok && (await response.json()).ready === true) {
      const state = await fetch(base + '/probe/testing-state', { signal: AbortSignal.timeout(6000) });
      assert.equal(state.ok, true);
      const rows = await state.json();
      assert.deepEqual(rows, { people: 2, departments: 1, rolledBackNames: 0 });
      return rows;
    }
    await delay(500);
  }
  throw Error('Spring did not provide its actual data readiness probe.');
}

async function main() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.ROCKETBRAIN_DOCKER_FIXTURE, '1');
  assert.ok((await fs.stat('/var/run/docker.sock')).isSocket());
  const engine = process.env.ROCKETBRAIN_DOCKER_TEST_ENGINE;
  assert.ok(Object.hasOwn(engines, engine), 'Select MySQL or MariaDB for the disposable Docker fixture.');
  const { image, env, admin, driver } = engines[engine];
  const jar = await fs.realpath(process.env.ROCKETBRAIN_DOCKER_SPRING_JAR);
  const jarStat = await fs.stat(jar);
  assert.ok(jarStat.isFile() && jar.endsWith('.jar') && jarStat.size <= 120 * 1024 * 1024);
  const jarSha256 = createHash('sha256').update(await fs.readFile(jar)).digest('hex');
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rocketbrain-docker-spring-'));
  const context = 'rb-spring-' + randomUUID().replaceAll('-', '').slice(0, 12);
  const composeFile = path.join(root, 'compose.json');
  const config = path.join(root, 'docker-config');
  const savedConfig = process.env.DOCKER_CONFIG;
  const password = randomUUID().replaceAll('-', '');
  const instance = createDockerWorkbench();
  let upAttempted = false;
  const docker = args => execFileSync('docker', args, { cwd: root, env: dockerEnvironment(), encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024 });
  const compose = ['--context', context, 'compose', '--file', composeFile, '--project-name', context];
  function address() {
    const socket = docker([...compose, 'port', 'app', '8080']).trim();
    assert.match(socket, /^127\.0\.0\.1:\d+$/);
    return 'http://' + socket;
  }
  try {
    await fs.mkdir(config);
    process.env.DOCKER_CONFIG = config;
    await fs.writeFile(composeFile, JSON.stringify({ services: {
      db: { image, environment: { [`${env}_ROOT_PASSWORD`]: randomUUID().replaceAll('-', ''),
        [`${env}_DATABASE`]: 'rocketbrain_fixture', [`${env}_USER`]: 'fixture', [`${env}_PASSWORD`]: password },
      healthcheck: { test: ['CMD', admin, 'ping', '-h', '127.0.0.1'], interval: '2s', timeout: '2s', retries: 50 } },
      app: { image: 'docker.io/library/eclipse-temurin:25-jre', entrypoint: ['java', '-jar', '/rocketbrain-fixture.jar'],
        depends_on: { db: { condition: 'service_healthy' } }, ports: ['127.0.0.1::8080'],
        volumes: [{ type: 'bind', source: jar, target: '/rocketbrain-fixture.jar', read_only: true }],
        environment: { SERVER_PORT: '8080', SERVER_ADDRESS: '0.0.0.0', SPRING_DATASOURCE_USERNAME: 'fixture',
          SPRING_DATASOURCE_PASSWORD: password, SPRING_DATASOURCE_DRIVER_CLASS_NAME: driver,
          SPRING_DATASOURCE_URL: 'jdbc:' + engine + '://db:3306/rocketbrain_fixture',
          SPRING_DATASOURCE_HIKARI_MAXIMUM_POOL_SIZE: '2' } }
    } }), { mode: 0o600, flag: 'wx' });
    docker(['context', 'create', context, '--docker', 'host=unix:///var/run/docker.sock']);
    await instance.selectContext(await instance.inspectContext(context));
    upAttempted = true;
    docker([...compose, 'up', '-d']);
    const originalAddress = address();
    const jdbc = await ready(originalAddress);
    const initial = await instance.inventory();
    assert.ok(initial.compose.some(item => item.name === context));
    const members = await instance.composeContainers(context);
    assert.equal(members.length, 2);
    const appId = docker([...compose, 'ps', '--quiet', '--no-trunc', 'app']).trim();
    const dbId = docker([...compose, 'ps', '--quiet', '--no-trunc', 'db']).trim();
    const app = members.find(item => item.id === appId);
    const db = members.find(item => item.id === dbId);
    assert.ok(app?.state === 'running' && db?.state === 'running');
    assert.ok(db.image.includes(engine));
    const logs = await instance.logs(app.id);
    assert.match(logs.stdout, /Started FixtureApplication/);

    await instance.apply((await instance.review(app.id, 'stop')).token, { approved: true });
    await assert.rejects(fetch(originalAddress + '/probe/ready', { signal: AbortSignal.timeout(2500) }));
    const stopped = await instance.inventory();
    assert.equal(stopped.containers.find(item => item.id === app.id).state, 'exited');
    assert.equal(stopped.containers.find(item => item.id === db.id).state, 'running');
    await instance.apply((await instance.review(app.id, 'start')).token, { approved: true });
    assert.deepEqual(await ready(address()), jdbc);
    return { verified: true, engine, dbImage: image, jarSha256, composeMembers: members.length, jdbc,
      composeInventory: true, applicationLogs: true, approvedAppLifecycle: true, independentDatabaseStayedRunning: true };
  } finally {
    instance.dispose();
    try { if (upAttempted) docker([...compose, 'down', '--volumes', '--remove-orphans']); }
    finally {
      if (savedConfig === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = savedConfig;
      const owned = await fs.realpath(root);
      assert.equal(path.dirname(owned), parent);
      assert.match(path.basename(owned), /^rocketbrain-docker-spring-/);
      await fs.rm(owned, { recursive: true, force: true });
    }
  }
}

main().then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
