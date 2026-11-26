'use strict';
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');
async function build() {
  const jdbcWorker = fs.readFileSync(path.join(__dirname, '../runtime/jdbc/DriverWorker.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/db/jdbc-worker-source.json'), JSON.stringify(jdbcWorker));
  const clientIdentity = fs.readFileSync(path.join(__dirname, '../runtime/db-tls/ClientIdentity.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/db/pkcs12-worker-source.json'), JSON.stringify(clientIdentity));
  const mixedClasses = fs.readFileSync(path.join(__dirname, '../runtime/java-mixed/MixedClassInspector.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/java/mixed-jvm-classfile-source.json'), JSON.stringify(mixedClasses));
  const fxmlPreview = fs.readFileSync(path.join(__dirname, '../runtime/javafx-preview/FxmlPreview.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/java/javafx-preview-source.json'), JSON.stringify(fxmlPreview));
  const fxmlClassInspector = fs.readFileSync(path.join(__dirname, '../runtime/javafx-preview/FxmlClassInspector.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/java/javafx-class-inspector-source.json'), JSON.stringify(fxmlClassInspector));
  const groovyConsole = fs.readFileSync(path.join(__dirname, '../runtime/groovy/GroovyConsoleWorker.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/java/groovy-console-source.json'), JSON.stringify(groovyConsole));
  const groovyReceiver = fs.readFileSync(path.join(__dirname, '../runtime/groovy/GroovyStaticReceiver.java'), 'utf8');
  fs.writeFileSync(path.join(__dirname, '../src/java/groovy-static-receiver-source.json'), JSON.stringify(groovyReceiver));
  const sourceDir=path.join(__dirname,'../runtime/jpa-observer/src/rocketbrain/observer');
  const sources=Object.fromEntries(fs.readdirSync(sourceDir).filter(name=>name.endsWith('.java')).sort().map(name=>[name,fs.readFileSync(path.join(sourceDir,name),'utf8')]));
  fs.writeFileSync(path.join(__dirname,'../src/jpa/observer-sources.json'),JSON.stringify(sources));
  fs.writeFileSync(path.join(__dirname,'../src/java/testing/launcher-sources.json'),JSON.stringify(require('../src/java/testing/provision').readLauncherSources()));
  const branchEvidence = fs.readFileSync(path.join(__dirname,'../runtime/java-coverage/BranchEvidence.java'),'utf8');
  fs.writeFileSync(path.join(__dirname,'../src/java/testing/branch-evidence-source.json'),JSON.stringify(branchEvidence));
  const signatureDirectory=path.join(__dirname,'../runtime/java-signature/src/rocketbrain/signature');
  const signatureSources=Object.fromEntries(fs.readdirSync(signatureDirectory).filter(name=>name.endsWith('.java')).sort().map(name=>[name,fs.readFileSync(path.join(signatureDirectory,name),'utf8')]));
  fs.writeFileSync(path.join(__dirname,'../src/java/signature-compiler-sources.json'),JSON.stringify(signatureSources));
  const kotlinWindowsPath=fs.readFileSync(path.join(__dirname,'../runtime/kotlin-editor/KtlspWindowsPath.java'),'utf8');
  fs.writeFileSync(path.join(__dirname,'../src/java/kotlin-editor-windows-source.json'),JSON.stringify(kotlinWindowsPath));
  const interopNullability=fs.readFileSync(path.join(__dirname,'../runtime/kotlin-editor/InteropNullability.java'),'utf8');
  fs.writeFileSync(path.join(__dirname,'../src/java/kotlin-nullability-source.json'),JSON.stringify(interopNullability));
  const coroutineProbe=fs.readFileSync(path.join(__dirname,'../runtime/kotlin-coroutines/CoroutineProbeAgent.java'),'utf8');
  fs.writeFileSync(path.join(__dirname,'../src/java/kotlin-coroutine-probe-source.json'),JSON.stringify(coroutineProbe));
  const quarkusStarter = path.join(__dirname,'../test/fixtures/java/quarkus');
  const quarkusFiles = ['pom.xml','src/main/java/quarkusfixture/GreetingConfig.java','src/main/java/quarkusfixture/GreetingResource.java',
    'src/main/resources/application.properties','src/main/resources/templates/greeting.html','src/test/java/quarkusfixture/GreetingResourceTest.java'];
  fs.writeFileSync(path.join(__dirname,'../src/java/quarkus-starter-source.json'),JSON.stringify(
    Object.fromEntries(quarkusFiles.map(file=>[file,fs.readFileSync(path.join(quarkusStarter,file),'utf8')]))));
  const jakartaHost=fs.readFileSync(path.join(__dirname,'../runtime/jakarta/JakartaWarHost.java'),'utf8');
  fs.writeFileSync(path.join(__dirname,'../src/java/jakarta-host-source.json'),JSON.stringify(jakartaHost));
  fs.mkdirSync('dist', { recursive: true });
  const registration = path.join('dist', 'spring-registration');
  fs.mkdirSync(registration, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../runtime/spring-registration/src/rocketbrain/spring/RegistrationTrace.java'),
    path.join(registration, 'RegistrationTrace.java'));
  fs.mkdirSync(path.join('dist', 'java-async'), { recursive: true });
  for (const file of ['TaskTrace.java', 'ReactorTaskTrace.java']) {
    fs.copyFileSync(path.join(__dirname, '../runtime/java-async/src/rocketbrain/async', file), path.join('dist', 'java-async', file));
  }
  fs.mkdirSync(path.join('dist', 'java-debug'), { recursive: true });
  for (const file of fs.readdirSync(path.join(__dirname, '../runtime/java-debug')).filter(file => file.endsWith('.java'))) {
    fs.copyFileSync(path.join(__dirname, '../runtime/java-debug', file), path.join('dist', 'java-debug', file));
  }
  fs.mkdirSync(path.join('dist', 'android-debug'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../runtime/android-debug/AndroidBreakpoint.java'), path.join('dist', 'android-debug/AndroidBreakpoint.java'));
  await esbuild.build({ entryPoints: ['scripts/java-quality-gate.js'], outfile: 'dist/java-quality-gate.js', bundle: true, platform: 'node', target: 'node20' });
  await esbuild.build({ entryPoints: ['scripts/ide-mcp-server.js'], outfile: 'dist/ide-mcp-server.js', bundle: true, platform: 'node', target: 'node20' });
  await esbuild.build({ entryPoints: ['src/extension.js'], outfile: 'dist/extension.js', bundle: true, platform: 'node', target: 'node20', external: ['vscode', 'cpu-features', './crypto/build/Release/sshcrypto.node'], sourcemap: false });
  await esbuild.build({ entryPoints: ['src/db/worker.js'], outfile: 'dist/worker.js', bundle: true, platform: 'node', target: 'node20', external: ['sql.js/dist/sql-wasm.wasm'], sourcemap: false });
  await esbuild.build({ entryPoints: ['src/db/sqlite-edit-worker.js'], outfile: 'dist/sqlite-edit-worker.js', bundle: true, platform: 'node', target: 'node22', sourcemap: false });
  fs.copyFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'), 'dist/sql-wasm.wasm');
  for (const file of ['results.js', 'results.css']) fs.copyFileSync(path.join('src/ui', file), path.join('dist', file));
  console.log('Built extension, isolated SQL worker, WASM and results view.');
}
build().catch(e => { console.error(e); process.exitCode = 1; });
