'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { fail, buildFingerprint, cancelled, inside, workspacePath } = require('./workbench-model');
const { buildSpec } = require('./workbench-tasks');

const reportFormat = 'RocketbrainSpockSpecification-v1';
const maxCases = 1000;
const maxReportBytes = 2 * 1024 * 1024;
const qualifiedName = /^(?:[a-z_][A-Za-z0-9_$]*\.)+[A-Za-z_$][A-Za-z0-9_$]*$/u;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const initScript = `import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.security.MessageDigest
import java.util.jar.JarFile
import java.util.zip.ZipFile
import org.codehaus.groovy.control.SourceUnit
import org.gradle.api.tasks.compile.GroovyCompile
import org.gradle.api.tasks.testing.Test
import org.gradle.api.tasks.testing.junitplatform.JUnitPlatformOptions

def config = new JsonSlurper().parse(new File(System.getProperty('rocketbrain.workbench.output')))
def file = new File(config.file)
def verifySource = {
    if (file.canonicalFile != file || !file.isFile() || file.length() > 65536 ||
        MessageDigest.getInstance('SHA-256').digest(file.bytes).encodeHex().toString() != config.digest)
        throw new GradleException('The saved Groovy specification changed before testing.')
}

gradle.projectsEvaluated {
    def project = gradle.rootProject
    if (project.projectDir.canonicalPath != config.root || !gradle.includedBuilds.empty ||
        !project.pluginManager.hasPlugin('groovy'))
        throw new GradleException('Choose the imported Gradle root owning the Spock specification.')
    verifySource()
    def unit = SourceUnit.create(file.name, file.getText('UTF-8'))
    unit.parse()
    unit.completePhase()
    unit.nextPhase()
    unit.convert()
    def matches = unit.AST.classes.findAll { !it.script && it.nameWithoutPackage + '.groovy' == file.name }
    if (matches.size() != 1)
        throw new GradleException('Open the saved file declaring its named Spock specification.')
    def declaration = matches.first()
    def name = declaration.name
    def parent = declaration.unresolvedSuperClass?.name
    def literalSpock = parent == 'spock.lang.Specification' ||
        unit.AST.imports.any { it.alias == parent && it.type.name == 'spock.lang.Specification' }
    if (!literalSpock || !(name ==~ /(?:[a-z_][A-Za-z0-9_$]*[.])+[A-Za-z_$][A-Za-z0-9_$]*/))
        throw new GradleException('Choose a named Groovy class directly extending spock.lang.Specification.')
    def task = project.tasks.findByName('test')
    def compile = project.tasks.findByName('compileTestGroovy')
    if (!(task instanceof Test) || !(compile instanceof GroovyCompile) || !(task.options instanceof JUnitPlatformOptions) ||
        !task.enabled || task.dryRun.getOrElse(false) || !compile.source.files.any { it.canonicalFile == file })
        throw new GradleException('The selected file must belong to the root Groovy test source set and its enabled JUnit Platform test task.')
    def selectedFilter = [name] as Set
    def spock = ['spock'] as Set
    def existing = task.filter.includePatterns
    if ((existing && existing != selectedFilter) || (task.options.includeEngines && !task.options.includeEngines.contains('spock')) ||
        task.options.excludeEngines.contains('spock'))
        throw new GradleException('The existing Gradle test filters require a separate specification run.')
    task.filter.setIncludePatterns(name)
    task.filter.setFailOnNoMatchingTests(true)
    task.options.setIncludeEngines(spock)
    def stage = new File(config.directory)
    task.binaryResultsDirectory.set(new File(stage, 'binary'))
    task.reports.junitXml.outputLocation.set(new File(stage, 'xml'))
    task.reports.html.outputLocation.set(new File(stage, 'html'))
    task.doNotTrackState('Rocketbrain requests fresh results for the selected Spock specification.')
    gradle.taskGraph.whenReady { graph ->
        if (!graph.hasTask(task) || graph.allTasks.any { it instanceof Test && it != task })
            throw new GradleException('The selected specification requires a single Gradle Test task.')
    }

    def cases = Collections.synchronizedList([])
    task.doFirst {
        verifySource()
        def classes = compile.destinationDirectory.get().asFile.canonicalFile
        def binaryName = name.replace('.', '/') + '.class'
        def binary = new File(classes, binaryName)
        if (!task.testClassesDirs.files.any { it.canonicalFile == classes } || !binary.isFile() || binary.canonicalFile != binary ||
            !task.enabled || task.dryRun.getOrElse(false) || task.filter.includePatterns != selectedFilter ||
            task.options.includeEngines != spock || task.options.excludeEngines.contains('spock'))
            throw new GradleException('The compiled Spock specification or its exact test scope changed.')
        def candidates = task.classpath.files
        if (candidates.size() > 256 || !candidates.any { it.canonicalFile == classes })
            throw new GradleException('The Spock test classpath did not identify a bounded selected class output.')
        def testCopies = task.testClassesDirs.files.findAll { new File(it, binaryName).isFile() }
        if (testCopies.size() != 1)
            throw new GradleException('Multiple compiled outputs define the selected Spock specification.')
        def shadow = candidates.any { item ->
            if (!item.exists() || item.canonicalFile == classes) return false
            if (item.directory) return new File(item, binaryName).isFile()
            if (!(item.name.toLowerCase(java.util.Locale.ROOT) ==~ /.*[.](jar|zip)/)) return false
            new JarFile(item, false, ZipFile.OPEN_READ, Runtime.version()).withCloseable { archive ->
                archive.getJarEntry(binaryName) != null
            }
        }
        if (shadow) throw new GradleException('The test runtime classpath shadows the selected Spock specification.')
    }
    task.afterTest { descriptor, result ->
        if (descriptor.className != name || cases.size() >= config.maximumCases)
            throw new GradleException('The Spock test result did not match the selected specification or its case limit.')
        def failure = result.exceptions.find()
        def match = failure?.stackTrace?.find { it.className == name && it.fileName == file.name && it.lineNumber > 0 }
        def row = [name: descriptor.name.take(500), displayName: descriptor.displayName.take(500),
            state: result.resultType.name(), durationMs: Math.max(0L, result.endTime - result.startTime)]
        if (failure != null) row.message = (failure.message ?: failure.class.name).take(1000)
        if (match != null) row.line = match.lineNumber
        cases.add(row)
    }
    task.afterSuite { descriptor, result ->
        if (descriptor.parent != null) return
        verifySource()
        def report = new File(stage, 'observed.json')
        if (!report.createNewFile())
            throw new GradleException('The owned Spock report already exists.')
        report.setText(JsonOutput.toJson([format: config.format, id: config.id, file: config.file, digest: config.digest,
            task: task.path, specification: name, line: declaration.lineNumber, cases: cases]), 'UTF-8')
    }
}
`;

