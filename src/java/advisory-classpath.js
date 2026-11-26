'use strict';

const path = require('node:path');

const mavenClasspathGoal = 'org.apache.maven.plugins:maven-dependency-plugin:3.11.0:build-classpath';
const gradleClasspathTask = 'rocketbrainReviewAdvisoryClasspath';
const gradleClasspathInit = `import groovy.json.JsonOutput

gradle.projectsEvaluated {
    def directory = gradle.startParameter.currentDir.canonicalFile
    def target = gradle.rootProject.allprojects.find { it.projectDir.canonicalFile == directory }
    if (target == null) return
    target.tasks.register('${gradleClasspathTask}') {
        doLast {
            def configuration = target.configurations.findByName('compileClasspath')
            if (configuration == null || !configuration.canBeResolved) {
                throw new GradleException('The selected module has no resolvable Java compile classpath.')
            }
            def entries = configuration.files.collect { it.canonicalPath }
            if (entries.size() > 250) throw new GradleException('The advisory classpath exceeds 250 entries.')
            new File(System.getProperty('rocketbrain.workbench.output')).setText(
                JsonOutput.toJson([format:'RocketbrainAdvisoryClasspath-v1', entries:entries]), 'UTF-8')
        }
    }
}
`;

function parseAdvisoryClasspath(text, tool) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw Error('Use a bounded Java advisory classpath.');
  let entries;
  if (tool === 'gradle') {
    let data;
    try { data = JSON.parse(text); }
    catch { throw Error('The Gradle compiler classpath was not valid JSON.'); }
    if (data?.format !== 'RocketbrainAdvisoryClasspath-v1') throw Error('The Gradle advisory classpath did not identify its format.');
    entries = data.entries;
  } else if (tool === 'maven') {
    entries = text.trim() ? text.trim().split(path.delimiter) : [];
  } else throw Error('Choose a Maven or Gradle compiler classpath.');
  if (!Array.isArray(entries) || entries.length > 250 || entries.some(item =>
    typeof item !== 'string' || !path.isAbsolute(item) || /^[/\\]{2}/u.test(item) || /[\x00-\x1f]/u.test(item))) {
    throw Error('Use a resolved local compiler classpath with at most 250 entries.');
  }
  const canonical = item => process.platform === 'win32' ? item.toLowerCase() : item;
  if (new Set(entries.map(canonical)).size !== entries.length) throw Error('The compiler classpath repeats a local entry.');
  return entries;
}

module.exports = { mavenClasspathGoal, gradleClasspathTask, gradleClasspathInit, parseAdvisoryClasspath };
