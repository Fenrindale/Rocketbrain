'use strict';

const platforms = Object.freeze({ win32: 'Windows', linux: 'Linux', darwin: 'macOS' });
const neutral = '!inQuickOpen';
const workspace = '(!inputFocus || editorTextFocus)';
const trusted = 'isWorkspaceTrusted';
const project = workspace + ' && ' + trusted + ' && workspaceFolderCount > 0';
const editing = 'editorTextFocus && !suggestWidgetVisible && !renameInputVisible && !codeActionMenuVisible';
const java = editing + ' && ' + trusted + ' && resourceScheme == file && editorLangId == java';
const jvm = editing + ' && ' + trusted + ' && resourceScheme == file && (editorLangId == java || editorLangId == kotlin)';
const sql = editing + ' && ' + trusted + ' && editorLangId == sql';
const database = workspace + ' && ' + trusted;
const results = '!editorTextFocus && !inputFocus && ' + trusted +
  ' && (focusedView == rocketbrain.results || webviewId == rocketbrain.results)';
const debug = workspace + ' && ' + trusted + ' && debugType == rocketbrain-java';
const stopped = debug + ' && debugState == stopped';

const sections = [
  ['Workspace and Git', 'f8', [
    ['a', 'rocketbrain.contextActions', 'Context Actions', workspace],
    ['s', 'rocketbrain.searchEverywhere', 'Search Everywhere', workspace],
    ['r', 'rocketbrain.recentFiles', 'Recent Files', workspace + ' && workspaceFolderCount > 0'],
    ['f', 'workbench.view.explorer', 'Focus Explorer', workspace],
    ['e', 'workbench.action.focusActiveEditorGroup', 'Focus Editor Group', '(terminalFocus || !inputFocus || editorTextFocus)', true],
    ['t', 'workbench.action.terminal.focus', 'Focus Terminal', workspace],
    ['g', 'workbench.view.scm', 'Focus Source Control', workspace],
    ['w', 'rocketbrain.gitWorktree.context', 'Manage Git Worktree Context', project],
    ['p', 'workbench.actions.view.problems', 'Show Problems', workspace],
    ['o', 'workbench.action.output.toggleOutput', 'Toggle Output', workspace],
    ['k', 'workbench.action.openGlobalKeybindings', 'Open Keyboard Shortcuts', workspace],
    ['h', 'workbench.action.selectTheme', 'Choose Color Theme', workspace]
  ]],
  ['Java, Spring and Tests', 'f9', [
    ['d', 'editor.action.revealDefinition', 'Go to Definition', java + ' && editorHasDefinitionProvider'],
    ['u', 'rocketbrain.java.findUsages', 'Find JVM & Spring Usages', jvm],
    ['s', 'rocketbrain.java.fileStructure', 'File Structure', jvm],
    ['a', 'rocketbrain.java.workbench.sourceTarget', 'Inspect Java Source Build Target', java + ' && !activeEditorIsDirty'],
    ['b', 'rocketbrain.java.workbench.build', 'Build Java Project', project],
    ['k', 'rocketbrain.java.workbench.tasks', 'Choose Build Task', project],
    ['r', 'rocketbrain.java.workbench.run', 'Run Java Configuration', project],
    ['c', 'rocketbrain.java.changeSignature', 'Change Java Signature', java + ' && !editorReadonly'],
    ['x', 'rocketbrain.java.safeDelete', 'Safe Delete Java Declaration', java + ' && !editorReadonly'],
    ['t', 'rocketbrain.java.testing.discover', 'Discover Java Tests', project],
    ['n', 'rocketbrain.java.testing.run', 'Run Java Tests', project],
    ['y', 'rocketbrain.java.testing.cancel', 'Cancel Java Tests', project],
    ['e', 'rocketbrain.spring.endpoints', 'Navigate to Spring Endpoint', project],
    ['v', 'rocketbrain.spring.beans', 'Navigate to Spring Bean', project],
    ['g', 'rocketbrain.spring.beanGraph', 'Show Spring Bean Dependency Graph', project],
    ['f', 'rocketbrain.spring.refresh', 'Refresh Spring Analysis', project]
  ]],
  ['Database and Results', 'f10', [
    ['o', 'rocketbrain.openConsole', 'Open SQL Console', workspace],
    ['c', 'rocketbrain.connectMysql', 'Connect MySQL / MariaDB', database],
    ['s', 'rocketbrain.manageSessions', 'Manage Console Sessions', database],
    ['r', 'rocketbrain.runQuery', 'Run Selected SQL or Current Statement', sql],
    ['f', 'rocketbrain.sql.format', 'Format SQL', sql + ' && !editorReadonly'],
    ['p', 'rocketbrain.sql.explainVisual', 'Visualize SQL Execution Plan', sql + ' && rocketbrain.mysqlConnected'],
    ['x', 'rocketbrain.cancelQuery', 'Cancel Console Query', sql],
    ['n', 'rocketbrain.schemaCatalog.refresh', 'Refresh Schema Catalog', database + ' && rocketbrain.mysqlConnected'],
    ['h', 'rocketbrain.sql.queryHistory', 'Query History', database],
    ['a', 'rocketbrain.sql.savedQueries', 'Saved SQL Queries', database],
    ['d', 'rocketbrain.db.searchSources', 'Search SQL Files, Database Objects and DDL', database],
    ['g', 'rocketbrain.focusQueryResults', 'Focus Query Results', sql],
    ['e', 'rocketbrain.focusQueryEditor', 'Focus Query Editor', results],
    ['q', 'rocketbrain.contextActions.results', 'Query Result Actions', results],
    ['b', 'rocketbrain.db.browseObjectNames', 'Browse Database Object Names', database + ' && rocketbrain.mysqlConnected'],
    ['l', 'rocketbrain.sql.goToColumnOrigin', 'Go to Database Column Origin', sql + ' && rocketbrain.mysqlConnected']
  ]],
  ['Java Debugger', 'f11', [
    ['d', 'rocketbrain.java.debug', 'Debug Java Main Class', java + ' && debugState == inactive'],
    ['b', 'editor.debug.action.toggleBreakpoint', 'Toggle Java Breakpoint', java],
    ['c', 'workbench.action.debug.continue', 'Continue Java Debugging', stopped],
    ['p', 'workbench.action.debug.pause', 'Pause Java Debugging', debug + ' && debugState == running'],
    ['o', 'workbench.action.debug.stepOver', 'Step Over in Java', stopped],
    ['i', 'rocketbrain.java.smartStepInto', 'Step Into a Java Call', stopped],
    ['u', 'workbench.action.debug.stepOut', 'Step Out in Java', stopped],
    ['a', 'rocketbrain.java.showAsyncTaskStack', 'Show Java Async Submission Stack', stopped]
  ]]
];

