'use strict';

const { analyzeSql, sourceLayout, statementRanges } = require('./sql-analysis');
const { joinedCompletionContext } = require('./sql-dml-usages');
const { tokenize } = require('./sql-policy');
const { endpointKey, maxSources, validName } = require('./join-catalog');

const writers = new Set(['INSERT','UPDATE','DELETE']);
const valueBoundaries = new Set(['=','<','>','<=','>=','<>','!=','+','-','*','/','(']);
const complex = new Set(['JOIN','USING','LEFT','RIGHT','CROSS','NATURAL','STRAIGHT_JOIN','SELECT','WITH']);
const keywords = new Set([...writers,'AS','FROM','SET','WHERE','ORDER','LIMIT','RETURNING','VALUES','VALUE','JOIN','USING',
  'LEFT','RIGHT','INNER','OUTER','CROSS','STRAIGHT_JOIN','NATURAL','ON','PARTITION','SELECT','WITH','INTO','AND','OR']);
const word = (token,value) => token?.kind === 'word' && token.upper === value;
const symbol = (token,value) => token?.kind === 'symbol' && token.value === value;
const name = token => validName(token?.value) &&
  (token.kind === 'identifier' || (token.kind === 'word' && !keywords.has(token.upper)));
const fold = value => value.toLowerCase();
const writable = column => typeof column.extra === 'string' &&
  !/\b(?:AUTO_INCREMENT|(?:VIRTUAL|STORED|PERSISTENT)\s+GENERATED)\b/i.test(column.extra);
const quote = value => '`' + value.replaceAll('`','``') + '`';
const same = (left,right,caseSensitive) => typeof left === 'string' && typeof right === 'string' &&
  (caseSensitive ? left === right : fold(left) === fold(right));

function target(tokens, options) {
  const command = tokens[0]?.upper;
  if (!writers.has(command) || tokens[0].kind !== 'word') return;
  let index = 1;
  if (command === 'INSERT' || command === 'DELETE') {
    const connector = command === 'INSERT' ? 'INTO' : 'FROM';
    if (!word(tokens[index++],connector)) return;
  }
  if (!name(tokens[index])) return;
  const qualified = symbol(tokens[index+1],'.');
  if (qualified && !name(tokens[index+2])) return;
  const schema = qualified ? tokens[index++].value : options.database;
  if (!validName(schema)) return;
  if (qualified) index++;
  const table = tokens[index++].value;
  let alias = table;
  if (command !== 'INSERT' && (word(tokens[index],'AS') || name(tokens[index]))) {
    if (word(tokens[index],'AS')) index++;
    if (!name(tokens[index])) return;
    alias = tokens[index++].value;
  }
  return {command,schema,table,alias,index};
}

function commaParts(tokens) {
  let depth = 0, start = 0;
  const parts = [];
  for (const [index,token] of tokens.entries()) {
    if (symbol(token,'(')) depth++;
    else if (symbol(token,')')) {
      if (--depth < 0) return;
    } else if (!depth && symbol(token,',')) {
      parts.push(tokens.slice(start,index));
      start = index + 1;
    }
  }
  if (depth) return;
  parts.push(tokens.slice(start));
  return parts;
}

function assignmentName(tokens, alias) {
  if (!name(tokens[0])) return;
  const qualified = symbol(tokens[1],'.');
  if (qualified && (fold(tokens[0].value) !== fold(alias) || !name(tokens[2]))) return;
  const column = qualified ? 2 : 0;
  return symbol(tokens[column+1],'=') && tokens.length > column+2 ? tokens[column].value : undefined;
}

function cursorSlot(before, after, base) {
  const tail = before.slice(base.index);
  if (base.command === 'INSERT') {
    if (!symbol(tail[0],'(') || !tail.slice(1).every((token,index)=>index%2 ? symbol(token,',') : name(token)) ||
        tail.length % 2 !== 1 || (after.length && !symbol(after[0],')') && !symbol(after[0],','))) return;
    return {write:true, used:tail.filter(name).map(token=>fold(token.value))};
  }

  if ([...tail,...after].some(token=>token.kind==='word' && complex.has(token.upper))) return;
  if (base.command === 'UPDATE' && !word(tail[0],'SET')) return;
  const where = tail.findIndex(token=>word(token,'WHERE'));
  if (base.command === 'DELETE' && where !== 0) return;
  if (where > 0 && !commaParts(tail.slice(1,where))?.every(part=>assignmentName(part,base.alias))) return;

  const qualified = symbol(tail.at(-1),'.');
  if (qualified && (!name(tail.at(-2)) || fold(tail.at(-2).value) !== fold(base.alias))) return;
  const body = qualified ? tail.slice(0,-2) : tail;
  if (where >= 0) {
    const final = body.at(-1);
    if (['WHERE','AND','OR'].some(keyword=>word(final,keyword))) return {write:false,used:[]};
    return;
  }
  const assignments = commaParts(body.slice(1));
  if (!assignments || assignments.at(-1).length || (after.length && !symbol(after[0],'='))) return;
  const used = assignments.slice(0,-1).map(part=>assignmentName(part,base.alias));
  if (used.every(Boolean)) return {write:true,used:used.map(fold)};
}

