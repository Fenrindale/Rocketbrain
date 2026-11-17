'use strict';
const { DURATION_UNITS } = require('./provider');

// Expression AST for the bounded, already scoped JPQL stream. Unknown syntax
// remains explicit; it is never recovered by pretending tokens have a type.
function normalizeTokens(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const pair = tokens[i].text + (tokens[i + 1]?.text || '');
    if (['>=', '<=', '<>', '!=', '||'].includes(pair)) { result.push({ ...tokens[i], text: pair, end: tokens[++i].end }); continue; }
    result.push(tokens[i]);
  }
  return result;
}
function parseExpression(tokens, options = {}) {
  const list = normalizeTokens(tokens); let cursor = 0, nodes = 0;
  const issues = [];
  const word = at => list[at]?.lower || list[at]?.text?.toLowerCase();
  const peek = () => word(cursor);
  function node(kind, start, end, value = {}) { if (++nodes > 4096) { issues.push('Expression AST node limit exceeded.'); return { kind: 'unknown', start, end }; } return { kind, start, end, ...value }; }
  function unknown(message, token = list[cursor] || list.at(-1)) { issues.push(message); return node('unknown', token?.start || 0, token?.end || 0, { reason: message }); }
  function take(text) { if (peek() === text) { cursor++; return true; } return false; }
  function expect(text) { if (!take(text)) issues.push('Expected ' + text + ' in expression.'); }
  function argumentsList(depth) {
    const args = []; let distinct = false;
    if (take('distinct')) distinct = true;
    if (take(')')) return { args, distinct };
    while (cursor < list.length) { const before = cursor; args.push(expression(0, depth + 1)); if (take(')')) break; if (!take(',')) { issues.push('Function/constructor argument boundary is unresolved.'); break; } if (cursor === before) break; }
    return { args, distinct };
  }
  function functionNode(token, depth) {
    const name = token.lower, start = token.start;
    expect('(');
    if (name === 'treat' || name === 'cast') {
      const value = expression(0, depth + 1); expect('as'); const parts = [];
      while (list[cursor]?.kind === 'id') { parts.push(list[cursor++].text); if (!take('.')) break; }
      expect(')'); return node(name, start, list[cursor - 1]?.end || token.end, { value, target: parts.join('.') });
    }
    if (name === 'extract') {
      const fields=[];while(cursor<list.length&&peek()!=='from'&&peek()!==')')fields.push(list[cursor++].text);
      const field=fields.join(' '); expect('from'); const value = expression(0, depth + 1); expect(')');
      return node('function', start, list[cursor - 1]?.end || token.end, { name, args: [value], field });
    }
    if (name === 'trim') {
      const first = cursor; let nesting = 0, from = -1;
      for (let i = cursor; i < list.length; i++) { if (list[i].text === '(') nesting++; else if (list[i].text === ')') { if (!nesting) break; nesting--; } if (!nesting && word(i) === 'from') { from = i; break; } }
      if (from >= 0) {
        let at = first; if (['leading', 'trailing', 'both'].includes(word(at))) at++;
        const prefix = list.slice(at, from), trimCharacter = prefix.length ? parseExpression(prefix, options) : null;
        if (trimCharacter?.issues.length) issues.push(...trimCharacter.issues);
        cursor = from + 1; const value = expression(0, depth + 1); expect(')');
        return node('function', start, list[cursor - 1]?.end || token.end, { name, args: trimCharacter ? [value, trimCharacter.ast] : [value], trimCharacter: Boolean(trimCharacter) });
      }
    }
    const result = argumentsList(depth);
    return node('function', start, list[cursor - 1]?.end || token.end, { name, ...result });
  }
  function window(value, depth) {
    if (!take('(')) { if(list[cursor]?.kind==='id')cursor++;issues.push('Named/malformed window specifications are outside this AST subset.');return node('window',value.start,list[cursor-1]?.end||value.end,{value,partition:[],order:[],frame:null}); }
    const begin=cursor;let nesting=0;
    while(cursor<list.length){if(list[cursor].text==='(')nesting++;else if(list[cursor].text===')'){if(!nesting)break;nesting--;}cursor++;}
    const body=list.slice(begin,cursor);expect(')');const top=[];nesting=0;
    for(let i=0;i<body.length;i++){if(body[i].text==='(')nesting++;else if(body[i].text===')')nesting--;else if(!nesting&&body[i-1]?.text!=='.')top.push({word:body[i].lower||body[i].text,index:i});}
    const find=name=>top.find(item=>item.word===name)?.index??-1,partitionAt=find('partition'),orderAt=find('order'),frameAt=Math.min(...['rows','range','groups'].map(find).filter(i=>i>=0),body.length);
    function fragments(tokens){const out=[];let start=0,n=0;for(let i=0;i<tokens.length;i++){if(tokens[i].text==='(')n++;else if(tokens[i].text===')')n--;else if(!n&&tokens[i].text===','){out.push(tokens.slice(start,i));start=i+1;}}out.push(tokens.slice(start));return out.filter(part=>part.length);}
    function parsePart(tokens){const result=parseExpression(tokens,options);issues.push(...result.issues);return result.ast;}
    const partition=partitionAt>=0?fragments(body.slice(partitionAt+2,Math.min(...[orderAt,frameAt].filter(i=>i>partitionAt),body.length))).map(parsePart):[];
    const order=orderAt>=0?fragments(body.slice(orderAt+2,frameAt)).map(part=>{const suffix=part.findIndex(token=>['asc','desc','nulls'].includes(token.lower));return parsePart(suffix>=0?part.slice(0,suffix):part);}):[];
    let frame=null;
    if(frameAt<body.length){let rest=body.slice(frameAt+1);const mode=body[frameAt].lower;if(rest.some(token=>token.lower==='exclude'))issues.push('Window frame EXCLUDE semantics are outside this AST subset.');
      function bound(tokens){const raw=tokens.map(token=>token.lower||token.text).join(' ');if(['unbounded preceding','unbounded following','current row'].includes(raw))return{kind:raw};const direction=tokens.at(-1)?.lower;if(!['preceding','following'].includes(direction)){issues.push('Window frame boundary is unresolved.');return{kind:'unknown'};}return{kind:direction,expression:parsePart(tokens.slice(0,-1))};}
      const between=rest[0]?.lower==='between';if(between)rest=rest.slice(1);const and=rest.findIndex(token=>token.lower==='and');frame={mode,start:bound(and>=0?rest.slice(0,and):rest),end:and>=0?bound(rest.slice(and+1)):null};if(between&&and<0)issues.push('Window BETWEEN requires two boundaries.');
    }
    if(body.length&&partitionAt<0&&orderAt<0&&frameAt===body.length)issues.push('Window body is outside the supported PARTITION/ORDER/frame subset.');
    return node('window',value.start,list[cursor-1]?.end||value.end,{value,partition,order,frame});
  }
  function primary(depth) {
    if (depth > 64) return unknown('Expression nesting limit exceeded.');
    const token = list[cursor++]; if (!token) return unknown('Expression is incomplete.');
    let value;
    if (token.text === '(') {
      if (['select', 'from'].includes(peek())) {
        const begin = cursor; let nesting = 0;
        while (cursor < list.length) { if (list[cursor].text === '(') nesting++; else if (list[cursor].text === ')') { if (!nesting) break; nesting--; } cursor++; }
        const body = list.slice(begin, cursor); expect(')'); value = node('subquery', token.start, list[cursor - 1]?.end || token.end, { bodyStart: body[0]?.start, tokens: body });
      } else { value = expression(0, depth + 1); expect(')'); }
    } else if (token.text === ':') {
      const parameter = list[cursor++]; value = parameter?.kind === 'id' ? node('parameter', token.start, parameter.end, { name: parameter.text, key: ':' + parameter.text }) : unknown('Named parameter is incomplete.', token);
    } else if (token.text === '?') {
      const parameter = list[cursor++]; value = /^\d+$/.test(parameter?.text || '') ? node('parameter', token.start, parameter.end, { position: Number(parameter.text), key: '?' + parameter.text }) : unknown('Positional parameter must have a static ordinal.', token);
    } else if (token.kind === 'string') value = node('literal', token.start, token.end, { literalKind: 'string', value: token.text.slice(1, -1).replace(/''/g, "'") });
    else if (token.kind === 'number') value = node('literal', token.start, token.end, { literalKind: 'number', value: token.text });
    else if (token.text === '*') value = node('star', token.start, token.end);
    else if (['+', '-'].includes(token.text) || token.lower === 'not') { const argument = expression(token.lower === 'not' ? 3 : 7, depth + 1); value = node('unary', token.start, argument.end, { op: token.lower || token.text, argument }); }
    else if (token.lower === 'exists') { const argument = primary(depth + 1); value = node('exists', token.start, argument.end, { argument }); }
    else if (['all', 'any', 'some'].includes(token.lower)) { const argument = primary(depth + 1); value = node('quantified', token.start, argument.end, { op: token.lower, argument }); }
    else if (token.lower === 'case') {
      const base = peek() === 'when' ? null : expression(0, depth + 1), branches = [];
      while (take('when')) { const condition = expression(0, depth + 1); expect('then'); const result = expression(0, depth + 1); branches.push({ condition, result }); }
      const otherwise = take('else') ? expression(0, depth + 1) : null; expect('end');
      value = node('case', token.start, list[cursor - 1]?.end || token.end, { base, branches, otherwise });
    } else if (token.lower === 'new') {
      const parts = []; while (list[cursor]?.kind === 'id') { parts.push(list[cursor++].text); if (!take('.')) break; }
      expect('('); const { args } = argumentsList(depth); value = node('constructor', token.start, list[cursor - 1]?.end || token.end, { className: parts.join('.'), args });
    } else if (['true', 'false', 'null'].includes(token.lower)) value = node('literal', token.start, token.end, { literalKind: token.lower, value: token.lower });
    else if (token.lower === 'local' && ['date', 'time', 'datetime'].includes(peek())) { const part = list[cursor++]; value = node('function', token.start, part.end, { name: 'local_' + part.lower, args: [] }); }
    else if (token.kind === 'id' && list[cursor]?.text === '(') value = functionNode(token, depth);
    else if (['current_date', 'current_time', 'current_timestamp'].includes(token.lower)) value = node('function', token.start, token.end, { name: token.lower, args: [] });
    else if (token.kind === 'id') value = node('path', token.start, token.end, { parts: [token.text] });
    else value = unknown('Unrecognized expression token: ' + token.text, token);
    while (take('.')) {
      const property = list[cursor++]; if (property?.kind !== 'id') { issues.push('Path is incomplete.'); break; }
      if (value.kind === 'path') { value.parts.push(property.text); value.end = property.end; }
      else value = node('member', value.start, property.end, { object: value, property: property.text });
    }
    if(options.provider){
      if(value.kind==='literal'&&value.literalKind==='number'&&DURATION_UNITS.has(peek())){const unit=list[cursor++];value=node('duration',value.start,unit.end,{amount:value,unit:unit.lower});}
      if(take('by')){const unit=list[cursor++];if(!DURATION_UNITS.has(unit?.lower))issues.push('Duration conversion unit is unsupported.');value=node('duration-conversion',value.start,unit?.end||value.end,{value,unit:unit?.lower});}
      if(take('filter')){expect('(');expect('where');const predicate=expression(0,depth+1);expect(')');value=node('filter',value.start,list[cursor-1]?.end||value.end,{value,predicate});}
      if(take('over'))value=window(value,depth+1);
    }
    return value;
  }
  function operator() {
    const name = peek();
    if (name === 'or') return { op: name, precedence: 1, count: 1 };
    if (name === 'and') return { op: name, precedence: 2, count: 1 };
    if (name === 'not' && ['in', 'like', 'between', 'member'].includes(word(cursor + 1))) return { op: 'not ' + word(cursor + 1), precedence: 3, count: 2 };
    if (['=', '<>', '!=', '<', '>', '<=', '>=', 'is', 'in', 'like', 'between', 'member'].includes(name)) return { op: name, precedence: 3, count: 1 };
    if (name === '||') return { op: name, precedence: 4, count: 1 };
    if (['+', '-'].includes(name)) return { op: name, precedence: 5, count: 1 };
    if (['*', '/'].includes(name)) return { op: name, precedence: 6, count: 1 };
    return null;
  }
  function expression(minimum, depth) {
    let left = primary(depth);
    while (cursor < list.length) {
      const op = operator(); if (!op || op.precedence < minimum) break; cursor += op.count;
      if (op.op === 'is') { const negated = take('not'), test = peek(); if (['null', 'empty', 'true', 'false'].includes(test)) cursor++; else issues.push('IS predicate is unresolved.'); left = node('is', left.start, list[cursor - 1]?.end || left.end, { argument: left, test, negated }); continue; }
      if (op.op.endsWith('between')) { const lower = expression(4, depth + 1); expect('and'); const upper = expression(4, depth + 1); left = node('between', left.start, upper.end, { argument: left, lower, upper, negated: op.count === 2 }); continue; }
      if (op.op.endsWith('in')) {
        let values, form = 'collection-or-subquery';
        if (list[cursor]?.text === '(' && !['select', 'from'].includes(word(cursor + 1))) { cursor++; values = argumentsList(depth).args; form = 'list'; }
        else values = [primary(depth + 1)];
        left = node('in', left.start, list[cursor - 1]?.end || left.end, { argument: left, values, form, negated: op.count === 2 }); continue;
      }
      if (op.op.endsWith('member')) take('of');
      const right = expression(op.precedence + 1, depth + 1);
      if (op.op.endsWith('like')) { const escape = take('escape') ? expression(4, depth + 1) : null; left = node('like', left.start, escape?.end || right.end, { argument: left, pattern: right, escape, negated: op.count === 2 }); }
      else left = node('binary', left.start, right.end, { op: op.op, left, right });
    }
    return left;
  }
  const ast = list.length ? expression(0, 0) : unknown('Expression is empty.');
  let resultAlias;
  if (options.selection && take('as')) resultAlias = list[cursor++]?.text;
  else if (options.selection && cursor === list.length - 1 && list[cursor].kind === 'id') resultAlias = list[cursor++].text;
  if (cursor < list.length) issues.push('Unresolved expression suffix: ' + list[cursor].text);
  return { ast, issues, resultAlias, nodes };
}

module.exports = { parseExpression, normalizeTokens };