async function openSpecification(document, project, roots, readSavedScript) {
  const uri = document?.uri;
  if (document?.isClosed || document?.isDirty || document?.languageId !== 'groovy' ||
      uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment || !uri.fsPath?.endsWith('.groovy')) {
    throw fail('Open a saved local Groovy specification before running it.');
  }
  const root = workspacePath(project.root, roots);
  const file = workspacePath(uri.fsPath, roots, { directory: false });
  if (!inside(root, file) || path.relative(file, uri.fsPath)) throw fail('Choose the unlinked source from this Gradle project.');
  const version = document.version;
  const build = buildFingerprint(root);
  if (project.tool !== 'gradle' || build !== project.buildFingerprint) {
    throw fail('Refresh the imported Gradle project before running a Spock specification.');
  }
  const bytes = await readSavedScript(file);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const lf = value => value.replace(/\r\n?/gu, '\n');
  if (lf(text) !== lf(document.getText())) throw fail('Save and reopen the exact Groovy specification before testing.');
  const validate = async () => {
    if (document.isClosed || document.isDirty || document.version !== version ||
        path.relative(workspacePath(uri.fsPath, roots, { directory: false }), file) ||
        buildFingerprint(root) !== build || !(await readSavedScript(file)).equals(bytes)) {
      throw fail('The Spock source or Gradle build changed. Run the saved specification again.');
    }
  };
  await validate();
  return { root, file, uri: uri.toString(), digest: digest(bytes), validate, lineCount: document.lineCount };
}

