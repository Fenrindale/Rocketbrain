'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execute } = require('./testing/provision');
const { independentJavaExecutable } = require('./debug-runtime');
const { verifiedGroovyJar } = require('./groovy-console');
const { analyzeJavaSources } = require('./signature-compiler');
const { stageClasspath } = require('./groovy-project-classpath');
const { fail } = require('./workbench-model');
const worker = require('./groovy-static-receiver-source.json');

async function inInspection(check, operation) {
  check();
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'rb-groovy-members-'));
  try { return await operation(root); }
  finally {
    const real = await fs.realpath(root);
    if (path.relative(real, root) || path.relative(parent, path.dirname(real)) || !path.basename(real).startsWith('rb-groovy-members-')) {
      throw fail('The Groovy compiler inspection directory changed.');
    }
    await fs.rm(real, { recursive: true, force: true, retryDelay: 200, maxRetries: 8 });
  }
}

function tokenAt(source, position) {
  let start = position;
  while (start > 0 && /[A-Za-z0-9_$]/u.test(source[start - 1])) start--;
  const prefix = source.slice(start, position);
  if (source[start - 1] !== '.' || /[A-Za-z0-9_$]/u.test(source[position] || '') ||
      !/^(?:[A-Za-z_$][A-Za-z0-9_$]{0,127})?$/u.test(prefix)) {
    throw fail('Place the cursor after a Groovy member prefix on an explicitly typed local receiver.');
  }
  return { start, end: position, prefix };
}

async function parseReceiver(root, source, token, options, check) {
  const binary = independentJavaExecutable(path.join(options.javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const script = path.join(root, 'selection.groovy'), program = path.join(root, 'GroovyStaticReceiver.java');
  const groovy = path.join(root, 'groovy-4.0.28.jar');
  const marker = '__rbGroovyMember' + randomUUID().replaceAll('-', '');
  const prepared = source.slice(0, token.start) + marker + source.slice(token.end);
  const pinned = await verifiedGroovyJar(options);
  await Promise.all([
    fs.writeFile(script, prepared, { flag: 'wx' }), fs.writeFile(program, worker, { flag: 'wx' }),
    fs.writeFile(groovy, pinned, { flag: 'wx' })
  ]);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|CLASSPATH)$/iu.test(key)));
  check();
  const reply = await execute(binary, ['-Xmx128m', '-cp', groovy, '--source', '25', program, script, marker, String(token.start)],
    { cwd: root, env, timeoutMs: 18000 });
  check();
  const found = /^RECEIVER\t([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\t(\d{1,6})\t(\d{1,6})$/u.exec(reply.output.trim());
  if (reply.code !== 0 || !found) throw fail('The Groovy compiler did not prove an explicitly typed local receiver with a named import or fully qualified type.');
  const start = Number(found[2]), end = Number(found[3]);
  if (start >= end || end > token.start || !/^[A-Za-z_$][\w$]*$/u.test(source.slice(start, end))) {
    throw fail('The Groovy receiver declaration changed during inspection.');
  }
  return { type: found[1], start, end };
}

async function javaMembers({ root, receiver, prefix, project, options, cancellation, check, javaSource }) {
  const classpath = await stageClasspath(project.classpath, root, check);
  const sample = 'RocketbrainMemberProbe' + randomUUID().replaceAll('-', '');
  const sources = javaSource ? [javaSource] : [{
    uri: pathToFileURL(path.join(root, sample + '.java')).href,
    text: 'final class ' + sample + ' {}'
  }];
  const symbols = await analyzeJavaSources({
    javaHome: options.javaHome, classpath, sources, storagePath: path.join(root, 'javac'), cancellation,
    inspection: { kind: 'groovyMembers', receiver, prefix }
  });
  check();
  if (symbols.errors?.length || !Array.isArray(symbols.groovyMembers)) {
    throw fail('Javac could not verify public Java members in the approved Groovy project classpath.');
  }
  return symbols.groovyMembers;
}

async function inspectGroovyMembers({ source, position, project, options, cancellation, check }) {
  return inInspection(check, async root => {
    const token = tokenAt(source, position);
    const receiver = await parseReceiver(root, source, token, options, check);
    const members = await javaMembers({ root, receiver: receiver.type, prefix: token.prefix, project, options, cancellation, check });
    return { token, receiver, members };
  });
}

async function findGroovyJavaDeclaration({ member, javaSource, project, options, cancellation, check }) {
  return inInspection(check, async root => {
    const matches = (await javaMembers({ root, receiver: member.owner, prefix: member.name, javaSource,
      project, options, cancellation, check })).filter(found => found.key === member.key && found.returnType === member.returnType);
    return matches.length === 1 ? matches[0].declaration : undefined;
  });
}

module.exports = { inspectGroovyMembers, findGroovyJavaDeclaration, tokenAt };
