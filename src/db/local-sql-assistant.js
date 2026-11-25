'use strict';

const { analyzeSql, sourceTokens } = require('./sql-analysis');
const { validateQuery } = require('./sql-policy');
const { normalizeLocalChatTarget, requestLocalChat } = require('../ai/local-chat');

const maxTables = 6;
const maxColumns = 48;
const maxContextBytes = 8192;
const maxInputBytes = 4096;
const identifier = /^[A-Za-z0-9_][A-Za-z0-9_$]{0,63}$/;
const sqlTypes = new Set('tinyint smallint mediumint int integer bigint decimal numeric float double real bit bool boolean year date time datetime timestamp char varchar binary varbinary tinytext text mediumtext longtext tinyblob blob mediumblob longblob enum set json'.split(' '));
const syntaxWords = new Set(('SELECT WITH RECURSIVE DISTINCT DISTINCTROW ALL FROM AS JOIN INNER LEFT RIGHT OUTER CROSS NATURAL ON USING ' +
  'WHERE GROUP BY HAVING ORDER ASC DESC LIMIT OFFSET UNION AND OR XOR NOT IS NULL TRUE FALSE UNKNOWN BETWEEN IN LIKE REGEXP RLIKE ' +
  'EXISTS CASE WHEN THEN ELSE END DIV MOD OVER PARTITION ROWS RANGE GROUPS UNBOUNDED PRECEDING FOLLOWING CURRENT ROW ' +
  'CAST CONVERT SIGNED UNSIGNED CHAR INTEGER DATE TIME DATETIME BINARY DECIMAL CURRENT_DATE CURRENT_TIMESTAMP INTERVAL YEAR MONTH DAY HOUR MINUTE SECOND ' +
  'COUNT ROW_NUMBER RANK DENSE_RANK LENGTH CHAR_LENGTH CHARACTER_LENGTH LOCATE LOWER UPPER LCASE UCASE CONCAT CONCAT_WS SUBSTRING SUBSTR TRIM ' +
  'REPLACE SUM AVG MIN MAX ABS COALESCE IFNULL NULLIF GREATEST LEAST EXTRACT').split(' '));

function error(message) {
  return Object.assign(new Error(message), { code: 'ROCKETBRAIN_LOCAL_SQL_ASSISTANT' });
}

function supportedCatalog(catalog) {
  return catalog?.semanticContextObserved === true && ['mysql', 'mariadb'].includes(catalog.dialect) &&
    identifier.test(catalog.database ?? '') && Array.isArray(catalog.sqlMode) && catalog.coverage?.tables === 'loaded' &&
    catalog.coverage?.columns === 'loaded' && Array.isArray(catalog.tables);
}

function offeredTables(catalog) {
  if (!supportedCatalog(catalog)) throw error('Load a MySQL or MariaDB catalog with observed SQL modes before using the local assistant.');
  return catalog.tables.filter(table => table.kind === 'table' && identifier.test(table.name))
    .map(table => ({ name: table.name, columns: table.columns.filter(column => identifier.test(column.name)).map(column => column.name) }))
    .filter(table => table.columns.length);
}

function typeName(value) {
  const type = /^[a-z]+/i.exec(value ?? '')?.[0].toLowerCase();
  return sqlTypes.has(type) ? type : 'unknown';
}

