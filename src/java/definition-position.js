'use strict';

const { lexJava } = require('../spring/java');

function qualifiedStart(tokens, index) {
  while (tokens[index - 1]?.text === '.' && tokens[index - 2]?.kind === 'id') index -= 2;
  return index;
}

// Ordinary calls cannot be a Spring injection name or a JPA query source span.
// Keep annotation names and arguments on the analysis path, even during edits.
function isPlainQualifiedCall(document, position) {
  if (document.languageId !== 'java' ||
    !/\.\s*[\p{L}_$][\p{L}\p{N}_$]*\s*\(/u.test(document.lineAt(position.line).text)) return false;
  const text = document.getText();
  if (text.length > 1024 * 1024) return false;
  const { tokens, issues } = lexJava(text);
  if (issues.length) return false;
  const offset = document.offsetAt(position);
  const name = tokens.findIndex(token => token.kind === 'id' && token.start <= offset && offset < token.end);
  if (name < 2 || tokens[name - 1].text !== '.' || tokens[name - 2].kind !== 'id' ||
    tokens[name + 1]?.text !== '(') return false;

  const start = qualifiedStart(tokens, name);
  if (['@', 'new'].includes(tokens[start - 1]?.text)) return false;
  let closed = 0;
  for (let index = start - 1; index > 0; index--) {
    if (tokens[index].text === ')') closed++;
    else if (tokens[index].text === '(') {
      if (closed) closed--;
      else if (tokens[index - 1].kind === 'id' && tokens[qualifiedStart(tokens, index - 1) - 1]?.text === '@') return false;
    }
  }
  return true;
}

module.exports = { isPlainQualifiedCall };
