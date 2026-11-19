'use strict';

// Audit exactly the selected Git snapshot. Never print a matching credential.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const mode = process.argv[2] || '--worktree';
if (process.argv.length > 3 || !['--worktree', '--staged', '--tracked'].includes(mode)) {
  console.error('Usage: node scripts/publication-audit.js [--worktree|--staged|--tracked]');
  process.exit(2);
}
const top = new Set([
  '.gitignore', '.gitattributes', '.vscodeignore', 'README.md', 'NOTICE.txt',
  'THIRD-PARTY-LICENSES.txt', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.vscode/launch.json', '.vscode/tasks.json', 'architecture/product-policy.json',
]);
function publicPath(name) {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..')) return false;
  if (/(?:^|\/)(?:node_modules|dist|target|build|bin|\.gradle|\.idea|\.settings|\.git)(?:\/|$)/i.test(name)) return false;
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.classpath|\.project|application-local\.[^/]+|connection[^/]*\.local\.json)$/i.test(name)) return false;
  if (top.has(name)) return true;
  if (name.includes('/.vscode/')) return false;
  if (/^src\/.+\.(?:js|cjs|json|css)$/.test(name)) return true;
  if (/^runtime\/.+\.java$/.test(name)) return true;
  if (name === 'test/fixtures/refactoring-v24-package/src/main/resources/fixture/packagev24/payload/nested/rows.csv') return true;
  if (/^test\/.+\.(?:js|cjs|java|json|xml|properties|sql|gradle|txt|css|ya?ml)$/.test(name)) return true;
  if (/^test\/fixtures\/[^\0]+\/src\/(?:main|test)\/resources\/META-INF\/services\/[A-Za-z_$][\w.$]*$/.test(name)) return true;
  if (/^scripts\/[^/]+\.(?:js|ps1)$/.test(name) && !/^scripts\/(?:record-v|observe-reference\.)/.test(name)) return true;
  if (/^docs\/.+\.(?:md|json)$/.test(name)) return true;
  if (/^\.github\/(?:workflows\/[^/]+\.ya?ml|[^/]+\.md)$/.test(name)) return true;
  return /^(?:media\/[^/]+\.svg|themes\/[^/]+\.json|third-party\/licenses\/[^/]+\.(?:txt|json))$/.test(name);
}
const rules = [
  ['github-credential', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{60,})/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['private-key-material', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['personal-windows-path', /[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!Public(?:[\\/]|['"]|$))[^\\/\s'"<>]+/gi],
  ['personal-unix-path', /\/(?:home|Users)\/(?!runner(?:\/|['"]|$))[A-Za-z0-9_.-]+\//g],
  ['private-enterprise-host', /\baiapp\.ghe\.com\b/gi],
];
function git(args, encoding = 'utf8') {
  return execFileSync(process.env.GIT || 'git', args, { cwd: root, encoding, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
}
const args = mode === '--staged'
  ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']
  : ['ls-files', '-z', '--cached', ...(mode === '--worktree' ? ['--others', '--exclude-standard'] : [])];
const files = [...new Set(git(args).split('\0').filter(Boolean))].sort();
if (!files.length) throw Error('No public files were selected; an empty audit is not a pass.');
const failures = [];
const entries = [];
for (const name of files) {
  if (!publicPath(name)) { failures.push({ file: name, rule: 'path-outside-public-allowlist' }); continue; }
  let bytes;
  if (mode === '--staged') {
    const info = git(['ls-files', '--stage', '--', name]).trim();
    if (!/^100644 |^100755 /.test(info)) { failures.push({ file: name, rule: 'non-regular-index-entry' }); continue; }
    bytes = git(['show', ':' + name], null);
  } else {
    const absolute = path.join(root, ...name.split('/'));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) { failures.push({ file: name, rule: 'non-regular-file' }); continue; }
    bytes = fs.readFileSync(absolute);
  }
  if (bytes.length > 1024 * 1024) failures.push({ file: name, rule: 'source-exceeds-one-mib' });
  if (bytes.includes(0)) { failures.push({ file: name, rule: 'binary-content' }); continue; }
  const content = bytes.toString('utf8');
  if (!Buffer.from(content, 'utf8').equals(bytes)) failures.push({ file: name, rule: 'invalid-utf8' });
  for (const [rule, pattern] of rules) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content))) {
      failures.push({ file: name, line: content.slice(0, match.index).split('\n').length, rule });
    }
  }
  entries.push({ path: name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
}
const digest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
console.log(JSON.stringify({ mode: mode.slice(2), files: files.length, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0), contentManifestSha256: digest, failures }, null, 2));
if (failures.length) process.exitCode = 1;
