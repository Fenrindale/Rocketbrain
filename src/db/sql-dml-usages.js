'use strict';

const { analyzeSql, sourceTokens, sourceRange } = require('./sql-analysis');
const { validName } = require('./join-catalog');

const commands = new Set(['INSERT', 'UPDATE', 'DELETE']);
const tableModifiers = {
  INSERT: new Set(['LOW_PRIORITY', 'HIGH_PRIORITY', 'IGNORE']),
  UPDATE: new Set(['LOW_PRIORITY', 'IGNORE']),
  DELETE: new Set(['LOW_PRIORITY', 'QUICK', 'IGNORE'])
};
const clauses = new Set(['WHERE', 'ORDER', 'LIMIT', 'RETURNING', 'JOIN', 'USING', 'PARTITION', 'GROUP', 'HAVING', 'FOR']);
const scalarWords = new Set(['AS','IS','AND','OR','XOR','NOT','IN','LIKE','REGEXP','RLIKE','BETWEEN','DIV','MOD',
  'COLLATE','BINARY','CASE','WHEN','THEN','ELSE','END','ESCAPE','DATE','TIME','TIMESTAMP','INTERVAL','FROM','USING']);
const nonNames = new Set([...commands, ...clauses, 'SELECT', 'WITH', 'REPLACE', 'INTO', 'FROM', 'AS', 'VALUES', 'VALUE', 'SET',
  'ON', 'DUPLICATE', 'KEY', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'STRAIGHT_JOIN', 'NATURAL', 'UNION', 'NULL', 'TRUE', 'FALSE', 'DEFAULT']);
const comparable = value => value.toLowerCase();
const equal = (left, right, insensitive) => insensitive ? comparable(left) === comparable(right) : left === right;
const name = token => Boolean(token && validName(token.value) && (token.kind === 'identifier' || token.kind === 'word' && !nonNames.has(token.upper)));
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const span = token => ({ start: token.start, end: token.end });
const limit = 128;

function split(tokens, first, end, boundary) {
  let start = first;
  const parts = [];
  for (let i = first; i < end; i++) {
    const token = tokens[i];
    if (symbol(token, '(') && token.close < end) i = token.close;
    else if (boundary(token)) {
      parts.push([start, i]);
      start = i + 1;
    }
  }
  parts.push([start, end]);
  return parts;
}

function valuePart(tokens, first, end, { allowDefault = false } = {}) {
  if (first === end) return null;
  if (allowDefault && end === first + 1 && word(tokens[first], 'DEFAULT')) return { constant: true };
  const terms = tokens.slice(first, end);
  if (terms.some(token => token.kind === 'word' && ['SELECT', 'WITH', 'RETURNING', 'JOIN', 'USING', 'OUTFILE'].includes(token.upper) ||
    token.kind === 'symbol' && [';', ':='].includes(token.value))) return null;
  const atom = token => ['identifier','string','number','parameter'].includes(token.kind) ||
    token.kind==='word'&&!scalarWords.has(token.upper);
  if (terms.some((token,index) => index>0 && atom(token) && (atom(terms[index-1]) || symbol(terms[index-1],')')))) return null;
  return { start: terms[0].start, end: terms.at(-1).end };
}

function parseInsert(tokens, start, end) {
  const list = tokens[start];
  if (!symbol(list, '(') || !Number.isInteger(list.close)) return undefined;
  const columns = split(tokens, start + 1, list.close, token => symbol(token, ','));
  if (!columns.length || columns.length > limit || !columns.every(([a,b]) => b === a + 1 && name(tokens[a]))) return undefined;
  const writes = columns.map(([a]) => ({ column: tokens[a] }));
  start = list.close + 1;
  if (word(tokens[start], 'SELECT') || word(tokens[start], 'WITH')) {
    return { writes, select: { start: tokens[start].start, end: tokens[end-1].end } };
  }
  if (!word(tokens[start], 'VALUE') && !word(tokens[start], 'VALUES')) return undefined;
  const values = [];
  for (let at = start + 1; at < end;) {
    const row = tokens[at];
    if (!symbol(row, '(') || !Number.isInteger(row.close)) return undefined;
    const parts = split(tokens, at + 1, row.close, token => symbol(token, ','));
    if (parts.length !== columns.length) return undefined;
    const expressions = parts.map(([a,b]) => valuePart(tokens,a,b,{allowDefault:true}));
    if (expressions.some(value => !value)) return undefined;
    values.push(...expressions);
    if (values.length > limit) return undefined;
    at = row.close + 1;
    if (at === end) break;
    if (!symbol(tokens[at], ',') || at + 1 >= end) return undefined;
    at++;
  }
  return values.length ? { writes, values } : undefined;
}

