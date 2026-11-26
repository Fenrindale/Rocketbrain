'use strict';

const { sourceLayout } = require('../db/sql-analysis');

const maxRequests = 12, maxSelects = 40, maxSql = 768;
const safeInt = (value, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && minimum <= value && value <= maximum;
const names = token => ['word', 'identifier'].includes(token?.kind) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(token.value);
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const symbol = (token, value) => token?.kind === 'symbol' && token.value === value;
const validJavaName = value => typeof value === 'string' && value.length <= 192 && /^[\w$]+(?:\.[\w$]+)+$/.test(value);
const validRoute = value => typeof value === 'string' && /^\/[A-Za-z0-9/_{}*.:\-]{0,159}$/.test(value);
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);

function tableAt(tokens, at) {
  if (!names(tokens[at])) return null;
  const path = [tokens[at++].value];
  while (path.length < 3 && symbol(tokens[at], '.') && names(tokens[at + 1])) {
    path.push(tokens[at + 1].value);
    at += 2;
  }
  return symbol(tokens[at], '.') ? null : { path: path.join('.'), end: at };
}

function tableName(text) {
  if (typeof text !== 'string' || text.length > 192) return null;
  const { tokens, nonCode } = sourceLayout(text, { sqlMode: [] });
  const parsed = tableAt(tokens, 0);
  return !nonCode.length && parsed?.end === tokens.length ? parsed.path : null;
}

function sqlShape(text) {
  if (typeof text !== 'string' || !text.length || text.length > maxSql) return null;
  const { tokens, nonCode } = sourceLayout(text, { sqlMode: [] });
  if (nonCode.length || !word(tokens[0], 'SELECT') || tokens.some(token =>
    !names(token) && !(token.kind === 'symbol' && /^[.,()=*<>!+/%\-]+$/.test(token.value)) &&
    !(token.kind === 'parameter' && token.value === '?'))) return null;
  let from = -1, where = -1;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (symbol(token,'(')) i = token.close;
    else if (word(token,'FROM') && from < 0) from = i + 1;
    else if (word(token,'WHERE') && where < 0) where = i + 1;
    else if (['UNION','INTERSECT','EXCEPT','INTO'].some(keyword => word(token,keyword))) return null;
  }
  const root = from > 0 && tableAt(tokens, from);
  if (!root) return null;
  const next = word(tokens[root.end],'AS') ? root.end + 1 : root.end;
  const clause = ['WHERE','JOIN','INNER','LEFT','RIGHT','CROSS','ORDER','GROUP','LIMIT','HAVING','FOR'].some(value=>word(tokens[next],value));
  const qualifier = !clause&&names(tokens[next]) ? tokens[next].value : root.path.split('.').at(-1);
  return { table: root.path, qualifier, tokens, where };
}

function usesCollectionKey(sql, keyColumn) {
  if (sql.where < 0 || sql.tokens.filter(token => token.kind === 'parameter').length !== 1) return false;
  const tokens = sql.tokens;
  for (let i = sql.where; i < tokens.length; i++) {
    const token = tokens[i];
    if(symbol(token,'(')&&word(tokens[i+1],'SELECT')){ i=token.close; continue; }
    if (!names(token) || token.value !== keyColumn) continue;
    const left = symbol(tokens[i - 1],'.') ? i - 2 : i;
    if (left !== i && (!names(tokens[left]) || tokens[left].value !== sql.qualifier)) continue;
    if (symbol(tokens[i+1],'=') && tokens[i+2]?.kind==='parameter' ||
        symbol(tokens[left-1],'=') && tokens[left-2]?.kind==='parameter') return true;
  }
  return false;
}

function usesCompositeCollectionKey(sql, columns) {
  if (sql.where < 0 || sql.tokens.filter(token => token.kind === 'parameter').length !== columns.length) return false;
  const tokens = sql.tokens;
  let at = sql.where;
  function take(matches) {
    if (!matches(tokens[at])) return false;
    at++;
    return true;
  }
  const takeSymbol = value => take(token=>symbol(token,value));
  const takeWord = value => take(token=>word(token,value));
  const parameter = () => take(token=>token?.kind==='parameter');
  function column() {
    if (!names(tokens[at])) return null;
    const first = tokens[at++].value;
    if (!takeSymbol('.')) return first;
    if (first!==sql.qualifier || !names(tokens[at])) return null;
    return tokens[at++].value;
  }
  function complete(found) {
    return at===tokens.length && new Set(found).size===columns.length &&
      columns.every(name=>found.includes(name));
  }
  if (takeSymbol('(')) {
    const found = [];
    for (let index=0; index<columns.length; index++) {
      if (index && !takeSymbol(',')) return false;
      found.push(column());
    }
    if (!takeSymbol(')')) return false;
    const membership = takeWord('IN');
    if (membership ? !takeSymbol('(') : !takeSymbol('=')) return false;
    if (!takeSymbol('(')) return false;
    for (let index=0; index<columns.length; index++) {
      if (index && !takeSymbol(',')) return false;
      if (!parameter()) return false;
    }
    return takeSymbol(')') && (!membership || takeSymbol(')')) && complete(found);
  }
  const found = [];
  for (let index=0; index<columns.length; index++) {
    if (index && !takeWord('AND')) return false;
    if (parameter()) {
      if (!takeSymbol('=')) return false;
      found.push(column());
    } else {
      found.push(column());
      if (!takeSymbol('=') || !parameter()) return false;
    }
  }
  return complete(found);
}

