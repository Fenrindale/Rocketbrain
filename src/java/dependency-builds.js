'use strict';

const path = require('node:path');
const { SaxesParser } = require('saxes');
const { lexJava, rangeAt } = require('../spring/java');

function fileKey(file) {
  return process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file);
}

function below(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
}

function pomFacts(file) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(file.text)) throw Error('XML document type and entity declarations are outside dependency inspection.');
  const parser = new SaxesParser({ xmlns: true });
  const frames = [];
  let project;
  parser.on('opentag', tag => {
    if (frames.length >= 32) throw Error('Maven descriptor nesting limit exceeded.');
    const node = { name: tag.local, namespace: tag.uri, text: '', children: [], start: file.text.lastIndexOf('<', parser.position - 1) };
    if (frames.length) frames.at(-1).children.push(node);
    else project = node;
    frames.push(node);
  });
  parser.on('text', content => { if (frames.length) frames.at(-1).text += content; });
  parser.on('cdata', content => { if (frames.length) frames.at(-1).text += content; });
  parser.on('closetag', () => { frames.pop().end = parser.position; });
  parser.write(file.text).close();
  if (project?.name !== 'project' || !['', 'http://maven.apache.org/POM/4.0.0'].includes(project.namespace)) {
    throw Error('The Maven descriptor does not declare a supported project.');
  }
  const children = (node, name) => node?.children.filter(child => child.name === name && child.namespace === project.namespace) || [];
  const one = (node, name) => {
    const values = children(node, name);
    if (values.length > 1) throw Error('Duplicate Maven <' + name + '> declaration.');
    return values[0];
  };
  const literal = (node, name) => {
    const element = one(node, name);
    if (!element || element.children.length) return '';
    return element.text.trim();
  };
  const simple = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,160}$/;
  function gav(node, inherited) {
    const group = literal(node, 'groupId') || literal(inherited, 'groupId');
    const artifact = literal(node, 'artifactId');
    const version = literal(node, 'version') || literal(inherited, 'version');
    return {
      group: simple.test(group) ? group : '', artifact: simple.test(artifact) ? artifact : '',
      version: simple.test(version) ? version : '', declaredVersion: version
    };
  }
  const dependency = node => ({ ...gav(node), scope: literal(node, 'scope') || 'compile',
    type: literal(node, 'type') || 'jar', classifier: literal(node, 'classifier'),
    range: rangeAt(file.text, Math.max(node.start, 0), node.end) });
  return {
    file, root: path.dirname(file.path), gav: gav(project, one(project, 'parent')),
    parent: one(project,'parent') ? gav(one(project,'parent')) : null,
    finalName: literal(one(project,'build'),'finalName'),
    packaging: literal(project, 'packaging') || 'jar',
    modules: children(one(project, 'modules'), 'module')
      .filter(module => !module.children.length).map(module => module.text.trim()),
    profiles: Boolean(one(project, 'profiles')),
    dependencies: children(one(project, 'dependencies'), 'dependency').map(dependency),
    managedDependencies: children(one(one(project, 'dependencyManagement'), 'dependencies'), 'dependency').map(dependency)
  };
}

function gradleStatements(text, sourceTokens, end) {
  const statements = [];
  let current = [];
  let level = 0, lineEnd = -1;
  function flush() {
    if (current.length) statements.push(current);
    current = [];
  }
  for (const token of sourceTokens) {
    if (token.start > end) break;
    if (!level && current.length && /\n/.test(text.slice(lineEnd, token.start))) flush();
    if (!level && token.text === ';') {
      flush();
      continue;
    }
    if (['{', '(', '['].includes(token.text)) level++;
    if (['}', ')', ']'].includes(token.text)) level--;
    current.push(token);
    lineEnd = token.end;
  }
  flush();
  return statements;
}

function gradlePath(token) {
  if (!['string', 'char'].includes(token?.kind)) return null;
  const value = token.value;
  return typeof value === 'string' && /^:?(?:[A-Za-z0-9_][\w.-]*)(?::[A-Za-z0-9_][\w.-]*)*$/.test(value) &&
    !value.split(':').some(part => part === '.' || part === '..')
    ? ':' + value.replace(/^:/, '') : null;
}

