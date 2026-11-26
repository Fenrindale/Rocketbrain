'use strict';

const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createHash,randomUUID}=require('node:crypto');
const {captureFxmlPreview}=require('./javafx-preview-fxml');
const {independentJavaExecutable}=require('./debug-runtime');
const {execute}=require('./testing/provision');
const {cancelled}=require('./workbench-model');
const worker=require('./javafx-preview-source.json');

const VERSION='26.0.2';
const artifacts=[
  ['base',749188,'67fb8b827c0baf9ad14a2436a041498eed26134b35f1b019c300fc46014c3892'],
  ['graphics',6161094,'bdbca2dd440b5f0151172597a5de8ada83a1375dce249ca600ecfc380eee2ba7'],
  ['controls',2605681,'33d9640f1db1ef8792b5fc270f08153411465d18ad49819d88543dff958675a8'],
  ['fxml',126203,'0a06affc0e71bcd265552e40da33e62bf842c44ce61af952d3b6a9342b1c7630']
];
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const IEND=Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function checkArtifact(file,size,expected) {
  const stat=await fs.lstat(file).catch(error=>{
    if (error.code!=='ENOENT') throw error;
  });
  if (!stat) return false;
  if (!stat.isFile()||stat.isSymbolicLink()||path.relative(file,await fs.realpath(file))||stat.size!==size||
      hash(await fs.readFile(file))!==expected) throw Error('The OpenJFX preview library failed verification: '+path.basename(file));
  return true;
}

async function runtime(storage,cancellation) {
  if (process.platform!=='win32'||process.arch!=='x64') {
    throw Error('The headless OpenJFX preview is available for Windows x64.');
  }
  if (!path.isAbsolute(storage||'')) throw Error('OpenJFX preview requires local extension storage.');
  await fs.mkdir(storage,{recursive:true});
  const cache=path.join(await fs.realpath(storage),'openjfx-'+VERSION+'-win-x64');
  await fs.mkdir(cache,{recursive:true});
  if (path.relative(cache,await fs.realpath(cache))) throw Error('Use a physical OpenJFX runtime directory.');
  const cancel=new AbortController();
  const subscription=cancellation?.onCancellationRequested?.(()=>cancel.abort());
  const abort=()=>cancel.abort();
  cancellation?.addEventListener?.('abort',abort,{once:true});
  if (cancelled(cancellation)) abort();
  try {
    return await Promise.all(artifacts.map(async ([name,size,expected])=>{
      const artifact='javafx-'+name,filename=artifact+'-'+VERSION+'-win.jar';
      const file=path.join(cache,filename);
      if (await checkArtifact(file,size,expected)) return file;
      const response=await fetch('https://repo.maven.apache.org/maven2/org/openjfx/'+artifact+'/'+VERSION+'/'+filename,
        {signal:AbortSignal.any([cancel.signal,AbortSignal.timeout(35000)])});
      if (!response.ok || Number(response.headers.get('Content-Length'))!==size) {
        throw Error('Unable to retrieve the pinned OpenJFX preview runtime.');
      }
      const parts=[];
      let downloaded=0;
      for await (const chunk of response.body) {
        if ((downloaded+=chunk.length)>size) throw Error('OpenJFX preview download exceeded its approved size.');
        parts.push(chunk);
      }
      const bytes=Buffer.concat(parts);
      if (bytes.length!==size||hash(bytes)!==expected) throw Error('The OpenJFX preview download failed SHA-256 verification.');
      const temp=path.join(cache,'.'+filename+'.'+randomUUID()+'.partial');
      try {
        await fs.writeFile(temp,bytes,{flag:'wx'});
        try {await fs.link(temp,file);}
        catch (error) {if (error.code!=='EEXIST') throw error;}
      } finally {await fs.rm(temp,{force:true});}
      if (!await checkArtifact(file,size,expected)) throw Error('OpenJFX preview runtime could not be installed.');
      return file;
    }));
  } finally {
    subscription?.dispose();
    cancellation?.removeEventListener?.('abort',abort);
  }
}

