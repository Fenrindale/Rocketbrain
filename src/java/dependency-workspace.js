'use strict';

const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { buildDescriptors, fileKey, below } = require('./dependency-builds');
const { analyzeDependencyGraph, parseJdeps } = require('./dependency-graph');
const { observeAttributedSources } = require('./dependency-attribution');

const SOURCE_LIMIT = 500;
const DESCRIPTOR_LIMIT = 100;
const EXCLUDE = '**/{.git,.idea,.metadata,.gradle,node_modules,target,build,out,bin,dist}/**';
const BUILDS = '**/{pom.xml,build.gradle,build.gradle.kts,settings.gradle,settings.gradle.kts}';
const MAX_TOOL_OUTPUT = 4 * 1024 * 1024;
const LOCAL_CLASS_LIMIT = 15000;
const reviews=new WeakMap();
const digest=value=>createHash('sha256').update(value).digest('hex');
const utf8=new TextDecoder('utf-8',{fatal:true});
const linkKey=({uri,range})=>JSON.stringify([uri,range?.start?.line,range?.start?.character,range?.end?.line,range?.end?.character]);

function localUri(uri) {
  return uri?.scheme === 'file' && !uri.authority && !uri.query && !uri.fragment && path.isAbsolute(uri.fsPath);
}

async function physical(file, kind) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || stat[kind]() === false || path.relative(file, await fs.realpath(file))) {
    throw Error('Use physical local project paths for dependency analysis.');
  }
  return stat;
}

function check(vscode, cancellation) {
  if (!vscode.workspace.isTrusted) throw Error('Trust the workspace before analyzing Java dependencies.');
  if (cancellation?.isCancellationRequested) throw Error('Java dependency analysis cancelled.');
}

function sourceSet(relative) {
  const match = /^src[\\/]([^\\/]+)[\\/]java(?:[\\/]|$)/.exec(relative);
  return match?.[1] || 'sources';
}

function builtSet(projectRoot, directory) {
  const local = path.relative(projectRoot, directory).split(path.sep);
  if (local[0] === 'build' && local[1] === 'classes' && local[2] === 'java' && local.length === 4) return local[3];
  if (local.join('/') === 'target/classes') return 'main';
  if (local.join('/') === 'target/test-classes') return 'test';
  if (local[0] === 'bin' && local.length === 2) return local[1];
  return null;
}

