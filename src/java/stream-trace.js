'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { lexJava } = require('../spring/java');

const run = promisify(execFile);
const sources = new Map(Object.entries({
  List: { type: 'object', qualified: 'java.util.List', factories: ['of'] },
  Stream: { type: 'object', qualified: 'java.util.stream.Stream', factories: ['of', 'empty'] },
  IntStream: { type: 'int', qualified: 'java.util.stream.IntStream', factories: ['of', 'empty', 'range', 'rangeClosed'] },
  LongStream: { type: 'long', qualified: 'java.util.stream.LongStream', factories: ['of', 'empty', 'range', 'rangeClosed'] },
  DoubleStream: { type: 'double', qualified: 'java.util.stream.DoubleStream', factories: ['of', 'empty'] }
}));
const terminals = new Set(['toList', 'toArray', 'findFirst', 'findAny', 'count', 'sum', 'average', 'min', 'max',
  'anyMatch', 'allMatch', 'noneMatch']);
const predicates = new Set(['filter', 'takeWhile', 'dropWhile', 'anyMatch', 'allMatch', 'noneMatch']);
const boundaries = new Set(['distinct', 'sorted', 'limit', 'skip', 'boxed', 'asLongStream', 'asDoubleStream']);
const yields = new Map(Object.entries({ mapToInt: 'int', mapToLong: 'long', mapToDouble: 'double', mapToObj: 'object',
  flatMapToInt: 'int', flatMapToLong: 'long', flatMapToDouble: 'double', boxed: 'object', asLongStream: 'long', asDoubleStream: 'double' }));
const helper = { object: 'flatObject', int: 'flatInt', long: 'flatLong', double: 'flatDouble' };
const primitiveMap = { int: 'mapInt', long: 'mapLong', double: 'mapDouble' };
const simpleValues = new Set(['true', 'false', 'null']);
const shortCircuit = new Set(['findFirst', 'findAny', 'anyMatch', 'allMatch', 'noneMatch']);

function argumentsAt(tokens, opening) {
  let depth = 0;
  for (let index = opening; index < tokens.length; index++) {
    if (tokens[index].text === '(') depth++;
    if (tokens[index].text === ')' && --depth === 0) return tokens.slice(opening + 1, index);
  }
  throw Error('The selected stream expression has an incomplete call.');
}

function literalParts(tokens) {
  if (!tokens.length) return [];
  const parts = [[]];
  for (const token of tokens) {
    if (token.text === ',') parts.push([]);
    else parts.at(-1).push(token);
  }
  if (parts.length > 256 || parts.some(part => !part.length)) throw Error('Use up to 256 literal Java values.');
  return parts;
}

function readLiteral(part) {
  const [first] = part;
  if (part.length === 1 && (['number', 'string', 'char'].includes(first.kind) || simpleValues.has(first.text))) return first.text;
  const numeric = part.map(token => token.text).join('');
  if (part.length === 2 && ['+', '-'].includes(first.text) && part[1].kind === 'number') return numeric;
  if (/^[+-]?(?:\d[\d_]*(?:\.[\d_]*)?|\.[\d_]+)(?:[eE][+-]?\d[\d_]*)?[fFdDlL]?$/.test(numeric)) return numeric;
  throw Error('The stream source must contain literal Java values.');
}

function sourceSize(factory, parts) {
  if (factory === 'empty') {
    if (parts.length) throw Error('Use empty() without arguments.');
    return 0;
  }
  const literals = parts.map(readLiteral);
  if (!factory.startsWith('range')) return parts.length;
  if (literals.length !== 2 || literals.some(text => !/^[+-]?(?:0|[1-9](?:[\d_]*\d)?)[lL]?$/.test(text))) {
    throw Error('Use two decimal integer literals as range endpoints.');
  }
  const [start, end] = literals.map(text => BigInt(text.replaceAll('_', '').replace(/[lL]$/, '')));
  const count = end - start + (factory === 'rangeClosed' ? 1n : 0n);
  if (count > 100000n) throw Error('Trace a range of up to 100,000 source values.');
  return count <= 0n ? 0 : Number(count);
}