function parseAssignments(tokens, start, end) {
  const parts = split(tokens, start, end, token => symbol(token, ','));
  if (parts.length > limit) return undefined;
  const writes = [], values = [];
  for (const [a,b] of parts) {
    if (a === b || !name(tokens[a])) return undefined;
    const qualified = symbol(tokens[a+1], '.') && name(tokens[a+2]), at = a + (qualified ? 3 : 1);
    if (!symbol(tokens[at], '=') || at + 1 >= b) return undefined;
    const value = valuePart(tokens, at+1, b, { allowDefault:true });
    if (!value) return undefined;
    values.push(value);
    writes.push({ column: tokens[at-1], ...(qualified && { qualifier: tokens[a] }) });
  }
  return { writes, values };
}

function parse(options, tokens) {
  const command = tokens[0]?.upper;
  if (tokens[0]?.kind !== 'word' || !commands.has(command)) return undefined;
  let end = tokens.length;
  if (symbol(tokens.at(-1), ';')) end--;
  if (tokens.slice(0,end).some(token => symbol(token,';'))) return null;
  let at = 1, modifiers = new Set();
  while (tokens[at]?.kind === 'word' && tableModifiers[command].has(tokens[at].upper)) {
    if (modifiers.has(tokens[at].upper)) return null;
    modifiers.add(tokens[at++].upper);
  }
  if (command === 'INSERT' || command === 'DELETE') {
    if (!word(tokens[at], command === 'INSERT' ? 'INTO' : 'FROM')) return null;
    at++;
  }
  const first = tokens[at];
  if (!name(first)) return null;
  let schema, table = first;
  if (symbol(tokens[at+1], '.')) {
    schema = first;
    table = tokens[at+2];
    if (!name(table)) return null;
    at += 2;
  }
  at++;
  let alias;
  if (command !== 'INSERT') {
    if (word(tokens[at], 'AS')) {
      alias = tokens[++at];
      if (!name(alias)) return null;
      at++;
    } else if (name(tokens[at])) {
      alias = tokens[at++];
    }
    if (alias && command === 'DELETE' && options.dialect === 'mariadb') {
      const match = /^(?:5\.5\.5-)?(\d+)\.(\d+)/.exec(options.serverVersion || '');
      if (!match || +match[1] < 11 || +match[1] === 11 && +match[2] < 6) return null;
    }
  }
  const source = { start:first.start, end:(alias || table).end };
  const target = { command, table, schema, alias, source };
  if (command === 'INSERT') {
    const body = parseInsert(tokens, at, end);
    return body ? { ...target, ...body } : null;
  }
  const later = [];
  for (let index = at; index < end; index++) {
    const token = tokens[index];
    if (symbol(token,'(') && token.close < end) index = token.close;
    else if (token.kind === 'word' && clauses.has(token.upper)) later.push(index);
  }
  if (later.length > 1 || later.length && !word(tokens[later[0]],'WHERE')) return null;
  const condition = later[0] ?? end;
  const where = later.length ? valuePart(tokens,condition+1,end) : undefined;
  if (later.length && !where) return null;
  const body = command === 'DELETE' ? (condition === at ? { writes:[],values:[] } : null) :
    word(tokens[at], 'SET') && parseAssignments(tokens, at+1, condition);
  return body ? { ...target, ...body, where } : null;
}

