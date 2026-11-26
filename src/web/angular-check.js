'use strict';

const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {execute}=require('../java/testing/provision');
const {angularSource,captureAngularProject,angularEnvironment,inspectAngularProject,inside}=require('./angular-project');
const {validRange}=require('./angular-lsp');

const worker=String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const [compilerFile,typescriptFile,config,root,dependencies,result]=process.argv.slice(2);
const angular=await import(pathToFileURL(compilerFile).href);
const {default:ts}=await import(pathToFileURL(typescriptFile).href);
const resolved=fs.realpathSync(root);
function within(directory,file){
  const relative=path.relative(directory,file);
  return !path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);
}
function allowed(file){
  // Only the staged project and its reviewed physical dependencies reach the compiler host.
  const requested=path.resolve(file);
  if(!within(resolved,requested)&&!within(dependencies,requested))return false;
  try {
    const physical=fs.realpathSync(file);
    return within(resolved,physical)||within(dependencies,physical);
  } catch {return false;}
}
const angularFiles=new angular.NodeJSFileSystem();
const angularRead=angularFiles.readFile.bind(angularFiles);
const angularExists=angularFiles.exists.bind(angularFiles);
const angularList=angularFiles.readdir.bind(angularFiles);
angularFiles.readFile=file=>{
  if(!allowed(file))throw Error('The Angular configuration or resource escaped the selected project.');
  return angularRead(file);
};
angularFiles.exists=file=>allowed(file)&&angularExists(file);
angularFiles.readdir=directory=>allowed(directory)?angularList(directory).filter(name=>allowed(path.join(directory,name))):[];
angular.setFileSystem(angularFiles);
const sys={
  ...ts.sys,
  readFile(file){return allowed(file)?ts.sys.readFile(file):undefined;},
  fileExists(file){return allowed(file)&&ts.sys.fileExists(file);},
  readDirectory(directory,...args){return allowed(directory)?ts.sys.readDirectory(directory,...args).filter(allowed):[];},
  directoryExists(directory){return allowed(directory)&&ts.sys.directoryExists(directory);},
};
const parsed=angular.readConfiguration(config,{noEmit:true,incremental:false},angularFiles);
const messages=[...parsed.errors];
if(parsed.rootNames.length&&!messages.some(item=>item.category===ts.DiagnosticCategory.Error)){
  const host=angular.createCompilerHost({options:parsed.options});
  const getSourceFile=host.getSourceFile.bind(host);
  host.readFile=sys.readFile;
  host.fileExists=sys.fileExists;
  host.readDirectory=sys.readDirectory;
  host.directoryExists=sys.directoryExists;
  host.getSourceFile=(file,...args)=>allowed(file)?getSourceFile(file,...args):undefined;
  host.writeFile=()=>{throw Error('The Angular check cannot emit project files.');};
  const program=new angular.NgtscProgram(parsed.rootNames,parsed.options,host);
  messages.push(...program.getTsOptionDiagnostics(),...program.getNgOptionDiagnostics(),...program.getTsSyntacticDiagnostics(),
    ...program.getNgStructuralDiagnostics(),...program.getNgSemanticDiagnostics());
}
const issues=messages.slice(0,250).map(item=>{
  const severity=item.category===ts.DiagnosticCategory.Error?'error':item.category===ts.DiagnosticCategory.Warning?'warning':'information';
  const row={code:item.code,severity,message:ts.flattenDiagnosticMessageText(item.messageText,'\n').slice(0,1200)};
  if(item.file&&Number.isInteger(item.start)&&allowed(item.file.fileName)&&
      !within(path.join(resolved,'node_modules'),path.resolve(item.file.fileName))){
    row.file=path.relative(resolved,path.resolve(item.file.fileName));
    const start=item.file.getLineAndCharacterOfPosition(item.start);
    const end=item.file.getLineAndCharacterOfPosition(item.start+(item.length||0));
    row.range={start,end};
  }
  return row;
});
fs.writeFileSync(result,JSON.stringify({strictTemplates:parsed.options.strictTemplates===true,
  diagnostics:issues,omitted:messages.length-issues.length,
  clean:parsed.rootNames.length>0&&!messages.some(item=>item.category===ts.DiagnosticCategory.Error)}),{flag:'wx'});
