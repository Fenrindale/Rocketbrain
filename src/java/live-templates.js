'use strict';

const { lexJava } = require('../spring/java');

const LIVE_COMMAND = 'rocketbrain.java.insertLiveTemplate';
const MAX_SOURCE_BYTES = 512 * 1024;
const BUILTINS = [
  ['main', 'Java entry point', 'public static void main(String[] args) {\n\t$0\n}'],
  ['sout', 'Print a value', 'System.out.println(${1:value});$0'],
  ['serr', 'Print an error', 'System.err.println(${1:message});$0'],
  ['fori', 'Index loop', 'for (int ${1:i} = 0; ${1:i} < ${2:limit}; ${1:i}++) {\n\t$0\n}'],
  ['iter', 'Enhanced for loop', 'for (${1:Object} ${2:item} : ${3:items}) {\n\t$0\n}'],
  ['tryc', 'Try and catch', 'try {\n\t$0\n} catch (${1:Exception} ${2:ex}) {\n\tthrow new IllegalStateException(${2:ex});\n}']
].map(([prefix, description, body]) => ({ prefix, description, body }));
const POSTFIX = [
  { prefix: 'if', description: 'If statement', emit: value => 'if (' + value + ') {\n\t$0\n}' },
  { prefix: 'nn', description: 'Non-null guard', emit: value => 'if (' + value + ' != null) {\n\t$0\n}' },
  { prefix: 'null', description: 'Null guard', emit: value => 'if (' + value + ' == null) {\n\t$0\n}' },
  { prefix: 'for', description: 'Enhanced for loop', emit: value => 'for (${1:Object} ${2:item} : ' + value + ') {\n\t$0\n}' },
  { prefix: 'var', description: 'Local variable (Java 10+)', emit: value => 'var ${1:value} = ' + value + ';$0' },
  { prefix: 'not', description: 'Negate expression', expression: true, emit: value => '!(' + value + ')' }
];
const STRUCTURAL = new Set(('abstract assert break case catch class continue default do else enum extends final finally for if implements '
  + 'import instanceof interface native new package private protected public record return sealed static super switch synchronized throw '
  + 'throws try void while yield').split(' '));

function listJavaLiveTemplates(custom = []) {
  if (!Array.isArray(custom) || custom.length > 35) throw Error('Configure at most 35 custom Java live templates.');
  const templates = new Map(BUILTINS.map(value => [value.prefix, value]));
  for (const entry of custom) {
    if (!entry || typeof entry.prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(entry.prefix) ||
        typeof entry.body !== 'string' || !entry.body.trim() || /\0/.test(entry.body) || Buffer.byteLength(entry.body) > 8192 ||
        (entry.description !== undefined && (typeof entry.description !== 'string' || /[\r\n\0]/.test(entry.description) ||
          entry.description.length > 120))) {
      throw Error('Each Java live template needs a letter-led prefix, a snippet body and an optional one-line description.');
    }
    templates.set(entry.prefix, {
      prefix: entry.prefix, body: entry.body.replace(/\r\n?/g, '\n'),
      description: entry.description || 'Java live template'
    });
  }
  return [...templates.values()];
}

function matchingOpen(tokens, at, left, right) {
  for (let depth = 0; at >= 0; at--) {
    if (tokens[at].text === right) depth++;
    if (tokens[at].text === left && --depth === 0) return at;
  }
  return -1;
}

function atomStart(tokens, at, depth = 0) {
  if (at < 0 || depth > 20) return -1;
  const token = tokens[at];
  let start = at;
  if (token.text === ')' || token.text === ']') {
    const paren = token.text === ')';
    const open = matchingOpen(tokens, at, paren ? '(' : '[', token.text);
    if (open < 0 || !paren && open === 0) return -1;
    const previous = tokens[open - 1];
    const called = previous && (previous.kind === 'id' && !STRUCTURAL.has(previous.text) || [')', ']'].includes(previous.text));
    start = called ? atomStart(tokens, open - 1, depth + 1) : paren ? open : -1;
  } else if (token.kind !== 'id' || STRUCTURAL.has(token.text)) {
    return -1;
  }
  if (start > 1 && tokens[start - 1].text === '.') start = atomStart(tokens, start - 2, depth + 1);
  return start;
}

function escapeSnippetText(value) {
  return value.replace(/[\\$}]/g, character => '\\' + character);
}

