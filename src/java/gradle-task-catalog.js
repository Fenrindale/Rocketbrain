'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const M = require('./workbench-model');
const { gradleImageModel } = require('./javafx-gradle-image');

const format = 'RocketbrainGradleTaskCatalog-v1';
const specification = 'rocketbrain.workbench.output';
const javafxImagesSpecification = 'rocketbrain.workbench.javafxImages';
const maximumBuilds = 16;
const segment = /^[A-Za-z0-9_.-]+$/;
const qualified = /^:(?:[A-Za-z0-9_.-]+:)*[A-Za-z0-9_.-]+$/;
const standardInputs = [
  'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts',
  'gradle.properties', 'gradle/libs.versions.toml'
];

const gradleInit = `import groovy.json.JsonOutput
import java.security.MessageDigest

def output = System.getProperty('${specification}')
if (output == null) return
def includeJavafxImages = System.getProperty('${javafxImagesSpecification}') == 'true'
${gradleImageModel}

def captured = [:]
def capture = { File file ->
  def name = file.absoluteFile.toPath().normalize().toString()
  if (!file.exists()) {
    captured[name] = null
  } else if (!file.isFile() || file.length() > ${M.LIMITS.fileBytes}) {
    throw new GradleException('The task catalog encountered an unsupported build input.')
  } else {
    captured[name] = MessageDigest.getInstance('SHA-256').digest(file.bytes).encodeHex().toString()
  }
}

def usual = ${JSON.stringify(standardInputs)}
gradle.beforeSettings { settings -> usual.each { capture(new File(settings.settingsDir, it)) } }
gradle.beforeProject { project ->
  capture(project.buildFile)
  capture(new File(project.projectDir, 'gradle.properties'))
}
gradle.projectsEvaluated {
  def root = gradle.rootProject
  def projects = root.allprojects
  def included = gradle.includedBuilds
  if (projects.size() > ${M.LIMITS.projects} || included.size() >= ${maximumBuilds}) {
    throw new GradleException('The task catalog reached its project or build limit.')
  }
  def tasks = []
  projects.each { project ->
    project.tasks.each { task ->
      if (tasks.size() < ${M.LIMITS.tasks + 1}) {
        def entry = [name: task.path, group: (task.group ?: '').take(100), description: (task.description ?: '').take(512)]
        if (includeJavafxImages && project == root && gradle.parent == null) {
          def image = javafxImageModel(project, task)
          if (image != null) entry.javafxImage = image
        }
        tasks << entry
      }
    }
  }
  if (tasks.size() > ${M.LIMITS.tasks}) throw new GradleException('The task catalog reached its task limit.')
  def payload = [
    format: '${format}', root: root.projectDir.canonicalPath, main: gradle.parent == null,
    includes: included.collect { item -> [name: item.name, root: item.projectDir.canonicalPath] },
    projects: projects.size(), inputs: captured, tasks: tasks
  ]
  def file = File.createTempFile('gradle-tasks-', '.json', new File(output))
  file.setText(JsonOutput.toJson(payload), 'UTF-8')
}
`;

function loadCatalog(directory, project, roots) {
  const names = fs.readdirSync(directory);
  if (names.length > maximumBuilds || !names.every(name => /^gradle-tasks-[0-9]+\.json$/.test(name))) {
    throw M.fail('Gradle returned an invalid or oversized build catalog.');
  }
  const builds = new Map();
  for (const name of names) {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
      throw M.fail('Gradle task metadata must be a bounded local file.');
    }
    const build = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (build.format !== format || typeof build.root !== 'string' || !path.isAbsolute(build.root) ||
        typeof build.main !== 'boolean' || !Array.isArray(build.includes) || !Array.isArray(build.tasks) ||
        !Number.isSafeInteger(build.projects) || build.projects < 1 || build.projects > M.LIMITS.projects ||
        !build.inputs || Array.isArray(build.inputs) || typeof build.inputs !== 'object') {
      throw M.fail('Gradle returned invalid task metadata.');
    }
    const root = fs.realpathSync(build.root);
    if (builds.has(root)) throw M.fail('Gradle returned duplicate build identities.');
    builds.set(root, build);
  }

  const main = builds.get(project.root);
  if (!main?.main || [...builds.values()].filter(build => build.main).length !== 1) {
    throw M.fail('Gradle did not report the selected build as its main catalog.');
  }

  const inputs = new Map(), tasks = new Map(), identities = new Set();
  let projects = 0;
  function addBuild(root, name, build) {
    if (identities.has(root)) throw M.fail('Gradle reported conflicting included build identities.');
    identities.add(root);
    projects += build.projects;
    if (projects > M.LIMITS.projects || Object.keys(build.inputs).length > 2 * M.LIMITS.projects + standardInputs.length) {
      throw M.fail('The catalog supports at most 30 Gradle projects and their local build scripts.');
    }
    for (const [file, digest] of Object.entries(build.inputs)) {
      if (!path.isAbsolute(file) || !M.inside(root, file) || (digest !== null && !/^[a-f0-9]{64}$/.test(digest))) {
        throw M.fail('Gradle returned a build input outside its observed directory.');
      }
      if (inputs.has(file) && inputs.get(file) !== digest) throw M.fail('Build files changed during task discovery.');
      inputs.set(file, digest);
    }
    for (const task of build.tasks) {
      if (!qualified.test(task.name) || typeof task.group !== 'string' || typeof task.description !== 'string') {
        throw M.fail('Gradle returned an unsupported task path.');
      }
      const selector = name ? ':' + name + task.name : task.name;
      if (tasks.has(selector)) throw M.fail('Each task must have a unique qualified Gradle path.');
      tasks.set(selector, { ...task, name: selector, buildName: name,
        provenance: name ? 'gradle-included-build-task' : 'gradle-observed-task' });
    }
  }

  addBuild(project.root, null, main);
  for (const entry of main.includes) {
    if (!entry || !segment.test(entry.name) || typeof entry.root !== 'string' || !path.isAbsolute(entry.root)) {
      throw M.fail('Gradle returned an unsupported included build identity.');
    }
    const root = fs.realpathSync(entry.root);
    if (root === project.root || !roots.some(directory => M.inside(directory, root))) continue;
    M.workspacePath(entry.root, roots);
    const build = builds.get(root);
    if (!build) throw M.fail('Gradle did not return the observed included build task catalog.');
    addBuild(root, entry.name, build);
  }
  if (tasks.size > M.LIMITS.tasks) throw M.fail('Discover at most 200 tasks across the selected Gradle build.');
  const guards = [...inputs].sort(([left], [right]) => left.localeCompare(right));
  verifyInputs(guards, roots);
  return { tasks: [...tasks.values()], guards };
}

function verifyInputs(inputs, roots) {
  for (const [file, digest] of inputs) {
    try {
      const stat = fs.lstatSync(file, {throwIfNoEntry:false});
      if (!stat && digest === null) continue;
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= M.LIMITS.fileBytes &&
          roots.some(root => M.inside(root, fs.realpathSync(file))) &&
          crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === digest) continue;
    } catch {
      // Give the same review requirement for removed, replaced and unreadable inputs.
    }
    throw M.fail('Gradle build inputs changed after task discovery. Refresh and review the task again.');
  }
}

module.exports = { format, specification, javafxImagesSpecification, gradleInit, loadCatalog, verifyInputs };