async function stageIdentity(folder, parent, identity) {
  const resolved = await fs.realpath(folder), stat = await fs.lstat(resolved, { bigint: true });
  if (path.relative(folder, resolved) || path.relative(parent, path.dirname(resolved)) ||
      !path.basename(resolved).startsWith('rb-spock-spec-') || stat.ino !== identity.ino || stat.dev !== identity.dev) {
    throw fail('The owned Spock report directory changed.');
  }
}

async function loadResults(folder, selection, id) {
  const file = path.join(folder, 'observed.json');
  let bytes;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxReportBytes) throw fail('The Spock result exceeds its report limit.');
    const input = await fs.open(file, 'r');
    try {
      const content = Buffer.alloc(stat.size + 1);
      const { bytesRead } = await input.read(content, 0, content.length, 0);
      if (bytesRead !== stat.size) throw fail('The Spock result changed while reading it.');
      bytes = content.subarray(0, bytesRead);
    } finally { await input.close(); }
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  const report = JSON.parse(bytes.toString('utf8'));
  const lineInSelection = line => Number.isInteger(line) && line >= 1 && line <= selection.lineCount;
  const supportedCase = item => typeof item?.name === 'string' && item.name.length <= 500 &&
    typeof item.displayName === 'string' && item.displayName.length <= 500 &&
    ['SUCCESS', 'FAILURE', 'SKIPPED'].includes(item.state) && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0 &&
    (item.message === undefined || typeof item.message === 'string' && item.message.length <= 1000) &&
    (item.line === undefined || lineInSelection(item.line));
  if (report?.format !== reportFormat || report.id !== id || report.file !== selection.file || report.digest !== selection.digest ||
      report.task !== ':test' || !qualifiedName.test(report.specification) || !lineInSelection(report.line) ||
      !Array.isArray(report.cases) || report.cases.length > maxCases || !report.cases.every(supportedCase)) {
    throw fail('Gradle returned a result outside the reviewed Spock specification.');
  }
  return report;
}

async function runSpockSpecification({ selection, project, tools, runner, verify, cancellation }) {
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rb-spock-spec-'));
  const identity = await fs.lstat(folder, { bigint: true });
  const initFile = path.join(folder, 'run.init.gradle'), output = path.join(folder, 'selection.json');
  const id = randomUUID();
  let verifiedExit = true;
  try {
    const { root, file, digest } = selection;
    await fs.writeFile(initFile, initScript, { flag: 'wx' });
    await fs.writeFile(output, JSON.stringify({ root, file, digest, id, directory: folder, format: reportFormat, maximumCases: maxCases }),
      { flag: 'wx' });
    await verify();
    if (cancelled(cancellation)) throw fail('The Spock specification run was cancelled before launch.');
    const launch = buildSpec(project, tools, [':test'], { discovery: true, initFile, output });
    launch.label = 'Spock · ' + path.basename(file);
    const result = await runner.execute(launch, { cancellation, timeoutMs: 240000 });
    verifiedExit = result.terminationConfirmed !== false;
    if (!verifiedExit) throw fail('The owned Gradle specification task did not confirm termination. Open the task terminal for its status.');
    if (result.cancelled || cancelled(cancellation)) return { state: 'cancelled', task: ':test', source: selection.uri, cases: [] };
    await verify();
    await stageIdentity(folder, parent, identity);
    const report = await loadResults(folder, selection, id);
    if (!report?.cases.length) throw fail('Gradle did not run the selected Spock specification. Check its dedicated task terminal.');
    return { state: result.code === 0 && report.cases.every(item => item.state !== 'FAILURE') ? 'succeeded' : 'failed',
      source: selection.uri, task: report.task, specification: report.specification, line: report.line, cases: report.cases, exitCode: result.code };
  } finally {
    if (verifiedExit) {
      await stageIdentity(folder, parent, identity);
      await fs.rm(folder, { recursive: true, retryDelay: 200, maxRetries: 8 });
    }
  }
}

module.exports = { openSpecification, runSpockSpecification };