function topLevel(tokens, start, end, keys) {
  const found = [];
  for (let index = start; index < end; index++) {
    const token = tokens[index];
    if (symbol(token, '(') && token.close < end) index = token.close;
    else if (token.kind === 'word' && keys.has(token.upper)) found.push(index);
  }
  return found;
}

function joinedMutation(tokens) {
  const command = tokens[0]?.upper;
  if (!['UPDATE','DELETE'].includes(command)) return null;
  const end = tokens.length - Number(symbol(tokens.at(-1), ';'));
  if (tokens.slice(0,end).some(token => symbol(token,';'))) return null;
  let start = 1;
  const seenModifiers = new Set();
  while (tokens[start]?.kind === 'word' && tableModifiers[command].has(tokens[start].upper)) {
    if (seenModifiers.has(tokens[start].upper)) return null;
    seenModifiers.add(tokens[start++].upper);
  }
  const clauseKeys = new Set(['SET','WHERE','ORDER','LIMIT','RETURNING','GROUP','HAVING','FOR']);
  let sourceStart = start, sourceEnd, body, targets;
  if (command === 'UPDATE') {
    const points = topLevel(tokens,start,end,clauseKeys);
    if (!word(tokens[points[0]],'SET') || points.length > 2 || points.length === 2 && !word(tokens[points[1]],'WHERE')) return null;
    sourceEnd = points[0];
    body = parseAssignments(tokens,sourceEnd+1,points[1]??end);
    if (!body) return null;
  } else {
    const using = word(tokens[start],'FROM');
    const keyword = using ? 'USING' : 'FROM';
    const [boundary] = topLevel(tokens,start+Number(using),end,new Set([keyword]));
    if (!Number.isInteger(boundary)) return null;
    targets = split(tokens,start+Number(using),boundary,token=>symbol(token,',')).map(([a,b])=>{
      if (!name(tokens[a])) return null;
      if (b === a+1 || b === a+3 && symbol(tokens[a+1],'.') && symbol(tokens[a+2],'*')) return tokens[a];
      return null;
    });
    if (!targets.length || targets.length > 32 || targets.some(value=>!value)) return null;
    sourceStart = boundary+1;
    body = { writes:[], values:[] };
  }
  const clauses = topLevel(tokens,sourceEnd===undefined?sourceStart:sourceEnd+1,end,clauseKeys);
  if (clauses.length > 1 || clauses.length && !word(tokens[clauses[0]],'WHERE')) return null;
  sourceEnd ??= clauses[0] ?? end;
  if (sourceEnd <= sourceStart) return null;
  const where = clauses.length ? valuePart(tokens,clauses[0]+1,end) : undefined;
  if (clauses.length && !where) return null;
  return { command, ...body, where, targets, source:{start:tokens[sourceStart].start,end:tokens[sourceEnd-1].end} };
}

function synthesized(text, parsed) {
  let sql = 'SELECT ';
  const mapped = [];
  const append = part => {
    mapped.push({ start:sql.length,end:sql.length+part.end-part.start,original:part.start });
    sql += text.slice(part.start,part.end);
  };
  if (parsed.select) {
    sql = '';
    append(parsed.select);
  }
  else if (parsed.values.length) for (const [index,value] of parsed.values.entries()) {
    if (index) sql += ', ';
    if (value.constant) sql += 'NULL';
    else {
      sql += '(';
      append(value);
      sql += '\n) IS NULL';
    }
  } else sql += '1';
  if (parsed.command !== 'INSERT') {
    sql += '\nFROM ';
    append(parsed.source);
    if (parsed.where) {
      sql += '\nWHERE ';
      append(parsed.where);
    }
  }
  const map = location => {
    const part = mapped.find(entry => entry.start <= location.start && location.end <= entry.end);
    return part && { start:part.original+location.start-part.start, end:part.original+location.end-part.start };
  };
  return { sql,map };
}

const unresolved = (reason, command) => ({ state:'unknown',command,references:[],coverage:{unknown:[{reason}]} });