`;

async function checkAngularProject(project,{cancellation}={}) {
  const selected=await inspectAngularProject(project.root,project.root,project.node);
  if (selected.fingerprint!==project.fingerprint) throw Error('Review the changed Angular toolchain before checking templates.');
  const before=await captureAngularProject(project.root);
  const parent=await fs.realpath(os.tmpdir()), directory=await fs.mkdtemp(path.join(parent,'rb-angular-check-'));
  const initial=await fs.lstat(directory,{bigint:true});
  const stage=path.join(directory,'project'), script=path.join(directory,'check.mjs'), output=path.join(directory,'result.json');
  const link=path.join(stage,'node_modules');
  let linked=false;
  try {
    await fs.mkdir(stage);
    for (const row of before.files) {
      const target=path.join(stage,row.relative);
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.writeFile(target,row.bytes,{flag:'wx'});
    }
    await fs.symlink(project.dependencies,link,process.platform==='win32'?'junction':'dir');
    linked=true;
    await fs.writeFile(script,worker,{flag:'wx'});
    const run=await execute(project.node,['--max-old-space-size=768',script,project.checker,project.typescript,
      path.join(stage,path.relative(project.root,project.config)),stage,project.dependencies,output],
    {cwd:stage,env:angularEnvironment(),timeoutMs:50000,maxOutputBytes:512*1024,cancellation});
    if (run.cancelled||cancellation?.aborted||cancellation?.isCancellationRequested) throw Error('Angular template checking cancelled.');
    if (run.timedOut||run.code!==0) throw Error('The installed Angular compiler did not finish checking the project.');
    const stat=await fs.lstat(output);
    if (!stat.isFile()||stat.isSymbolicLink()||stat.size>768*1024) throw Error('Angular returned an invalid diagnostic report.');
    const report=JSON.parse(await fs.readFile(output,'utf8'));
    if (![report.strictTemplates,report.clean].every(flag=>typeof flag==='boolean')||
        !Number.isSafeInteger(report.omitted)||report.omitted<0||
        !Array.isArray(report.diagnostics)||report.diagnostics.length>250) throw Error('Angular returned invalid diagnostics.');
    const captured=new Map(before.files.map(row=>[row.relative,row]));
    const diagnostics=[], projectDiagnostics=[];
    for (const issue of report.diagnostics) {
      if (!Number.isSafeInteger(issue?.code)||!['error','warning','information'].includes(issue.severity)||
          typeof issue.message!=='string'||issue.message.length>1200) throw Error('Angular returned an invalid diagnostic row.');
      const bounded={code:issue.code,severity:issue.severity,message:issue.message.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu,'')};
      const source=typeof issue.file==='string'?captured.get(issue.file):undefined;
      if (!source||!validRange(issue.range,source.bytes.toString('utf8'))||!await angularSource(project.root,source.file)) {
        // Global diagnostics are displayed separately, with no navigable file URI.
        if (issue.file===undefined)projectDiagnostics.push(bounded);
        continue;
      }
      const file=source.file;
      if (!inside(project.root,file))continue;
      diagnostics.push({...bounded,file,range:issue.range});
    }
    const [after,runtime]=await Promise.all([captureAngularProject(project.root),
      inspectAngularProject(project.root,project.root,project.node)]);
    if (before.fingerprint!==after.fingerprint||runtime.fingerprint!==project.fingerprint) {
      throw Error('Angular source, configuration or tools changed during inspection.');
    }
    return {state:'checked',strictTemplates:report.strictTemplates,clean:report.clean,
      omitted:report.omitted,diagnostics,projectDiagnostics,sourceFingerprint:before.fingerprint,emittedFiles:false};
  } finally {
    const actual=await fs.realpath(directory), identity=await fs.lstat(actual,{bigint:true});
    if (path.relative(directory,actual)||path.relative(parent,path.dirname(actual))||
        !path.basename(actual).startsWith('rb-angular-check-')||identity.dev!==initial.dev||identity.ino!==initial.ino) {
      throw Error('Angular compiler staging changed ownership.');
    }
    if (linked) {
      const ownedLink=await fs.lstat(link);
      if (!ownedLink.isSymbolicLink()||path.relative(project.dependencies,await fs.realpath(link))) {
        throw Error('Angular compiler dependency link changed before cleanup.');
      }
      await fs.unlink(link);
    }
    await fs.rm(actual,{recursive:true,force:true,maxRetries:6,retryDelay:180});
  }
}

module.exports={checkAngularProject};