function lambdaArgument(stage, argument, source) {
  const wrapped = argument[0]?.text === '(';
  const parameter = argument[wrapped ? 1 : 0];
  const arrow = wrapped ? 3 : 1;
  if (parameter?.kind !== 'id' || wrapped && argument[2]?.text !== ')' || argument[arrow]?.text !== '-' ||
      argument[arrow + 1]?.text !== '>' || !argument[arrow + 2] || argument[arrow + 2].text === '{' ||
      argument.some(item => item.text === ';')) {
    throw Error('Use a one-parameter expression lambda for ' + stage.name + '.');
  }
  stage.parameter = parameter.text;
  stage.body = source.slice(argument[arrow + 2].start, argument.at(-1).end);
}

function streamPipeline(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64 * 1024) throw Error('Select a Java stream expression up to 64 KiB.');
  const { tokens, issues } = lexJava(source);
  if (issues.length || !tokens.length || tokens.length > 4000) throw Error('Choose a complete stream expression with supported source tokenization.');
  const opening = tokens.findIndex(token => token.text === '(');
  const qualifier = tokens.slice(0, Math.max(0, opening - 2)).map(item => item.text).join('');
  const typeName = qualifier.split('.').at(-1);
  const producer = sources.get(typeName), factory = tokens[opening - 1]?.text;
  if (opening < 3 || tokens[opening - 2]?.text !== '.' || !producer || !producer.factories.includes(factory) ||
      qualifier !== typeName && qualifier !== producer.qualified) {
    throw Error('Start with a supported JDK Stream, IntStream, LongStream, DoubleStream, or List.of source.');
  }
  const sourceArguments = argumentsAt(tokens, opening);
  const sourceCount = sourceSize(factory, literalParts(sourceArguments));
  const values = source.slice(tokens[opening].end, tokens[opening + sourceArguments.length + 1].start);
  const list = typeName === 'List';
  let cursor = opening + sourceArguments.length + 2;
  if (list) {
    if (tokens.slice(cursor, cursor + 4).map(item => item.text).join('') !== '.stream()') throw Error('Call stream() directly on the literal list.');
    cursor += 4;
  }
  let outputType = producer.type;
  const stages = [{ name: 'input', start: tokens[0].start, end: tokens[cursor - 1].end, outputType }];
  while (cursor < tokens.length && tokens[cursor].text !== ';') {
    const name = tokens[cursor + 1];
    if (tokens[cursor].text !== '.' || tokens[cursor + 2]?.text !== '(' || !name ||
        !terminals.has(name.text) && !predicates.has(name.text) && !boundaries.has(name.text) &&
        !yields.has(name.text) && !['map', 'flatMap'].includes(name.text)) {
      throw Error('Choose supported sequential operations such as filter, map, sorted, or a supported terminal operation.');
    }
    if (stages.length > 12) throw Error('Trace up to twelve stream operations.');
    const args = argumentsAt(tokens, cursor + 2);
    const closing = cursor + 3 + args.length;
    const stage = { name: name.text, start: name.start, end: tokens[closing].end, inputType: outputType,
      outputType: yields.get(name.text) ?? outputType };
    if (['limit', 'skip'].includes(stage.name)) {
      if (args.length !== 1 || !/^\d{1,7}[lL]?$/.test(args[0].text)) throw Error('Use a nonnegative integer literal with ' + stage.name + '().');
      stage[stage.name] = args[0].text;
    } else if (predicates.has(stage.name) || /^(?:flatMap|map)/.test(stage.name)) {
      lambdaArgument(stage, args, source);
    } else if (args.length) {
      throw Error('Use ' + stage.name + '() without arguments.');
    }
    stages.push(stage);
    cursor = closing + 1;
    if (terminals.has(stage.name)) break;
    outputType = stage.outputType;
  }
  if (tokens[cursor]?.text === ';') cursor++;
  if (cursor !== tokens.length || !terminals.has(stages.at(-1).name)) {
    throw Error('Select one complete stream pipeline ending with toList() or another supported terminal operation.');
  }
  return { list, origin: qualifier + '.' + factory, qualifier, qualified: producer.qualified, typeName, factory, values, stages, sourceCount };
}

