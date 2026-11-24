'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { physicalDirectory } = require('./file-templates');

const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const TIMEOUT_MS = 30000;
const SUCCESS_MARKER = 'ROCKETBRAIN_JSHELL_COMPLETE';

// Run ordinary JShell snippets using OpenJDK's documented SourceCodeAnalysis API.
// The local execution engine lives in this disposable Java process.
const JAVA_HELPER = String.raw`
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import jdk.jshell.JShell;
import jdk.jshell.Snippet;
import jdk.jshell.SnippetEvent;
import jdk.jshell.SourceCodeAnalysis;
import jdk.jshell.execution.LocalExecutionControlProvider;

class RocketbrainScratch {
    public static void main(String[] classpath) throws Exception {
        System.setOut(new PrintStream(System.out, true, StandardCharsets.UTF_8));
        System.setErr(new PrintStream(System.err, true, StandardCharsets.UTF_8));
        String script = new String(System.in.readAllBytes(), StandardCharsets.UTF_8);
        int errors = 0;
        int count = 0;
        var pending = new StringBuilder();
        try (JShell shell = JShell.builder()
                .executionEngine(new LocalExecutionControlProvider(), Map.of())
                .in(System.in).out(System.out).err(System.err).build()) {
            for (String entry : classpath) {
                shell.addToClasspath(entry);
            }
            SourceCodeAnalysis analysis = shell.sourceCodeAnalysis();
            input:
            for (String line : script.split("\\R", -1)) {
                pending.append(line).append('\n');
                while (!pending.toString().isBlank()) {
                    var step = analysis.analyzeCompletion(pending.toString());
                    if (step.completeness() == SourceCodeAnalysis.Completeness.EMPTY) {
                        pending.setLength(0);
                        break;
                    }
                    if (step.source() == null || (!step.completeness().isComplete()
                            && step.completeness() != SourceCodeAnalysis.Completeness.UNKNOWN)) {
                        break;
                    }
                    if (++count > 500) {
                        System.err.println("Scratch exceeds 500 Java snippets.");
                        errors++;
                        pending.setLength(0);
                        break input;
                    }
                    for (SnippetEvent event : shell.eval(step.source())) {
                        if (event.status() == Snippet.Status.REJECTED) {
                            shell.diagnostics(event.snippet()).forEach(diag ->
                                System.err.println(diag.getMessage(Locale.ROOT)));
                            errors++;
                        } else if (event.exception() != null) {
                            System.err.println(event.exception().getClass().getSimpleName() + ": "
                                + event.exception().getMessage());
                            errors++;
                        } else if (event.status() == Snippet.Status.VALID && event.value() != null) {
                            System.out.println(event.value());
                        }
                    }
                    if (step.remaining().length() >= pending.length()) {
                        System.err.println("Unable to advance to the next Java snippet.");
                        errors++;
                        pending.setLength(0);
                        break input;
                    }
                    pending.replace(0, pending.length(), step.remaining());
                }
                if (pending.toString().isBlank()) {
                    pending.setLength(0);
                }
            }
            if (!pending.toString().isBlank()) {
                System.err.println("Incomplete Java snippet at the end of the scratch.");
                errors++;
            }
        }
        System.out.print("\nROCKETBRAIN_JSHELL_COMPLETE " + errors + "\n");
        System.out.flush();
        if (errors != 0) {
            System.exit(2);
        }
    }
}
`;

async function scratchJavaLauncher(javaHome) {
  if (typeof javaHome !== 'string' || !path.isAbsolute(javaHome) || /^\\\\/.test(javaHome)) {
    throw Error('Configure an absolute local independent JDK to run Java Scratch.');
  }
  const home = await fs.realpath(javaHome);
  const release = (await fs.readFile(path.join(home, 'release'), 'utf8')).slice(0, 65536);
  const version = Number(/(?:^|\n)JAVA_VERSION="(\d+)/.exec(release)?.[1] || 0);
  if (version < 11 || /JetBrains|(?:^|[\\/])jbr(?:[\\/]|$)/i.test(home) || /JetBrains/i.test(release)) {
    throw Error('Java Scratch requires an independent full JDK 11 or newer.');
  }
  const executable = name => path.join(home, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
  const launch = executable('java');
  for (const tool of [launch, executable('javac'), executable('jshell')]) {
    if (!(await fs.stat(tool)).isFile()) throw Error('Java Scratch requires java, javac and jshell from a full independent JDK.');
  }
  return { executable: launch, version };
}

async function scratchClasspath(paths) {
  if (!Array.isArray(paths) || paths.length > 160 || Buffer.byteLength(JSON.stringify(paths)) > 24000) {
    throw Error('The observed project classpath exceeds the Java Scratch limit.');
  }
  const results = new Set();
  for (const entry of paths) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || /^\\\\/.test(entry) || /[\0\r\n]/.test(entry)) {
      throw Error('Java Scratch classpaths require observed absolute local paths.');
    }
    const file = await fs.realpath(entry);
    const info = await fs.stat(file);
    if (file.includes(path.delimiter) || (!info.isDirectory() && !(info.isFile() && /\.jar$/i.test(file)))) {
      throw Error('Java Scratch supports class directories and JAR dependencies in the selected classpath.');
    }
    results.add(file);
  }
  return [...results];
}