function profileRules(platform) {
  if (!Object.hasOwn(platforms, platform)) throw Error('Choose Windows, Linux or macOS for the keyboard profile.');
  const modifier = platform === 'darwin' ? 'cmd' : 'ctrl';
  return sections.flatMap(([group, leader, entries]) => entries.map(([letter, command, title, clause, allowTerminal]) => ({
    group, title, key: modifier + '+shift+' + leader + ' ' + letter, command,
    when: [neutral, allowTerminal ? undefined : '!terminalFocus', clause].filter(Boolean).join(' && ')
  })));
}

const maxInputBytes = 1024 * 1024;
const maxRules = 6000;

function parseKeybindings(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > maxInputBytes) {
    throw Error('Choose a keybindings JSON or JSONC document up to 1 MiB.');
  }
  // Keep strings intact while stripping JSONC comments and trailing commas.
  const tokens = /"(?:[^"\\]|\\[\s\S])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|\/(?!\/|\*)|[\[\]{},]|[^"\/\[\]{},]+/gy;
  text = text.replace(/^\uFEFF/u, '');
  const clean = [];
  let pendingComma = false, removableComma = false, previous, depth = 0;
  while (tokens.lastIndex < text.length) {
    const match = tokens.exec(text);
    if (!match) throw Error('The supplied keybindings contain an unclosed string or comment.');
    const part = match[0];
    if (part.startsWith('//') || part.startsWith('/*') || !part.trim()) {
      clean.push(' ');
      continue;
    }
    if (part === '[' || part === '{') depth++;
    if (part === ']' || part === '}') depth--;
    if (depth > 32) throw Error('The supplied keybindings are nested too deeply.');
    if (pendingComma && (!removableComma || ![']', '}'].includes(part))) clean.push(',');
    pendingComma = part === ',';
    removableComma = pendingComma && previous && ![',', '[', '{'].includes(previous);
    if (!pendingComma) clean.push(part);
    previous = part;
  }
  if (pendingComma) clean.push(',');
  let rules;
  try { rules = JSON.parse(clean.join('')); }
  catch { throw Error('The supplied document is not valid keybindings JSONC.'); }
  if (!Array.isArray(rules) || rules.length > maxRules ||
      rules.some(rule => !rule || typeof rule !== 'object' || Array.isArray(rule))) {
    throw Error('Use a keybindings array with at most 6000 objects.');
  }
  return rules;
}

