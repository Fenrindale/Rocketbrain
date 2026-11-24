'use strict';

const { lexJava, parseJavaFile } = require('../spring/java');

const SELECTIONS = ['constructor', 'accessors', 'equalsHashCode', 'delegate'];
const MODIFIERS = new Set('public private protected static final transient volatile synchronized native strictfp abstract'.split(' '));
const PRIMITIVES = new Set('boolean byte char short int long float double'.split(' '));
const TYPE_TEXT = /^[\p{L}\p{N}_. $<>,?&\[\]\s]+$/u;
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

function closeOf(tokens, at) {
  const ends = { '{': '}', '(': ')', '[': ']' }, key = tokens[at]?.text, end = ends[key];
  if (!end) return -1;
  for (let depth = 0, i = at; i < tokens.length; i++) {
    if (tokens[i].text === key) depth++;
    if (tokens[i].text === end && --depth === 0) return i;
  }
  return -1;
}

function annotationEnd(tokens, start) {
  let cursor = start + 1;
  if (tokens[cursor]?.kind !== 'id') return start;
  while (tokens[cursor + 1]?.text === '.' && tokens[cursor + 2]?.kind === 'id') cursor += 2;
  if (tokens[cursor + 1]?.text === '(') {
    const close = closeOf(tokens, cursor + 1);
    return close < 0 ? start : close + 1;
  }
  return cursor + 1;
}

function afterField(tokens, start, end) {
  let extra = false;
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (token.text === ';') return { next: index + 1, extra };
    if (token.text === ',') extra = true;
    if (['[','(','{'].includes(token.text)) {
      const close = closeOf(tokens, index);
      if (close < 0 || close >= end) break;
      index = close;
    }
  }
  return { next: end, extra: true };
}

function readFields(source, tokens, start, end) {
  const fields = [];
  let pos = start, excluded = 0;
  while (pos < end) {
    if (tokens[pos].text === ';') { pos++; continue; }
    const modifiers = new Set();
    const initial = pos;
    for (; pos < end;) {
      const keyword = tokens[pos].text;
      if (keyword === '@') {
        const next = annotationEnd(tokens, pos);
        if (next <= pos) throw Error('An incomplete Java annotation prevents field selection.');
        pos = next;
      } else if (MODIFIERS.has(keyword)) {
        modifiers.add(keyword);
        pos++;
      } else break;
    }
    const head = pos;
    while (pos < end && ![';','{','=','('].includes(tokens[pos].text)) pos++;
    if (pos >= end) break;
    const separator = tokens[pos].text;
    if (separator === '{') {
      const close = closeOf(tokens, pos);
      if (close < 0) break;
      pos = close + 1;
      continue;
    }
    if (separator === '(') {
      const close = closeOf(tokens, pos);
      if (close < 0) break;
      pos = close + 1;
      while (pos < end && ![';','{'].includes(tokens[pos].text)) pos++;
      if (pos >= end) break;
      pos = tokens[pos].text === '{' ? closeOf(tokens, pos) + 1 : pos + 1;
      if (pos <= initial) break;
      continue;
    }
    const name = tokens[pos - 1], typeTokens = tokens.slice(head, pos - 1);
    const trailing = afterField(tokens, pos + (separator === '=' ? 1 : 0), end);
    const type = typeTokens.length ? source.slice(typeTokens[0].start, typeTokens.at(-1).end) : '';
    let genericDepth = 0;
    const combined = typeTokens.some(token => {
      if (token.text === '<') genericDepth++;
      if (token.text === '>') genericDepth--;
      return token.text === ',' && genericDepth <= 0;
    });
    if (name?.kind === 'id' && type && TYPE_TEXT.test(type) && !combined && !trailing.extra && genericDepth === 0) {
      if (!modifiers.has('static')) fields.push({
        name: name.text, type: type.replace(/\s+/g, ' '), final: modifiers.has('final'),
        initialized: separator === '=', offset: tokens[initial].start
      });
    } else excluded++;
    pos = trailing.next;
  }
  return { fields, excluded };
}

