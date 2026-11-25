'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { LIMITS:HPROF_LIMITS } = require('./hprof-format');
const { analyzeHprof } = require('./hprof-graph');
const {
  parseJvmList, summarizeProfile, parseThreadSnapshot, parseThreadLocks, parseHeapHistogram
} = require('./jvm-diagnostics-model');

const MAX_RECORDING = 64 * 1024 * 1024;
const MAX_DUMP = 8 * 1024 * 1024;
const MAX_INSPECTION = 20 * 1024 * 1024;
const MAX_HISTOGRAM = 6 * 1024 * 1024;
const ATTACH_MS = 15000;
const PROFILE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<configuration version="2.0" label="Rocketbrain CPU and allocation samples">
  <event name="jdk.ExecutionSample"><setting name="enabled">true</setting><setting name="period">10 ms</setting></event>
  <event name="jdk.NativeMethodSample"><setting name="enabled">true</setting><setting name="period">20 ms</setting></event>
  <event name="jdk.ObjectAllocationSample"><setting name="enabled">true</setting><setting name="stackTrace">true</setting><setting name="throttle">150/s</setting></event>
</configuration>
`;
const PROCESS_IDENTITY = `class RocketbrainJvmIdentity {
  public static void main(String[] args) {
    long pid = Long.parseLong(args[0]);
    var process = ProcessHandle.of(pid).orElseThrow();
    var info = process.info();
    var command = java.nio.file.Path.of(info.command().orElseThrow()).getFileName().toString();
    if (!command.matches("(?i)javaw?(\\\\.exe)?")) throw new IllegalStateException("Local JVM unavailable");
    System.out.println(pid + ":" + info.startInstant().orElseThrow().toEpochMilli());
  }
}
`;
// Emit only the selected event fields. The public jfr JSON command repeats
// full class/module metadata for every stack frame and can exceed this
// feature's inspection budget even for a short recording.
const RECORDING_READER = String.raw`
import java.nio.file.Path;
import java.util.Set;
import jdk.jfr.consumer.RecordingFile;

