'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const M = require('./workbench-model');
const { independentJavaExecutable } = require('./debug-runtime');
const { execute } = require('./testing/provision');
const { describeSourceLayout } = require('./workbench-source-layout');
const worker = require('./javafx-class-inspector-source.json');

const binary = /^(?:[A-Za-z_][\w]*\/)*[A-Za-z_][\w]*$/u;
const jars = /^javafx-(base|graphics|controls|media|web|fxml)-\d[\w.-]*\.jar$/iu;
const sourceSettings = 'org.eclipse.jdt.ls.core.sourcePaths';
const outputSettings = 'org.eclipse.jdt.ls.core.outputPath';
const entrySettings = 'org.eclipse.jdt.ls.core.classpathEntries';

function physical(value, limit, directory = false) {
  try {
    const file = M.local(value);
    if (/^(?:\\\\|\/\/)/u.test(file) || path.relative(file, fs.realpathSync(file))) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > limit)) return;
    return { file, size:stat.size, time:stat.mtimeMs, change:stat.ctimeMs, inode:stat.ino };
  } catch { return; }
}

async function fxmlComponent({ filename, workspace, request, cancellation }) {
  const file = physical(filename, 1024 * 1024);
  if (!file || !M.inside(workspace,file.file)) return;
  const observed = await request('java.project.getAll',[],cancellation);
  if (!Array.isArray(observed) || observed.length > M.LIMITS.projects || M.cancelled(cancellation)) return;
  const root = observed.map(item=>physical(item,0,true)).filter(item=>item &&
    M.inside(workspace,item.file) && M.inside(item.file,file.file)).map(item=>item.file)
    .sort((a,b)=>b.length-a.length)[0];
  if (!root) return;
  const components = path.relative(root,file.file).split(path.sep);
  if (components[0]!=='src' || !['main','test'].includes(components[1]) || components[2]!=='resources') return;
  const uri = pathToFileURL(root).href, scope = components[1]==='test'?'test':'runtime';
  const packet = await request('java.project.getClasspaths',[uri,{scope}],cancellation);
  const packetRoot = physical(packet?.projectRoot,0,true);
  if (!Array.isArray(packet?.classpaths) || !Array.isArray(packet?.modulepaths) ||
      !packetRoot || path.relative(packetRoot.file,root)) return;
  const classpaths = [...new Set([...packet.classpaths,...packet.modulepaths])];
  if (classpaths.length > M.LIMITS.libraries || M.cancelled(cancellation)) return;
  const modules = [];
  for (const entry of classpaths) {
    const jar = physical(entry,128*1024*1024);
    const family = jar && jars.exec(path.basename(jar.file))?.[1].toLowerCase();
    if (family) modules.push({ ...jar, kind:'jar', name:'javafx.'+family });
  }
  if (!modules.some(item=>item.name==='javafx.graphics') || modules.length>18 ||
      modules.reduce((total,jar)=>total+jar.size,0)>256*1024*1024) return;
  const settings = await request('java.project.getSettings',[uri,[sourceSettings,outputSettings,entrySettings]],cancellation);
  if (M.cancelled(cancellation)) return;
  const project = { root, sourceRoots:[] };
  const sourceRoots = settings?.[sourceSettings];
  if (Array.isArray(sourceRoots) && sourceRoots.length <= M.LIMITS.sourceRoots) {
    for (const item of sourceRoots) {
      const source = physical(item,0,true);
      if (!source || !M.inside(root,source.file) || !path.relative(root,source.file)) continue;
      const scopeDir = path.relative(root,source.file).split(path.sep).slice(0,2).join('/');
      if (scopeDir !== 'src/main' && !(scope==='test'&&scopeDir==='src/test')) continue;
      project.sourceRoots.push({id:source.file,path:source.file});
    }
  }
  describeSourceLayout(project,settings?.[entrySettings],settings?.[outputSettings]);
  const defaultOutput = project.outputRoots.find(item=>item.default&&item.exists)?.path;
  const outputs = new Map();
  for (const source of project.sourceRoots) {
    const output = physical(source.outputPath || defaultOutput,0,true);
    if (!output || !M.inside(root,output.file) || !path.relative(root,output.file) ||
        fs.existsSync(path.join(output.file,'module-info.class')) || fs.existsSync(path.join(source.path,'module-info.java'))) continue;
    if (!outputs.has(output.file)) outputs.set(output.file,[]);
    outputs.get(output.file).push(source.path);
  }
  return { root, scope, modules, outputs };
}

