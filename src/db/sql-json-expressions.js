'use strict';

const limit = 16 * 1024;
const maximumLegs = 128;
const paths = (from, multiple = true, stride = 1) => ({ from, multiple, stride });
const readJson = { minimum:1, maximum:1, family:'json', documents:[0] };
const pairUpdate = { ...readJson, minimum:3, maximum:Infinity, pairs:true, paths:paths(1,false,2) };
const rules = new Map(Object.entries({
  JSON_EXTRACT:{...readJson, minimum:2, maximum:Infinity, paths:paths(1)},
  JSON_SET:pairUpdate,
  JSON_INSERT:pairUpdate,
  JSON_REPLACE:pairUpdate,
  JSON_ARRAY_APPEND:pairUpdate,
  JSON_REMOVE:{...readJson, minimum:2, maximum:Infinity, paths:paths(1,false)},
  JSON_KEYS:{...readJson, maximum:2, paths:paths(1,false)},
  JSON_TYPE:{...readJson, family:'string'},
  JSON_DEPTH:{...readJson, family:'integer'},
  JSON_LENGTH:{...readJson, maximum:2, family:'integer', paths:paths(1)},
  JSON_VALID:{minimum:1, maximum:1, family:'integer'},
  JSON_CONTAINS:{...readJson, minimum:2, maximum:3, family:'integer', documents:[0,1], paths:paths(2,false)},
  JSON_CONTAINS_PATH:{...readJson, minimum:3, maximum:Infinity, family:'integer', paths:paths(2), mode:1},
  JSON_OBJECT:{minimum:0, maximum:Infinity, family:'json', pairs:true},
  JSON_ARRAY:{minimum:0, maximum:Infinity, family:'json'},
  JSON_QUOTE:{minimum:1, maximum:1, family:'string'},
  JSON_UNQUOTE:{minimum:1, maximum:1, family:'string'}
}));

function literalValue(source, at, sqlMode) {
  if (at?.kind !== 'string') return undefined;
  const raw = source.slice(at.start,at.end), quote = raw[0];
  if (raw.length < 2 || raw.length > limit || raw.at(-1) !== quote ||
      !["'",'"'].includes(quote) || quote === '"' && !Array.isArray(sqlMode)) return undefined;
  const content = raw.slice(1,-1);
  if (content.includes('\\') && !Array.isArray(sqlMode)) return undefined;
  const escapes = !sqlMode?.some(mode=>String(mode).toUpperCase()==='NO_BACKSLASH_ESCAPES');
  const decoded = {0:'\0', b:'\b', n:'\n', r:'\r', t:'\t', Z:'\x1a'};
  let value = '';
  for (let i=0; i<content.length; i++) {
    const character = content[i];
    if (character === quote && content[i+1] === quote) {
      value += quote;
      i++;
    } else if (character === '\\' && escapes) {
      const escaped = content[++i];
      if (escaped === undefined || escaped === '%' || escaped === '_') return undefined;
      value += decoded[escaped] ?? escaped;
    } else value += character;
  }
  return value;
}

function jsonPath(value, dialect) {
  const text = value.trim();
  const invalid = reason => ({state:'invalid',reason});
  const uncertain = {state:'unknown'};
  let at = dialect === 'mariadb' ? /^(?:lax[ \t\r\n]+)?/iu.exec(text)[0].length : 0;
  let legs = 0, multiple = false;
  if (text[at++] !== '$') return invalid('A JSON path must start at the $ root.');
  while (at < text.length) {
    if (++legs > maximumLegs) return uncertain;
    const rest = text.slice(at);
    if (rest.startsWith('**')) {
      if (at+2 >= text.length) return invalid('The recursive ** leg needs a following member or array step.');
      if (!'.['.includes(text[at+2])) return uncertain;
      at += 2;
      multiple = true;
    } else if (text[at] === '.') {
      at++;
      if (text[at] === '*') { multiple = true; at++; }
      else if (text[at] === '"') {
        const quoted = /^"(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[a-fA-F0-9]{4})*"/u.exec(text.slice(at));
        if (!quoted) return invalid('The JSON path contains an invalid quoted member.');
        at += quoted[0].length;
      } else {
        // Non-ASCII and escape-based member names depend on the engine's identifier grammar.
        const member = /^[a-zA-Z_$][\w$]*/u.exec(text.slice(at));
        if (!member) return at >= text.length || '.[]'.includes(text[at]) ?
          invalid('The JSON path member name is missing.') : uncertain;
        at += member[0].length;
      }
    } else if (text[at] === '[') {
      const end = text.indexOf(']',at+1);
      if (end < 0) return invalid('The JSON array step is missing a closing bracket.');
      const index = text.slice(at+1,end).trim();
      if (index === '*') multiple = true;
      else if (!/^\d+$/u.test(index)) {
        if (index === '' || /^[a-zA-Z_]\w*$/u.test(index) && index.toLowerCase() !== 'last') {
          return invalid('The JSON array step needs a numeric index or a supported path selector.');
        }
        // Ranges, negative indexes and last-based forms differ by release and dialect.
        return uncertain;
      }
      at = end+1;
    } else return uncertain;
  }
  return {state:'known',multiple};
}

