'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const { freePort } = require('../java-debug-dap');

const run = promisify(execFile);
const executable = (home, name) => path.join(home, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:CLASSPATH|JAVA_OPTS|CATALINA_OPTS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$/iu.test(name)));

async function certs(directory, javaHome) {
  const password = path.join(directory, 'keystore-secret.txt');
  await fs.writeFile(password, randomBytes(24).toString('hex'), { mode: 0o600 });
  const key = (verb, alias, store, ...args) => run(executable(javaHome, 'keytool'),
    [verb, '-alias', alias, '-keystore', store, '-storepass:file', password, ...args],
    { cwd: directory, env: cleanEnv(), windowsHide: true, timeout: 15000 });
  await key('-genkeypair', 'ca', 'ca.p12', '-storetype', 'PKCS12', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '2', '-dname', 'CN=Rocketbrain Owned Tomcat Test CA', '-ext', 'BC=ca:true',
    '-ext', 'KU=keyCertSign,cRLSign');
  await key('-exportcert', 'ca', 'ca.p12', '-rfc', '-file', 'ca.pem');
  await key('-genkeypair', 'tomcat', 'tomcat.p12', '-storetype', 'PKCS12', '-keyalg', 'RSA', '-keysize', '2048',
    '-validity', '2', '-dname', 'CN=owned-tomcat-loopback');
  await key('-certreq', 'tomcat', 'tomcat.p12', '-file', 'tomcat.csr');
  await key('-gencert', 'ca', 'ca.p12', '-infile', 'tomcat.csr', '-outfile', 'tomcat.pem', '-rfc',
    '-validity', '2', '-ext', 'SAN=IP:127.0.0.1', '-ext', 'EKU=serverAuth', '-ext', 'KU=digitalSignature,keyEncipherment');
  await key('-importcert', 'ca', 'tomcat.p12', '-file', 'ca.pem', '-noprompt');
  await key('-importcert', 'tomcat', 'tomcat.p12', '-file', 'tomcat.pem', '-noprompt');
  return path.join(directory, 'ca.pem');
}

