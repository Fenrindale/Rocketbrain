'use strict';

const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { lexJava } = require('../spring/java');

const run = promisify(execFile);
const kinds = new Set(['filter', 'map', 'flatMap', 'limit', 'toList']);
const literalKinds = new Set(['number', 'string', 'char']);
const simpleValues = new Set(['true', 'false', 'null']);

function streamPipeline(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 64 * 1024) throw Error('Select a Java stream expression up to 64 KiB.');
  const { tokens, issues } = lexJava(source);
  if (issues.length || !tokens.length || tokens.length > 4000) throw Error('Choose a complete stream expression with supported source tokenization.');
  const endOfCall = opening => {
    let depth = 0;
    for (let i = opening; i < tokens.length; i++) {
      if (tokens[i].text === '(') depth++;
      if (tokens[i].text === ')' && --depth === 0) return i;
    }
    throw Error('The selected stream expression has an incomplete call.');
  };
  const sourceOpening = tokens.findIndex(token => token.text === '(');
  const origin = tokens.slice(0,sourceOpening).map(item=>item.text).join('');
  const list = origin === 'List.of' || origin === 'java.util.List.of';
  if (sourceOpening < 0 || !list && !['Stream.of','java.util.stream.Stream.of'].includes(origin)) {
    throw Error('Start with Stream.of or List.of with literal values.');
  }
  const sourceClosing = endOfCall(sourceOpening);
  let count = 0, needValue = true;
  for (let i=sourceOpening+1;i<sourceClosing;i++) {
    const token=tokens[i];
    if (!needValue && token.text===',') {needValue=true;continue;}
    if (!needValue) throw Error('Use comma-separated literal stream values.');
    if (['+','-'].includes(token.text) && tokens[i+1]?.kind==='number') i++;
    else if (!literalKinds.has(token.kind) && !simpleValues.has(token.text)) throw Error('The stream source must contain literal Java values.');
    count++; needValue=false;
  }
  if (needValue || count>256) throw Error('Use between one and 256 literal stream values.');
  const values=source.slice(tokens[sourceOpening].end,tokens[sourceClosing].start);
  let i=sourceClosing+1;
  if (list) {
    if (tokens.slice(i,i+4).map(item=>item.text).join('')!=='.stream()') throw Error('Call stream() directly on the literal list.');
    i+=4;
  }
  const stages=[{ name:'input', start:tokens[0].start, end:tokens[i-1].end }];
  while (i<tokens.length && tokens[i].text!==';') {
    const name=tokens[i+1];
    if (tokens[i].text!=='.' || !kinds.has(name?.text) || tokens[i+2]?.text!=='(') {
      throw Error('Use filter, map, flatMap or limit followed by toList().');
    }
    if (stages.length>12) throw Error('Trace up to eleven stream operations.');
    const closing=endOfCall(i+2), argument=tokens.slice(i+3,closing);
    const stage={name:name.text,start:name.start,end:tokens[closing].end};
    if (stage.name==='toList') {
      if (argument.length) throw Error('Use the no-argument toList() terminal operation.');
      stages.push(stage); i=closing+1; break;
    }
    if (stage.name==='limit') {
      if (argument.length!==1 || !/^\d{1,7}[lL]?$/.test(argument[0].text)) throw Error('Use a nonnegative integer literal with limit().');
      stage.limit=argument[0].text;
    } else {
      const parameter=argument[0]?.text==='(' ? argument[1] : argument[0];
      const arrow=argument[0]?.text==='(' ? 3 : 1;
      if (parameter?.kind!=='id' || argument[0]?.text==='(' && argument[2]?.text!==')' ||
          argument[arrow]?.text!=='-' || argument[arrow+1]?.text!=='>' || !argument[arrow+2] ||
          argument[arrow+2].text==='{' || argument.some(item=>item.text===';')) {
        throw Error('Use a one-parameter expression lambda for '+stage.name+'.');
      }
      stage.parameter=parameter.text;
      stage.body=source.slice(argument[arrow+2].start,argument.at(-1).end);
    }
    stages.push(stage); i=closing+1;
  }
  if (tokens[i]?.text===';') i++;
  if (i!==tokens.length || stages.at(-1).name!=='toList') throw Error('Select one complete stream pipeline ending with toList().');
  return { list, origin, values, stages };
}

