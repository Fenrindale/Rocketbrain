'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { nativeElfHeader } = require('./linux-native-executable');

const programLimit = 128 * 1024 * 1024;
const sourceLimit = 2 * 1024 * 1024;
const sourceSets = new Set(['commonMain', 'nativeMain', 'linuxMain', 'linuxX64Main']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const boundedArgument = value => typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f\x7f]/u.test(value);
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mode, stat.ctimeMs, stat.mtimeMs].join(':');
const changed = () => Error('The reviewed Kotlin/Native source, executable or GDB changed. Review again.');

function physicalFile(file, limit) {
  if (!boundedArgument(file) || !path.isAbsolute(file)) throw Error('Choose a physical local file.');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit || fs.realpathSync(file) !== file) {
    throw Error('Choose a regular local file within the Kotlin/Native debug size limit.');
  }
  return stat;
}

function snapshot(file, expected, limit) {
  const bytes = Buffer.alloc(expected.size);
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (identity(fs.fstatSync(handle)) !== identity(expected)) throw changed();
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
      if (!read) throw changed();
      offset += read;
    }
    if (identity(fs.fstatSync(handle)) !== identity(expected) ||
        identity(physicalFile(file, limit)) !== identity(expected)) throw changed();
    return bytes;
  } finally { fs.closeSync(handle); }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return Boolean(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function kotlinNativeElf(bytes) {
  const rejected = () => { throw Error('Choose a Linux x64 ELF executable with embedded DWARF debug info and lines.'); };
  if (!nativeElfHeader(bytes, 'x64')) rejected();
  const table = Number(bytes.readBigUInt64LE(40)), size = bytes.readUInt16LE(58);
  const count = bytes.readUInt16LE(60), index = bytes.readUInt16LE(62);
  if (table < 64 || size !== 64 || count < 1 || count > 8192 || index < 1 || index >= count ||
      table + count * size > bytes.length) rejected();
  function section(entry) {
    const at = table + entry * size;
    const offset = Number(bytes.readBigUInt64LE(at + 24)), length = Number(bytes.readBigUInt64LE(at + 32));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset + length > bytes.length) rejected();
    return bytes.subarray(offset, offset + length);
  }
  const names = section(index);
  const required = new Set(['.debug_info', '.debug_line']);
  for (let i = 1; i < count; i++) {
    const start = bytes.readUInt32LE(table + i * size), end = names.indexOf(0, start);
    if (end < start || end - start > 256) rejected();
    const name = names.toString('ascii', start, end);
    if (required.has(name) && section(i).length) required.delete(name);
  }
  if (required.size) rejected();
}

function reviewKotlinNativeLaunch({ workspace, program, source, args = [], gdb = '/usr/bin/gdb' }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw Error('Kotlin/Native debugging requires a Linux x64 extension host.');
  if (!Array.isArray(args) || args.length > 32 || !args.every(boundedArgument) || JSON.stringify(args).length > 16384) {
    throw Error('Use up to 32 literal application arguments within 16 KiB.');
  }
  const root = fs.realpathSync(workspace);
  const programStat = physicalFile(program, programLimit), sourceStat = physicalFile(source, sourceLimit);
  const output = path.dirname(program), module = path.resolve(output, '../../../..');
  if (!inside(root, program) || !inside(root, source) || !program.endsWith('.kexe') ||
      output !== path.join(module, 'build/bin/linuxX64/debugExecutable') ||
      !['build.gradle', 'build.gradle.kts'].some(name => fs.lstatSync(path.join(module, name), { throwIfNoEntry: false })?.isFile())) {
    throw Error('Choose a linuxX64 Gradle debug executable within the open Kotlin workspace.');
  }
  const [main, sourceSet, language] = path.relative(module, source).split(path.sep);
  if (main !== 'src' || !sourceSets.has(sourceSet) || language !== 'kotlin' || !source.endsWith('.kt') ||
      sourceStat.mtimeMs > programStat.mtimeMs) {
    throw Error('Choose a saved Kotlin source in the same Gradle module and rebuild its debug executable after changing it.');
  }
  if (!boundedArgument(gdb) || !path.isAbsolute(gdb)) throw Error('Choose an absolute system GDB path.');
  const tool = fs.realpathSync(gdb);
  if (inside(root, tool)) throw Error('Choose a system GDB executable outside the project.');
  const gdbStat = physicalFile(tool, programLimit);
  fs.accessSync(tool, fs.constants.X_OK);
  fs.accessSync(program, fs.constants.X_OK);
  const programBytes = snapshot(program, programStat, programLimit);
  kotlinNativeElf(programBytes);
  const artifactSha256 = sha(programBytes), sourceSha256 = sha(snapshot(source, sourceStat, sourceLimit));
  function validate(full = false) {
    if (identity(physicalFile(tool, programLimit)) !== identity(gdbStat) ||
        identity(physicalFile(program, programLimit)) !== identity(programStat) ||
        sha(snapshot(source, sourceStat, sourceLimit)) !== sourceSha256 ||
        (full && sha(snapshot(program, programStat, programLimit)) !== artifactSha256)) {
      throw changed();
    }
  }
  function validateInferior(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw Error('GDB did not identify the owned Kotlin/Native process.');
    const executable = '/proc/' + pid + '/exe';
    const observed = fs.statSync(executable);
    if (fs.readlinkSync(executable) !== program || observed.dev !== programStat.dev || observed.ino !== programStat.ino) {
      throw Error('The stopped process did not load the exact reviewed Kotlin/Native executable.');
    }
  }
  validate(true);
  return Object.freeze({ program, source, module, gdb: tool, args: Object.freeze([...args]), artifactSha256, sourceSha256,
    validate, validateInferior });
}

module.exports = { kotlinNativeElf, reviewKotlinNativeLaunch, boundedArgument };