async function boundedDocuments(vscode, matcher, folders, limit, maxBytes, cancellation, scope) {
  const pattern=scope?new vscode.RelativePattern(scope,matcher):matcher;
  const uris = await vscode.workspace.findFiles(pattern, EXCLUDE, limit + 1, cancellation);
  const local = uris.filter(uri => localUri(uri) && folders.some(folder => below(folder.uri.fsPath, uri.fsPath)));
  if (uris.length > limit) throw Error('Java dependency analysis found more than ' + limit + ' matching workspace files.');
  const open = new Map(vscode.workspace.textDocuments.filter(document => document.isDirty && localUri(document.uri))
    .map(document => [fileKey(document.uri.fsPath), document]));
  const rows = [];
  let total = 0;
  for (const uri of local.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
    check(vscode, cancellation);
    try {
      const size = (await physical(uri.fsPath, 'isFile')).size;
      if (size > maxBytes) throw Error('A Java dependency input exceeds its ' + maxBytes + ' byte limit.');
      const buffer = await fs.readFile(uri.fsPath);
      if (buffer.length > maxBytes) throw Error('A Java dependency input grew beyond its byte limit.');
      if ((total += buffer.length) > 18 * 1024 * 1024) throw Error('Java dependency source inputs exceed 18 MiB.');
      let text,invalidUtf8=false;
      try { text=utf8.decode(buffer); }
      catch { text=buffer.toString('utf8').replace(/^\uFEFF/,'');invalidUtf8=true; }
      rows.push({path:uri.fsPath,uri:uri.toString(),text,dirty:open.has(fileKey(uri.fsPath)),invalidUtf8,
        ...(scope&&{hash:digest(buffer)})});
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return rows;
}

function composeProjects(folders, declared, imported) {
  const directories = new Map();
  for (const folder of folders) {
    const root = fileKey(folder.uri.fsPath);
    directories.set(root, { root, id: root, label: folder.name, uri: folder.uri.toString(), buildTools: [] });
  }
  for (const descriptor of declared) {
    const previous = directories.get(descriptor.root);
    directories.set(descriptor.root, { id: descriptor.root, label: previous?.label || path.basename(descriptor.root), ...descriptor });
  }
  for (const project of imported) {
    const root = fileKey(project.root);
    if (!folders.some(folder => below(folder.uri.fsPath, root))) continue;
    const previous = directories.get(root);
    if (previous) {
      previous.imported = project;
    } else {
      directories.set(root, { id: root, root, label: project.name, uri: project.uri, buildTools: [], imported: project });
    }
  }
  return [...directories.values()].sort((a, b) => b.root.length - a.root.length || a.root.localeCompare(b.root));
}

function assignFiles(files, projects, {packet=false}={}) {
  return files.flatMap(file => {
    const project = projects.find(project => below(project.root, file.path));
    if (!project) return [];
    const relative = path.relative(project.root, file.path);
    const observed = project.imported?.sourceRoots?.filter(source => !source.unavailable && below(source.path, file.path))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const chosen=packet
      ? observed?.generated?'generated':(['main','test'].includes(observed?.scope)?observed.scope:sourceSet(relative))
      : sourceSet(observed ? path.relative(project.root, observed.path) : relative);
    return [{ ...file, projectId: project.id, projectLabel: project.label, sourceSet: chosen }];
  });
}

async function jdepsExecutable(javaHome) {
  if (typeof javaHome !== 'string' || !path.isAbsolute(javaHome) || /^\\\\/.test(javaHome)) {
    throw Error('Configure a local independent JDK to inspect compiled dependencies.');
  }
  const home = await fs.realpath(javaHome);
  const release = path.join(home, 'release');
  const stat = await physical(release, 'isFile');
  if (stat.size > 65536) throw Error('Use a recognized JDK installation with a bounded release descriptor.');
  if (/JetBrains|JBR/i.test(await fs.readFile(release, 'utf8'))) throw Error('Use an independent full JDK for compiled dependencies.');
  const executable = path.join(home, 'bin', process.platform === 'win32' ? 'jdeps.exe' : 'jdeps');
  await physical(executable, 'isFile');
  return executable;
}

async function validateOutput(directory, count, cancellation) {
  try { await physical(directory, 'isDirectory'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  let ownsClasses = false;
  const pending = [directory];
  while (pending.length) {
    const next = pending.pop();
    if (cancellation?.isCancellationRequested) throw Error('Java dependency analysis cancelled.');
    const entries = await fs.readdir(next, { withFileTypes: true });
    for (const item of entries) {
      if (++count.entries > LOCAL_CLASS_LIMIT) throw Error('Java class output inventory exceeds its entry limit.');
      const file = path.join(next, item.name);
      if (item.isSymbolicLink()) throw Error('Linked compiled output contents are outside Java dependency inspection.');
      if (item.isDirectory()) pending.push(file);
      if (item.isFile() && item.name.endsWith('.class')) {
        ownsClasses = true;
        if ((count.bytes += (await fs.stat(file)).size) > 128 * 1024 * 1024) {
          throw Error('Java class output exceeds 128 MiB.');
        }
      }
    }
  }
  return ownsClasses;
}

async function compiledOutputs(projects, cancellation) {
  const output = new Map(), count = { entries: 0, bytes: 0 };
  const availableSlots = new Set();
  for (const project of projects) {
    const observed = (project.imported?.libraries || []).filter(item =>
      item.kind === 'classpath' && typeof item.path === 'string' && below(project.root, item.path))
      .map(item => item.path);
    const candidates = [
      ...observed.map(directory => ({ directory, observed: true })),
      ...['build/classes/java/main', 'build/classes/java/test', 'target/classes', 'target/test-classes', 'bin/main', 'bin/test', 'bin']
        .map(name => ({ directory: path.join(project.root, name), observed: false }))
    ];
    for (const candidate of candidates) {
      const { directory } = candidate;
      const set = builtSet(project.root, directory);
      if (!set && !candidate.observed && path.relative(directory, path.join(project.root, 'bin'))) continue;
      if (path.extname(directory).toLowerCase() === '.jar' || output.has(fileKey(directory)) ||
          projects.find(candidate => below(candidate.root, directory)) !== project) continue;
      if (directory.includes(path.delimiter)) continue;
      const slot = set && JSON.stringify([project.id, set]);
      if (slot && availableSlots.has(slot)) continue;
      if (!await validateOutput(directory, count, cancellation)) continue;
      if (slot) availableSlots.add(slot);
      const named = await fs.stat(path.join(directory, 'module-info.class')).then(info => info.isFile(), error => {
        if (error.code !== 'ENOENT') throw error;
        return false;
      });
      output.set(fileKey(directory), { directory, projectId: project.id, sourceSet: set, named });
      if (output.size > 32) throw Error('Select a workspace with at most 32 compiled Java output directories.');
    }
  }
  // An observed parent output may contain conventional main/test descendants.
  // Analyze the specific roots so the same class is never counted twice.
  return [...output.values()].filter(item => ![...output.values()].some(other =>
    item !== other && below(item.directory, other.directory)));
}

function runJdeps(executable, input, paths, cancellation, timeout) {
  const args = ['-J-Xmx512m', '-J-Duser.language=en', '-J-Duser.country=US', '-J-Dfile.encoding=UTF-8',
    '-J-Dstdout.encoding=UTF-8', '--ignore-missing-deps', '--no-recursive', '-verbose:class',
    '-filter:none'];
  if (paths.classpath) args.push('--class-path', paths.classpath);
  if (input.named) args.push('--module-path', paths.modulepath);
  args.push(input.directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !['JAVA_TOOL_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH'].includes(name.toUpperCase())));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: input.directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0, interruption;
    const stop = message => {
      interruption ||= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop('Compiled Java dependency analysis timed out.'), timeout);
    const sub = cancellation?.onCancellationRequested?.(() => stop('Java dependency analysis cancelled.'));
    if (cancellation?.isCancellationRequested) stop('Java dependency analysis cancelled.');
    const finish = () => { clearTimeout(timer); sub?.dispose(); };
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_TOOL_OUTPUT) stop('Compiled Java dependency output exceeds its limit.');
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', error => { finish(); reject(error); });
    child.once('close', exitCode => {
      finish();
      if (interruption) reject(interruption);
      else if (exitCode !== 0) reject(Object.assign(Error('The independent JDK could not resolve one compiled Java output.'), { outputUnavailable: true }));
      else resolve(parseJdeps(Buffer.concat(chunks).toString('utf8')));
    });
  });
}