function inspectClass(source, offset) {
  const { tokens, issues } = lexJava(source);
  if (Buffer.byteLength(source) > 512 * 1024 || issues.length) throw Error('Use a complete bounded Java source before generating members.');
  const parsed = parseJavaFile({ text: source });
  let depth = 0;
  for (let at = 0; at < tokens.length; at++) {
    if (tokens[at].text === '{') depth++;
    if (tokens[at].text === '}') depth--;
    if (depth !== 0 || tokens[at].text !== 'class' || tokens[at - 1]?.text === '.' || tokens[at + 1]?.kind !== 'id') continue;
    const start = tokens.findIndex((token, index) => index > at && token.text === '{');
    const end = closeOf(tokens, start);
    if (start < 0 || end < start) break;
    if (offset >= tokens[at].start && offset <= tokens[end].end) {
      const name = tokens[at + 1].text, header = tokens.slice(at + 2, start);
      const extendsAt = header.findIndex(token => token.text === 'extends');
      let supertype = '';
      if (extendsAt >= 0) {
        let generic = 0;
        for (let i = 0; i < extendsAt; i++) generic += Number(header[i].text === '<') - Number(header[i].text === '>');
        if (!generic) supertype = header.slice(extendsAt + 1).find(token => token.kind === 'id')?.text || '?';
      }
      return {
        name, owner: [parsed.packageName,name].filter(Boolean).join('.'), packageName: parsed.packageName,
        imports: parsed.imports, generic: header[0]?.text === '<', supertype,
        start: tokens[at].start, closing: tokens[end].start,
        ...readFields(source, tokens, start + 1, end)
      };
    }
    at = end;
  }
  throw Error('Place the cursor inside a top-level Java class.');
}

function directMethods(report, owner) {
  return report.methods.filter(method => method.owner === owner);
}

function delegateMethods(report, owner) {
  return directMethods(report, owner).filter(method =>
    !method.constructor && !method.generic && !method.varargs &&
    method.modifiers.includes('public') && !method.modifiers.includes('static') &&
    IDENTIFIER.test(method.name) && TYPE_TEXT.test(method.returnType) &&
    method.parameters.every(parameter => !parameter.annotated && IDENTIFIER.test(parameter.name) && TYPE_TEXT.test(parameter.type)) &&
    method.throwsTypes.every(type => TYPE_TEXT.test(type)));
}

function cap(value) {
  return value[0].toUpperCase() + value.slice(1);
}

function sameClassCast(model) {
  if (!model.generic) return model.name;
  throw Error('Generate equality for a non-generic class with a direct Object superclass.');
}

function arrayComparison(field) {
  const stripped = field.type.replace(/\s/g, ''), dims = (/(?:\[\])+$/.exec(stripped)?.[0].length || 0) / 2;
  if (!dims) return null;
  return dims === 1 && PRIMITIVES.has(stripped.slice(0, -2)) ? 'shallow' : 'deep';
}

function equalsExpression(field) {
  const left = 'this.' + field.name, right = 'that.' + field.name, array = arrayComparison(field);
  if (array) return 'java.util.Arrays.' + (array === 'deep' ? 'deepEquals' : 'equals') + '(' + left + ', ' + right + ')';
  if (['float','double'].includes(field.type)) return 'java.lang.' + cap(field.type) + '.compare(' + left + ', ' + right + ') == 0';
  if (PRIMITIVES.has(field.type)) return left + ' == ' + right;
  return 'java.util.Objects.equals(' + left + ', ' + right + ')';
}

function hashExpression(field) {
  const value = 'this.' + field.name, array = arrayComparison(field);
  if (array) return 'java.util.Arrays.' + (array === 'deep' ? 'deepHashCode' : 'hashCode') + '(' + value + ')';
  return 'java.util.Objects.hashCode(' + value + ')';
}