function projectSchema(catalog, selections) {
  const available = new Map(offeredTables(catalog).map(table => [table.name, new Set(table.columns)]));
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > maxTables) {
    throw error('Choose at least one and at most six visible tables.');
  }
  const picked = new Map();
  let columnCount = 0;
  for (const selection of selections) {
    const { table, columns } = selection ?? {};
    const allowed = available.get(table);
    if (!allowed || picked.has(table) || !Array.isArray(columns) || !columns.length || new Set(columns).size !== columns.length ||
        columns.length > maxColumns || columns.some(name => !allowed.has(name))) throw error('Choose distinct visible columns from each selected table.');
    columnCount += columns.length;
    if (columnCount > maxColumns) throw error('Choose at most 48 columns across the selected tables.');
    picked.set(table, new Set(columns));
  }

  const tables = [], relationships = [];
  for (const original of catalog.tables) {
    const selected = picked.get(original.name);
    if (!selected) continue;
    const columns = original.columns.filter(column => selected.has(column.name)).map(column => ({ name: column.name,
      type: typeName(column.type), nullable: column.nullable === true, primaryKey: column.primaryKey === true }));
    tables.push({ name: original.name, columns });
    for (const relation of original.foreignKeys ?? []) {
      const references = picked.get(relation.referencedTable);
      if (relation.referencedSchema !== catalog.database || !references || !relation.columns?.length ||
          relation.columns.some(column => !selected.has(column.name) || !references.has(column.referencedColumn))) continue;
      const mapped = [...relation.columns].sort((left, right) => left.ordinal - right.ordinal);
      relationships.push({ table: original.name, columns: mapped.map(column => column.name),
        referencedTable: relation.referencedTable, referencedColumns: mapped.map(column => column.referencedColumn) });
      if (relationships.length > 16) throw error('Select fewer tables or columns to keep the relationship context bounded.');
    }
  }
  const context = { dialect: catalog.dialect, schema: catalog.database, tables, relationships };
  if (Buffer.byteLength(JSON.stringify(context)) > maxContextBytes) throw error('Choose at most 8 KiB of schema metadata.');
  return { context, catalog: { database: catalog.database, tables, coverage: { tables: 'loaded', columns: 'loaded' } },
    dialect: catalog.dialect, sqlMode: [...catalog.sqlMode], tableNameCaseSensitive: catalog.tableNameCaseSensitive !== false };
}

function reviewSelect(source, scope) {
  if (typeof source !== 'string' || !source.trim() || Buffer.byteLength(source) > maxInputBytes || source.includes('\0')) {
    throw error('Review one nonempty read-only SQL statement of at most 4 KiB.');
  }
  const options = { dialect: scope.dialect, sqlMode: scope.sqlMode, tableNameCaseSensitive: scope.tableNameCaseSensitive };
  let shape, tokens;
  try {
    const { first } = validateQuery(source, { readOnly: true, sqlMode: scope.sqlMode, allowOptimizerHints: false });
    if (!['SELECT', 'WITH'].includes(first)) throw Error();
    tokens = sourceTokens(source, options);
    shape = analyzeSql(source, scope.catalog, options);
  } catch { throw error('The local assistant requires one supported, read-only SELECT statement.'); }
  const unscoped = tokens.some((item, index) => item.kind === 'symbol' && item.value === '*' &&
    !(tokens[index - 2]?.kind === 'word' && tokens[index - 2]?.upper === 'COUNT' && tokens[index - 1]?.value === '(' &&
      tokens[index + 1]?.value === ')'));
  const unbound = tokens.some(item => item.kind === 'parameter');
  const relations = shape.relations.filter(item => item.kind === 'catalog');
  if (unscoped || unbound || shape.state !== 'known' || shape.diagnostics.length || !relations.length ||
    relations.some(relation => !relation.catalog)) {
    throw error('The query uses unapproved schema elements or SQL outside static review. Choose explicit approved columns.');
  }
  return { sql: source.trim(), tokens, tables: [...new Set(relations.map(relation => relation.catalog.table))].sort() };
}

function redactSql(sql, tokens, scope) {
  const catalogNames = new Set([scope.catalog.database, ...scope.catalog.tables.flatMap(table =>
    [table.name, ...table.columns.map(column => column.name)])].map(name => name.toLowerCase()));
  const aliases = new Map();
  return tokens.map(token => {
    if (token.kind === 'string' || token.kind === 'number') return '?';
    if (token.kind === 'word' || token.kind === 'identifier') {
      const name = token.value.toLowerCase();
      if (!catalogNames.has(name) && !(token.kind === 'word' && (syntaxWords.has(token.upper) || sqlTypes.has(name)))) {
        if (!aliases.has(name)) aliases.set(name, 'alias_' + (aliases.size + 1));
        return aliases.get(name);
      }
    }
    return sql.slice(token.start, token.end);
  }).join(' ');
}