function boundJoinedUsage(text, parsed, catalog, options, remote) {
  const {command, targets, writes} = parsed;
  const uncertain = message=>unresolved(message,command);
  if (catalog?.coverage?.tables !== 'loaded' || catalog.coverage.columns !== 'loaded' || !validName(catalog.database)) {
    return uncertain('Complete table and column metadata is required for joined DML.');
  }
  const {sql,map} = synthesized(text,parsed);
  const binding = analyzeSql(sql,catalog,{...options,catalogComplete:true,usageParameters:true,joinOrigins:true,joinTables:remote});
  const relations = binding.scopes[0]?.relations;
  if (binding.state !== 'known' || binding.scopes.length !== 1 || !relations || relations.length < 2 ||
      relations.some(item=>item.kind!=='catalog'||!item.catalog||!item.definition)) {
    return uncertain('The joined mutation does not have one verified physical-table scope.');
  }
  const tableInsensitive=options.tableNameCaseSensitive===false;
  const realTables=[...(catalog.tables||[]).map(item=>({...item,schema:catalog.database})),...remote];
  const relationAt = (qualifier,column) => {
    const matches = relations.filter(item=>(!qualifier||equal(item.alias,qualifier.value,true))&&
      (!column||item.columns.some(value=>equal(value.name,column.value,true))));
    return matches.length===1?matches[0]:undefined;
  };
  const isBase = relation=>realTables.some(item=>item.kind==='table'&&equal(item.schema,relation.catalog.database,tableInsensitive)&&
    equal(item.name,relation.catalog.table,tableInsensitive));
  const references = [], changed = new Set(), written = new Set();
  const addTarget = (relation, token) => {
    if (changed.has(relation)) return;
    const location=token?span(token):map(relation.definition);
    if (!location) return;
    changed.add(relation);
    references.push({...location,kind:'table',name:token?.value??relation.alias,catalog:relation.catalog,usage:'write',command});
  };
  for (const {column,qualifier} of writes) {
    const relation=relationAt(qualifier,column);
    if (!relation||!isBase(relation)) return uncertain('A SET column has no unique writable base-table binding.');
    const resolved=relation.columns.find(item=>equal(item.name,column.value,true));
    const key=relation.alias.toLowerCase()+'\0'+resolved.name.toLowerCase();
    if (written.has(key)) return uncertain('A SET target is duplicated.');
    written.add(key);
    addTarget(relation);
    references.push({...span(column),kind:'column',name:column.value,physicalColumn:{...relation.catalog,column:resolved.name},usage:'write',command});
    if (qualifier) references.push({...span(qualifier),kind:'relation',name:qualifier.value,definition:map(relation.definition),command});
  }
  for (const target of targets||[]) {
    const relation=relationAt(target);
    if (!relation||!isBase(relation)||changed.has(relation)) return uncertain('A DELETE target is duplicated or has no unique base-table binding.');
    addTarget(relation,target);
  }
  if (!changed.size) return uncertain('The joined statement has no confirmed target.');
  for (const ref of binding.references) {
    if (!['column','relation','table','relation-definition'].includes(ref.kind)) continue;
    const range=map(ref);
    if (!range) continue;
    if (ref.kind==='table' && references.some(item=>item.kind==='table'&&item.usage==='write'&&
        item.start===range.start&&item.end===range.end)) continue;
    references.push({...ref,...range,definition:ref.definition&&map(ref.definition),usage:'read',command});
  }
  references.sort((a,b)=>a.start-b.start||a.end-b.end);
  const physicalTargets=[...changed].map(item=>item.catalog);
  return {state:'known',command,references:references.map(ref=>({...ref,range:sourceRange(text,ref.start,ref.end)})),
    coverage:{unknown:[]},target:physicalTargets[0],targets:physicalTargets,executedSql:false};
}