const modifierAliases = new Map([
  ['ctrl', 'ctrl'], ['control', 'ctrl'], ['shift', 'shift'], ['alt', 'alt'],
  ['option', 'alt'], ['cmd', 'meta'], ['meta', 'meta'], ['win', 'meta']
]);

function normalizedKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\r\n\0]/u.test(value)) return;
  const chords = value.toLowerCase().trim().replace(/ *\+ */gu, '+').split(/\s+/u);
  if (chords.length > 4) return;
  const steps = chords.map(chord => {
    const parts = chord.split('+'), key = parts.pop(), modifiers = parts.map(item => modifierAliases.get(item));
    if (!key || modifiers.some(item => !item) || new Set(modifiers).size !== modifiers.length) return;
    return [...modifiers.sort(), key].join('+');
  });
  if (steps.every(Boolean)) return steps.join(' ');
}

function literalFacts(when) {
  if (!when) return [];
  const facts = [];
  for (const term of when.split('&&').map(value => value.trim())) {
    const equality = /^(editorLangId|resourceScheme|debugState|debugType|focusedView) (==|!=) (?:([\w.-]+)|'([\w.-]+)')$/u.exec(term);
    const toggle = /^(!)?([\w.]+)$/u.exec(term);
    if (equality) facts.push([equality[1], equality[3] ?? equality[4], equality[2] === '==']);
    else if (toggle) facts.push([toggle[2], 'true', !toggle[1]]);
    else return [];
  }
  return facts;
}

function scopeDisjoint(left, right) {
  const other = literalFacts(right);
  return literalFacts(left).some(([key, value, equal]) =>
    other.some(([peer, expected, matches]) =>
      key === peer && (equal && matches ? value !== expected : equal !== matches && value === expected)));
}

function auditProfile(platform, { commands, manifests = [], input } = {}) {
  const profile = profileRules(platform);
  const available = new Set(commands);
  const entries = new Map();
  let manifestRules = 0, manifestIncomplete = false;
  function scan(binding, source, contributed) {
    const override = { win32: 'win', linux: 'linux', darwin: 'mac' }[platform];
    const pressed = contributed && binding?.[override] !== undefined ? binding[override] : binding?.key;
    const key = normalizedKey(pressed), command = binding?.command;
    if (!key || typeof command !== 'string' || !/^[-\w.:]{0,180}$/u.test(command)) return;
    const when = typeof binding.when === 'string' && binding.when.length <= 1500 &&
      !/[\u0000-\u001f\u007f]/u.test(binding.when) ? binding.when : '';
    const found = entries.get(key) || [];
    found.push({ source, command, when, action: command.startsWith('-') ? 'remove' : command ? 'bind' : 'block',
      systemWide: binding.systemWide === true, hasArgs: Object.hasOwn(binding, 'args') });
    entries.set(key, found);
  }
  for (const manifest of manifests) {
    const bindings = manifest?.packageJSON?.contributes?.keybindings;
    if (!Array.isArray(bindings)) continue;
    for (const binding of bindings) {
      if (manifestRules === maxRules) { manifestIncomplete = true; break; }
      manifestRules++;
      scan(binding, manifest.id, true);
    }
    if (manifestIncomplete) break;
  }
  const supplied = input === undefined ? [] : parseKeybindings(input);
  for (const binding of supplied) scan(binding, 'Supplied keybindings', false);
  const routes = profile.map(rule => {
    const key = normalizedKey(rule.key), overlaps = [];
    let omitted = 0;
    for (const [existing, bindings] of entries) {
      const relation = existing === key ? 'same shortcut' :
        existing.startsWith(key + ' ') || key.startsWith(existing + ' ') ? 'chord prefix' : undefined;
      if (!relation) continue;
      for (const binding of bindings) {
        if (overlaps.length === 24) { omitted++; continue; }
        const scope = scopeDisjoint(rule.when, binding.when) ? 'disjoint literal contexts' :
          relation === 'same shortcut' && binding.action === 'bind' && !binding.hasArgs && !binding.systemWide && binding.command === rule.command &&
          binding.when === rule.when ? 'identical rule' : 'possible overlap';
        overlaps.push({ ...binding, relation, scope });
      }
    }
    return { ...rule, available: available.has(rule.command), overlaps, omitted };
  });
  return { platform, routes, manifestRules, manifestIncomplete, suppliedRules: supplied.length,
    suppliedInput: input !== undefined };
}

function exportProfile(report) {
  return JSON.stringify(report.routes.filter(rule => rule.available).map(({ key, command, when }) =>
    ({ key, command, when })), null, 2) + '\n';
}

module.exports = { platforms, profileRules, parseKeybindings, auditProfile, exportProfile };