class RocketbrainRecordingReader {
    static final Set<String> EVENTS = Set.of(
        "jdk.ExecutionSample", "jdk.NativeMethodSample", "jdk.ObjectAllocationSample",
        "jdk.ObjectAllocationInNewTLAB", "jdk.ObjectAllocationOutsideTLAB"
    );
    static void string(String value) {
        System.out.print('"');
        if (value != null) {
            for (int i = 0; i < Math.min(value.length(), 512); i++) {
                char c = value.charAt(i);
                if (c == '"' || c == '\\') System.out.print('\\');
                if (c < 32) System.out.printf("\\u%04x", (int)c);
                else System.out.print(c);
            }
        }
        System.out.print('"');
    }
    public static void main(String[] args) throws Exception {
        System.setOut(new java.io.PrintStream(System.out, false, java.nio.charset.StandardCharsets.UTF_8));
        int observed = 0, scanned = 0, omitted = 0;
        System.out.print("{\"recording\":{\"events\":[");
        try (RecordingFile file = new RecordingFile(Path.of(args[0]))) {
            while (file.hasMoreEvents()) {
                if (++scanned > 500000) throw new IllegalArgumentException("Recording event count");
                var event = file.readEvent();
                String kind = event.getEventType().getName();
                if (!EVENTS.contains(kind)) {
                    omitted++;
                    continue;
                }
                if (++observed > 16000) throw new IllegalArgumentException("Recording sample count");
                if (observed > 1) System.out.print(',');
                System.out.print("{\"type\":");
                string(kind);
                System.out.print(",\"values\":{\"startTime\":");
                string(event.getStartTime().toString());
                if (event.hasField("weight")) System.out.print(",\"weight\":" + event.getLong("weight"));
                if (event.hasField("allocationSize")) System.out.print(",\"allocationSize\":" + event.getLong("allocationSize"));
                if (event.hasField("objectClass")) {
                    var type = event.getClass("objectClass");
                    if (type != null) {
                        System.out.print(",\"objectClass\":{\"name\":");
                        string(type.getName());
                        System.out.print('}');
                    }
                }
                System.out.print(",\"stackTrace\":{\"frames\":[");
                var stack = event.getStackTrace();
                if (stack != null) {
                    int count = 0;
                    for (var frame : stack.getFrames()) {
                        var method = frame.getMethod();
                        if (method == null) continue;
                        if (++count > 24) break;
                        if (count > 1) System.out.print(',');
                        System.out.print("{\"lineNumber\":" + frame.getLineNumber() + ",\"method\":{\"name\":");
                        string(method.getName());
                        System.out.print(",\"descriptor\":");
                        string(method.getDescriptor());
                        System.out.print(",\"type\":{\"name\":");
                        string(method.getType().getName());
                        System.out.print("}}}");
                    }
                }
                System.out.print("]}}}");
            }
        }
        System.out.print("],\"omittedEvents\":" + omitted + "}}");
        System.out.flush();
    }
}
`;

function assertRunning(signal) {
  if (signal?.aborted) throw Error('JVM diagnostics cancelled.');
}

function absoluteLocal(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !/^(?:\\\\|\/\/)/.test(value) && !/["\r\n\0]/.test(value);
}

async function physical(location, type) {
  if (!absoluteLocal(location)) throw Error('Choose a local diagnostic path.');
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink() || !stat[type]() || path.relative(location, await fs.realpath(location))) {
    throw Error('Use a physical local diagnostic path.');
  }
  return stat;
}

async function boundedFile(file, limit) {
  const stat = await physical(file, 'isFile');
  if (!stat.size || stat.size > limit) throw Error('The diagnostic file is empty or exceeds its size limit.');
  return stat;
}

async function readBounded(file, limit) {
  await boundedFile(file, limit);
  const bytes = await fs.readFile(file);
  if (bytes.length > limit) throw Error('The diagnostic file exceeds its size limit.');
  return bytes.toString('utf8');
}

function localExecutable(name, javaHome) {
  return path.join(javaHome, 'bin', name + (process.platform === 'win32' ? '.exe' : ''));
}

async function sdk(javaHome) {
  if (!absoluteLocal(javaHome)) throw Error('Configure a local independent JDK 25 or newer for JVM diagnostics.');
  const home = await fs.realpath(javaHome);
  const release = await readBounded(path.join(home, 'release'), 65536);
  const feature = Number(/(?:^|\n)JAVA_VERSION="(\d+)[."]/.exec(release)?.[1] || 0);
  if (feature < 25 || /JetBrains|JBR/i.test(release)) throw Error('Use an independent full JDK 25 or newer for JVM diagnostics.');
  const java = localExecutable('java', home), jcmd = localExecutable('jcmd', home), jfr = localExecutable('jfr', home);
  for (const executable of [java,jcmd,jfr]) await physical(executable, 'isFile');
  return { java, jcmd, jfr };
}

function launch(executable, args, { cwd, signal, timeout = ATTACH_MS, outputLimit = 1024 * 1024, label }) {
  assertRunning(signal);
  const blocked = new Set(['CLASSPATH','JAVA_TOOL_OPTIONS','JDK_JAVA_OPTIONS','_JAVA_OPTIONS','JAVA_OPTIONS']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !blocked.has(name.toUpperCase())));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, windowsHide:true, stdio:['ignore','pipe','pipe'] });
    const parts = [];
    let cause, seen = 0, settled = false;
    function stop(message) {
      cause ||= Error(message);
      child.kill('SIGKILL');
    }
    const cancelled = () => stop('JVM diagnostics cancelled.');
    const timer = setTimeout(() => stop(label + ' timed out.'), timeout);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on('data', buffer => {
      seen += buffer.length;
      if (seen > outputLimit) stop(label + ' exceeds its output limit.');
      else parts.push(buffer);
    });
    // Diagnostic process errors can contain unrelated launch data.
    child.stderr.resume();
    child.once('error', () => finish(cause || Error(label + ' could not start.')));
    child.once('close', status => finish(cause || (status !== 0 ? Error(label + ' did not finish successfully.') : null),
      Buffer.concat(parts).toString('utf8')));
    signal?.addEventListener('abort', cancelled, { once:true });
    if (signal?.aborted) cancelled();
  });
}

async function ownedDirectory(root) {
  if (!absoluteLocal(root)) throw Error('The JVM diagnostic storage must be local.');
  await fs.mkdir(root, { recursive:true });
  await physical(root, 'isDirectory');
  return fs.mkdtemp(path.join(root, 'jvm-'));
}

async function removeOwnedFiles(directory, names) {
  for (const name of names) {
    const file = path.join(directory, name);
    try { await fs.unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.rmdir(directory);
}

function insideQuoted(value) {
  if (!absoluteLocal(value)) throw Error('Use a local JVM diagnostic output.');
  // jcmd joins its diagnostic arguments before the target parses them.
  return '"' + value + '"';
}

async function destination(file, extension) {
  if (file === undefined) return;
  if (!absoluteLocal(file) || path.extname(file).toLowerCase() !== extension) throw Error('Choose a local ' + extension + ' destination.');
  await physical(path.dirname(file), 'isDirectory');
  try { await fs.lstat(file); throw Error('A diagnostic output already exists at that path.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function copyNew(input, output) {
  if (!output) return;
  await physical(path.dirname(output), 'isDirectory');
  try { await fs.copyFile(input, output, constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code === 'EEXIST') throw Error('A diagnostic output already exists at that path.');
    throw error;
  }
}

async function recordingHeader(file) {
  await boundedFile(file, MAX_RECORDING);
  const descriptor = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(4);
    const { bytesRead } = await descriptor.read(header, 0, 4, 0);
    if (bytesRead !== 4 || !header.equals(Buffer.from([70,76,82,0]))) throw Error('Use a complete JFR recording file.');
  } finally { await descriptor.close(); }
}

function sleep(ms, signal) {
  assertRunning(signal);
  return new Promise((resolve, reject) => {
    const end = () => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    };
    const timer = setTimeout(end, ms);
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(Error('JVM diagnostics cancelled.'));
    }
    signal?.addEventListener('abort', cancel, { once:true });
    if (signal?.aborted) cancel();
  });
}

function createJvmDiagnostics({ javaHome, storagePath, trusted = () => {} }) {
  let toolkit;
  const reviewed = new Map(), active = new Set();
  const ready = () => toolkit ||= sdk(javaHome);

  function allowed(signal) {
    trusted();
    assertRunning(signal);
  }

  async function command(pid, op, options, { signal, label, outputLimit, timeout } = {}) {
    allowed(signal);
    const { jcmd } = await ready();
    return launch(jcmd, ['-J-Dstdout.encoding=UTF-8', '-J-Dfile.encoding=UTF-8', String(pid), op, ...options],
      { signal, timeout, outputLimit, label });
  }

  async function identity(pid, signal) {
    allowed(signal);
    const { java } = await ready(), dir = await ownedDirectory(storagePath);
    const name = 'RocketbrainJvmIdentity.java', file = path.join(dir,name);
    try {
      await fs.writeFile(file, PROCESS_IDENTITY, { flag:'wx' });
      const result = await launch(java, ['--source','25',file,String(pid)],
        { signal, cwd:dir, label:'Local JVM selection', timeout:10000, outputLimit:256 });
      const parsed = /^(\d{1,10}):(\d{1,16})\s*$/.exec(result);
      if (!parsed || Number(parsed[1]) !== pid) throw Error('Select a running local Java process.');
      return parsed[2];
    } finally { await removeOwnedFiles(dir,[name]); }
  }

  async function list({ signal } = {}) {
    allowed(signal);
    const { jcmd } = await ready();
    return parseJvmList(await launch(jcmd, ['-J-Dstdout.encoding=UTF-8','-l'],
      { signal, label:'Local JVM list', outputLimit:512*1024 }));
  }

  async function select(pid, { signal } = {}) {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647 || pid === process.pid) throw Error('Choose a positive local Java process ID.');
    const start = await identity(pid, signal);
    await command(pid,'VM.version',[],{ signal,label:'Local JVM attach check',outputLimit:4096 });
    if (await identity(pid, signal) !== start) throw Error('The local JVM changed while selecting it.');
    const id = randomUUID(), target = { id,pid,start };
    for (const [key,value] of reviewed) if (Date.now() - value.selectedAt > 180000 && !active.has(value.pid)) reviewed.delete(key);
    if (reviewed.size >= 20) throw Error('Close expired JVM diagnostics before selecting another target.');
    reviewed.set(id,{ ...target, selectedAt:Date.now() });
    return target;
  }

  async function targetProcess(target, signal) {
    allowed(signal);
    const item = reviewed.get(target?.id);
    if (!item || item.pid !== target.pid || item.start !== target.start ||
        (Date.now() - item.selectedAt > 180000 && !active.has(item.pid))) throw Error('Select the local JVM again.');
    if (await identity(item.pid, signal) !== item.start) throw Error('The selected local JVM process has changed.');
    return item;
  }

  async function inspectJfr(file, { signal } = {}) {
    allowed(signal);
    await recordingHeader(file);
    const { java } = await ready(), directory = await ownedDirectory(storagePath);
    const name = 'RocketbrainRecordingReader.java', reader = path.join(directory,name);
    try {
      await fs.writeFile(reader, RECORDING_READER, { flag:'wx' });
      const inspected = await launch(java, ['-Xmx256m','--source','25',reader,file],
        { cwd:directory, signal, label:'JFR inspection', timeout:25000, outputLimit:MAX_INSPECTION });
      return summarizeProfile(inspected);
    } finally { await removeOwnedFiles(directory,[name]); }
  }

  async function inspectThreads(file, { signal } = {}) {
    allowed(signal);
    const raw = await readBounded(file, MAX_DUMP);
    assertRunning(signal);
    return path.extname(file).toLowerCase() === '.json' ?
      { format:'json',snapshot:parseThreadSnapshot(raw) } : { format:'locks',locks:parseThreadLocks(raw) };
  }

  async function inspectHeapDump(file,{signal}={}) {
    allowed(signal);
    if(typeof file!=='string'||path.extname(file).toLowerCase()!=='.hprof')throw Error('Choose a local HotSpot .hprof file.');
    const before=await boundedFile(file,HPROF_LIMITS.bytes),descriptor=await fs.open(file,'r');
    const same=stat=>stat.isFile()&&stat.dev===before.dev&&stat.ino===before.ino&&stat.size===before.size&&
      stat.mtimeMs===before.mtimeMs&&stat.ctimeMs===before.ctimeMs;
    let bytes;
    try {
      if(!same(await descriptor.stat()))throw Error('The heap dump changed before it could be opened.');
      bytes=Buffer.allocUnsafe(before.size);
      let offset=0;
      while(offset<bytes.length){
        allowed(signal);
        const {bytesRead}=await descriptor.read(bytes,offset,Math.min(1024*1024,bytes.length-offset),offset);
        if(!bytesRead)throw Error('The heap dump changed while reading it.');
        offset+=bytesRead;
      }
      if(!same(await descriptor.stat())||!same(await physical(file,'isFile')))throw Error('The heap dump changed while reading it.');
    }finally{await descriptor.close();}
    allowed(signal);
    const result=await analyzeHprof(bytes,{signal});
    allowed(signal);
    return result;
  }

  async function captureThreads(target, { output, format = 'json', signal } = {}) {
    await destination(output, format === 'json' ? '.json' : '.txt');
    if (!['json','locks'].includes(format)) throw Error('Choose structured JSON or a platform lock dump.');
    const item = await targetProcess(target, signal);
    const dir = await ownedDirectory(storagePath);
    const names = ['threads.json','locks.txt'];
    const structured = path.join(dir,names[0]), lockFile = path.join(dir,names[1]);
    try {
      await command(item.pid,'Thread.dump_to_file',['-format=json',insideQuoted(structured)],
        { signal,label:'Structured JVM thread capture',outputLimit:4096 });
      const snapshot = parseThreadSnapshot(await readBounded(structured, MAX_DUMP));
      await targetProcess(item, signal);
      const rawLocks = await command(item.pid,'Thread.print',['-l'],
        { signal,label:'Platform JVM lock capture',outputLimit:MAX_DUMP });
      const locks = parseThreadLocks(rawLocks);
      if (output && format === 'locks') await fs.writeFile(lockFile,rawLocks,{flag:'wx'});
      await targetProcess(item, signal);
      await copyNew(format === 'json' ? structured : lockFile, output);
      return { snapshot,locks,output:output || null };
    } finally { await removeOwnedFiles(dir,names); }
  }

  async function histogram(target, { signal } = {}) {
    const item = await targetProcess(target, signal);
    const text = await command(item.pid,'GC.class_histogram',['-all','-parallel=1'],
      { signal,label:'JVM class histogram',outputLimit:MAX_HISTOGRAM,timeout:30000 });
    await targetProcess(item, signal);
    return parseHeapHistogram(text);
  }

  async function profile(target, { seconds = 5, output, signal } = {}) {
    if (!Number.isInteger(seconds) || seconds < 3 || seconds > 30) throw Error('Choose a JVM recording duration from 3 to 30 seconds.');
    await destination(output,'.jfr');
    const item = await targetProcess(target, signal);
    if (active.has(item.pid)) throw Error('A JVM recording is already running for this process.');
    active.add(item.pid);
    let dir;
    try { dir = await ownedDirectory(storagePath); }
    catch (error) { active.delete(item.pid); throw error; }
    const configName = 'sampling.jfc', recordingName = 'sampling.jfr';
    const config = path.join(dir,configName), file = path.join(dir,recordingName);
    const name = 'rocketbrain_' + randomUUID().replaceAll('-','');
    let attempted = false, completed = false, cleaned = false;
    try {
      await fs.writeFile(config, PROFILE_XML, { flag:'wx' });
      await targetProcess(item, signal);
      attempted = true;
      const started = await command(item.pid,'JFR.start',[
        'name=' + name, 'settings=' + insideQuoted(config), 'duration=' + seconds + 's', 'disk=true',
        'maxsize=32m', 'dumponexit=false', 'filename=' + insideQuoted(file)
      ], { signal,label:'JVM flight recording start',outputLimit:4096 });
      if (!/Started recording\s+\d+/i.test(started)) throw Error('The JVM did not confirm the flight recording start.');
      await sleep(seconds * 1000,signal);
      const deadline = Date.now() + 10000;
      let hasOutput = false;
      while (Date.now() < deadline) {
        allowed(signal);
        const stat = await fs.stat(file).catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return null;
        });
        if (stat?.size > 0) { hasOutput = true; break; }
        await sleep(250,signal);
      }
      if (!hasOutput) throw Error('The target JVM produced an empty recording. Check the target JVM flight recorder repository path.');
      await targetProcess(item,signal);
      const summary = await inspectJfr(file,{signal});
      completed = true;
      if (summary.omittedEvents > 0 && output) {
        throw Error('The JVM included events outside the selected recording settings. Choose a JVM without overlapping recording events.');
      }
      await copyNew(file,output);
      return { summary,output:output || null,seconds };
    } finally {
      if (attempted && !completed) {
        try {
          await targetProcess(item);
          const stopped = await command(item.pid,'JFR.stop',['name=' + name],
            { label:'JVM flight recording stop',outputLimit:4096,timeout:8000 });
          cleaned = /Stopped recording|Could not find recording/i.test(stopped);
        } catch {
          // The configured duration still bounds the recorder if it stops
          // accepting Attach commands or the selected JVM has exited.
        }
      }
      active.delete(item.pid);
      if (attempted && !completed && !cleaned) await sleep(Math.min(seconds,30) * 1000);
      await removeOwnedFiles(dir,[configName,recordingName]);
    }
  }

  return { list,select,profile,inspectJfr,captureThreads,inspectThreads,histogram,inspectHeapDump };
}

module.exports = { createJvmDiagnostics };
