'use strict';
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const {pathToFileURL}=require('node:url');
const { startMysqlFixture } = require('./integration-mysql');
const { startFixture: startMariaFixture } = require('./integration-db-fixture');
const WORKSPACE = path.resolve(__dirname, '..');
const PROJECT = path.join(WORKSPACE, 'test', 'fixtures', 'spring-boot-app');
const OUTPUT = path.join(WORKSPACE, 'test-output', 'spring-project');
const INSTANCES = path.join(OUTPUT, 'instances');
const MARKER = 'RocketbrainSpringProjectFixture-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function javaHome() {
  if (process.env.ROCKETBRAIN_SPRING_JAVA_HOME) return path.resolve(process.env.ROCKETBRAIN_SPRING_JAVA_HOME);
  if (process.env.ROCKETBRAIN_JAVA_TEST_CONFIG) {
    const config = JSON.parse(fs.readFileSync(process.env.ROCKETBRAIN_JAVA_TEST_CONFIG, 'utf8'));
    return config.javaHome || config.settings?.['rocketbrain.java.javaHome'];
  }
  return path.join(WORKSPACE, 'research', 'implementation', 'runtimes', 'temurin25', 'extracted', 'jdk-25.0.5+8');
}
function javaExe() {
  const home = javaHome(), release = fs.readFileSync(path.join(home, 'release'), 'utf8');
  if (/JetBrains|JBR/i.test(release) || !/JAVA_VERSION="25\./.test(release)) throw new Error('Use the independently provisioned Temurin JDK25 for this fixture.');
  return path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
}
function run(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: PROJECT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '', settled = false;
    const timer = setTimeout(() => { child.kill(); finish(new Error('Spring fixture build timed out.')); }, 240000);
    const finish = (error, code) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : code === 0 ? resolve(output) : reject(new Error('Spring fixture build failed (' + code + '):\n' + output)); };
    const capture = data => { output = (output + data.toString('utf8')).slice(-30000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', finish); child.once('exit', code => finish(null, code));
  });
}
async function hash(file, algorithm = 'sha256') {
  const digest = crypto.createHash(algorithm);
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
let building;
async function buildSpringProject() {
  if (building) return building;
  building = (async () => {
    const gradleHome = process.env.ROCKETBRAIN_GRADLE_HOME || path.join(WORKSPACE, 'research', 'implementation', 'runtimes', 'gradle-9.1.0', 'extracted', 'gradle-9.1.0');
    const launcher = path.join(gradleHome, 'lib', 'gradle-launcher-9.1.0.jar');
    if (!fs.existsSync(launcher)) throw new Error('Provision the pinned Gradle9.1 runtime first.');
    const output = await run(javaExe(), ['-Dorg.gradle.java.home=' + javaHome(), '-cp', launcher, 'org.gradle.launcher.GradleMain',
      '--no-daemon', '--console=plain', '--max-workers=2', '--gradle-user-home', path.join(WORKSPACE, 'test-output', 'java-gradle-user-home'), 'classes', 'writeClasspath', 'testClasses', 'writeTestClasspath']);
    await fsp.mkdir(OUTPUT, { recursive: true });
    await fsp.writeFile(path.join(OUTPUT, 'build.log'), output);
    const artifacts = JSON.parse(await fsp.readFile(path.join(PROJECT, 'build', 'dependencies.json'), 'utf8'));
    const dependencies = [];
    for (const item of artifacts) {
      const base = 'https://repo.maven.apache.org/maven2/' + item.group.replaceAll('.', '/') + '/' + item.name + '/' + item.version + '/' + item.name + '-' + item.version;
      dependencies.push({ ...item, url: base + '.jar', pomUrl: base + '.pom', sourceUrl: base + '-sources.jar', sha256: await hash(item.file) });
    }
    const checked = new Set(['spring-boot', 'spring-core', 'hibernate-core', 'spring-data-jpa', 'mysql-connector-j', 'mariadb-java-client', 'spring-webflux', 'spring-cloud-openfeign-core', 'reactor-netty-http']);
    for (const item of dependencies.filter(item => checked.has(item.name))) {
      const pomResponse = await fetch(item.pomUrl, { signal: AbortSignal.timeout(15000) });
      if (!pomResponse.ok) throw new Error('Cannot inspect the official dependency POM license: ' + item.name);
      const pom = await pomResponse.text(), licenseSection = /<licenses>([\s\S]*?)<\/licenses>/.exec(pom)?.[1] || '';
      item.declaredLicenses = [...licenseSection.matchAll(/<license>([\s\S]*?)<\/license>/g)].map(match => ({
        name: /<name>([\s\S]*?)<\/name>/.exec(match[1])?.[1]?.trim() || 'unspecified',
        url: /<url>([\s\S]*?)<\/url>/.exec(match[1])?.[1]?.trim() || item.pomUrl,
      }));
      item.licenseSource = item.pomUrl;
      for (const algorithm of ['sha256', 'sha512', 'sha1']) {
        const response = await fetch(item.url + '.' + algorithm, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const expected = (await response.text()).trim().split(/\s+/)[0].toLowerCase();
        if (!new RegExp('^[a-f0-9]{' + { sha256: 64, sha512: 128, sha1: 40 }[algorithm] + '}$').test(expected)) throw new Error('Invalid publisher dependency checksum.');
        if (await hash(item.file, algorithm) !== expected) throw new Error('Spring dependency publisher checksum mismatch: ' + item.name);
        item.publisherChecksum = { algorithm, expected, url: item.url + '.' + algorithm, verified: true }; break;
      }
      if (!item.publisherChecksum) throw new Error('No publisher checksum for main dependency ' + item.name);
      const sourceDirectory = path.join(OUTPUT, 'sources');
      await fsp.mkdir(sourceDirectory, { recursive: true });
      const sourceFile = path.join(sourceDirectory, item.name + '-' + item.version + '-sources.jar');
      let sourceChecksum;
      for (const algorithm of ['sha256','sha512','sha1']) {
        const response = await fetch(item.sourceUrl + '.' + algorithm, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const expected = (await response.text()).trim().split(/\s+/)[0].toLowerCase();
        if (!new RegExp('^[a-f0-9]{' + { sha256:64,sha512:128,sha1:40 }[algorithm] + '}$').test(expected)) throw new Error('Invalid source checksum.');
        sourceChecksum = { algorithm, expected, url: item.sourceUrl + '.' + algorithm }; break;
      }
      if (!sourceChecksum) throw new Error('No publisher source checksum for ' + item.name);
      if (!fs.existsSync(sourceFile) || await hash(sourceFile, sourceChecksum.algorithm) !== sourceChecksum.expected) {
        const response = await fetch(item.sourceUrl, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error('Cannot download official dependency sources: ' + item.name);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 24 * 1024 * 1024) throw new Error('Dependency source archive exceeds fixture size limit.');
        await fsp.writeFile(sourceFile, bytes);
      }
      if (await hash(sourceFile, sourceChecksum.algorithm) !== sourceChecksum.expected) throw new Error('Official source checksum mismatch.');
      item.sources = { url: item.sourceUrl, file: sourceFile, sha256: await hash(sourceFile), publisherChecksum: { ...sourceChecksum, verified:true } };
    }
    const result = { asOf: '2026-11-12', projectPath: PROJECT, javaHome: javaHome(), gradleHome, java: 'Temurin25', gradle: '9.1.0',
      dependencies, testOnly: true, bundledInVsix: false, licenseScope: 'Main component licenses are recorded from their exact published POMs. Hibernate7.4.13.Final declares Apache-2.0; do not infer older Hibernate licenses. JDBC driver exceptions/notices remain upstream. These fixture dependencies are not product runtime dependencies.',
      verification: 'All resolved runtime JARs have computed SHA-256; six main engines/drivers and their original source JARs additionally match publisher checksums over official Maven Central HTTPS. OpenPGP signatures not verified.' };
    await fsp.writeFile(path.join(OUTPUT, 'dependencies.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  })().catch(error => { building = undefined; throw error; });
  return building;
}
async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function waitExit(promise, milliseconds) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function removeInstance(folder, id) {
  const absolute = path.resolve(folder), relative = path.relative(INSTANCES, absolute);
  if (relative !== id || path.isAbsolute(relative) || relative.startsWith('..')) throw new Error('Refusing to remove a non-owned Spring instance.');
  const marker = JSON.parse(await fsp.readFile(path.join(absolute, 'owner.json'), 'utf8'));
  if (marker.kind !== MARKER || marker.id !== id) throw new Error('Spring fixture ownership marker mismatch.');
  const realRelative = path.relative(await fsp.realpath(INSTANCES), await fsp.realpath(absolute));
  if (realRelative !== id) throw new Error('Spring fixture real path escaped its workspace.');
  await fsp.rm(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
async function startSpringProject({ engine = 'mysql', debug = false, debugPort,naming='standard',observer=process.env.ROCKETBRAIN_JPA_OBSERVER_TEST==='1' } = {}) {
  if (!['mysql', 'mariadb'].includes(engine)) throw new Error('Select mysql or mariadb.');
  if(!['standard','custom','opaque'].includes(naming))throw new Error('Select standard, custom or opaque fixture naming.');
  if (debugPort !== undefined && (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535)) throw new Error('Invalid JDWP port.');
  const jfrRepository=process.env.ROCKETBRAIN_FIXTURE_JFR_REPOSITORY;
  if (jfrRepository && (!path.isAbsolute(jfrRepository) || !/^[\x21-\x7e]+$/.test(jfrRepository) ||
      /[,=]/.test(jfrRepository) || !(await fsp.stat(jfrRepository)).isDirectory())) {
    throw new Error('Use an existing ASCII directory for the fixture recording repository.');
  }
  const build = await buildSpringProject();
  // Prepare immutable agent artifacts before starting any disposable server.
  const agent=observer?await require('./jpa-observer-build').buildObserver({target:path.join(OUTPUT,'observer'),javaHome:javaHome()}):null;
  if (debug && debugPort === undefined) debugPort = await unusedPort();
  let db,clientCertificates,spawned=false;
  await fsp.mkdir(INSTANCES, { recursive: true });
  const id = crypto.randomUUID(), folder = path.join(INSTANCES, id), port = await unusedPort();
  let endpointProbePort;
  if (process.env.ROCKETBRAIN_SPRING_ENDPOINTS_TEST === '1') {
    do { endpointProbePort = await unusedPort(); } while (endpointProbePort === port);
  }
  await fsp.mkdir(folder);
  await fsp.writeFile(path.join(folder, 'owner.json'), JSON.stringify({ kind: MARKER, id }));
  try {
  let observerArgs=[],observerTokenFile,observerDescriptorFile;
  if(observer){
    observerTokenFile=path.join(folder,'observer.token');observerDescriptorFile=path.join(folder,'observer-connection.json');
    const configFile=path.join(folder,'observer-agent.json');
    await fsp.writeFile(observerTokenFile,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});
    await fsp.writeFile(configFile,JSON.stringify({tokenFile:observerTokenFile,descriptorFile:observerDescriptorFile,port:0,queries:true,validate:true,
      performance:process.env.ROCKETBRAIN_JPA_PERFORMANCE_TEST==='1',consoleSelect:process.env.ROCKETBRAIN_JPA_CONSOLE_TEST==='1',
      consoleFetchSnapshots:process.env.ROCKETBRAIN_JPA_FETCH_SNAPSHOT_TEST==='1'}),{flag:'wx',mode:0o600});
    observerArgs=['-javaagent:'+agent.jarPath+'=config='+pathToFileURL(configFile).href];
  }
  const runtimeUrl = 'http://127.0.0.1:' + port + '/actuator', baseUrl = 'http://127.0.0.1:' + port;
  const propertyProbe = process.env.ROCKETBRAIN_SPRING_PROPERTY_TEST === '1' ? {
    FIXTURE_INSPECTION_ENABLED: 'true', FIXTURE_INSPECTION_MESSAGE: engine + '-from-local-launch',
    MANAGEMENT_ENDPOINT_ENV_SHOW_VALUES: 'always', MANAGEMENT_INFO_PROCESS_ENABLED: 'true'
  } : {};
  let classpath = await fsp.readFile(path.join(PROJECT, 'build', 'runtime-classpath.txt'), 'utf8');
  // The optional reactive stack can exceed the Windows launcher command line.
  // An owned manifest jar keeps its classpath URLs and Unicode paths intact.
  if (process.platform === 'win32' && classpath.length > 28000) {
    const { manifestText } = require('../src/java/testing');
    const entries=[...new Set(classpath.split(path.delimiter).filter(file=>fs.existsSync(file)))];
    const manifest=path.join(folder,'MANIFEST.MF'), jar=path.join(folder,'classpath.jar');
    await fsp.writeFile(manifest,manifestText(entries),{flag:'wx'});
    await run(path.join(javaHome(),'bin','jar.exe'),['--create','--file',jar,'--manifest',manifest],{cwd:folder});
    classpath=jar;
  }
  const javaArgs = ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dstderr.encoding=UTF-8',
    ...observerArgs,
    ...(jfrRepository ? ['-XX:FlightRecorderOptions=repository='+jfrRepository] : []),
    ...(debugPort ? ['-agentlib:jdwp=transport=dt_socket,server=y,suspend=n,address=127.0.0.1:' + debugPort] : []), '-cp', classpath, 'fixture.boot.FixtureApplication'];
  const dbOptions={namedPipe:process.env.ROCKETBRAIN_FIXTURE_NAMED_PIPE==='1'};
  if (process.env.ROCKETBRAIN_ENABLE_DB_CLIENT_IDENTITY_FIXTURE === '1') {
    clientCertificates = await require('./connection-security-fixture').certificates({protectedIdentity:true,ssh:false});
    dbOptions.tls = clientCertificates.server;
  }
  db=engine==='mysql'?await startMysqlFixture(dbOptions):await startMariaFixture(dbOptions);
  const clientIdentityFixturePath = clientCertificates && await require('../test/helpers/client-identity-fixture')
    .prepareClientIdentityFixture(db,clientCertificates,path.join(folder,'client-identity.json'));
  const url = engine === 'mysql' ? 'jdbc:mysql://127.0.0.1:' + db.config.port + '/' + db.config.database + '?allowPublicKeyRetrieval=true&sslMode=DISABLED'
    : 'jdbc:mariadb://127.0.0.1:' + db.config.port + '/' + db.config.database;
  let log = '', stopping, child;
  const logFile = path.join(folder, 'application.log');
  const output = fs.createWriteStream(logFile);
  child = spawn(javaExe(), javaArgs, { cwd: PROJECT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    SERVER_PORT: String(port), SERVER_ADDRESS: '127.0.0.1', SPRING_DATASOURCE_URL: url, SPRING_DATASOURCE_USERNAME: db.config.user, ...propertyProbe,
    ...(endpointProbePort ? {FIXTURE_ENDPOINT_PROBE_PORT: String(endpointProbePort)} : {}),
    ...(process.env.ROCKETBRAIN_JPA_DIAGRAM_TEST==='1' ? {FIXTURE_DIAGRAM_SECOND_FACTORY:'true'} : {}),
    ...(process.env.ROCKETBRAIN_JPA_MULTI_FETCH_TEST==='1' ? {FIXTURE_FETCH_MULTI_ENABLED:'true'} : {}),
    SPRING_DATASOURCE_PASSWORD: db.config.password, SPRING_DATASOURCE_DRIVER_CLASS_NAME: engine === 'mysql' ? 'com.mysql.cj.jdbc.Driver' : 'org.mariadb.jdbc.Driver',
    SPRING_JPA_HIBERNATE_NAMING_PHYSICAL_STRATEGY:naming==='opaque'?'fixture.boot.OpaquePhysicalNamingStrategy':naming==='custom'?'fixture.boot.FixturePhysicalNamingStrategy':'org.hibernate.boot.model.naming.PhysicalNamingStrategyStandardImpl',
    SPRING_JPA_HIBERNATE_NAMING_IMPLICIT_STRATEGY:naming==='custom'?'fixture.boot.FixtureImplicitNamingStrategy':'org.hibernate.boot.model.naming.ImplicitNamingStrategyJpaCompliantImpl' } });
  spawned=true;
  const exitPromise = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  const capture = data => { const safe = data.toString('utf8').replaceAll(db.config.password, '[redacted]'); log = (log + safe).slice(-30000); output.write(safe); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      if (child.pid && child.exitCode === null && child.signalCode === null) { child.kill(); await waitExit(exitPromise, 10000); }
      if (child.pid && child.exitCode === null && child.signalCode === null) throw new Error('Spring fixture did not stop; preserving its evidence.');
      await new Promise(resolve => output.end(resolve));
      await fsp.copyFile(logFile, path.join(OUTPUT, 'last-' + engine + '-application.log'));
      try { await db.stop(); } finally { await clientCertificates?.remove(); }
      await removeInstance(folder, id);
    })();
    return stopping;
  }
  try {
    const deadline = Date.now() + 90000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Spring application exited before readiness:\n' + log);
      try { const response = await fetch(baseUrl + '/probe/ready', { signal: AbortSignal.timeout(1000) }); ready = response.ok && (await response.json()).ready === true; }
      catch {}
      if (!ready) await pause(200);
    }
    if (!ready) throw new Error('Spring application did not become ready:\n' + log);
    const configPath = path.join(folder, 'runtime.json');
    const observerConnection=observer?JSON.parse(await fsp.readFile(observerDescriptorFile,'utf8')):null;
    const config = { runtimeUrl, baseUrl, appURL: baseUrl, projectPath: PROJECT, sourcePaths: [path.join(PROJECT, 'src', 'main', 'java')],
      port, dbEngine: engine, dbConfigPath: db.configPath, ...(clientIdentityFixturePath&&{clientIdentityFixturePath}), processId: child.pid, javaProcessId: child.pid, debugPort: debugPort || null,naming,
      ...(observer?{observerUrl:observerConnection.baseUrl,observerTokenFile}:{}),
      ...(endpointProbePort?{endpointProbeUrl:'http://127.0.0.1:'+endpointProbePort}:{}),
      namingStrategy:naming==='opaque'?{physical:'fixture.boot.OpaquePhysicalNamingStrategy'}:naming==='custom'?{physical:'fixture.boot.FixturePhysicalNamingStrategy',implicit:'fixture.boot.FixtureImplicitNamingStrategy'}:null,
      expectations: { conditionalBean: 'conditionalRuntimeThing', dynamicBean: 'registeredRuntimeThing', factoryBean: 'productFactory',
        proxiedBean: 'probeService', configurationPrefix: 'fixture.credentials', mappingPath: '/probe', packageName: 'fixture.boot' } };
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    return { ...config, configPath, db, build, process: child, stop, close: stop };
  } catch (error) { await stop().catch(() => {}); throw error; }
  } catch(error) {
    if(!spawned){try{await db?.stop();}finally{try{await clientCertificates?.remove();}finally{await removeInstance(folder,id);}}}
    throw error;
  }
}
async function main() {
  const mode = process.argv[2] || 'smoke';
  if (mode === 'build') { const result = await buildSpringProject(); console.log(JSON.stringify({ status: 'built', projectPath: PROJECT, dependencies: result.dependencies.length })); return; }
  const engineIndex = process.argv.indexOf('--engine'), engine = engineIndex < 0 ? 'mysql' : process.argv[engineIndex + 1];
  const debugIndex = process.argv.indexOf('--debug-port');
  const namingIndex=process.argv.indexOf('--naming');
  const fixture = await startSpringProject({ engine, observer:process.argv.includes('--observer')||process.env.ROCKETBRAIN_JPA_OBSERVER_TEST==='1',debug: process.argv.includes('--debug'), debugPort: debugIndex < 0 ? undefined : Number(process.argv[debugIndex + 1]),naming:namingIndex<0?'standard':process.argv[namingIndex+1] });
  console.log(JSON.stringify({ status: 'ready', runtimeUrl: fixture.runtimeUrl, projectPath: fixture.projectPath, configPath: fixture.configPath, engine, debugPort: fixture.debugPort }));
  try {
    if (mode === 'run') {
      const separator = process.argv.indexOf('--'), args = separator < 0 ? process.argv.slice(3) : process.argv.slice(separator + 1);
      if (!args.length) throw new Error('Pass Node arguments after --.');
      const allowPrincipalCreation = process.env.ROCKETBRAIN_ENABLE_DBPRINCIPAL_FIXTURE === '1';
      const allowRoleInheritance = process.env.ROCKETBRAIN_ENABLE_ROLE_INHERITANCE_FIXTURE === '1';
      const allowRoleMembership = process.env.ROCKETBRAIN_ENABLE_ROLE_MEMBERSHIP_FIXTURE === '1';
      const adminConfig = allowPrincipalCreation || allowRoleInheritance || allowRoleMembership || process.env.ROCKETBRAIN_ENABLE_DBADMIN_FIXTURE === '1'
        ? await require('../test/helpers/database-admin-fixture').prepareDatabaseAdminFixture(fixture, { allowPrincipalCreation, allowRoleInheritance, allowRoleMembership })
        : undefined;
      const dbMcpEnvironment = process.env.ROCKETBRAIN_ENABLE_DB_MCP_FIXTURE === '1'
        ? await require('../test/helpers/db-mcp-fixture').prepareDbMcpFixture(fixture)
        : {};
      process.exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { cwd: WORKSPACE, windowsHide: true, stdio: 'inherit', env: { ...process.env,
          ROCKETBRAIN_SPRING_RUNTIME_CONFIG: fixture.configPath, ROCKETBRAIN_SPRING_PROJECT_CONFIG: fixture.configPath, ROCKETBRAIN_JPA_RUNTIME: '1',
          ROCKETBRAIN_TEST_MYSQL_ENGINE: engine, ROCKETBRAIN_MYSQL_TEST_CONFIG: fixture.db.configPath, ROCKETBRAIN_TEST_MYSQL_CONFIG: fixture.db.configPath,
          ...(fixture.db.pipeName ? { ROCKETBRAIN_TEST_MYSQL_PIPE: fixture.db.pipeName } : {}),
          ...(adminConfig ? { ROCKETBRAIN_DBADMIN_TEST_CONFIG: adminConfig } : {}), ...dbMcpEnvironment,
          ...(fixture.db.crossConfigPath ? { ROCKETBRAIN_SCHEMA_CROSS_CONFIG: fixture.db.crossConfigPath } : {}) } });
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
      });
    } else if (mode === 'start') {
      // Writing "stop\n" to this CLI's stdin awaits the complete cleanup path.
      // Console interrupts remain best effort: Windows hosts may terminate a
      // whole process group before an asynchronous signal handler completes.
      let requested = false, resolveStopped, rejectStopped;
      const stopped = new Promise((resolve, reject) => { resolveStopped = resolve; rejectStopped = reject; });
      const end = async () => {
        if (requested) return;
        requested = true;
        try { await fixture.stop(); resolveStopped(); } catch (error) { rejectStopped(error); }
      };
      const input = readline.createInterface({ input: process.stdin, terminal: false });
      const onLine = line => { if (line.trim().toLowerCase() === 'stop') void end(); };
      const onSignal = () => { void end(); };
      const onExit = () => { void end(); };
      input.on('line', onLine);
      process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
      fixture.process.once('exit', onExit);
      try { await stopped; }
      finally {
        process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
        fixture.process.removeListener('exit', onExit);
        input.removeListener('line', onLine); input.close(); process.stdin.pause();
      }
    } else {
      const probe = await (await fetch(fixture.baseUrl + '/probe')).json();
      const runtime = await (await fetch(fixture.baseUrl + '/probe/runtime')).json();
      console.log(JSON.stringify({ engine, runtime, probe }));
    }
  } finally { await fixture.stop(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildSpringProject, startSpringProject, PROJECT, OUTPUT };
