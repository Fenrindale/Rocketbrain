'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { independentJavaExecutable } = require('./debug-runtime');

const run = promisify(execFile);
const helper = String.raw`import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

class RegexCheck {
    public static void main(String[] args) throws Exception {
        String pattern = Files.readString(Path.of(args[0]), StandardCharsets.UTF_8);
        try {
            Pattern.compile(pattern);
            System.out.print("OK");
        } catch (PatternSyntaxException issue) {
            byte[] description = issue.getDescription().getBytes(StandardCharsets.UTF_8);
            System.out.print(issue.getIndex() + "\t" + Base64.getEncoder().encodeToString(description));
        } catch (StackOverflowError limit) {
            System.out.print("LIMIT");
        }
    }
}
`;

async function checkJavaRegex(javaHome, pattern, signal) {
  if (!path.isAbsolute(javaHome || '')) throw Error('Configure an independent Java JDK for regular expression validation.');
  if (typeof pattern !== 'string' || !pattern.isWellFormed() || pattern.length > 16384 || pattern.includes('\0')) {
    throw Error('Use a bounded Java regular expression without NUL or unpaired surrogates.');
  }
  signal?.throwIfAborted();
  const java = independentJavaExecutable(path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const parent = await fs.realpath(os.tmpdir());
  const folder = await fs.mkdtemp(path.join(parent, 'rb-check-regex-'));
  const script = path.join(folder, 'RegexCheck.java'), input = path.join(folder, 'pattern.txt');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CLASSPATH|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|JDK_JAVAC_OPTIONS|JAVA_OPTIONS)$/i.test(name)));
  try {
    await fs.writeFile(script, helper, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(input, pattern, { flag: 'wx', mode: 0o600 });
    let stdout;
    try {
      ({ stdout } = await run(java, ['-Xmx64m', '-Xss512k', '--source', '11', script, input], {
        cwd: folder, env, signal, timeout: 10000, maxBuffer: 32768, windowsHide: true
      }));
    } catch {
      signal?.throwIfAborted();
      throw Error('The configured JDK could not validate the regular expression.');
    }
    if (stdout === 'OK') return { valid: true };
    if (stdout === 'LIMIT') throw Error('The regular expression exceeds the Java engine’s compilation limit.');
    const error = /^(-?\d+)\t([A-Za-z0-9+/=]+)$/.exec(stdout);
    if (!error) throw Error('The configured Java engine returned an unexpected regex result.');
    const index = Number(error[1]);
    const description = Buffer.from(error[2], 'base64').toString('utf8');
    return { valid: false, index: Number.isSafeInteger(index) ? index : -1, description: description.slice(0, 240) };
  } finally {
    if (await fs.realpath(folder) !== folder || path.dirname(folder) !== parent) throw Error('The Java regex validation directory changed ownership.');
    await fs.rm(folder, { recursive: true, force: false });
  }
}

module.exports = { checkJavaRegex };
