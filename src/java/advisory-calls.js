'use strict';

const { analyzeJavaSources } = require('./signature-compiler');
const { rangeAt } = require('../spring/java');
const { maxSelection } = require('./dependency-advisories');

const apacheFactory = { owner: 'org.apache.commons.text.lookup.StringLookupFactory', name: 'interpolatorStringLookup',
  returns: 'org.apache.commons.text.lookup.StringLookup', isStatic: false };
const apacheCreate = { owner: 'org.apache.commons.text.StringSubstitutor', name: 'createInterpolator',
  returns: 'org.apache.commons.text.StringSubstitutor', isStatic: true };

const catalog = [
  {
    name: 'org.apache.commons:commons-text', ids: ['GHSA-599f-7c49-w659','CVE-2022-42889'],
    fixedVersion: '1.10.0',
    sources: ['https://commons.apache.org/proper/commons-text/security.html',
      'https://commons.apache.org/proper/commons-text/changes.html',
      'https://commons.apache.org/proper/commons-text/apidocs/org/apache/commons/text/lookup/StringLookupFactory.html'],
    recommendation: 'Review upgrading this dependency to a vendor-fixed release and check that the application validates untrusted interpolation input.',
    verified: {
      '1.5': ['e0642e88241d083ed184848a6a8b39670a48e484963c483a8acb266f09874b77', [apacheFactory]],
      '1.6': ['df45e56549b63e0fe716953c9d43cc158f8bf008baf60498e7c17f3faa00a70b', [apacheFactory]],
      '1.7': ['8434bbfb887e7a0f3dfef92ac84e783f847bc0f0f43b8cc9e026646b137b6065', [apacheFactory]],
      '1.8': ['6fe7ad4ad5349d6b77e7a0e1c9f6037108a1ee48c42e7e6eb4b18f56d324f7b2', [apacheFactory,apacheCreate]],
      '1.9': ['0812f284ac5dd0d617461d9a2ab6ac6811137f25122dfffd4788a4871e732d00', [apacheFactory,apacheCreate]],
    },
  },
  {
    name: 'com.google.guava:guava', ids: ['GHSA-5mg8-w23w-74h3','CVE-2020-8908'], fixedVersion: '32.0.1-jre',
    sources: ['https://github.com/advisories/GHSA-5mg8-w23w-74h3','https://github.com/google/guava/releases/tag/v32.0.1',
      'https://guava.dev/releases/32.0.1-jre/api/docs/com/google/common/io/Files.html'],
    recommendation: 'Review a vendor-fixed JRE dependency version and migrating this call to java.nio.file.Files.createTempDirectory.',
    verified: {
      '31.1-jre': ['a42edc9cab792e39fe39bb94f3fca655ed157ff87a8af78e1d6ba5b07c4a00ab',
        [{ owner: 'com.google.common.io.Files', name: 'createTempDir', returns: 'java.io.File', isStatic: true }]],
    },
  },
];

function plan(report) {
  if (report?.provider !== 'OSV' || !Array.isArray(report.packages) || report.packages.length > maxSelection ||
      report.packages.some(item=>!Array.isArray(item?.advisories))) {
    throw Error('Open a reviewed Maven or Gradle dependency advisory report first.');
  }
  const targets = [], rows = [];
  for (const item of report.packages) {
    if (!item?.advisories?.length) continue;
    const rule = catalog.find(profile => profile.name === item.name && profile.ids.some(id => item.advisories.includes(id)));
    const artifact = rule?.verified[item.version];
    const row = { key: item.key, dependency: item.name, version: item.version, advisories: [...item.advisories],
      state: 'no-supported-signature', calls: [] };
    if (rule) {
      row.callAdvisories = item.advisories.filter(id => rule.ids.includes(id));
      row.vendorFixVersion = rule.fixedVersion;
      row.sources = [...rule.sources];
      row.recommendation = rule.recommendation;
    }
    rows.push(row);
    if (!artifact) continue;
    if (report.packages.filter(candidate => candidate.name === item.name).length > 1) {
      row.state = 'multiple-resolved-versions';
      continue;
    }
    row.state = 'artifact-unverified';
    row.signatures = [];
    for (const signature of artifact[1]) targets.push({ row, signature, artifactSha256: artifact[0] });
  }
  return { rows, targets };
}