function joinedSlot(before, after) {
  const command = before[0]?.upper;
  if (!word(before[0],'UPDATE') && !word(before[0],'DELETE')) return;
  const qualified = symbol(before.at(-1),'.');
  const qualifier = qualified ? before.at(-2) : undefined;
  if (qualified && !name(qualifier)) return;
  const lead = before.at(qualified ? -3 : -1), next = after[0];
  if (['WHERE','AND','OR'].some(value => word(lead,value)) ||
      (lead?.kind === 'symbol' && valueBoundaries.has(lead.value))) return { kind:'read', qualifier };
  if (command === 'UPDATE' && (word(lead,'SET') || symbol(lead,',')) &&
      (!next || symbol(next,'=') || symbol(next,',') || word(next,'WHERE'))) {
    return { kind:'write', qualifier, fillAssignment:!symbol(next,'=') };
  }
  if (command === 'DELETE' && !qualified &&
      (['DELETE','FROM','LOW_PRIORITY','QUICK','IGNORE'].some(value => word(lead,value)) || symbol(lead,','))) {
    return { kind:'target' };
  }
}

async function joinedColumns(source, local, statement, catalog, options, readCatalog, current) {
  if (!options.catalogComplete || !validName(catalog.database)) return [];
  let layout;
  try { layout = sourceLayout(source,options); } catch { return []; }
  if (layout.nonCode.some(range => range.start <= local && local < range.end)) return [];
  const {tokens} = layout;
  const editing = tokens.find(token => token.start < local && local <= token.end && name(token));
  const start = editing?.start ?? local, end = editing?.end ?? local;
  const before = tokens.filter(token => token.end <= start), after = tokens.filter(token => token.start >= end);
  if (!before.length || /\S/.test(source.slice(before.at(-1).end,start)) ||
      tokens.some(token => token.start < local && local < token.end && token !== editing)) return [];
  const slot = joinedSlot(before,after);
  if (!slot) return [];
  const context = joinedCompletionContext(source, options, slot, {start,end,expressionStart:slot.qualifier?.start ?? start});
  if (!context) return [];

  const analyze = joinTables => analyzeSql(context.query,catalog,{...options,catalogComplete:true,joinOrigins:true,usageParameters:true,joinTables});
  const scope = value => {
    const relations = value.scopes[0]?.relations;
    return value.scopes.length === 1 && relations?.length >= 2 && relations.length <= maxSources &&
      relations.every(item => item.kind === 'catalog') ? relations : undefined;
  };
  let binding = analyze([]);
  if (!scope(binding)) return [];
  const endpoints = [...new Map(binding.relations.filter(item => item.requested && !item.catalog)
    .map(item => [endpointKey(item.requested),item.requested])).values()];
  let remote = [];
  if (endpoints.length) {
    if (!readCatalog || catalog.cachedMetadata || endpoints.length > maxSources || !current()) return [];
    try { remote = (await readCatalog({endpoints,includeEdges:false})).tables; } catch { return []; }
    if (!current() || !Array.isArray(remote)) return [];
    binding = analyze(remote);
  }

  const relations = scope(binding);
  if (!current() || binding.state !== 'known' || !relations ||
      relations.some(item => !item.catalog || !item.complete)) return [];
  const aliasMatches = (expected, typed) => same(expected,typed,options.tableNameCaseSensitive !== false);
  if (options.tableNameCaseSensitive !== false && binding.references.some(ref => {
    if (ref.kind !== 'relation') return false;
    const relation = relations.find(item => item.id === ref.relationId);
    return relation && !aliasMatches(relation.alias,ref.name);
  })) return [];
  const sources = [...(catalog.tables || []),...(catalog.views || [])].map(table => ({...table,schema:catalog.database})).concat(remote);
  const owners = relations.map(relation => ({ alias:relation.alias, table:sources.find(table =>
    table.schema === relation.catalog.database && table.name === relation.catalog.table) }));
  if (owners.some(owner => !owner.table || !['table','view'].includes(owner.table.kind))) return [];
  const columnOwners = new Map();
  for (const owner of owners) for (const {name} of owner.table.columns) {
    const key = fold(name);
    if (!columnOwners.has(key)) columnOwners.set(key,new Set());
    columnOwners.get(key).add(owner);
  }
  const match = (qualifier,column) => [...(column ? columnOwners.get(fold(column)) || [] : owners)]
    .filter(owner => !qualifier || aliasMatches(owner.alias,qualifier.value));
  const assignmentKey = (owner,column) => fold(owner.alias)+'\0'+fold(column);
  const used = new Set();
  for (const {qualifier,column} of context.writes) {
    const [owner,...rest] = match(qualifier,column.value);
    if (!owner || rest.length || owner.table.kind !== 'table') return [];
    const key = assignmentKey(owner,column.value);
    if (used.has(key)) return [];
    used.add(key);
  }
  const deleted = new Set();
  for (const target of context.targets) {
    const [owner,...rest] = match(target);
    if (!owner || rest.length || owner.table.kind !== 'table' || deleted.has(owner)) return [];
    deleted.add(owner);
  }

  const prefix = editing ? fold(source.slice(start,local).replace(/^[\x60"]/,'')) : '';
  const candidate = (label, kind, detail) => ({label,kind,detail,insertText:quote(label),
    start:statement.start+start,end:statement.start+end});
  if (slot.kind === 'target') {
    return owners.filter(owner => owner.table.kind === 'table' && !deleted.has(owner) && fold(owner.alias).startsWith(prefix))
      .map(owner => candidate(owner.alias,'table','DELETE target · '+owner.table.schema+'.'+owner.table.name));
  }
  const purpose = slot.kind === 'write' ? 'Writable column' : context.readClause === 'filter' ? 'Filter column' : 'Value column';
  const candidates = match(slot.qualifier).flatMap(owner => owner.table.columns.filter(column =>
    typeof column.type === 'string' && validName(column.name) && fold(column.name).startsWith(prefix) &&
    match(slot.qualifier,column.name).length === 1 &&
    (slot.kind !== 'write' || owner.table.kind === 'table' && writable(column) && !used.has(assignmentKey(owner,column.name))))
    .map(column => candidate(column.name,'column',purpose+
      ' · '+column.type+' · '+owner.alias+' ('+owner.table.schema+'.'+owner.table.name+')')));
  return candidates.slice(0,128);
}

async function scopedDmlColumns(text, offset, catalog, options = {}, readCatalog, current = () => true) {
  if (!catalog || offset < 0 || offset > text.length || !current()) return [];
  const { statements, unknown } = statementRanges(text,options);
  const statement = statements.find(item=>item.start <= offset && offset <= item.end);
  if (!statement || unknown.some(item=>item.start >= statement.start && item.start < offset &&
      item.reason !== 'Unclosed parenthesis.')) return [];
  const source = text.slice(statement.start,statement.end), local = offset-statement.start;
  let tokens;
  try { tokens = tokenize(source,false,{sqlMode:options.sqlMode}); }
  catch { return []; }
  const editing = tokens.find(token=>token.start < local && local <= token.end && name(token));
  const start = editing?.start ?? local, end = editing?.end ?? local;
  const before = tokens.filter(token=>token.end <= start), after = tokens.filter(token=>token.start >= end);
  if (!before.length || /\S/.test(source.slice(before.at(-1).end,start)) ||
      tokens.some(token=>token.start < local && local < token.end && token !== editing)) return [];
  const base = target(before,options);
  const slot = base && cursorSlot(before,after,base);
  if (!slot) return ['UPDATE','DELETE'].some(command=>word(tokens[0],command))
    ? joinedColumns(source,local,statement,catalog,options,readCatalog,current) : [];
  const sameName = (left,right) => same(left,right,options.tableNameCaseSensitive);
  const defaultSchema = sameName(base.schema,catalog.database);
  let tables = defaultSchema && options.catalogComplete ? catalog.tables :
    undefined;
  if (!tables && !catalog.cachedMetadata && readCatalog) {
    try {
      const observed = await readCatalog({endpoints:[{schema:base.schema,table:base.table}],includeEdges:false});
      tables = observed.tables.filter(item=>sameName(item.schema,base.schema));
    } catch { return []; }
  }
  if (!current()) return [];
  const visible = tables?.filter(item=>sameName(item.name,base.table) && item.kind === 'table');
  if (visible?.length !== 1 || !Array.isArray(visible[0].columns)) return [];
  const typed = editing ? fold(source.slice(start,local).replace(/^[`"]/,'')) : '';
  return visible[0].columns.filter(column=>typeof column.type === 'string' && validName(column.name) &&
    fold(column.name).startsWith(typed) && !slot.used.includes(fold(column.name)) &&
    (!slot.write || writable(column))).slice(0,128)
    .map(column=>({label:column.name,kind:'column',detail:(slot.write?'Writable column':'Filter column')+' · '+column.type,
      insertText:quote(column.name),start:statement.start+start,end:statement.start+end}));
}

module.exports = { scopedDmlColumns };