async function observeBytecode(projects, javaHome, cancellation) {
  const executable = await jdepsExecutable(javaHome);
  const outputs = await compiledOutputs(projects, cancellation);
  if (!outputs.length) throw Error('Build the selected Java project to inspect compiled package references.');
  const paths = {
    classpath: outputs.filter(output => !output.named).map(output => output.directory).join(path.delimiter),
    modulepath: outputs.filter(output => output.named).map(output => output.directory).join(path.delimiter)
  };
  if (Buffer.byteLength(paths.classpath + paths.modulepath) > 12000) throw Error('Compiled package classpaths exceed the documented workspace size limit.');
  const bytecode = [], inspected = [], issues = [];
  const deadline = Date.now() + 45000;
  for (const input of outputs) {
    if (cancellation?.isCancellationRequested) throw Error('Java dependency analysis cancelled.');
    const timeout = Math.min(15000, deadline - Date.now());
    if (timeout <= 0) throw Error('Compiled Java dependency analysis timed out.');
    const uri = pathToFileURL(input.directory).href;
    try {
      const pairs = await runJdeps(executable, input, paths, cancellation, timeout);
      bytecode.push(...pairs.map(pair => ({ ...pair, projectId: input.projectId, sourceSet: input.sourceSet })));
      inspected.push({ ...input, uri });
    } catch (error) {
      if (!error.outputUnavailable) throw error;
      issues.push({ uri, directory: true, message: input.named ?
        'A compiled named module could not be resolved with the local module outputs. Its source requires directives remain visible.' :
        'The independent JDK could not resolve a compiled Java output.' });
    }
    if (bytecode.length > 40000) throw Error('Compiled Java dependency incidence count exceeds its limit.');
  }
  return { bytecode, outputs: inspected, issues };
}

async function scanInputs(vscode,folders,cancellation,scope) {
  return Promise.all([
    boundedDocuments(vscode,BUILDS,folders,DESCRIPTOR_LIMIT,256*1024,cancellation,scope),
    boundedDocuments(vscode,'**/*.java',folders,SOURCE_LIMIT,512*1024,cancellation,scope)
  ]);
}

const importedIn=(java,scope)=>(java.workbench?.getSnapshot().projects||[])
  .filter(project=>!scope||below(scope.fsPath,project.root));
const importedFingerprint=projects=>digest(JSON.stringify(projects.map(({id,libraries,sourceRoots})=>
  [id,(libraries||[]).map(({kind,path,projectDependency})=>[kind,path,projectDependency]),
    (sourceRoots||[]).map(({path,scope,generated})=>[path,scope,generated])]).sort((a,b)=>a[0].localeCompare(b[0]))));
const javaHomeOf=(vscode,java)=>java.getState().javaHome||vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome');

async function attributionScope(vscode,requested,folders) {
  const scope=typeof requested==='string'?vscode.Uri.parse(requested,true):requested|| (folders.length===1?folders[0].uri:null);
  if(!localUri(scope)||!folders.some(folder=>below(folder.uri.fsPath,scope.fsPath))) {
    throw Error('Choose one physical project directory inside the open Java workspace.');
  }
  await physical(scope.fsPath,'isDirectory');
  return scope;
}