function analyzeDmlUsage(text, catalog, options = {}, remote = [], parsedTokens) {
  let tokens = parsedTokens;
  if (!tokens) {
    try { tokens = sourceTokens(text,options); }
    catch {
      return /^\s*(?:INSERT|UPDATE|DELETE)\b/i.test(text) ? unresolved('The mutation has incomplete or uncertain SQL token boundaries.') : undefined;
    }
  }
  const parsed = parse(options,tokens);
  if (parsed === undefined) return undefined;
  if (!parsed) {
    const joined=joinedMutation(tokens);
    return joined ? boundJoinedUsage(text,joined,catalog,options,remote) :
      unresolved('The mutation shape does not have a supported INSERT column list, UPDATE SET, or DELETE scope.', tokens[0].upper);
  }
  const { command, table, schema, alias, writes } = parsed;
  const insensitive = options.tableNameCaseSensitive === false;
  if (catalog?.coverage?.tables !== 'loaded' || catalog.coverage.columns !== 'loaded' || !validName(catalog.database)) {
    return unresolved('Table and column metadata is unavailable for this mutation.', command);
  }
  const local = !schema || equal(schema.value,catalog.database,insensitive);
  const requested = { schema: local ? catalog.database : schema.value, table: table.value };
  const candidates = (local ? [...(catalog.tables || []), ...(catalog.views || [])] :
    remote.filter(item => equal(item.schema,requested.schema,insensitive)))
    .filter(item => equal(item.name,table.value,insensitive) && ['table','view'].includes(item.kind));
  if (candidates.length !== 1) {
    const unknown = unresolved('The mutation target is absent or ambiguous in the available catalog.',command);
    if (!local && !remote.length) return { ...unknown, pending:[requested], possibleTokens:tokens.filter(name).map(span) };
    return unknown;
  }
  const observed = candidates[0], origin = { database: local ? catalog.database : observed.schema, table:observed.name };
  const tableRef = { ...span(table), kind:'table', name:table.value, catalog:origin, usage:'write',command };
  const references = [tableRef], used = new Set();
  const aliasRecord = alias && { ...span(alias), kind:'relation-definition', name:alias.value, definition:span(alias),command };
  if (aliasRecord) references.push(aliasRecord);
  for (const {column,qualifier} of writes) {
    if (qualifier && !equal(qualifier.value,(alias || table).value,true)) return unresolved('The SET column qualifier does not match the mutation target.',command);
    const found = (observed.columns || []).filter(value => equal(value.name,column.value,true));
    if (found.length !== 1 || used.has(comparable(found[0].name))) return unresolved('A write column is missing, duplicated or ambiguous.',command);
    used.add(comparable(found[0].name));
    references.push({ ...span(column), kind:'column', name:column.value, physicalColumn:{ ...origin,column:found[0].name },usage:'write',command });
    if (qualifier) references.push({ ...span(qualifier),kind:'relation',name:qualifier.value,
      ...(alias ? { definition:span(alias) } : { physicalTable:origin,usage:'write' }),command });
  }
  const {sql,map} = synthesized(text,parsed);
  const binding = analyzeSql(sql,catalog,{...options,catalogComplete:true,usageParameters:true,joinOrigins:true,joinTables:remote});
  if (binding.state !== 'known' || parsed.select && binding.projections.length !== writes.length) {
    return unresolved('Read expressions or the INSERT projection width are not proven for this mutation.',command);
  }
  for (const ref of binding.references) {
    if (!['column','relation'].includes(ref.kind) && !(parsed.select && ref.kind === 'table' && ref.catalog)) continue;
    const range = map(ref);
    if (!range) continue;
    const definition = ref.definition && map(ref.definition);
    references.push({ ...ref,...range,definition,usage:'read',command });
  }
  references.sort((a,b)=>a.start-b.start || a.end-b.end);
  const unique = [...new Map(references.map(ref=>[ref.start+':'+ref.end+':'+ref.kind,ref])).values()];
  return { state:'known',command,references:unique.map(ref=>({...ref,range:sourceRange(text,ref.start,ref.end)})),
    coverage:{unknown:[]},target:origin,executedSql:false };
}

module.exports = { analyzeDmlUsage };