function prepareLocalSqlRequest({ endpoint, model, catalog, selections, mode, input }) {
  if (!['draft', 'explain'].includes(mode) || typeof input !== 'string' || !input.trim() ||
      Buffer.byteLength(input) > maxInputBytes || input.includes('\0')) throw error('Supply a request or SQL statement of at most 4 KiB.');
  const target = normalizeLocalChatTarget(endpoint, model);
  const scope = projectSchema(catalog, selections);
  const reviewed = mode === 'explain' ? reviewSelect(input, scope) : null;
  const approved = { ...scope.context, ...(reviewed ? { sql: redactSql(input, reviewed.tokens, scope) } : { request: input.trim() }) };
  if (approved.sql && Buffer.byteLength(approved.sql) > maxInputBytes) throw error('Choose a smaller SQL statement for local explanation.');
  const system = mode === 'draft' ?
    'Draft MySQL or MariaDB SQL from approved schema only. Reply with JSON keys sql and explanation. Use one read-only SELECT, explicit column names, and no Markdown. Return an empty sql if the schema cannot support the request. Keep the explanation brief.' :
    'Explain this SELECT in one brief sentence. Question marks represent withheld values. Return a JSON object with one key, explanation. Then stop. Do not invent values or execution results.';
  const fields = mode === 'draft' ? ['sql', 'explanation'] : ['explanation'];
  const schema = { type: 'object', required: fields, additionalProperties: false,
    properties: Object.fromEntries(fields.map(key => [key, key === 'sql' ? { type: 'string' } :
      { type: 'string', minLength: 1, maxLength: 384 }])) };
  const payload = { temperature: 0, frequency_penalty: 0.15, max_tokens: 512,
    response_format: { type: 'json_schema', json_schema: { name: 'rocketbrain_sql_' + mode, strict: true, schema } },
    messages: [{ role: 'system', content: system },
      { role: 'user', content: JSON.stringify(approved) }] };
  return { target, scope, mode, preview: approved, payload, reviewed };
}

async function executeLocalSqlRequest(prepared, { signal } = {}) {
  const { target, mode, payload, scope, reviewed } = prepared;
  const completion = await requestLocalChat(target, payload, { signal });
  const [choice] = Array.isArray(completion?.choices) ? completion.choices : [];
  const tools = choice?.message?.tool_calls;
  const calledTool = tools != null && (!Array.isArray(tools) || tools.length > 0);
  if (completion?.choices?.length !== 1 || !['stop', 'length'].includes(choice?.finish_reason) || choice.message?.role !== 'assistant' ||
      typeof choice.message.content !== 'string' || calledTool || choice.message.function_call) {
    throw error('The local model did not complete the expected JSON response.');
  }
  let answer;
  try { answer = JSON.parse(choice.message.content); } catch { throw error('The local model did not return the requested JSON object.'); }
  const keys = mode === 'draft' ? ['sql', 'explanation'] : ['explanation'];
  if (!answer || Array.isArray(answer) || typeof answer !== 'object' || Object.keys(answer).length !== keys.length ||
      keys.some(key => typeof answer[key] !== 'string') || !answer.explanation.trim() ||
      Buffer.byteLength(answer.explanation) > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(answer.explanation)) {
    throw error('The local model response did not match the requested draft or explanation.');
  }
  const verified = mode === 'draft' ? reviewSelect(answer.sql, scope) : reviewed;
  return { mode, model: target.model, endpoint: target.endpoint, dialect: scope.dialect, schema: scope.catalog.database,
    tables: verified.tables, execution: 'not-run', ...(mode === 'draft' ? { sql: verified.sql } : {}), explanation: answer.explanation.trim() };
}

module.exports = { offeredTables, projectSchema, reviewSelect, prepareLocalSqlRequest, executeLocalSqlRequest };
