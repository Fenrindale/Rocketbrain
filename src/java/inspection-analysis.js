'use strict';

const { lexJava,parseJavaFile } = require('../spring/java');
const { RULES } = require('./inspection-profiles');

const MAX_TOKENS = 500000;
const MAX_GROUPS = 150;
const MAX_CHECKS = 25000;
const MAX_COMPARE_TOKENS = 3000000;
const MAX_CANDIDATES = 16;
const MAX_METHOD_TOKENS = 8000;
const STATEMENT_END = new Set([';','}']);
const BODY_START = new Set([';','{','}']);
const LITERALS = new Set(['string','number','char','text-block']);

function positions(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') offsets.push(i + 1);
  function point(offset) {
    let low = 0, high = offsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (offsets[middle] <= offset) low = middle; else high = middle;
    }
    return { line:low,character:offset - offsets[low] };
  }
  return (start,end) => ({ start:point(start),end:point(end) });
}

function matching(tokens) {
  const opening = { '(':')','{':'}','[':']' };
  const closed = new Set(Object.values(opening)), stack = [], pairs = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const { text,kind } = tokens[i];
    if (kind !== 'symbol') continue;
    if (opening[text]) stack.push(i);
    else if (closed.has(text)) {
      const start = stack.pop();
      if (start === undefined || opening[tokens[start].text] !== text) return null;
      pairs.set(start,i);
    }
  }
  return stack.length ? null : pairs;
}

function suppressions(source,tokens,range) {
  const ignoredFile = new Set(), ignoredLines = new Map();
  const first = tokens[0]?.start ?? source.length;
  for (let end = 0,index = 0; index <= tokens.length; index++) {
    const next = tokens[index]?.start ?? source.length;
    const gap = source.slice(end,next);
    for (const comment of gap.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g)) {
      const directive = /^\/\/\s*rocketbrain-ignore(-file)?:\s*([A-Za-z, ]+)\s*$/.exec(comment[0]);
      if (!directive) continue;
      const rules = directive[2].trim().split(/[ ,]+/).filter(name => Object.hasOwn(RULES,name));
      const start = end + comment.index, line = range(start,start).start.line;
      if (directive[1]) {
        if (start < first) for (const key of rules) ignoredFile.add(key);
      } else {
        const beginning = source.lastIndexOf('\n',start - 1) + 1;
        const bare = !source.slice(beginning,start).trim();
        for (const key of [line,...(bare ? [line + 1] : [])]) {
          if (!ignoredLines.has(key)) ignoredLines.set(key,new Set());
          for (const rule of rules) ignoredLines.get(key).add(rule);
        }
      }
    }
    end = tokens[index]?.end ?? source.length;
  }
  return (rule,line) => ignoredFile.has(rule) || ignoredLines.get(line)?.has(rule);
}

function javaIssues(file,profile,tokens,pairs,range,includeAnchors) {
  const { text,uri } = file;
  const suppressed = suppressions(text,tokens,range), issues = [], imports = new Set();
  function report(id, first, last) {
    const severity = profile.rules[id];
    const selection = range(tokens[first].start,tokens[last].end);
    if (severity !== 'off' && !suppressed(id,selection.start.line)) {
      const issue={ id,uri,severity,message:RULES[id].label,range:selection };
      if (includeAnchors) issue.anchor=[first-Math.max(0,first-6),last-first+1,
        ...tokens.slice(Math.max(0,first-6),last+7).map(token=>[token.kind,token.text])];
      issues.push(issue);
    }
  }
  for (const [index,token] of tokens.entries()) {
    if (token.kind !== 'id') continue;
    const next = tokens[index + 1];
    if (token.text === 'import') {
      let last = index + 1;
      while (last < tokens.length && tokens[last].text !== ';') last++;
      const between = tokens.slice(index + 1,last);
      if (last === tokens.length || !between.length || between.some(item => item.kind !== 'id' && !['.','*'].includes(item.text))) continue;
      const identity = between.map(item => item.text).join(' ');
      if (imports.has(identity)) report('duplicateImport',index,last);
      imports.add(identity);
    } else if (token.text === 'catch' || token.text === 'finally') {
      const isCatch = token.text === 'catch';
      const after = isCatch && next?.text === '(' ? pairs.get(index + 1) : index;
      const open = tokens[after + 1], close = tokens[after + 2];
      if ((!isCatch || next?.text === '(') && open?.text === '{' && close?.text === '}' &&
          !text.slice(open.end,close.start).trim()) {
        report(isCatch ? 'emptyCatch' : 'emptyFinally',index,after+2);
      }
    } else if (token.text === 'if' && next?.text === '(') {
      const close = pairs.get(index + 1), tail = tokens[close + 1];
      if (tail?.text === ';' && !text.slice(tokens[close].end,tail.start).trim()) {
        report('emptyIf',index,close+1);
      }
    }
  }
  return issues;
}