async function renderFxmlPreview({file,workspace,dirty,javaHome,storage,width=480,height=320,workspaceTrusted,
  allowPreview,cancellation,propertyEdit,expectedFingerprint}) {
  if (workspaceTrusted!==true||allowPreview!==true||cancelled(cancellation)) {
    throw Error('Choose an FXML preview in a trusted workspace.');
  }
  if (![width,height].every(value=>Number.isSafeInteger(value)&&value>=32&&value<=1024)) {
    throw Error('Choose a JavaFX preview between 32 and 1024 pixels per side.');
  }
  if (!path.isAbsolute(javaHome||'')) throw Error('Configure an independent JDK 24 or later for JavaFX preview.');
  const java=independentJavaExecutable(path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java'));
  const version=await fs.readFile(path.join(path.dirname(path.dirname(java)),'release'),'utf8');
  if (Number(/^JAVA_VERSION="(\d+)/mu.exec(version)?.[1]||0)<24) throw Error('JavaFX preview requires JDK 24 or later.');
  const before=captureFxmlPreview(file,workspace,{dirty,propertyEdit,expectedFingerprint});
  const modules=await runtime(storage,cancellation);
  if (cancelled(cancellation)) throw Error('FXML preview cancelled.');
  const parent=await fs.realpath(os.tmpdir()), stage=await fs.mkdtemp(path.join(parent,'rb-fxml-preview-'));
  const identity=await fs.lstat(stage,{bigint:true});
  try {
    const resources=path.join(stage,'resources'), output=path.join(stage,'preview.png');
    for (const [source,{staged}] of before.files) {
      const destination=path.join(resources,path.relative(before.root,source));
      await fs.mkdir(path.dirname(destination),{recursive:true});
      await fs.writeFile(destination,staged,{flag:'wx'});
    }
    const sourceWorker=path.join(stage,'FxmlPreview.java');
    await fs.writeFile(sourceWorker,worker,{flag:'wx'});
    const targets=path.join(stage,'targets.txt');
    await fs.writeFile(targets,before.targets.map(target=>target.id).join('\n'),{flag:'wx'});
    const env={...process.env};
    for (const key of Object.keys(env)) if (/^(?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|CLASSPATH)$/iu.test(key)) delete env[key];
    const input=path.join(resources,path.relative(before.root,file));
    const run=await execute(java,['-Dglass.platform=headless','-Dprism.order=sw','-Djava.awt.headless=true','-Duser.home='+stage,
      '-Djava.io.tmpdir='+stage,'--enable-native-access=javafx.graphics','--module-path',modules.join(path.delimiter),
      '--add-modules','javafx.controls,javafx.fxml,java.desktop',sourceWorker,input,output,String(width),String(height),targets],
    {cwd:stage,env,timeoutMs:42000,cancellation,maxOutputBytes:256*1024});
    if (run.cancelled||cancelled(cancellation)) throw Error('FXML preview cancelled.');
    const observed=/^Rocketbrain FXML Preview (26\.0\.2\+\d+)\s*$/mu.exec(run.output)?.[1];
    if (run.timedOut||run.code!==0||!observed) {
      const reason=run.output.split(/\r?\n/u).find(line=>/^(?:Caused by: )?(?:javafx\.fxml\.LoadException|java\.lang\.IllegalArgumentException)/u.test(line));
      throw Error('The selected static FXML layout could not render.'+(reason?' '+reason.slice(0,360):''));
    }
    if (captureFxmlPreview(file,workspace,{dirty}).fingerprint!==before.fingerprint) {
      throw Error('FXML or CSS changed during rendering. Refresh from the saved resource files.');
    }
    const stat=await fs.lstat(output);
    if (!stat.isFile()||stat.isSymbolicLink()||path.relative(output,await fs.realpath(output))||stat.size>6*1024*1024) {
      throw Error('JavaFX did not produce a bounded preview image.');
    }
    const png=await fs.readFile(output);
    if (png.length<45||!png.subarray(0,8).equals(PNG)||png.readUInt32BE(8)!==13||png.toString('ascii',12,16)!=='IHDR'||
        png.readUInt32BE(16)!==width||png.readUInt32BE(20)!==height||!png.subarray(-12).equals(IEND)) {
      throw Error('JavaFX did not return a complete PNG of the reviewed dimensions.');
    }
    const bounds=new Map(),ids=new Set(before.targets.map(target=>target.id));
    for (const line of run.output.split(/\r?\n/u).filter(line=>line.startsWith('RB_FRAME_TARGET\t'))) {
      const [,id,...coordinates]=line.split('\t');
      const [x,y,w,h]=coordinates.map(value=>/^\d{1,4}$/u.test(value)?Number(value):NaN);
      if (!ids.has(id)||bounds.has(id)||coordinates.length!==4||![x,y,w,h].every(Number.isSafeInteger)||
          w<1||h<1||x+w>width||y+h>height) throw Error('JavaFX returned invalid FXML property bounds.');
      bounds.set(id,{x,y,width:w,height:h});
    }
    return {png,report:{runtime:observed,width,height,bytes:png.length,imageSha256:hash(png),resourcesSha256:before.effective,
      ...before.summary},design:{targets:before.targets.map(target=>({...target,bounds:bounds.get(target.id)})),
      sourceText:before.sourceText,edit:before.edit}};
  } finally {
    const actual=await fs.realpath(stage),observed=await fs.lstat(actual,{bigint:true});
    if (path.relative(stage,actual)||path.relative(parent,path.dirname(actual))||!path.basename(actual).startsWith('rb-fxml-preview-')||
        identity.dev!==observed.dev||identity.ino!==observed.ino) throw Error('The FXML preview staging directory ownership changed.');
    await fs.rm(actual,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={renderFxmlPreview,VERSION};
