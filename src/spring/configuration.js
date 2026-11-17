'use strict';
const { rangeAt } = require('./java');

function unescapeProperty(value) { return value.replace(/\\(?:u([0-9a-fA-F]{4})|(.))/g, (all, unicode, char) => unicode ? String.fromCharCode(parseInt(unicode, 16)) : ({ t: '\t', n: '\n', r: '\r', f: '\f' })[char] ?? char); }
function parseProperties(file) {
  const result = [], lines = file.text.split(/\r?\n/); let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const start = offset; let line = lines[i]; offset += line.length + (file.text.includes('\r\n') ? 2 : 1);
    while (/(?:^|[^\\])(?:\\\\)*\\$/.test(line) && i + 1 < lines.length) { line = line.slice(0, -1) + lines[++i].trimStart(); offset += lines[i].length + (file.text.includes('\r\n') ? 2 : 1); }
    if (/^\s*[#!]/.test(line) || !line.trim()) continue;
    let keyEnd = -1, escaped = false, keyStart = /^\s*/.exec(line)[0].length;
    for (let j = keyStart; j < line.length; j++) { if (escaped) { escaped = false; continue; } if (line[j] === '\\') { escaped = true; continue; } if (/[=:\s]/.test(line[j])) { keyEnd = j; break; } }
    if (keyEnd < 0) keyEnd = line.length;
    let valueStart = keyEnd; while (/\s/.test(line[valueStart] || '') && valueStart < line.length) valueStart++;
    if (/[=:]/.test(line[valueStart] || '')) valueStart++;
    while (/\s/.test(line[valueStart] || '') && valueStart < line.length) valueStart++;
    const key = unescapeProperty(line.slice(keyStart, keyEnd));
    if (key) result.push({ key, value: unescapeProperty(line.slice(valueStart)), uri: file.uri, range: rangeAt(file.text, start + keyStart, start + keyEnd), source: file.uri });
  }
  return { entries: result, issues: [] };
}
function parseYaml(file) {
  const entries = [], issues = [], stack = []; let offset = 0;
  if (/^---\s*$/m.test(file.text)) return { entries, issues: ['Multi-document YAML is excluded; profile activation and document merging need the Spring configuration loader.'] };
  for (const line of file.text.split(/\r?\n/)) {
    const start = offset; offset += line.length + (file.text.includes('\r\n') ? 2 : 1);
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^( *)([\w.-]+):(?:\s+(.*))?\s*$/.exec(line);
    if (!match || /\t/.test(line)) { issues.push('YAML arrays, flow values, aliases and complex keys are not modeled.'); continue; }
    while (stack.length && stack.at(-1).indent >= match[1].length) stack.pop();
    const key = [...stack.map(item => item.key), match[2]].join('.');
    if (match[3] === undefined || !match[3].trim() || match[3].trim().startsWith('#')) { stack.push({ key: match[2], indent: match[1].length }); continue; }
    let value = match[3].trim();
    if (/^[\[\]{&*|>]/.test(value)) { issues.push(`Complex YAML value omitted: ${key}`); continue; }
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { issues.push(`Unrecognized YAML quoting: ${key}`); continue; } }
    else if (value.startsWith("'")) { if (!value.endsWith("'")) continue; value = value.slice(1, -1).replace(/''/g, "'"); }
    else value = value.replace(/\s+#.*$/, '');
    entries.push({ key, value: String(value), uri: file.uri, range: rangeAt(file.text, start + match[1].length, start + match[1].length + match[2].length), source: file.uri });
  }
  return { entries, issues: [...new Set(issues)] };
}

function configuration(files, options = {}) {
  const entries = new Map(), issues = [];
  const directories = [...new Set(files.map(file => file.uri.slice(0, file.uri.lastIndexOf('/'))))];
  const ambiguousContext = directories.length > 1;
  if (ambiguousContext) issues.push({ message: 'Application configuration comes from multiple directories/contexts. Select rocketbrain.spring.configurationRoots; source values remain unknown until the context is bounded.' });
  let profiles = Array.isArray(options.activeProfiles) ? options.activeProfiles.filter(value => typeof value === 'string' && value) : [];
  const parsed = files.map(file => ({ ...file, parsed: /\.properties$/i.test(file.uri) ? parseProperties(file) : parseYaml(file), profile: /\/application-([^/]+)\.(?:properties|ya?ml)$/i.exec(file.uri)?.[1] || '' })).sort((left, right) => left.uri.localeCompare(right.uri));
  const add = file => { for (const entry of file.parsed.entries) entries.set(entry.key, entry); issues.push(...file.parsed.issues.map(message => ({ uri: file.uri, message }))); };
  for (const file of parsed.filter(file => !file.profile)) add(file);
  if (!profiles.length) profiles = String(options.properties?.['spring.profiles.active'] ?? entries.get('spring.profiles.active')?.value ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const active = profiles.length ? profiles : String(entries.get('spring.profiles.default')?.value || 'default').split(',').map(value => value.trim());
  for (const profile of active) for (const file of parsed.filter(file => file.profile === profile)) add(file);
  if (ambiguousContext) for (const entry of entries.values()) entry.ambiguousContext = true;
  for (const [key, value] of Object.entries(options.properties || {})) if (['string', 'number', 'boolean'].includes(typeof value)) entries.set(key, { key, value: String(value), uri: null, range: null, source: 'rocketbrain.spring.properties override' });
  return { entries, profiles: active, issues, ambiguousContext, profileState: ambiguousContext && !options.activeProfiles?.length && !options.properties?.['spring.profiles.active'] ? 'unknown' : 'known' };
}

function resolveTemplate(template, entries, stack = []) {
  if (typeof template !== 'string') return { state: 'unknown', reason: 'The property expression is not a literal string.', definitions: [] };
  if (template.includes('#{')) return { state: 'unknown', reason: 'SpEL execution is not performed.', definitions: [] };
  if (stack.length > 20) return { state: 'unknown', reason: 'Placeholder recursion limit.', definitions: [] };
  let value = '', definitions = [], cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('${', cursor);
    if (open < 0) { value += template.slice(cursor); break; }
    value += template.slice(cursor, open); let end = open + 2, depth = 1, colon = -1;
    for (; end < template.length; end++) {
      if (template.startsWith('${', end)) { depth++; end++; }
      else if (template[end] === '}' && --depth === 0) break;
      else if (template[end] === ':' && depth === 1 && colon < 0) colon = end;
    }
    if (depth) return { state: 'unknown', reason: 'Unbalanced placeholder.', definitions };
    const keyText = template.slice(open + 2, colon >= 0 ? colon : end);
    const key = resolveTemplate(keyText, entries, stack);
    if (key.state !== 'resolved') return key;
    if (stack.includes(key.value)) return { state: 'unknown', reason: `Cyclic placeholder: ${[...stack, key.value].join(' → ')}`, definitions };
    const entry = entries.get(key.value);
    if (entry) {
      if (entry.ambiguousContext) return { state: 'unknown', reason: `Configuration context is ambiguous for ${key.value}; select one configuration root.`, definitions: [entry] };
      const resolved = resolveTemplate(entry.value, entries, [...stack, key.value]); definitions.push(entry, ...resolved.definitions);
      if (resolved.state !== 'resolved') return { ...resolved, definitions };
      value += resolved.value;
    } else if (colon >= 0) {
      const fallback = resolveTemplate(template.slice(colon + 1, end), entries, stack); definitions.push(...fallback.definitions);
      if (fallback.state !== 'resolved') return { ...fallback, definitions };
      value += fallback.value;
    } else return { state: 'unresolved', key: key.value, reason: `No local configuration value for ${key.value}; external property sources may provide it.`, definitions };
    cursor = end + 1;
  }
  return { state: 'resolved', value, definitions: [...new Map(definitions.map(item => [item.uri + '|' + item.key, item])).values()] };
}

module.exports = { parseProperties, parseYaml, configuration, resolveTemplate };
