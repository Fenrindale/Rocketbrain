'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {fileURLToPath} = require('node:url');
const {lexJava} = require('../spring/java');
const {validIdentifier} = require('./file-templates');
const {inside} = require('./testing-projects');
const {resolveMoveProject} = require('./move');
const {reviewClosedModule} = require('./package-module');
const {key} = require('./move-scope');
const {snapshotClasspath} = require('./signature-compiler');

const main = path.join('src','main','java');
const descriptor = path.join(main,'module-info.java');
const outputPaths = ['bin','bin/main','target/classes','build/classes/java/main'];
const models = ['.project','.classpath','.settings/org.eclipse.jdt.core.prefs','pom.xml',
  'build.gradle','build.gradle.kts','settings.gradle','settings.gradle.kts','gradle.properties','gradle/libs.versions.toml'];
const observationError = () => Error('Qualified Package Rename requires exactly two imported closed Java modules with only their reviewed project outputs.');
const command = (send,name,args,token) => send('workspace/executeCommand',{command:name,arguments:args},token);

function readDescriptor(file) {
  const stat = fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || key(fs.realpathSync(file)) !== key(file)) throw observationError();
  return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file));
}

function moduleName(text) {
  const {tokens,issues} = lexJava(text);
  const module = tokens[0]?.text === 'open' ? 1 : 0;
  const last = tokens.findIndex(token => token.text === '{');
  const name = tokens.slice(module+1,last).map(token => token.text).join('');
  return !issues.length && tokens[module]?.text === 'module' && last>module+1 &&
    name.split('.').every(validIdentifier) ? name : undefined;
}

function qualifiedTargets(text) {
  const {tokens} = lexJava(text);
  const names = new Set();
  for (const [index,token] of tokens.entries()) {
    if (token.text !== 'to' || tokens[index-1]?.kind !== 'id' || tokens[index+1]?.kind !== 'id') continue;
    let end=index+2;
    while (tokens[end]?.text === '.' && tokens[end+1]?.kind === 'id') end+=2;
    names.add(tokens.slice(index+1,end).map(part => part.text).join(''));
    if (tokens[end]?.text !== ';') throw observationError();
  }
  return names;
}

