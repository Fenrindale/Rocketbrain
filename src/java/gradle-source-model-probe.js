'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { buildSpec } = require('./workbench-tasks');
const { cancelled, fail } = require('./workbench-model');

const run = promisify(execFile);
const source = String.raw`
import java.io.File;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.HashSet;
import java.util.Set;
import org.gradle.tooling.GradleConnector;
import org.gradle.tooling.ProjectConnection;
import org.gradle.tooling.model.gradle.GradleBuild;

public class RocketbrainGradleSourceModel {
  private static final int MAX_BUILDS = 16;
  private static final int MAX_PROJECTS = 30;
  private static final Set<String> roots = new HashSet<>();
  private static int projects;

  private static String field(String value) throws Exception {
    byte[] bytes = value.getBytes(StandardCharsets.UTF_8);
    if (bytes.length > 2048) throw new IllegalArgumentException("model field limit");
    return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
  }

  private static void observe(GradleBuild build, String parent) throws Exception {
    String root = build.getBuildIdentifier().getRootDir().getCanonicalPath();
    if (!roots.add(root) || roots.size() > MAX_BUILDS) throw new IllegalArgumentException("repeated build or graph limit");
    System.out.println("B " + field(root) + " " + field(parent));
    for (var project : build.getProjects()) {
      if (++projects > MAX_PROJECTS) throw new IllegalArgumentException("project limit");
      System.out.println("P " + field(root) + " " + field(project.getProjectDirectory().getCanonicalPath()) +
          " " + field(project.getPath()) + " " + field(project.getBuildTreePath()));
    }
    for (var included : build.getIncludedBuilds()) observe(included, root);
  }

  public static void main(String[] args) throws Exception {
    var connector = GradleConnector.newConnector().forProjectDirectory(new File(args[0]))
      .useInstallation(new File(args[1])).useGradleUserHomeDir(new File(args[2]));
    try (ProjectConnection connection = connector.connect()) {
      var settings = connection.model(GradleBuild.class).setJavaHome(new File(args[3]))
        .withArguments("--offline", "--no-configuration-cache", "--max-workers=2",
          "-Dorg.gradle.daemon.idletimeout=1000", "-Dorg.gradle.java.installations.auto-download=false")
        .setStandardOutput(OutputStream.nullOutputStream()).setStandardError(OutputStream.nullOutputStream());
      observe(settings.get(), "");
    } finally {
      connector.disconnect();
    }
  }
}
`;

function boundedGradleEnvironment(source, home, javaHome) {
  const clean = Object.fromEntries(Object.entries(source).filter(([key]) =>
    /^(?:PATH|Path|PATHEXT|SYSTEMROOT|SystemRoot|WINDIR|COMSPEC|LANG|LC_[A-Z_]+)$/u.test(key)));
  return { ...clean, HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, JAVA_HOME: javaHome,
    GRADLE_USER_HOME: home };
}

function linkedAbort(cancellation) {
  const controller = new AbortController(), abort = () => controller.abort();
  let subscription;
  if (cancellation?.onCancellationRequested) subscription = cancellation.onCancellationRequested(abort);
  else cancellation?.addEventListener?.('abort', abort, { once: true });
  if (cancelled(cancellation)) abort();
  return { signal: controller.signal, close() {
    subscription?.dispose();
    cancellation?.removeEventListener?.('abort', abort);
  } };
}

function decodeField(text) {
  if (!/^[A-Za-z0-9_-]{0,2731}$/u.test(text)) throw fail('Gradle emitted an invalid composite model field.');
  const raw = Buffer.from(text, 'base64url');
  if (raw.toString('base64url') !== text) throw fail('Gradle emitted an invalid composite model field.');
  return new TextDecoder('utf-8', { fatal: true }).decode(raw);
}

function parseModel(output) {
  const lines = output.split(/\r?\n/u).filter(line => line.length);
  if (!lines.length || lines.length > 46) throw fail('The Gradle composite model exceeded its graph limit.');
  return lines.map(line => {
    const [kind, ...fields] = line.split(' ');
    if (kind === 'B' && fields.length === 2) {
      const [buildRoot, parent] = fields.map(decodeField);
      return { kind, buildRoot, parent };
    }
    if (kind === 'P' && fields.length === 4) {
      const [buildRoot, component, projectPath, treePath] = fields.map(decodeField);
      return { kind, buildRoot, component, projectPath, treePath };
    }
    throw fail('Gradle emitted an unknown composite model record.');
  });
}

async function readGradleSourceModel({ project, tools, spec, cancellation }) {
  const scratch = await fs.realpath(os.tmpdir());
  const home = await fs.mkdtemp(path.join(scratch, 'rb-gradle-source-model-'));
  const link = linkedAbort(cancellation);
  const script = path.join(home, 'RocketbrainGradleSourceModel.java');
  const javaHome = path.dirname(path.dirname(spec.command));
  const env = boundedGradleEnvironment(spec.env, home, javaHome);
  const lib = path.join(tools.gradleHome, 'lib');
  const verifyHome = async () => {
    const physical = await fs.realpath(home);
    if (path.relative(home, physical) || path.relative(scratch, path.dirname(physical))) {
      throw fail('The private Gradle model directory changed during inspection.');
    }
  };
  let result, processStarted;
  try {
    await fs.writeFile(script, source, { mode: 0o600, flag: 'wx' });
    link.signal.throwIfAborted();
    processStarted = true;
    result = await run(spec.command, ['-XX:-UsePerfData', '-Dfile.encoding=UTF-8', '-cp', path.join(lib, '*'), script,
      project.root, tools.gradleHome, home, javaHome], { cwd: project.root, env, windowsHide: true,
      signal: link.signal, timeout: 90000, maxBuffer: 256 * 1024 });
  } catch {
    if (link.signal.aborted) throw fail('Gradle composite model inspection was cancelled.');
    throw fail('Gradle could not report a complete offline composite model using the reviewed installation.');
  } finally {
    link.close();
    await verifyHome();
    try {
      if (processStarted) {
        const stop = buildSpec(project, tools, ['help']);
        await run(stop.command, [...stop.args.slice(0, stop.args.indexOf('org.gradle.launcher.GradleMain') + 1),
          '--stop', '--gradle-user-home', home], { cwd: home, env, timeout: 16000, maxBuffer: 65536, windowsHide: true });
      }
    } finally {
      await verifyHome();
      await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    }
  }
  return parseModel(result.stdout);
}

module.exports = { readGradleSourceModel, parseModel };