function javaBodies(file,tokens,pairs,range) {
  const parsed = parseJavaFile({ text:file.text });
  const indexed = new Map(tokens.map((token,index) => [token.start,index]));
  const bodies = [];
  let oversized = 0;
  for (const type of parsed.types) {
    for (const method of type.methods || []) {
      const offset = indexed.get(method.start), open = offset === undefined ? undefined : offset + 1;
      if (tokens[open]?.text !== '(' || !pairs.has(open)) continue;
      let body = pairs.get(open) + 1;
      while (body < tokens.length && !['{',';','}'].includes(tokens[body].text)) body++;
      if (tokens[body]?.text !== '{' || !pairs.has(body)) continue;
      const end = pairs.get(body);
      if (end - body - 1 > MAX_METHOD_TOKENS) { oversized++; continue; }
      if (end > body + 1) bodies.push({ uri:file.uri, name:type.name + '.' + method.name,
        tokens:tokens.slice(body + 1,end),range });
    }
  }
  return { bodies,oversized };
}

function duplicateGroups(bodies,mode,minimum) {
  const values = new Map(), windows = new Map(), matches = new Map();
  let examined = 0, truncated = false;
  let compared = 0;
  const RADIX = 16777619;
  let power = 1;
  for (let i = 1; i < minimum; i++) power = Math.imul(power,RADIX);
  function tokenId(token) {
    const value = token.kind + ':' + (mode === 'ignore-literals' && LITERALS.has(token.kind) ? '' : token.text);
    if (!values.has(value)) values.set(value,values.size + 1);
    return values.get(value);
  }
  for (const body of bodies) body.values = body.tokens.map(tokenId);
  function occurrence(body,start,length) {
    const first = body.tokens[start], last = body.tokens[start + length - 1];
    return { uri:body.uri,method:body.name,start:first.start,end:last.end,range:body.range(first.start,last.end) };
  }
  for (const body of bodies) {
    if (examined >= MAX_CHECKS || compared >= MAX_COMPARE_TOKENS) break;
    if (body.values.length < minimum) continue;
    let rolling = 0;
    for (let i = 0; i < minimum; i++) rolling = (Math.imul(rolling,RADIX) + body.values[i]) >>> 0;
    for (let start = 0; start + minimum <= body.values.length; start++) {
      if (start) rolling = (Math.imul(rolling - Math.imul(body.values[start - 1],power),RADIX) + body.values[start + minimum - 1]) >>> 0;
      if (start && !BODY_START.has(body.tokens[start - 1].text)) continue;
      const bucket = windows.get(rolling) || [];
      for (const candidate of bucket) {
        if (++examined > MAX_CHECKS) { truncated = true; break; }
        const maxLength = candidate.body === body ? start - candidate.start : Infinity;
        if (maxLength < minimum) continue;
        const remaining = MAX_COMPARE_TOKENS - compared;
        const found = span(candidate.body,candidate.start,body,start,Math.min(maxLength,remaining));
        compared += found.compared;
        if (compared >= MAX_COMPARE_TOKENS) truncated = true;
        const length = found.completed;
        if (length < minimum) continue;
        const left = occurrence(candidate.body,candidate.start,length), right = occurrence(body,start,length);
        if (left.range.end.line - left.range.start.line < 2 || right.range.end.line - right.range.start.line < 2) continue;
        const key = body.values.slice(start,start + length).join(',');
        if (!matches.has(key)) matches.set(key,{ tokens:length,occurrences:new Map() });
        const group = matches.get(key);
        for (const item of [left,right]) group.occurrences.set(item.uri + '#' + item.start,item);
      }
      if (examined > MAX_CHECKS || compared >= MAX_COMPARE_TOKENS) break;
      if (bucket.length < MAX_CANDIDATES) bucket.push({ body,start });
      else truncated = true;
      windows.set(rolling,bucket);
    }
  }
  const ordered = [...matches.values()].map(match => ({
    tokens:match.tokens,occurrences:[...match.occurrences.values()].sort((a,b) => a.uri.localeCompare(b.uri) || a.start - b.start)
  })).sort((a,b) => b.tokens - a.tokens || b.occurrences.length - a.occurrences.length);
  const groups = [];
  for (const item of ordered) {
    if (groups.some(group => item.occurrences.every(span => group.occurrences.some(known =>
      known.uri === span.uri && known.start <= span.start && known.end >= span.end)))) continue;
    if (groups.length >= MAX_GROUPS) { truncated = true; break; }
    groups.push(item);
  }
  return { groups,truncated,examinedPairs:examined };
}

