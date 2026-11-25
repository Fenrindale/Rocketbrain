'use strict';

const { statementRanges } = require('./sql-analysis');
const { tokenize } = require('./sql-policy');
const { validName } = require('./join-catalog');

const writers = new Set(['INSERT','UPDATE','DELETE']);
const complex = new Set(['JOIN','USING','LEFT','RIGHT','CROSS','NATURAL','STRAIGHT_JOIN','SELECT','WITH']);
const keywords = new Set(['AS','FROM','SET','WHERE','ORDER','LIMIT','RETURNING','VALUES','VALUE','JOIN','USING',
  'LEFT','RIGHT','INNER','OUTER','CROSS','STRAIGHT_JOIN','NATURAL','ON','PARTITION','SELECT','WITH','INTO','AND','OR']);
const word = (token,value) => token?.kind === 'word' && token.upper === value;
const symbol = (token,value) => token?.kind === 'symbol' && token.value === value;
const name = token => validName(token?.value) &&
  (token.kind === 'identifier' || (token.kind === 'word' && !keywords.has(token.upper)));
const fold = value => value.toLowerCase();
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
  if (!base) return [];
  const slot = cursorSlot(before,after,base);
  if (!slot) return [];
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
    (!slot.write || (typeof column.extra === 'string' &&
      !/\b(?:AUTO_INCREMENT|(?:VIRTUAL|STORED|PERSISTENT)\s+GENERATED)\b/i.test(column.extra)))).slice(0,128)
    .map(column=>({label:column.name,kind:'column',detail:(slot.write?'Writable column':'Filter column')+' · '+column.type,
      insertText:quote(column.name),start:statement.start+start,end:statement.start+end}));
}

module.exports = { scopedDmlColumns };