function gradleSettings(file) {
  const { tokens, issues } = lexJava(file.text);
  const statements = gradleStatements(file.text, tokens, file.text.length);
  const projects = new Map([[':', path.dirname(file.path)]]);
  const complex = issues.length || statements.some(parts => ![
    'include', 'rootProject', 'pluginManagement', 'dependencyResolutionManagement', 'enableFeaturePreview'
  ].includes(parts[0].text)) || statements.some(parts => parts[0].text === 'rootProject' &&
    parts.slice(0, 4).map(token => token.text).join('') !== 'rootProject.name=');
  if (complex) return { projects, limitation: 'Computed Gradle project membership is outside literal descriptor analysis.' };
  for (const statement of statements) {
    if (statement[0].text !== 'include') continue;
    const body = statement[1]?.text === '(' ? statement.slice(2, -1) : statement.slice(1);
    const paths = body.filter((token, index) => index % 2 === 0).map(gradlePath);
    if (!body.length || body.length % 2 === 0 || paths.some(name => !name) ||
        body.some((token, index) => index % 2 && token.text !== ',') ||
        statement[1]?.text === '(' && statement.at(-1)?.text !== ')') {
      return { projects, limitation: 'Computed Gradle include is outside literal descriptor analysis.' };
    }
    for (const name of paths) {
      const directory = path.join(path.dirname(file.path), ...name.slice(1).split(':'));
      projects.set(name, directory);
    }
  }
  return { projects };
}

const GRADLE_EDGES = new Set([
  'api', 'implementation', 'compileOnly', 'compileOnlyApi', 'runtimeOnly', 'testImplementation',
  'testCompileOnly', 'testRuntimeOnly', 'testFixturesApi', 'testFixturesImplementation'
]);

function gradleDependencies(file) {
  const { tokens, issues } = lexJava(file.text);
  const dependencies = [];
  let limitation = issues.length ? 'A Gradle descriptor has unsupported literal syntax.' : null;
  let braces = 0, visits = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.text === '{') braces++;
    if (token.text === '}') braces--;
    if (braces !== 0 || token.text !== 'dependencies' || tokens[i + 1]?.text !== '{') continue;
    if (++visits > 8) throw Error('Gradle dependency block limit exceeded.');
    let end = i + 2, depth = 1;
    for (; end < tokens.length && depth; end++) {
      if (tokens[end].text === '{') depth++;
      if (tokens[end].text === '}') depth--;
    }
    if (depth) throw Error('A Gradle dependency block is incomplete.');
    const body = gradleStatements(file.text, tokens.slice(i + 2, end - 1), tokens[end - 1].start);
    const dynamic = body.some(statement =>
      ['if', 'else', 'for', 'while', 'when', 'switch', 'try', 'do'].includes(statement[0].text));
    if (dynamic) {
      limitation = 'Computed Gradle dependency branches are outside literal descriptor analysis.';
    } else {
      for (const statement of body) {
        if (!statement.some(token => token.text === 'project')) continue;
        const scope = statement[0].text;
        const call = statement[1]?.text === '(' ? statement.slice(2, -1) : statement.slice(1);
        const arg = call[2]?.text === 'path' && call[3]?.text === ':' ? call[4] : call[2];
        const close = arg === call[4] ? 5 : 3;
        const target = gradlePath(arg);
        if (!GRADLE_EDGES.has(scope) || call[0]?.text !== 'project' || call[1]?.text !== '(' ||
            !target || call.length !== close + 1 || call[close]?.text !== ')' ||
            statement[1]?.text === '(' && statement.at(-1)?.text !== ')') {
          limitation = 'An extended Gradle project dependency was omitted.';
          continue;
        }
        dependencies.push({ target, scope, range: rangeAt(file.text, statement[0].start, statement.at(-1).end) });
      }
    }
    i = end - 1;
  }
  if (!dependencies.length && tokens.some(token => token.kind === 'id' && token.text === 'project') && !limitation) {
    limitation = 'Gradle project references outside a direct dependency block were omitted.';
  }
  return { dependencies, limitation };
}

