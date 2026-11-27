'use strict';

const AST = require('./schema-trigger-ast');
const {sourceTokens} = require('./sql-analysis');

const fail = message => Object.assign(new Error(message), {code: 'ROCKETBRAIN_REBUILD_TRIGGER_MAPPING'});
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const identity = trigger => trigger.schema + '/' + trigger.name;
const standardAst = ast => ast?.format === 'RocketbrainStructuredTrigger' && ast.formatVersion === 1;
const isMappedTriggerPlan = plan => plan.formatVersion === 9;
const splitOperators = new Set(['<=', '>=', '<>', '!=', '<<', '>>', '==']);
// The structured renderer inserts a space before parentheses. These function
// names in its scalar grammar are whitespace-sensitive in both vendor lexers.
const spacingSensitiveFunctions = new Set(['CAST', 'NOW', 'SUBSTR', 'SUBSTRING', 'TRIM']);

function replayableTokens(body, sqlMode) {
  const tokens = AST.lex(body, {sqlMode});
  for (let i = 1; i < tokens.length; i++) {
    const prior = tokens[i - 1], token = tokens[i];
    if (prior.kind === 'word' && token.value === '(' && spacingSensitiveFunctions.has(prior.value.toUpperCase())) {
      throw fail('The structured renderer cannot preserve the binding of this whitespace-sensitive trigger function.');
    }
    if (prior.kind === 'punct' && token.kind === 'punct' && splitOperators.has(prior.value + token.value) ||
        prior.kind === 'number' && token.value === '.' || prior.value === '.' && token.kind === 'number' ||
        prior.end === token.start && (prior.kind === 'number' && token.kind === 'word' ||
        prior.kind === 'word' && token.kind === 'literal')) {
      throw fail('The trigger uses a compound SQL token whose spelling cannot be retained by the structured renderer.');
    }
  }
  return tokens;
}

function assertOrdinaryTriggerSource(shown, trigger) {
  if (!standardAst(trigger.ast)) throw fail('Rebind only ordinary statically modeled trigger bodies without routine calls or dynamic SQL.');
  const sources = shown[0]?.filter(value => typeof value === 'string' && /^\s*CREATE\s/iu.test(value)) || [];
  if (shown.length !== 1 || sources.length !== 1) throw fail('The complete mapped trigger definition is unavailable.');
  const source = sources[0];
  if (Buffer.byteLength(source) > AST.LIMITS.bytes) throw fail('The complete mapped trigger definition exceeds the SQL source limit.');
  const tokens = sourceTokens(source, {sqlMode: trigger.sqlMode.split(',').filter(Boolean)});
  const word = (index, value) => tokens[index]?.kind === 'word' && tokens[index].upper === value;
  const name = index => ['word', 'identifier'].includes(tokens[index]?.kind) ? tokens[index].value : undefined;
  let at = 7;
  function consumeName(expected) {
    if (tokens[at + 1]?.value === '.') {
      if (name(at) !== trigger.schema) throw fail('The exact trigger DDL schema differs from its catalog owner.');
      at += 2;
    }
    return name(at++) === expected;
  }
  if (!word(0, 'CREATE') || !word(1, 'DEFINER') || tokens[2]?.value !== '=' || tokens[4]?.value !== '@' ||
      name(3) + '@' + name(5) !== trigger.definer || !word(6, 'TRIGGER') || !consumeName(trigger.name) ||
      !word(at++, trigger.timing) || !word(at++, trigger.event) || !word(at++, 'ON') ||
      !consumeName(trigger.table) || !word(at++, 'FOR') || !word(at++, 'EACH') || !word(at++, 'ROW') ||
      !tokens[at]) {
    throw fail('Use the exact ordinary trigger identity, timing, event, subject and definer.');
  }
  for (let i = 0, end = 0; i <= at; i++) {
    if (!/^\s*$/u.test(source.slice(end, tokens[i].start))) {
      throw fail('Comments and conditional modifiers in the trigger header need separate review.');
    }
    end = tokens[i].end;
  }
  const bodySource = source.slice(tokens[at].start);
  replayableTokens(bodySource, trigger.sqlMode);
  const body = AST.parse(bodySource, trigger.schema, trigger.table, {sqlMode: trigger.sqlMode});
  if (!same(body, trigger.ast)) throw fail('The mapped trigger source and observed catalog body differ.');
}