function lengthAllowsWildcards(dialect, serverVersion) {
  if (dialect === 'mariadb') return false;
  const version = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(serverVersion || ''));
  if (!version) return undefined;
  const [, major, minor, patch] = version.map(Number);
  return major>8 || major===8 && (minor>0 || patch>=26);
}
function checkPath(name, at, value, dialect, multiple, issue, unknown) {
  if (at?.upper === 'NULL') return;
  if (value === undefined) {
    unknown(name + ' path value or string decoding depends on runtime or SQL mode.',at?.start);
    return;
  }
  const path = jsonPath(value,dialect);
  if (path.state === 'invalid') issue('sql.json.path',path.reason,at,'warning');
  else if (path.state === 'unknown') unknown(name + ' uses an unverified JSON path form.',at?.start);
  else if (path.multiple && multiple === false) issue('sql.json.path.multiple',name + ' expects a path without wildcards.',at,'warning');
  else if (path.multiple && multiple === undefined) unknown(name + ' wildcard support requires the observed server version.',at.start);
}

function checkJsonFunction(name, location, args, { source, dialect, serverVersion, sqlMode, issue, unknown }) {
  const rule = rules.get(name), count = args.length;
  if (args.some(arg=>arg.empty) || count < rule.minimum || count > rule.maximum || rule.pairs && (count-rule.minimum)%2) {
    const expectation = rule.pairs ? name === 'JSON_OBJECT' ? 'key/value pairs' : 'a document followed by one or more path/value pairs' :
      rule.minimum === rule.maximum ? String(rule.minimum) + ' argument(s)' : rule.minimum + (rule.maximum === Infinity ? ' or more' : ' to ' + rule.maximum) + ' arguments';
    issue('sql.json.arity',name + ' expects ' + expectation + '.',location);
    return {family:'unknown'};
  }
  for (const index of rule.documents || []) {
    const arg = args[index], value = literalValue(source,arg.literal,sqlMode);
    if (value !== undefined) {
      try { JSON.parse(value); }
      catch { issue('sql.json.document',name + ' expects valid JSON text in this document argument.',arg.location,'warning'); }
    }
  }
  if (rule.mode !== undefined) {
    const mode = args[rule.mode], value = literalValue(source,mode.literal,sqlMode);
    if (value !== undefined && !['one','all'].includes(value.toLowerCase())) {
      issue('sql.json.mode',name + " expects 'one' or 'all' in this argument.",mode.location,'warning');
    }
  }
  if (rule.paths) {
    const multiple = name==='JSON_LENGTH' ? lengthAllowsWildcards(dialect,serverVersion) : rule.paths.multiple;
    for (let index=rule.paths.from; index<count; index+=rule.paths.stride) {
      const { location:at, literal } = args[index];
      checkPath(name,literal || at,literalValue(source,literal,sqlMode),dialect,multiple,issue,unknown);
    }
  }
  if (name === 'JSON_OBJECT' && dialect === 'mysql') {
    for (let index=0; index<count; index+=2) {
      const { literal, location:at } = args[index];
      if (literal?.upper === 'NULL') issue('sql.json.key','JSON_OBJECT requires a non-NULL key.',at,'warning');
    }
  }
  return {family:rule.family,nullable:!['JSON_OBJECT','JSON_ARRAY'].includes(name)};
}

module.exports = { isJsonFunction:name=>rules.has(name), checkJsonFunction, checkPath, literalValue };