function readSelect(value, index) {
  if (!value || value.sequence !== index + 1 || !safeInt(value.session, 1, maxSelects) || !safeInt(value.durationMicros)) return null;
  const shape = sqlShape(value.sql);
  if (!shape) return null;
  const select = { sequence: value.sequence, session: value.session, sql: value.sql, table: shape.table,
    durationMicros: value.durationMicros };
  if (value.collection === undefined) return select;
  const load = value.collection;
  const ownerTable = tableName(load?.ownerTable), childTable = tableName(load?.childTable), keyColumn = tableName(load?.keyColumn);
  const keyColumns = Array.isArray(load?.keyColumns) && load.keyColumns.length>=2 && load.keyColumns.length<=4
    ? load.keyColumns.map(tableName) : undefined;
  if (!validJavaName(load?.role) || !validJavaName(load.entity) || !load.role.startsWith(load.entity + '.') ||
      !ownerTable || !childTable || childTable !== shape.table || !safeInt(load.key, 1, maxSelects)) return null;
  if (keyColumns) {
    if (load.keyColumn!==undefined || new Set(keyColumns).size!==keyColumns.length ||
        keyColumns.some(name=>!name || name.includes('.')) || !usesCompositeCollectionKey(shape,keyColumns)) return null;
  } else if (load.keyColumns!==undefined || !keyColumn || keyColumn.includes('.') || !usesCollectionKey(shape,keyColumn)) {
    return null;
  }
  return { ...select, collection: { role:load.role, entity:load.entity, ownerTable, childTable,
    ...(keyColumns?{keyColumns}:{keyColumn}), key:load.key } };
}

function findings(selects) {
  const groups = new Map();
  for (const select of selects) {
    const load = select.collection;
    if (!load) continue;
    const key = JSON.stringify([select.session, load.role, load.entity, load.ownerTable, load.childTable,
      load.keyColumns || load.keyColumn, select.sql]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(select);
  }
  const suspects = [];
  for (const repeats of groups.values()) {
    const first = repeats[0], last = repeats.at(-1), load = first.collection;
    const distinctOwnerKeys = new Set(repeats.map(select=>select.collection.key)).size;
    if (distinctOwnerKeys < 2 || distinctOwnerKeys !== repeats.length) continue;
    const parents = selects.filter(select=>select.session===first.session && select.sequence<last.sequence &&
      !select.collection && select.table===load.ownerTable);
    if (parents.length !== 1 || parents[0].sequence >= first.sequence) continue;
    suspects.push({
      kind: 'collection-select-n-plus-one',
      entity: load.entity,
      collectionRole: load.role,
      ownerTable: load.ownerTable,
      childTable: load.childTable,
      ...(load.keyColumns?{keyColumns:load.keyColumns}:{keyColumn:load.keyColumn}),
      session: first.session,
      parent: { sequence: parents[0].sequence, sql: parents[0].sql, durationMicros: parents[0].durationMicros },
      child: { sql:first.sql, sequences:repeats.map(select=>select.sequence), executions:repeats.length,
        distinctOwnerKeys, totalDurationMicros:repeats.reduce((sum,select)=>sum+select.durationMicros,0) }
    });
  }
  return suspects;
}

function summarizePerformance(input) {
  const enabled = input?.enabled === true, available = enabled && input.available === true;
  const report = { state: available ? 'observed' : enabled ? 'awaiting-supported-hooks' : 'disabled',
    scope: 'synchronous-spring-mvc-hibernate-selects', requests: [], omittedRequests: safeInt(input?.omittedRequests) ? input.omittedRequests : 0,
    rawBindValuesRetained: false, observerExecutedSql: false };
  if (!enabled || input.scope !== 'synchronous-spring-mvc' || input.rawBindValuesRetained !== false || input.observerExecutedSql !== false ||
      !Array.isArray(input.requests) || input.requests.length > maxRequests) return report;
  for (const value of input.requests) {
    if (!safeInt(value?.id,1) || !safeInt(value.durationMicros) || !safeInt(value.omittedSelects) ||
        !Array.isArray(value.selects) || value.selects.length > maxSelects) {
      report.omittedRequests++;
      continue;
    }
    const selects = value.selects.flatMap((select,index)=>{
      try {
        const observed = readSelect(select,index);
        return observed ? [observed] : [];
      } catch { return []; }
    });
    const omittedSelects = value.omittedSelects + value.selects.length - selects.length;
    const complete = available && value.complete === true && omittedSelects === 0;
    report.requests.push({ id: value.id, method: methods.has(value.method) ? value.method : undefined,
      route: validRoute(value.route) ? value.route : undefined,
      startedAt: typeof value.startedAt==='string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.startedAt) ? value.startedAt : undefined,
      durationMicros:value.durationMicros, coverage: complete ? 'complete-within-supported-hooks' : 'partial',
      selectCount: selects.length, omittedSelects, selects, suspects: complete ? findings(selects) : [] });
  }
  return report;
}

module.exports = { summarizePerformance };