function startScratchProcess({ executable, args, cwd, source, signal, timeoutMs }) {
  const excluded = new Set(['CLASSPATH', 'JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key.toUpperCase())));
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ state: 'cancelled', exitCode: null, output: '' });
      return;
    }
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0;
    let interruption;
    function stop(reason) {
      if (interruption) return;
      interruption = reason;
      child.kill('SIGKILL');
    }
    function receive(chunk, buffers) {
      const available = MAX_OUTPUT_BYTES - bytes;
      if (available > 0) buffers.push(chunk.subarray(0, available));
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) stop('output-limit');
    }
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timed-out'), timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    };
    child.on('error', error => {
      finish();
      reject(error);
    });
    child.stdout.on('data', chunk => receive(chunk, stdout));
    child.stderr.on('data', chunk => receive(chunk, stderr));
    child.stdin.on('error', () => {});
    child.once('close', exitCode => {
      finish();
      const text = Buffer.concat(stdout).toString('utf8');
      const match = new RegExp('(?:^|\\n)' + SUCCESS_MARKER + ' (\\d+)\\r?\\n?$').exec(text);
      const reported = match ? text.slice(0, match.index) : text;
      const diagnostics = Buffer.concat(stderr).toString('utf8');
      const output = [reported, diagnostics].filter(Boolean).join(reported.endsWith('\n') ? '' : '\n');
      const state = interruption || (match && Number(match[1]) === 0 && exitCode === 0 ? 'finished' : 'failed');
      resolve({ state, exitCode, output, snippetErrors: match ? Number(match[1]) : null });
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    else child.stdin.end(source, 'utf8');
  });
}

async function runJavaScratch({ source, javaHome, classpaths = [], storagePath, signal, timeoutMs = TIMEOUT_MS,
  assertTrusted = () => {} }) {
  assertTrusted();
  if (typeof source !== 'string' || !source.trim() || source.includes('\0') || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
    throw Error('Use a non-empty Java Scratch file of at most 64 KiB.');
  }
  if (!path.isAbsolute(storagePath) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > TIMEOUT_MS) {
    throw Error('Invalid Java Scratch runtime limits.');
  }
  const launcher = await scratchJavaLauncher(javaHome);
  const cp = await scratchClasspath(classpaths);
  await fs.mkdir(storagePath, { recursive: true });
  await physicalDirectory(storagePath);
  const cwd = await fs.mkdtemp(path.join(storagePath, 'run-'));
  const helper = path.join(cwd, 'RocketbrainScratch.java');
  try {
    await fs.writeFile(helper, JAVA_HELPER, { encoding: 'utf8', flag: 'wx' });
    assertTrusted();
    const result = await startScratchProcess({
      executable: launcher.executable, args: ['-Dfile.encoding=UTF-8', '--source', '11', helper, ...cp], cwd, source, signal, timeoutMs
    });
    return { ...result, jdkVersion: launcher.version, classpathEntries: cp.length };
  } finally {
    try {
      if ((await fs.lstat(helper)).isFile() && await fs.readFile(helper, 'utf8') === JAVA_HELPER) await fs.unlink(helper);
      await fs.rmdir(cwd);
    } catch (error) {
      // Retain any files explicitly created by the scratch snippet.
      if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error;
    }
  }
}

module.exports = { runJavaScratch, scratchClasspath, scratchJavaLauncher, MAX_SOURCE_BYTES, MAX_OUTPUT_BYTES };