async function qualifiedPackageScope(vscode,send,sourceUri,token) {
  const source = await resolveMoveProject(send,vscode,sourceUri,token,'test');
  const text = readDescriptor(path.join(source.root,descriptor));
  const names = text ? qualifiedTargets(text) : new Set();
  if (!names.size) return undefined;
  if (names.size !== 1) throw observationError();
  const [wantedPeer] = names;
  const rootUri = vscode.workspace.getWorkspaceFolder(sourceUri)?.uri;
  if (!rootUri) throw observationError();
  const root = fs.realpathSync(rootUri.fsPath);
  const all = await command(send,'java.project.getAll',[],token);
  if (!Array.isArray(all) || all.length<2 || all.length>30) throw observationError();
  const seen = all.map(value => {
    if (typeof value !== 'string') throw observationError();
    const uri = vscode.Uri.parse(value);
    if (uri.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
        key(fs.realpathSync(uri.fsPath)) !== key(uri.fsPath)) throw observationError();
    return uri.fsPath;
  });
  const targets = seen.filter(file => key(file)!==key(source.root) && inside(root,file)).filter(file => {
    const text = readDescriptor(path.join(file,descriptor));
    return text && moduleName(text) === wantedPeer;
  });
  const [other] = targets;
  if (targets.length!==1 || !seen.some(file => key(file)===key(source.root)) || inside(source.root,other) || inside(other,source.root)) {
    throw observationError();
  }
  const peerUri = vscode.Uri.file(path.join(other,descriptor));
  const peerContents = readDescriptor(peerUri.fsPath);
  if (!peerContents) throw observationError();
  const peer = await resolveMoveProject(send,vscode,peerUri,token,'test');
  if (key(peer.root) !== key(other)) throw observationError();
  source.name = moduleName(text);
  peer.name = moduleName(peerContents);
  if (!source.name || peer.name !== wantedPeer || source.name === peer.name) throw observationError();
  const projects = [source,peer];
  for (const project of projects) {
    if (project.sourceRoots.length !== 1 || key(project.sourceRoot) !== key(path.join(project.root,main))) throw observationError();
    const cp = await command(send,'java.project.getClasspaths',[vscode.Uri.file(project.root).toString(),{scope:'test'}],token);
    if (!Array.isArray(cp?.classpaths) || cp.classpaths.length || !Array.isArray(cp.modulepaths) ||
        cp.modulepaths.length !== (project === source ? 1 : 2) ||
        cp.modulepaths.some(dir => typeof dir !== 'string' || !path.isAbsolute(dir))) throw observationError();
    const paths = cp.modulepaths.map(file => {
      const info = fs.lstatSync(file,{throwIfNoEntry:false});
      if (!info?.isDirectory() || info.isSymbolicLink() || key(fs.realpathSync(file)) !== key(file)) throw observationError();
      return file;
    });
    const outputs = new Set(outputPaths.map(relative => key(path.join(project.root,relative))));
    project.output = paths.find(file => outputs.has(key(file)));
    project.modulepaths = paths;
    if (!project.output || !fs.lstatSync(path.join(project.output,'module-info.class'),{throwIfNoEntry:false})?.isFile() ||
        paths.some(file => file !== project.output && (project === source || key(file) !== key(source.output)))) throw observationError();
  }
  if (new Set(peer.modulepaths.map(key)).size !== 2) throw observationError();
  const outsiders = [];
  for (const folder of seen.filter(file => !projects.some(project => key(file)===key(project.root)))) {
    const cp = await command(send,'java.project.getClasspaths',[vscode.Uri.file(folder).toString(),{scope:'test'}],token);
    if (!Array.isArray(cp?.classpaths) || !Array.isArray(cp.modulepaths)) throw observationError();
    const paths = [...cp.classpaths,...cp.modulepaths];
    if (paths.length>500 || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file) ||
        process.platform==='win32' && !/^[A-Za-z]:[\\/]/u.test(file))) throw observationError();
    if (paths.some(file => projects.some(project => inside(project.root,file) ||
        fs.existsSync(file) && inside(project.root,fs.realpathSync(file))))) {
      throw Error('An additional imported Java project depends on the reviewed named modules.');
    }
    outsiders.push({folder,classpaths:cp.classpaths,modulepaths:cp.modulepaths});
  }

  const readBuildFiles = () => [...new Set([...projects.map(project => project.root),root]
    .flatMap(folder => models.map(relative => path.join(folder,relative))))].filter(file => {
      const stat=fs.lstatSync(file,{throwIfNoEntry:false});
      if (!stat) return false;
      if (!stat.isFile() || stat.isSymbolicLink() || key(fs.realpathSync(file))!==key(file)) throw observationError();
      return true;
    });
  const buildFiles = readBuildFiles(), modelMembership = JSON.stringify(buildFiles);
  function checkBuildFiles() {
    if (JSON.stringify(readBuildFiles())!==modelMembership) throw Error('The reviewed named module build file set changed.');
  }
  return {source,peer,projects,namedPackageModule:true,qualifiedPackageModules:true,buildFiles,classpathIdentity:[],checkBuildFiles,
    includeClassRegistrations:true,metadata:JSON.stringify({outsiders,projects:projects.map(project => ({
      root:project.root,name:project.name,sourceRoot:project.sourceRoot,modulepaths:project.modulepaths
    }))})};
}

function bindQualifiedPackageScope(scope,sources,javaHome,oldPackage,newPackage) {
  const {source,peer} = scope;
  const picks = scope.projects.map(project => reviewClosedModule(project.root,
    sources.filter(file => inside(project.root,file.file)),
    {allowVisibility:true,qualifiedPeer:project === source ? peer.name : source.name,requirePeer:project === peer}));
  const [provider,client] = picks;
  if (provider?.name !== source.name || client?.name !== peer.name ||
      !provider.qualified.some(directive => directive.packageName === oldPackage || directive.packageName.startsWith(oldPackage+'.'))) {
    throw Error('Choose a package with an existing export or open to the reviewed consumer module.');
  }
  const inputPackages = new Set(sources.filter(file => file.file.endsWith('.java')).map(file => key(file.file)));
  const binary = snapshotClasspath(javaHome,[source.output,peer.output]);
  const binaryPrefix = namespace => namespace.replaceAll('.','/')+'/';
  for (const entry of binary.files) {
    const owner = scope.projects.find(project => inside(project.output,entry.file));
    if (!owner) continue;
    const rel = path.relative(owner.output,entry.file).split(path.sep).join('/');
    if (rel.startsWith(binaryPrefix(newPackage)) || rel.startsWith(binaryPrefix(oldPackage)) &&
        !inputPackages.has(key(path.join(owner.sourceRoot,...rel.replace(/(?:\$[^/]+)?\.class$/u,'.java').split('/'))))) {
      throw Error('An unreviewed compiled class occupies the old or new package. Rebuild the reviewed named modules.');
    }
  }
  const sourceForCompile = record => {
    const file = record.file || fileURLToPath(record.uri), project = scope.projects.find(project => inside(project.sourceRoot,file));
    if (!project) throw observationError();
    return {...record,moduleName:project.name,modulePath:path.relative(project.sourceRoot,file).split(path.sep).join('/')};
  };
  return {provider,client,validate:()=>binary.validate(),sourceForCompile};
}

module.exports = {qualifiedPackageScope,bindQualifiedPackageScope};