async function startOwnedManager({ base, javaHome, tomcatHome, springUrl }) {
  assert.match(springUrl, /^http:\/\/127\.0\.0\.1:\d+$/u);
  const conf = path.join(base, 'conf');
  await fs.mkdir(base);
  await fs.cp(path.join(tomcatHome, 'conf'), conf, { recursive: true });
  const applications = path.join(base, 'webapps');
  await fs.mkdir(applications);
  await fs.cp(path.join(tomcatHome, 'webapps', 'manager'), path.join(applications, 'manager'), { recursive: true });
  const caFile = await certs(conf, javaHome);
  const username = 'rb-script-' + randomBytes(4).toString('hex'), password = randomBytes(24).toString('hex');
  await fs.writeFile(path.join(conf, 'tomcat-users.xml'), '<tomcat-users><role rolename="manager-script"/>' +
    '<user username="' + username + '" password="' + password + '" roles="manager-script"/></tomcat-users>\n', { mode: 0o600 });
  const port = await freePort();
  const server = [
    '<Server port="-1" shutdown="SHUTDOWN">',
    '<Listener className="org.apache.catalina.startup.VersionLoggerListener"/>',
    '<Listener className="org.apache.catalina.mbeans.GlobalResourcesLifecycleListener"/>',
    '<GlobalNamingResources><Resource name="UserDatabase" auth="Container" type="org.apache.catalina.UserDatabase"',
    'factory="org.apache.catalina.users.MemoryUserDatabaseFactory" pathname="conf/tomcat-users.xml" readonly="true"/></GlobalNamingResources>',
    '<Service name="Catalina"><Connector address="127.0.0.1" port="' + port + '"',
    'protocol="org.apache.coyote.http11.Http11NioProtocol" SSLEnabled="true" scheme="https" secure="true"',
    'sslImplementationName="org.apache.tomcat.util.net.jsse.JSSEImplementation">',
    '<SSLHostConfig><Certificate certificateKeystoreFile="conf/tomcat.p12" certificateKeystoreType="PKCS12"',
    'certificateKeystorePasswordFile="conf/keystore-secret.txt" certificateKeyAlias="tomcat"/></SSLHostConfig></Connector>',
    '<Engine name="Catalina" defaultHost="localhost">',
    '<Realm className="org.apache.catalina.realm.UserDatabaseRealm" resourceName="UserDatabase"/>',
    '<Host name="localhost" appBase="webapps" unpackWARs="true" autoDeploy="true"/></Engine></Service></Server>', ''
  ].join('\n');
  await fs.writeFile(path.join(conf, 'server.xml'), server);
  const classpath = ['bin/bootstrap.jar', 'bin/tomcat-juli.jar'].map(file => path.join(tomcatHome, file)).join(path.delimiter);
  const serverArgs = ['-Dcatalina.home=' + tomcatHome, '-Dcatalina.base=' + base,
    '-Djava.io.tmpdir=' + path.join(base, 'temp'), '-Duser.language=en', '-Duser.country=US',
    '-Djava.util.logging.config.file=' + path.join(conf, 'logging.properties'),
    '-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager',
    '-cp', classpath, 'org.apache.catalina.startup.Bootstrap', 'start'];
  await fs.mkdir(path.join(base, 'temp'));
  const child = spawn(executable(javaHome, 'java'), serverArgs, { cwd: base,
    env: { ...cleanEnv(), RB_JAKARTA_SPRING_URL: springUrl }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', exited = false;
  for (const pipe of [child.stdout, child.stderr]) pipe.setEncoding('utf8').on('data', chunk => { output = (output + chunk).slice(-24000); });
  const closed = new Promise(resolve => {
    child.once('close', () => { exited = true; resolve(); });
    child.once('error', () => { exited = true; resolve(); });
  });
  async function stop() {
    if (!exited) child.kill();
    let timer;
    try {
      await Promise.race([closed, new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('The owned Tomcat Manager did not exit.')), 12000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    const deadline = Date.now() + 35000;
    while (!exited && Date.now() < deadline) {
      if (output.includes('Server startup in [')) {
        assert.match(output, /Apache Tomcat\/11\.0\.29/u);
        return { origin: 'https://127.0.0.1:' + port, caFile, username, password, applicationBase: applications, stop };
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw Error('The owned Tomcat 11.0.29 Manager did not start. ' + output.split(/\r?\n/u).slice(-8).join('\n'));
  } catch (error) {
    await stop();
    throw error;
  }
}

async function applicationResponse(manager, context, route, expectedStatus = 200, { cookie, captureSession } = {}) {
  const ca = await fs.readFile(manager.caFile);
  return new Promise((resolve, reject) => {
    const request = https.get(manager.origin + context + route, { ca, agent: false, rejectUnauthorized: true,
      headers: cookie ? { Cookie: cookie } : undefined,
      signal: AbortSignal.timeout(10000) }, response => {
      if (response.statusCode !== expectedStatus) {
        response.resume();
        reject(Error('Expected application status ' + expectedStatus + ', received ' + response.statusCode));
        return;
      }
      const parts = [];
      response.on('data', part => parts.push(part));
      response.once('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8').trim();
        const session = response.headers['set-cookie']?.find(value => value.startsWith('JSESSIONID='))?.split(';', 1)[0];
        resolve(captureSession ? { body, cookie: session } : body);
      });
    });
    request.once('error', reject);
  });
}

async function publishExternalFixtureWar(manager, context, file) {
  assert.match(manager.origin, /^https:\/\/127\.0\.0\.1:\d+$/u);
  assert.match(context, /^\/rb-[a-z]+$/u);
  const ca = await fs.readFile(manager.caFile), archive = await fs.readFile(file);
  const version = 'zz-fixture-external', endpoint = new URL('/manager/text/deploy', manager.origin);
  endpoint.searchParams.set('path', context);
  endpoint.searchParams.set('version', version);
  const result = await new Promise((resolve, reject) => {
    const request = https.request(endpoint, { method: 'PUT', ca, agent: false, rejectUnauthorized: true,
      signal: AbortSignal.timeout(30000), headers: { 'Content-Type': 'application/octet-stream',
        'Content-Length': archive.length, 'Accept-Language': 'en',
        Authorization: 'Basic ' + Buffer.from(manager.username + ':' + manager.password).toString('base64') }
    }, response => {
      const chunks = [];
      response.on('data', value => chunks.push(value));
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8').trim() }));
    });
    request.once('error', reject);
    request.end(archive);
  });
  assert.deepEqual(result, { status: 200, body: `OK - Deployed application at context path [${context}##${version}]` });
}

module.exports = { startOwnedManager, applicationResponse, publishExternalFixtureWar };