function rewriteTrigger(trigger, mapping) {
  let body = AST.render(trigger.ast);
  const tokens = replayableTokens(body, trigger.sqlMode);
  const edits = [];
  for (let i = 0; i < tokens.length - 2; i++) {
    const [prefix, dot, column] = tokens.slice(i, i + 3);
    if (prefix.kind !== 'word' || !['NEW', 'OLD'].includes(prefix.value.toUpperCase()) || dot.value !== '.') continue;
    const target = mapping.get(column.name);
    if (target !== undefined) edits.push({start: column.start, end: column.end, text: AST.q(target)});
  }
  if (!edits.length) return trigger;
  for (const {start, end, text} of edits.reverse()) body = body.slice(0, start) + text + body.slice(end);
  const ast = AST.parse(body, trigger.schema, trigger.table, {sqlMode: trigger.sqlMode});
  if (!standardAst(ast) || !same(ast.targets, trigger.ast.targets) || !same(ast.locals, trigger.ast.locals)) {
    throw fail('The mapped trigger changes a local or target-table binding.');
  }
  return {...trigger, ast};
}

function projectMappedTriggers(plan, triggers) {
  const mapped = new Map(Object.entries(plan.columnMappings).map(([name, pairs]) =>
    [name, new Map(pairs.map(({from, to}) => [from, to]))]));
  let rebound = false;
  const projected = triggers.map(trigger => {
    if (!standardAst(trigger.ast) || trigger.schema !== plan.database ||
        trigger.ast.targets.some(target => target.schema !== plan.database || mapped.has(target.table))) {
      throw fail('Mapped triggers require statically bound same-schema bodies and unmapped DML target tables.');
    }
    const mapping = mapped.get(trigger.table);
    if (!mapping) {
      replayableTokens(AST.render(trigger.ast), trigger.sqlMode);
      return trigger;
    }
    const rewritten = rewriteTrigger(trigger, mapping);
    rebound ||= rewritten !== trigger;
    return rewritten;
  });
  if (!rebound) throw fail('The selected column mappings have no observed NEW or OLD trigger references to rebind.');
  return projected;
}

function validateMappedTriggerBundle(plan, bundle) {
  const {before, after} = bundle;
  if (before.views.length || after.views.length || before.routines?.length || after.routines?.length) {
    throw fail('Dependent views or routines require a separate migration from trigger column rebinding.');
  }
  const beforeTables = bundle.tableSnapshots;
  const rebuiltNames = new Set(plan.steps.map(step => step.table));
  const afterTables = beforeTables.filter(table => table.schema !== plan.database || !rebuiltNames.has(table.name))
    .concat(plan.steps.map(step => ({...step.after, schema: plan.database})));
  const projected = projectMappedTriggers(plan, before.triggers);
  if (!same(after.triggers, projected)) throw fail('The reviewed trigger dependency phases differ from the mapped source.');
  for (const [triggers, tables] of [[before.triggers, beforeTables], [after.triggers, afterTables]]) {
    for (const trigger of triggers) {
      AST.validate(trigger.ast, {database: trigger.schema, table: trigger.table, timing: trigger.timing, event: trigger.event, tables});
    }
  }
}

function validateObservedTriggerPhase(bundle, phase, rows) {
  const wanted = bundle[phase].triggers;
  const keys = new Set(wanted.map(identity));
  const observed = rows.filter(row => keys.has(row[11] + '/' + row[0]));
  if (observed.length !== wanted.length || observed.some((row, index) => {
    const [name, table, timing, event, body, sqlMode, definer, charset, collation, databaseCollation, , schema] = row;
    const expected = wanted[index];
    return name !== expected.name || table !== expected.table || timing !== expected.timing || event !== expected.event ||
      sqlMode !== expected.sqlMode || definer !== expected.definer || charset !== expected.charset ||
      collation !== expected.collation || databaseCollation !== expected.databaseCollation || schema !== expected.schema ||
      !same(AST.parse(body, schema, table, {sqlMode}), expected.ast);
  })) {
    throw fail('The mapped trigger definition, context or relative action order differs from the reviewed phase.');
  }
}

module.exports = {isMappedTriggerPlan, assertOrdinaryTriggerSource, projectMappedTriggers,
  validateMappedTriggerBundle, validateObservedTriggerPhase};