function validatedBindings(compiled, targets) {
  const states = new Set(['archive','unresolved','source-shadowed','duplicate-owner','unverified-origin']);
  const result = compiled.advisoryCalls;
  const entries = compiled.classpathEntries;
  if (!Array.isArray(entries) || !Array.isArray(result?.bindings) || result.bindings.length !== targets.length ||
      !Array.isArray(result.uses) || result.uses.length > 2000 || !Number.isSafeInteger(result.omitted) || result.omitted < 0) {
    throw Error('The Java compiler returned an invalid advisory call report.');
  }
  return result.bindings.map((binding, index) => {
    if (!states.has(binding?.state) || !Number.isSafeInteger(binding.archive) ||
        (binding.state === 'archive' ? !entries[binding.archive] : binding.archive !== -1)) {
      throw Error('The Java compiler returned an invalid advisory archive binding.');
    }
    const { row, signature, artifactSha256 } = targets[index];
    const matches = binding.state === 'archive' && entries[binding.archive].sha256 === artifactSha256;
    const state = matches ? 'verified' : binding.state === 'archive' ? 'artifact-hash-mismatch' : binding.state;
    const output = { ...signature, state, ...(matches && { artifactSha256 }) };
    row.signatures.push(output);
    return output;
  });
}

async function inspectAdvisoryCalls({ report, sources, classpath, javaHome, release, storagePath, cancellation }) {
  const { rows, targets } = plan(report);
  if (!targets.length) return { rows, state: 'no-supported-signatures', sourceFiles: 0, omitted: 0 };
  if (!Array.isArray(sources) || !sources.length || sources.some(file => file.dirty || file.invalidUtf8)) {
    throw Error('Save the selected Java production sources as UTF-8 before inspecting advisory calls.');
  }
  const compiler = await analyzeJavaSources({ sources, classpath, javaHome, release, storagePath, cancellation,
    manifestLimit: 256 * 1024, inspection: { kind: 'advisoryCalls', targets: targets.map(target => target.signature) } });
  if (compiler.errors.length) {
    for (const { row } of targets) row.state = 'compiler-errors';
    return { rows, state: 'compiler-errors', sourceFiles: sources.length, omitted: 0, problems: compiler.errors.slice(0, 12),
      validateClasspath: compiler.validateClasspath };
  }
  const bindings = validatedBindings(compiler, targets);
  const byUri = new Map(sources.map(file => [file.uri,file]));
  for (const use of compiler.advisoryCalls.uses) {
    const target = targets[use?.target], file = byUri.get(use?.uri);
    if (!target || !file || !Number.isSafeInteger(use.start) || !Number.isSafeInteger(use.end) || use.start < 0 ||
        use.end <= use.start || use.end > file.text.length || !['call','method reference'].includes(use.kind)) {
      throw Error('The Java compiler returned an invalid advisory call source range.');
    }
    if (bindings[use.target].state !== 'verified') continue;
    target.row.calls.push({ uri: use.uri, range: rangeAt(file.text,use.start,use.end), kind: use.kind,
      signature: target.signature.owner + '#' + target.signature.name + '()', artifactSha256: bindings[use.target].artifactSha256 });
  }
  for (const row of rows.filter(entry => entry.signatures)) {
    const available = row.signatures.filter(item => item.state === 'verified').length;
    if (row.calls.length) row.state = 'calls-observed';
    else if (!available) row.state = 'artifact-unverified';
    else if (available !== row.signatures.length || compiler.advisoryCalls.omitted) row.state = 'inspection-incomplete';
    else row.state = 'no-listed-use-observed';
  }
  return { rows, state: 'inspected', sourceFiles: sources.length, omitted: compiler.advisoryCalls.omitted,
    validateClasspath: compiler.validateClasspath };
}

module.exports = { inspectAdvisoryCalls };