function javaPipeline(pipeline) {
  const { qualified, factory, values, list } = pipeline;
  const lines = [qualified + '.' + factory + '(' + values + ')' + (list ? '.stream()' : ''),
    '.peek(value -> observe(0,"input",value,null))'];
  const atBoundary = (index, action) => '.peek(value -> observe(' + index + ',"' + action + '",value,null))';
  for (const [index, stage] of pipeline.stages.entries()) {
    if (index === 0) continue;
    const { name, parameter, body, outputType } = stage;
    if (predicates.has(name)) {
      const observation = name === 'filter' ? 'filterValue' : 'predicateValue';
      lines.push('.' + name + '(' + parameter + ' -> ' + observation + '(' + index + ',' + parameter + ',(' + body + ')))');
      if (name === 'takeWhile' || name === 'dropWhile') lines.push(atBoundary(index, 'emitted'));
    } else if (name.startsWith('flatMap') || name.startsWith('map')) {
      const observation = name.startsWith('flatMap') ? helper[outputType] : primitiveMap[outputType] ?? 'mapValue';
      lines.push('.' + name + '(' + parameter + ' -> ' + observation + '(' + index + ',' + parameter + ',(' + body + ')))');
    } else if (terminals.has(name)) {
      lines.push(atBoundary(index, 'result'), '.' + name + '()');
    } else {
      lines.push(atBoundary(index, 'candidate'), '.' + name + '(' + (stage[name] ?? '') + ')',
        atBoundary(index, name === 'limit' || name === 'skip' ? 'retained' : 'emitted'));
    }
  }
  return lines.join('\n    ');
}

function javaProgram(pipeline, marker) {
  const flatMaps = Object.entries(helper).map(([type, name]) => {
    const signature = {object: 'Stream<T>', int: 'IntStream', long: 'LongStream', double: 'DoubleStream'}[type];
    return `
  static ${type === 'object' ? '<T> ' : ''}${signature} ${name}(int stage,Object input,${signature} output) {
    observe(stage,"expanded",input,null);
    return output==null ? null : output.peek(value -> observe(stage,"flat value",input,value));
  }`;
  });
  const primitiveMaps = Object.entries(primitiveMap).map(([type, name]) => `
  static ${type} ${name}(int stage,Object input,${type} output) {
    observe(stage,"mapped",input,output);
    return output;
  }`);
  return `import java.util.List;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.OptionalLong;
import java.util.OptionalDouble;
import java.util.stream.*;
class Trace {
  static int emitted;
  static boolean clipped;
  static final int MAX_EVENTS=512;

  static String valueType(Object object) {
    return object == null ? null : object.getClass().getTypeName();
  }

  static String json(Object object) {
    if (object==null) return "null";
    String value;
    if (object instanceof String text) value=text;
    else if (object instanceof Integer || object instanceof Long || object instanceof Float ||
      object instanceof Double || object instanceof Byte || object instanceof Short ||
      object instanceof Boolean || object instanceof Character) value=object.toString();
    else value="<"+object.getClass().getTypeName()+">";
    StringBuilder safe=new StringBuilder();
    safe.append('"');
    for(int offset=0;offset<value.length()&&offset<180;offset++) {
      char c=value.charAt(offset);
      if(c=='"'||c==92) safe.append((char)92).append(c);
      else if(c<32||Character.isSurrogate(c)) safe.append((char)92).append('u').append(String.format("%04x",(int)c));
      else safe.append(c);
    }
    if(value.length()>180) safe.append("…");
    return safe.append('"').toString();
  }

  static void observe(int stage,String action,Object input,Object output) {
    if(emitted>=MAX_EVENTS){clipped=true;return;}
    emitted++;
    System.out.println("${marker}"+"["+stage+","+json(action)+","+json(input)+","+json(output)+","+
      json(valueType(input))+","+json(valueType(output))+"]");
  }

  static boolean filterValue(int stage,Object input,boolean predicate) {
    observe(stage,predicate?"accepted":"rejected",input,null);
    return predicate;
  }

  static boolean predicateValue(int stage,Object input,boolean predicate) {
    observe(stage,"predicate",input,predicate);
    return predicate;
  }

  static <T> T mapValue(int stage,Object input,T output) {
    observe(stage,"mapped",input,output);
    return output;
  }
${primitiveMaps.join('\n')}
${flatMaps.join('\n')}

  static void terminal(Object result) {
    String type=valueType(result), kind="scalar";
    Object value=result;
    if(result instanceof List<?> list) {kind="list";type="java.util.List";value=list.size();}
    else if(result != null && result.getClass().isArray()) {kind="array";value=java.lang.reflect.Array.getLength(result);}
    else if(result instanceof Optional<?> optional) {kind="optional";value=optional.orElse(null);}
    else if(result instanceof OptionalInt optional) {kind="optional";value=optional.isPresent()?optional.getAsInt():null;}
    else if(result instanceof OptionalLong optional) {kind="optional";value=optional.isPresent()?optional.getAsLong():null;}
    else if(result instanceof OptionalDouble optional) {kind="optional";value=optional.isPresent()?optional.getAsDouble():null;}
    System.out.println("${marker}"+"["+json(kind)+","+json(type)+","+json(value)+","+json(valueType(value))+"]");
  }

  public static void main(String[] args) {
    terminal(${javaPipeline(pipeline)});
    System.out.println("${marker}"+"["+clipped+"]");
  }
}
`;
}