function customClasses(outputs, dirty) {
  const classes = [];
  let entries = 0, bytes = 0;
  function walk(root,sources,directory,depth) {
    if (depth>20) throw Error('The FXML Java output is too deeply nested.');
    const handle = fs.opendirSync(directory);
    try {
      for (let entry; (entry=handle.readSync())!==null;) {
        if (++entries>2200) throw Error('The FXML Java output has too many entries.');
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory,entry.name);
        if (entry.isDirectory() && /^[A-Za-z_][\w]*$/u.test(entry.name)) {
          walk(root,sources,file,depth+1);
        } else if (entry.isFile() && /^[A-Z_][\w]*\.class$/u.test(entry.name)) {
          const name = path.relative(root,file).slice(0,-6).split(path.sep).join('/');
          const observed = physical(file,512*1024);
          if (!observed || name.startsWith('javafx/') || !binary.test(name) || !name.includes('/')) continue;
          const matches = sources.map(source=>physical(path.join(source,name+'.java'),512*1024))
            .filter(source=>source && M.inside(root,observed.file) && !dirty(source.file));
          if (matches.length!==1 || matches[0].time>observed.time || M.packageName(fs.readFileSync(matches[0].file,'utf8'),'java')!==
              name.split('/').slice(0,-1).join('.')) continue;
          if (classes.length>=480 || (bytes+=observed.size)>24*1024*1024) throw Error('FXML Java class inspection exceeds its bound.');
          classes.push({ ...observed, kind:'class', name, source:matches[0] });
        }
      }
    } finally {handle.closeSync();}
  }
  for (const [directory,sources] of outputs) walk(directory,sources,directory,0);
  return classes;
}

function inputsOf(component, dirty) {
  return [...component.modules,...customClasses(component.outputs,dirty)]
    .sort((left,right)=>left.file.localeCompare(right.file));
}

function classify(output, inputs) {
  const classes = new Map(), duplicate = new Set();
  for (const row of output.split(/\r?\n/u).filter(Boolean)) {
    const [kind,...fields] = row.split('\t');
    if (kind==='class' && fields.length===6) {
      const [index,name,parent,visible,constructor,source] = fields, input = inputs[Number(index)];
      if (!/^\d{1,3}$/u.test(index) || !input || !binary.test(name) || parent && !binary.test(parent) ||
          ![visible,constructor].every(value=>['true','false'].includes(value)) ||
          (input.kind==='class'&&input.name!==name)) {
        throw Error('Unexpected FXML class inspection result.');
      }
      if (classes.has(name)) duplicate.add(name);
      classes.set(name,{name,parent,visible:visible==='true'&&
        (input.kind!=='class'||path.basename(input.source.file)===source),constructor:constructor==='true',origin:input.kind,
        methods:new Map()});
    } else if (kind==='member' && fields.length===3) {
      const [name,method,type] = fields, target = classes.get(name);
      if (!target || !/^(?:set|get|is)[A-Z][\w]{0,100}$/u.test(method) || !/^(?:[ZBCSIJFD]|L[\w/$]+;)$/u.test(type)) {
        throw Error('Unexpected FXML member inspection result.');
      }
      if (!target.visible) continue;
      if (!target.methods.has(method)) target.methods.set(method,new Set());
      target.methods.get(method).add(type);
    } else throw Error('Unexpected FXML class inspection row.');
  }
  for (const name of duplicate) classes.delete(name);
  return classes;
}

async function inspectClasses(inputs, javaHome, cancellation) {
  const java = independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const parent = await fsp.realpath(os.tmpdir()), directory = await fsp.mkdtemp(path.join(parent,'rb-fxml-classes-'));
  const identity = await fsp.lstat(directory,{bigint:true});
  try {
    const program=path.join(directory,'FxmlClassInspector.java'), list=path.join(directory,'inputs.txt');
    await fsp.writeFile(program,worker,{flag:'wx'});
    await fsp.writeFile(list,inputs.map(input=>[input.kind,Buffer.from(input.file).toString('base64'),input.name].join('\t')).join('\n'),
      {flag:'wx'});
    const env = {...process.env};
    for (const key of Object.keys(env)) if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH)$/iu.test(key)) delete env[key];
    const run = await execute(java,['-Duser.home='+directory,'-Djava.io.tmpdir='+directory,'-Xmx128m',program,list],
      {cwd:directory,env,timeoutMs:24000,maxOutputBytes:4*1024*1024,cancellation});
    if (run.code!==0 || run.cancelled || run.timedOut) throw Error('The FXML class inspection did not complete.');
    return classify(run.output,inputs);
  } finally {
    const actual=await fsp.realpath(directory), observed=await fsp.lstat(actual,{bigint:true});
    if (path.relative(directory,actual) || path.relative(parent,path.dirname(actual)) ||
        !path.basename(actual).startsWith('rb-fxml-classes-') || identity.dev!==observed.dev || identity.ino!==observed.ino) {
      throw Error('FXML class inspection storage changed ownership.');
    }
    await fsp.rm(actual,{recursive:true,force:true,maxRetries:5,retryDelay:150});
  }
}

module.exports = { fxmlComponent, inputsOf, inspectClasses };