function emitMembers(model, { kind, fields, accessor = 'both', delegate } = {}, methods = []) {
  if (!SELECTIONS.includes(kind) || !Array.isArray(fields) || fields.length === 0 || fields.length > 20 ||
      new Set(fields).size !== fields.length) throw Error('Select unique Java fields for the requested generation.');
  const selected = fields.map(name => {
    const result = model.fields.find(field => field.name === name);
    if (!result) throw Error('A selected Java field is unavailable.');
    return result;
  });
  const generated = [], names = new Set();
  function member(name, params, declaration, body) {
    const key = name + '/' + params;
    if (names.has(key)) throw Error('Selected fields generate colliding members.');
    if (kind !== 'constructor' && methods.some(method => method.name === name && method.parameters.length === params)) {
      throw Error('A selected member collides with existing Java method ' + name + '.');
    }
    generated.push({ name, params, declaration, body });
    names.add(key);
  }
  if (kind === 'constructor') {
    if (selected.some(field => field.final && field.initialized) ||
        model.fields.some(field => field.final && !field.initialized && !fields.includes(field.name))) {
      throw Error('Select every uninitialized final field and omit initialized final fields for a constructor.');
    }
    const args = selected.map(field => field.type + ' ' + field.name).join(', ');
    member(model.name, selected.length, 'public ' + model.name + '(' + args + ')',
      selected.map(field => 'this.' + field.name + ' = ' + field.name + ';'));
  } else if (kind === 'accessors') {
    if (!['get','set','both'].includes(accessor)) throw Error('Select getters, setters or both.');
    for (const field of selected) {
      if (accessor !== 'set') {
        const name = (field.type === 'boolean' ? 'is' : 'get') + cap(field.name);
        member(name, 0, 'public ' + field.type + ' ' + name + '()', ['return this.' + field.name + ';']);
      }
      if (accessor !== 'get' && !field.final) {
        const name = 'set' + cap(field.name);
        member(name, 1, 'public void ' + name + '(' + field.type + ' ' + field.name + ')',
          ['this.' + field.name + ' = ' + field.name + ';']);
      } else if (accessor === 'set') throw Error('Final Java fields do not have setters.');
    }
  } else if (kind === 'equalsHashCode') {
    if (model.supertype) throw Error('Review inherited equality separately before generating equals and hashCode.');
    const cast = sameClassCast(model);
    member('equals', 1, '@java.lang.Override\npublic boolean equals(java.lang.Object other)', [
      'if (this == other) return true;',
      'if (other == null || getClass() != other.getClass()) return false;',
      cast + ' that = (' + cast + ') other;',
      'return ' + selected.map(equalsExpression).join(' &&\n    ') + ';'
    ]);
    member('hashCode', 0, '@java.lang.Override\npublic int hashCode()', [
      'int result = 1;', ...selected.map(field => 'result = 31 * result + ' + hashExpression(field) + ';'), 'return result;'
    ]);
  } else {
    if (selected.length !== 1 || !delegate) throw Error('Select one delegate field and one observed method.');
    const name = delegate.name;
    const args = delegate.parameters.map(p => p.type + ' ' + p.name).join(', ');
    const throws = delegate.throwsTypes.length ? ' throws ' + delegate.throwsTypes.join(', ') : '';
    const call = 'this.' + selected[0].name + '.' + name + '(' + delegate.parameters.map(p => p.name).join(', ') + ');';
    member(name, delegate.parameters.length, 'public ' + delegate.returnType + ' ' + name + '(' + args + ')' + throws,
      [(delegate.returnType === 'void' ? '' : 'return ') + call]);
  }
  if (!generated.length) throw Error('The selection has no eligible Java members.');
  return generated;
}

function materializeMembers(source, model, members, unitIndent = '    ') {
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lineStart = source.lastIndexOf('\n', model.closing - 1) + 1;
  const leading = source.slice(lineStart, model.closing);
  const ownLine = /^[ \t]*$/.test(leading);
  const classLine = source.lastIndexOf('\n', model.start - 1) + 1;
  const indentBase = ownLine ? leading : /^[ \t]*/.exec(source.slice(classLine, model.start))[0];
  const memberIndent = indentBase + unitIndent, bodyIndent = memberIndent + unitIndent;
  const blocks = members.map(member => {
    const declaration = member.declaration.split('\n').map(line => memberIndent + line).join(eol);
    const body = member.body.flatMap(line => line.split('\n')).map(line => bodyIndent + line).join(eol);
    return declaration + ' {' + eol + body + eol + memberIndent + '}';
  });
  const offset = ownLine ? lineStart : model.closing;
  const insertion = eol + blocks.join(eol + eol) + eol + (ownLine ? '' : indentBase);
  const text = source.slice(0, offset) + insertion + source.slice(offset);
  return { offset, insertion, text, generatedStart: offset, generatedEnd: offset + insertion.length };
}

module.exports = { inspectClass, directMethods, delegateMethods, emitMembers, materializeMembers, SELECTIONS };
