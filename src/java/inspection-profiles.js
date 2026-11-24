'use strict';

const RULES = Object.freeze({
  emptyCatch: { severity:'warning', label:'Empty catch block' },
  emptyFinally: { severity:'information', label:'Empty finally block' },
  emptyIf: { severity:'warning', label:'Empty if statement' },
  duplicateImport: { severity:'information', label:'Duplicate import' }
});
const SEVERITIES = new Set(['error','warning','information','hint','off']);
const MODES = new Set(['exact','ignore-literals']);
const BUILTINS = [
  { name:'Java workspace',include:['**/*.java'] },
  { name:'Java application sources',include:['**/src/main/java/**/*.java'] }
];

function globPattern(glob) {
  if (typeof glob !== 'string' || !glob.length || glob.length > 160 ||
      glob.startsWith('/') || /[\\:\0\r\n{}\[\]]/.test(glob) ||
      glob.split('/').some(part => !part || ['.','..'].includes(part) || part.includes('**') && part !== '**') ||
      (glob.match(/\*\*|\*/g) || []).length > 10) {
    throw Error('Use relative inspection glob patterns with * or ** and no traversal.');
  }
  const chunks = [];
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] !== '*') chunks.push('[^/]*');
      else if (glob[index + 2] === '/') { chunks.push('(?:[^/]+/)*'); index += 2; }
      else { chunks.push('.*'); index++; }
    } else if (char === '?') chunks.push('[^/]');
    else chunks.push(char.replace(/[.+()^$|]/g, '\\$&'));
  }
  return new RegExp('^' + chunks.join('') + '$', process.platform === 'win32' ? 'iu' : 'u');
}

function inspectionProfile(value) {
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\r\n\0]/.test(value.name)) {
    throw Error('Every Java inspection profile needs a short name.');
  }
  const include = value.include ?? ['**/*.java'], exclude = value.exclude ?? [];
  if (!Array.isArray(include) || !include.length || include.length > 12 || !Array.isArray(exclude) || exclude.length > 12) {
    throw Error('Use 1 to 12 include globs and up to 12 exclude globs per inspection profile.');
  }
  const includePatterns = include.map(globPattern), excludePatterns = exclude.map(globPattern);
  const selected = value.rules ?? {};
  if (!selected || typeof selected !== 'object' || Array.isArray(selected) ||
      Object.keys(selected).some(id => !Object.hasOwn(RULES,id) || !SEVERITIES.has(selected[id]))) {
    throw Error('Set each known Java inspection rule to error, warning, information, hint or off.');
  }
  const rules = Object.fromEntries(Object.entries(RULES).map(([id, rule]) => [id,selected[id] ?? rule.severity]));
  const duplicateMode = value.duplicateMode ?? 'exact', minDuplicateTokens = value.minDuplicateTokens ?? 32;
  if (!MODES.has(duplicateMode) || !Number.isInteger(minDuplicateTokens) || minDuplicateTokens < 20 || minDuplicateTokens > 200) {
    throw Error('Set duplicate mode to exact or ignore-literals and the minimum to 20–200 tokens.');
  }
  return {
    name:value.name.trim(), include:[...include], exclude:[...exclude], rules, duplicateMode,minDuplicateTokens,
    matches: relative => {
      const normalized = relative.replaceAll('\\','/');
      return includePatterns.some(pattern => pattern.test(normalized)) && !excludePatterns.some(pattern => pattern.test(normalized));
    }
  };
}

function inspectionProfiles(values = []) {
  if (!Array.isArray(values) || values.length > 20) throw Error('Configure at most 20 Java inspection profiles.');
  const indexes = new Map(BUILTINS.map(value => [value.name,inspectionProfile(value)]));
  const user = new Set();
  for (const entry of values) {
    const prepared = inspectionProfile(entry);
    if (user.has(prepared.name)) throw Error('Use unique Java inspection profile names.');
    user.add(prepared.name);
    indexes.set(prepared.name,prepared);
  }
  return [...indexes.values()];
}

module.exports = { inspectionProfile, inspectionProfiles, RULES };