function javaProgram(pipeline, marker) {
  const lines=[pipeline.list ? 'List.of('+pipeline.values+').stream()' : 'Stream.of('+pipeline.values+')',
    '.peek(value -> observe(0,"input",value,null))'];
  for (const [index,stage] of pipeline.stages.entries()) {
    if (stage.name==='input') continue;
    if (stage.name==='toList') {
      lines.push('.peek(value -> observe('+index+',"result",value,null))','.toList()');
      continue;
    }
    if (stage.name==='limit') {
      lines.push('.peek(value -> observe('+index+',"candidate",value,null))', '.limit('+stage.limit+')',
        '.peek(value -> observe('+index+',"retained",value,null))');
      continue;
    }
    const helper = { filter:'filterValue', map:'mapValue', flatMap:'flatValue' }[stage.name];
    lines.push('.'+stage.name+'('+stage.parameter+' -> '+helper+'('+index+','+stage.parameter+',('+stage.body+')))');
  }
  return `import java.util.List;
import java.util.stream.Stream;
class Trace {
  static int emitted;
  static boolean clipped;
  static final int MAX_EVENTS=512;
  static String json(Object object) {
    if (object==null) return "null";
    String value;
    if (object instanceof String text) value=text;
    else if (object instanceof Integer || object instanceof Long || object instanceof Float ||
      object instanceof Double || object instanceof Byte || object instanceof Short || object instanceof Boolean || object instanceof Character) value=object.toString();
    else value="<"+object.getClass().getTypeName()+">";
    StringBuilder safe=new StringBuilder(); safe.append('"');
    for(int offset=0;offset<value.length()&&offset<180;offset++) {
      char c=value.charAt(offset);
      if(c=='"'||c==92) safe.append((char)92).append(c);
      else if(c<32||Character.isSurrogate(c)) safe.append((char)92).append('u').append(String.format("%04x",(int)c));
      else safe.append(c);
    }
    if(value.length()>180) safe.append("…");
    return safe.append('"').toString();
  }
  static void observe(int stage,String type,Object value,Object outcome) {
    if(emitted>=MAX_EVENTS){clipped=true;return;}
    emitted++;
    System.out.println("${marker}"+"["+stage+","+json(type)+","+json(value)+","+json(outcome)+"]");
  }
  static boolean filterValue(int stage,Object input,boolean predicate) {
    observe(stage,predicate?"accepted":"rejected",input,null); return predicate;
  }
  static <T> T mapValue(int stage,Object input,T output) {
    observe(stage,"mapped",input,output); return output;
  }
  static <T> Stream<T> flatValue(int stage,Object input,Stream<T> output) {
    observe(stage,"expanded",input,null);
    return output==null ? null : output.peek(value->observe(stage,"flat value",input,value));
  }
  public static void main(String[] args) {
    ${lines.join('\n    ')};
    System.out.println("${marker}"+"["+clipped+"]");
  }
}
`;
}

async function traceStream(source, executable, { signal, timeout = 10000 } = {}) {
  const pipeline=streamPipeline(source);
  if (!path.isAbsolute(executable)) throw Error('Choose a configured independent JDK.');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rocketbrain-stream-'));
  const file=path.join(dir,'Trace.java');
  const marker='RB_STREAM_'+randomUUID().replaceAll('-','')+':';
  let created=false;
  try {
    await fs.writeFile(file,javaProgram(pipeline,marker),{flag:'wx'}); created=true;
    const env={...process.env};
    for(const name of Object.keys(env)) if(/^(?:_JAVA_OPTIONS|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH)$/i.test(name)) delete env[name];
    let stdout;
    try {
      ({stdout}=await run(executable,['-Xmx128m','-Dfile.encoding=UTF-8',file],
        {cwd:dir,env,windowsHide:true,signal,timeout,maxBuffer:1024*1024}));
    } catch(error) {
      if(signal?.aborted) throw Error('The Java stream trace was cancelled.');
      if(error.killed||error.code==='ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw Error('The Java stream exceeded its execution or output limit.');
      throw Error('The selected pipeline did not compile or run independently. '+String(error.stderr||'').replaceAll(file,'Trace.java').trim().slice(0,1200));
    }
    const records=stdout.split(/\r?\n/).filter(line=>line.startsWith(marker)).map(line=>JSON.parse(line.slice(marker.length)));
    const end=records.pop();
    if (end?.length!==1 || typeof end[0]!=='boolean' || records.length>512 ||
        records.some(record=>record.length!==4 || !pipeline.stages[record[0]])) throw Error('The Java stream trace did not produce a complete observation.');
    return { stages:pipeline.stages.map(({name,start,end})=>({name,start,end})),
      events:records.map(([stage,action,input,output])=>({stage,action,input,output})),truncated:end[0] };
  } finally {
    if(created) await fs.unlink(file);
    await fs.rmdir(dir);
  }
}

module.exports = { streamPipeline, traceStream };