function dependencyLinks(report) {
  const links=new Map();
  const add=link=>{if(link?.uri)links.set(linkKey(link),structuredClone(link));};
  for(const layer of report.layers) {
    for(const node of layer.nodes)if(!node.external)add(node);
    for(const edge of layer.edges) {
      for(const evidence of edge.evidence){add(evidence);add(evidence.target);}
      for(const declaration of edge.buildDeclarations||[])add(declaration);
    }
  }
  for(const note of report.issues)if(!note.directory)add(note);
  return links;
}

async function verifyDependencyLink(vscode,java,report,reference,cancellation) {
  check(vscode,cancellation);
  const review=reviews.get(report),link=review?.links.get(linkKey(reference||{}));
  if(!link)throw Error('Choose a source link from the current scoped Java dependency report.');
  if(!vscode.workspace.getWorkspaceFolder(review.scope)||javaHomeOf(vscode,java)!==review.javaHome||
      importedFingerprint(importedIn(java,review.scope))!==review.imported) {
    throw Error('The reviewed Java dependency scope or compiler inputs changed. Inspect dependencies again.');
  }
  const inputs=(await scanInputs(vscode,[{uri:review.scope}],cancellation,review.scope)).flat();
  if(inputs.length!==review.inputs.size||inputs.some(row=>row.dirty||review.inputs.get(row.uri)!==row.hash)) {
    throw Error('A reviewed Java source or build descriptor changed. Inspect dependencies again.');
  }
  check(vscode,cancellation);
  review.compiler?.validateClasspath();
  return {reference:link,hash:review.inputs.get(link.uri)};
}

async function workspaceDependencyGraph(vscode, java, { includeCompiled = false, attributeSources=false, scopeUri, storagePath, cancellation } = {}) {
  check(vscode, cancellation);
  let folders = (vscode.workspace.workspaceFolders || []).filter(folder => localUri(folder.uri));
  if (!folders.length) throw Error('Open a local Java workspace to view dependencies.');
  const scope=attributeSources?await attributionScope(vscode,scopeUri,folders):null;
  if(scope)folders=[{uri:scope,name:path.basename(scope.fsPath)}];
  const [descriptors,sourceFiles]=await scanInputs(vscode,folders,cancellation,scope);
  const cleanFiles = sourceFiles.filter(file => !file.dirty);
  const build = buildDescriptors(descriptors.filter(file => !file.dirty));
  const imported=importedIn(java,scope);
  const projects = composeProjects(folders, build.descriptors, imported);
  const files = assignFiles(cleanFiles, projects);
  const buildEdges = build.links.map(({ fromRoot: from, toRoot: to, ...evidence }) => ({ from, to, evidence }));
  const issues = [...build.issues, ...[...descriptors, ...sourceFiles].filter(file => file.dirty)
    .map(file => ({ uri: file.uri, message: 'Save this edited source or descriptor to include it in the dependency graph.' }))];
  const observed = includeCompiled ? await observeBytecode(projects,
    java.getState().javaHome || vscode.workspace.getConfiguration('rocketbrain.java').get('javaHome'), cancellation)
    : { bytecode: [], outputs: [] };
  check(vscode, cancellation);
  const report = analyzeDependencyGraph({ files, projects, buildEdges, bytecode: observed.bytecode, issues: [...issues, ...(observed.issues || [])] });
  const result={...report,compiledOutputs:observed.outputs,observedProjects:imported.length,includeCompiled};
  if(scope) {
    const javaHome=javaHomeOf(vscode,java), packet=assignFiles(sourceFiles,projects,{packet:true});
    const unresolvedBuild=descriptors.some(file=>file.dirty||file.invalidUtf8);
    const attribution=unresolvedBuild?{
      summary:{state:'unsaved-descriptor',sourceFiles:0,archiveCount:0,buildExecuted:false},layers:[],
      notes:[{message:'Save the build descriptors as valid UTF-8 before comparing their dependency edges.'}]
    }:await observeAttributedSources({files:packet,projects,buildEdges,javaHome,storagePath,cancellation});
    result.attribution=attribution.summary;
    result.layers.push(...attribution.layers);
    result.issues.push(...attribution.notes);
    reviews.set(result,{scope,javaHome,compiler:attribution.compiler,imported:importedFingerprint(imported),
      inputs:new Map([...descriptors,...sourceFiles].map(file=>[file.uri,file.hash])),links:dependencyLinks(result)});
  }
  return result;
}

module.exports = {workspaceDependencyGraph,verifyDependencyLink,observeBytecode,compiledOutputs,localUri,check};