function liveCandidates(source, cursor, templates, postfix = true) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > source.length ||
      Buffer.byteLength(source) > MAX_SOURCE_BYTES) return [];
  const { tokens, issues } = lexJava(source);
  if (issues.some(issue => /Unicode|Unterminated/.test(issue))) return [];
  const prefix = /[A-Za-z][A-Za-z0-9_]*$/.exec(source.slice(0, cursor))?.[0] || '';
  const start = cursor - prefix.length;
  const at = tokens.findIndex(token => token.start === start && token.end === cursor && token.kind === 'id');
  if (prefix && at < 0) return [];
  const dot = prefix ? tokens[at - 1] : tokens.find(token => token.end === cursor);
  if (postfix && dot?.text === '.' && dot.end === start) {
    const dotIndex = tokens.indexOf(dot), last = tokens[dotIndex - 1];
    const firstIndex = atomStart(tokens, dotIndex - 1);
    if (firstIndex < 0 || !last || last.end !== dot.start || tokens[firstIndex - 1]?.text === 'new') return [];
    const first = tokens[firstIndex];
    const receiver = source.slice(first.start, last.end);
    if (receiver.length > 240 || /[\r\n]|\/\*|\/\//.test(receiver) || receiver === 'null') return [];
    const lineStart = source.lastIndexOf('\n', first.start - 1) + 1;
    const newline = source.indexOf('\n', cursor);
    const tail = source.slice(cursor, newline === -1 ? source.length : newline);
    const before = source.slice(lineStart, first.start);
    const reviewedStatement = /^\s*$/.test(before) && /^([ \t]*;)?[ \t\r]*(?:\/\/.*)?$/.test(tail);
    const semicolon = /^\s*;/.exec(tail)?.[0].length || 0;
    return POSTFIX.filter(template => template.prefix.startsWith(prefix) &&
      (template.expression ? !/^[\w$]/.test(source[cursor] || '') : reviewedStatement))
      .map(template => ({
        ...template, form: 'postfix', filter: receiver + '.' + template.prefix,
        body: template.emit(escapeSnippetText(receiver)),
        start: first.start, end: cursor + (template.expression ? 0 : semicolon)
      }));
  }
  if (!prefix || /[\w$]/.test(source[cursor] || '') ||
      !/^\s*$/.test(source.slice(source.lastIndexOf('\n', start - 1) + 1, start))) return [];
  return templates.filter(template => template.prefix.startsWith(prefix)).map(template =>
    ({ ...template, form: 'live', start, end: cursor }));
}

function registerJavaLiveTemplates(vscode) {
  function config(uri) {
    return vscode.workspace.getConfiguration('rocketbrain.java', uri);
  }
  function provide(document, position) {
    const settings = config(document.uri);
    const values = liveCandidates(document.getText(), document.offsetAt(position),
      listJavaLiveTemplates(settings.get('liveTemplates', [])), settings.get('postfixCompletion', true));
    return values.map(value => {
      const label = value.form === 'postfix' ? '.' + value.prefix : value.prefix;
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
      item.detail = value.description;
      item.insertText = new vscode.SnippetString(value.body);
      item.range = new vscode.Range(document.positionAt(value.start), document.positionAt(value.end));
      if (value.filter) item.filterText = value.filter;
      return item;
    });
  }
  const provider = vscode.languages.registerCompletionItemProvider({ language: 'java', scheme: 'file' }, {
    provideCompletionItems(document, position) {
      try { return provide(document, position); } catch { return []; }
    }
  }, '.');
  async function insertTemplate({ prefix } = {}) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'java' || editor.document.uri.scheme !== 'file') {
      throw Error('Open a Java file before inserting a live template.');
    }
    const document = editor.document;
    const version = document.version;
    const selections = [...editor.selections];
    const all = listJavaLiveTemplates(config(document.uri).get('liveTemplates', []));
    const selected = prefix ? all.find(template => template.prefix === prefix) :
      (await vscode.window.showQuickPick(all.map(item => ({ label: item.prefix, description: item.description, item })),
        { title: 'Java Live Templates' }))?.item;
    if (!selected) return false;
    if (editor !== vscode.window.activeTextEditor || document.version !== version || selections.length !== editor.selections.length ||
        selections.some((selection, index) => !selection.isEqual(editor.selections[index]))) {
      throw Error('The Java editor changed while selecting the template.');
    }
    return editor.insertSnippet(new vscode.SnippetString(selected.body), selections);
  }
  const command = vscode.commands.registerCommand(LIVE_COMMAND, async options => {
    try { return await insertTemplate(options); }
    catch (error) { await vscode.window.showErrorMessage('Rocketbrain Java: ' + error.message); return false; }
  });
  return { provide, insertTemplate, dispose() { provider.dispose(); command.dispose(); } };
}

module.exports = { LIVE_COMMAND, listJavaLiveTemplates, liveCandidates, registerJavaLiveTemplates };
