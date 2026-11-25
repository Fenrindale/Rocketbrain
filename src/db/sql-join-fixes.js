'use strict';

const { analyzeSql, sourceLayout, statementRanges } = require('./sql-analysis');
const { endpointKey, validName, maxParts } = require('./join-catalog');

const tail = new Set(['WHERE','GROUP','HAVING','ORDER','LIMIT','WINDOW','FOR','LOCK']);
const excluded = new Set(['CROSS','NATURAL','STRAIGHT_JOIN','USING','UNION','INTERSECT','EXCEPT']);
const word = (token, value) => token?.kind === 'word' && token.upper === value;
const quote = value => '`' + value.replaceAll('`','``') + '`';
const endpoint = relation => ({ schema:relation.catalog.database, table:relation.catalog.table });
const matchingEndpoint = (left, right) => endpointKey(left) === endpointKey(right);

function joinGap(text, offset, catalog) {
  if (typeof text !== 'string' || !Number.isInteger(offset) || !catalog?.database || catalog.cachedMetadata ||
      ['tables','columns'].some(key => catalog.coverage?.[key] !== 'loaded')) return null;
  const options = { dialect:catalog.dialect, database:catalog.database, sqlMode:catalog.sqlMode,
    tableNameCaseSensitive:catalog.tableNameCaseSensitive, catalogComplete:true, joinOrigins:true };
  const split = statementRanges(text, options), section = split.statements.find(item => item.start <= offset && offset <= item.end);
  if (!section || split.unknown.length) return null;
  const source = text.slice(section.start,section.end), local = offset - section.start;
  const { tokens, nonCode } = sourceLayout(source,options);
  if (!word(tokens[0],'SELECT') || nonCode.some(span => local >= span.start && local < span.end)) return null;
  const main = [];
  for (let index=0;index<tokens.length;index++) {
    const token=tokens[index];
    main.push(token);
    if (token.close!==undefined) index=token.close;
  }
  if (main.some(token => token.kind === 'word' && excluded.has(token.upper))) return null;
  const joins = main.filter(token => word(token,'JOIN'));
  if (joins.length !== 1) return null;
  const join = joins[0];
  if (local < join.start) return null;
  const where = main.find(token => token.start > join.end && (token.value===';' || token.kind==='word' && tail.has(token.upper)));
  const boundary = where?.start ?? source.length;
  if (local > boundary) return null;
  const joinTokens = main.filter(token => token.start >= join.end && token.start < boundary && token.value !== ';');
  const present = joinTokens.findIndex(token => word(token,'ON'));
  if (present !== -1 && present !== joinTokens.length - 1) return null;
  const on = present === -1 ? null : joinTokens[present];
  const blank = on ? source.slice(0,on.start) + ' '.repeat(on.end - on.start) + source.slice(on.end) : source;
  const model = analyzeSql(blank,catalog,options);
  if (model.state!=='known' || model.scopes.length!==1 || !model.scopes[0].complete ||
      model.diagnostics.length || model.relations.length!==2) return null;
  const [left,right] = model.relations;
  if ([left,right].some(item => item.kind!=='catalog' || !item.catalog || !validName(item.alias)) ||
      right.start <= join.end || left.alias.toLowerCase()===right.alias.toLowerCase()) return null;
  const start=on?.end ?? right.end;
  if (nonCode.some(span => span.start < boundary && span.end > right.end) || local < right.start || local > boundary) return null;
  return { before:source, statementStart:section.start, start, left, right, options, hasOn:Boolean(on),
    endpoints:[endpoint(left),endpoint(right)] };
}

function livePredicates(gap, catalog, inventory) {
  const [left,right] = gap.endpoints;
  if (matchingEndpoint(left,right)) return [];
  const tables = inventory.tables.filter(item=>item.kind==='table');
  const partsFor = (value, table) => tables.find(item=>item.schema===value.schema && item.name===value.table)?.columns;
  const leftColumns=partsFor(left,tables),rightColumns=partsFor(right,tables);
  if (!leftColumns || !rightColumns) return [];
  const seen = new Set();
  const fixes = [];
  for (const edge of inventory.edges) {
    if (edge.kind!=='physical' || !validName(edge.name) || !Array.isArray(edge.parts) || !edge.parts.length || edge.parts.length>maxParts) continue;
    const reversed=matchingEndpoint(edge.parent,left)&&matchingEndpoint(edge.child,right);
    if (!reversed && !(matchingEndpoint(edge.child,left)&&matchingEndpoint(edge.parent,right))) continue;
    const l=new Set(),r=new Set(),predicates=[];
    for (const [index,part] of edge.parts.entries()) {
      const lhs=reversed?part.parentColumn:part.column, rhs=reversed?part.column:part.parentColumn;
      if (part.ordinal!==index+1 || l.has(lhs) || r.has(rhs) || !validName(lhs) || !validName(rhs) ||
          !leftColumns.some(item=>item.name===lhs) || !rightColumns.some(item=>item.name===rhs)) break;
      l.add(lhs);r.add(rhs);
      predicates.push(quote(gap.left.alias)+'.'+quote(lhs)+' = '+quote(gap.right.alias)+'.'+quote(rhs));
    }
    if (predicates.length!==edge.parts.length) continue;
    const replacement=(gap.hasOn?' ':' ON ') + predicates.join(' AND ');
    if (seen.has(replacement)) continue;
    const completed=gap.before.slice(0,gap.start)+replacement+gap.before.slice(gap.start);
    const validated=analyzeSql(completed,catalog,gap.options);
    if (validated.state!=='known' || validated.diagnostics.length) continue;
    seen.add(replacement);
    const start=gap.statementStart+gap.start;
    fixes.push({ title:'Complete JOIN using '+edge.name, start, end:start, replacement, edge });
  }
  return fixes.slice(0,20);
}

async function sqlJoinFixes(text, offset, catalog, observe) {
  if (typeof observe!=='function') return [];
  try {
    const gap=joinGap(text,offset,catalog);
    if (!gap) return [];
    const inventory=await observe({ endpoints:gap.endpoints });
    return livePredicates(gap,catalog,inventory);
  } catch { return []; }
}

module.exports = { sqlJoinFixes };