function observations(stdout, marker, pipeline) {
  const records = stdout.split(/\r?\n/).filter(line => line.startsWith(marker))
    .map(line => JSON.parse(line.slice(marker.length)));
  const end = records.pop(), result = records.pop();
  const isNullableText = value => value === null || typeof value === 'string' && value.length <= 181;
  if (!Array.isArray(end) || end.length !== 1 || typeof end[0] !== 'boolean' ||
      !Array.isArray(result) || result.length !== 4 || !['optional', 'list', 'array', 'scalar'].includes(result[0]) ||
      !result.slice(1).every(isNullableText) || records.length > 512 || records.some(record => !Array.isArray(record) ||
      record.length !== 6 || !Number.isInteger(record[0]) || !pipeline.stages[record[0]] ||
      typeof record[1] !== 'string' || !record.slice(1).every(isNullableText))) {
    throw Error('The Java stream trace did not produce a complete observation.');
  }
  const [kind, type, value, valueType] = result;
  const name = pipeline.stages.at(-1).name;
  const inputEvents = records.filter(record => record[0] === 0).length;
  const evaluation = end[0] ? 'capture-limited'
    : name === 'count' && !records.length && /^\d+$/.test(value) && value !== '0' ? 'count-without-traversal'
    : shortCircuit.has(name) && inputEvents < pipeline.sourceCount ? 'short-circuited'
    : records.length ? 'observed' : 'no-events';
  return {
    stages: pipeline.stages.map(({ name, start, end, inputType, outputType }) => ({ name, start, end, inputType, outputType })),
    events: records.map(([stage, action, input, output, inputType, outputType], sequence) =>
      ({ sequence: sequence + 1, stage, action, input, output, inputType, outputType })),
    terminal: { name, kind, type, value, valueType },
    demand: { evaluation, sourceCount: pipeline.sourceCount, inputEvents },
    truncated: end[0]
  };
}

async function traceStream(source, executable, { signal, timeout = 10000 } = {}) {
  const pipeline = streamPipeline(source);
  if (!path.isAbsolute(executable)) throw Error('Choose a configured independent JDK.');
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'rocketbrain-stream-'));
  const file = path.join(dir, 'Trace.java');
  const marker = 'RB_STREAM_' + randomUUID().replaceAll('-', '') + ':';
  let created = false;
  try {
    await fs.writeFile(file, javaProgram(pipeline, marker), { flag: 'wx' });
    created = true;
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(?:_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/i.test(name)) delete env[name];
    }
    let stdout;
    try {
      ({ stdout } = await run(executable, ['-Xmx128m', '-Dfile.encoding=UTF-8', file],
        { cwd: dir, env, windowsHide: true, signal, timeout, maxBuffer: 1024 * 1024 }));
    } catch (error) {
      if (signal?.aborted) throw Error('The Java stream trace was cancelled.');
      if (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('The Java stream exceeded its execution or output limit.');
      throw Error('The selected pipeline did not compile or run independently. ' +
        String(error.stderr || '').replaceAll(file, 'Trace.java').trim().slice(0, 1200));
    }
    return observations(stdout, marker, pipeline);
  } finally {
    if (created) await fs.unlink(file);
    await fs.rmdir(dir);
  }
}

module.exports = { streamPipeline, traceStream };