function span(left,a,right,b,maximum) {
  const depth = { '(':0,'{':0,'[':0 };
  const closes = { ')':'(','}':'{',']':'[' };
  let length = 0, completed = 0;
  while (length < maximum && a + length < left.values.length && b + length < right.values.length &&
      left.values[a + length] === right.values[b + length]) {
    const token = right.tokens[b + length];
    if (token.kind === 'symbol') {
      if (Object.hasOwn(depth,token.text)) depth[token.text]++;
      else if (Object.hasOwn(closes,token.text) && --depth[closes[token.text]] < 0) break;
    }
    length++;
    if (STATEMENT_END.has(token.text) && Object.values(depth).every(value => !value)) completed = length;
  }
  return { completed,compared:length + 1 };
}

function inspectSources(files,profile,{ duplicates = true,includeAnchors=false } = {}) {
  const findings = [], bodies = [], skipped = [];
  let tokenCount = 0, oversizedMethods = 0;
  for (const file of files) {
    const { tokens,issues } = lexJava(file.text), pairs = matching(tokens);
    if (issues.length || !pairs) { skipped.push({ uri:file.uri,reason:'Incomplete or unsupported Java lexical input' }); continue; }
    tokenCount += tokens.length;
    if (tokenCount > MAX_TOKENS) throw Error('Java inspection exceeds the token limit. Choose a narrower profile.');
    const range = positions(file.text);
    for (const finding of javaIssues(file,profile,tokens,pairs,range,includeAnchors)) findings.push(finding);
    if (duplicates) {
      const item = javaBodies(file,tokens,pairs,range);
      oversizedMethods += item.oversized;
      bodies.push(...item.bodies);
    }
  }
  const duplicatesResult = duplicates ? duplicateGroups(bodies,profile.duplicateMode,profile.minDuplicateTokens) :
    { groups:[],truncated:false,examinedPairs:0 };
  return {
    findings, duplicateGroups:duplicatesResult.groups, duplicateMode:profile.duplicateMode,
    duplicateSearchTruncated:duplicatesResult.truncated, examinedPairs:duplicatesResult.examinedPairs,
    oversizedMethods, readFiles:files.length, scannedFiles:files.length - skipped.length, skipped
  };
}

module.exports = { inspectSources };