function buildDescriptors(files) {
  const issues = [], links = [], poms = new Map(), gradle = new Map(), settings = [];
  for (const file of files) {
    const name = path.basename(file.path).toLowerCase();
    try {
      if (name === 'pom.xml') poms.set(fileKey(path.dirname(file.path)), pomFacts(file));
      if (name === 'build.gradle' || name === 'build.gradle.kts') {
        const key = fileKey(path.dirname(file.path));
        if (gradle.has(key)) {
          issues.push({ uri: file.uri, message: 'Both Gradle descriptor variants are present; direct edges were omitted.' });
          gradle.set(key, null);
        } else {
          gradle.set(key, { file, ...gradleDependencies(file) });
        }
      }
      if (name === 'settings.gradle' || name === 'settings.gradle.kts') {
        settings.push({ file, ...gradleSettings(file) });
      }
    } catch (error) { issues.push({ uri: file.uri, message: error.message }); }
  }
  function setIssue(file, message) { issues.push({ uri: file.uri, message }); }
  const incomingModules = new Set(), mavenCollections = [];
  function modulePaths(pom) {
    const output = [];
    for (const module of pom.modules) {
      const qualified = module.split(/[\\/]/);
      const root = path.resolve(pom.root, module);
      if (!qualified.length || qualified.some(child => !/^[\w.-]+$/.test(child) || child === '..' || child === '.') ||
          !below(pom.root, root) || !poms.has(fileKey(root))) {
        setIssue(pom.file, 'An unobserved or dynamic Maven reactor module was omitted.');
        continue;
      }
      incomingModules.add(fileKey(root));
      output.push(root);
    }
    return output;
  }
  const children = new Map([...poms].map(([key, pom]) => [key, modulePaths(pom)]));
  for (const [key] of poms) {
    if (incomingModules.has(key) || !children.get(key).length) continue;
    const reactor = new Map();
    const pending = [key];
    for (let i = 0; i < pending.length; i++) {
      const member = pending[i];
      if (reactor.has(member)) continue;
      reactor.set(member, poms.get(member));
      for (const child of children.get(member) || []) pending.push(fileKey(child));
    }
    mavenCollections.push(reactor);
  }
  for (const reactor of mavenCollections) {
    const coordinates = [...reactor.values()];
    for (const [root, pom] of reactor) {
      if (pom.profiles) setIssue(pom.file, 'Profile-specific Maven module edges were omitted.');
      for (const dependency of pom.dependencies) {
        if (!dependency.group || !dependency.artifact || dependency.classifier || dependency.type !== 'jar') continue;
        const candidates = coordinates.filter(item => item.gav.group === dependency.group && item.gav.artifact === dependency.artifact);
        if (!candidates.length) continue;
        const targets = candidates.filter(item => dependency.version && item.gav.version === dependency.version && item.packaging === 'jar');
        if (targets.length !== 1 || !['compile', 'provided', 'runtime', 'test'].includes(dependency.scope)) {
          setIssue(pom.file, 'A Maven reactor dependency could not be matched to one literal coordinate and scope.');
          continue;
        }
        links.push({ fromRoot: root, toRoot: fileKey(targets[0].root), kind: 'Maven ' + dependency.scope,
          uri: pom.file.uri, range: dependency.range, symbol: dependency.group + ':' + dependency.artifact });
      }
    }
  }
  const byGradleRoot = new Map();
  for (const item of settings) {
    const key = fileKey(path.dirname(item.file.path));
    if (byGradleRoot.has(key)) byGradleRoot.set(key, null);
    else byGradleRoot.set(key, item);
  }
  for (const item of byGradleRoot.values()) {
    if (!item) continue;
    if (item.limitation) {
      setIssue(item.file, item.limitation);
      continue;
    }
    for (const directory of item.projects.values()) {
      const key = fileKey(directory), descriptor = gradle.get(key);
      if (!descriptor) continue;
      if (descriptor.limitation) setIssue(descriptor.file, descriptor.limitation);
      for (const dependency of descriptor.dependencies) {
        const target = item.projects.get(dependency.target);
        if (!target || !gradle.get(fileKey(target))) {
          setIssue(descriptor.file, 'A Gradle dependency does not identify a reviewed local project descriptor.');
          continue;
        }
        links.push({ fromRoot: key, toRoot: fileKey(target), kind: 'Gradle ' + dependency.scope,
          uri: descriptor.file.uri, range: dependency.range, symbol: dependency.target });
      }
    }
  }
  const declaredRoots = [...new Set([...poms.keys(), ...gradle.keys()])];
  return {
    links, issues,
    descriptors: declaredRoots.map(root => ({
      root, uri: poms.get(root)?.file.uri || gradle.get(root)?.file.uri,
      buildTools: [poms.has(root) && 'Maven', gradle.get(root) && 'Gradle'].filter(Boolean)
    }))
  };
}

module.exports = { buildDescriptors, pomFacts, gradleSettings, gradleDependencies, fileKey, below };
