'use strict';

const path=require('node:path');
const fs=require('node:fs/promises');
const sourceFs=require('node:fs');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {lexJava,matching,rangeAt}=require('../spring/java');
const {fileKey}=require('./dependency-builds');
const {snapshotKmpSources}=require('./kmp-sources');
const {buildSnapshot,kmpSpec,regular,safeDirectory}=require('./kmp-gradle');
const {fail,cancelled,inside}=require('./workbench-model');

const identifier=/^[A-Za-z_][A-Za-z0-9_]{0,95}$/u;
const previewAnnotations=new Set(['androidx.compose.ui.tooling.preview.Preview','org.jetbrains.compose.ui.tooling.preview.Preview']);
const composable='androidx.compose.runtime.Composable';
const task='rocketbrainComposePreview';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const IEND=Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
const decode=new TextDecoder('utf-8',{fatal:true});

const PREVIEW_INIT=`import groovy.json.JsonSlurper
gradle.beforeProject { project ->
  def property = { name -> System.getProperty('rocketbrain.compose.' + name) }
  if (project.path != property('module')) return
  project.pluginManager.withPlugin('org.jetbrains.kotlin.multiplatform') {
    project.extensions.getByName('kotlin').targets.configureEach { target ->
      if (target.name == property('target') && target.platformType.name() == 'jvm') {
        def main = target.compilations.getByName('main')
        if (target.compilations.names.contains('rocketbrainPreview') ||
            project.tasks.names.contains('rocketbrainComposePreview')) {
          throw new GradleException('The Compose preview task or compilation name is already in use.')
        }
        def render = target.compilations.create('rocketbrainPreview')
        render.associateWith(main)
        render.defaultSourceSet.kotlin.srcDir(new File(property('source')))
        project.tasks.register('rocketbrainComposePreview', JavaExec) {
          dependsOn(render.compileTaskProvider)
          classpath(render.output.allOutputs, render.runtimeDependencyFiles, main.output.allOutputs)
          doFirst {
            def review = new JsonSlurper().parse(new File(property('review')), 'UTF-8')
            def source = new File(review.file).canonicalFile.toPath()
            def sets = main.allKotlinSourceSets
            def owners = sets.findAll { set ->
              set.kotlin.srcDirs.any { source.startsWith(it.canonicalFile.toPath()) }
            }
            def resourceRoots = sets.collectMany { set ->
              set.resources.srcDirs.collect { it.toPath().toAbsolutePath().normalize().toString() }
            }.unique().sort()
            def buildDirectory = project.layout.buildDirectory.get().asFile.canonicalPath
            if (owners.collect { it.name } != [review.sourceSet] || resourceRoots != review.resourceRoots ||
                (review.buildDirectory != null && buildDirectory != review.buildDirectory)) {
              throw new GradleException('The Compose target source set or resource paths changed. Inspect the project again.')
            }
          }
          mainClass.set('rocketbrain.preview.PreviewMainKt')
          jvmArgs('-Djava.awt.headless=true', '--enable-native-access=ALL-UNNAMED')
          args(property('output'))
        }
      }
    }
  }
}
`;

function previewFunctions(text) {
  const {tokens,issues}=lexJava(text);
  if (issues.length || text.includes('`') ||
      [...text.matchAll(/\/\*[\s\S]*?\*\//gu)].some(match=>match[0].slice(2,-2).includes('/*'))) return [];
  const imports=new Map();
  let pkg,depth=0,annotations=[],visibility;
  const functions=[];
  const at=index=>tokens[index]?.text;
  function dotted(index) {
    if (!identifier.test(at(index)||'')) return;
    const names=[at(index++)];
    while (at(index)==='.' && identifier.test(at(index+1)||'')) {
      names.push(at(index+1));
      index+=2;
    }
    return {name:names.join('.'),next:index};
  }
  for (let i=0;i<tokens.length;i++) {
    const word=at(i);
    if (word==='{') depth++;
    if (word==='}') depth--;
    if (depth!==0) continue;
    if (word==='package'||word==='import') {
      const name=dotted(i+1);
      if (!name) return [];
      if (word==='package') {
        if (pkg!==undefined) return [];
        pkg=name.name;
      } else {
        const alias=at(name.next)==='as'?at(name.next+1):name.name.split('.').at(-1);
        if (!identifier.test(alias||'')) return [];
        if (imports.has(alias) && imports.get(alias)!==name.name) return [];
        imports.set(alias,name.name);
        if (at(name.next)==='as') name.next+=2;
      }
      i=name.next-1;
      annotations=[];visibility=undefined;
      continue;
    }
    if (word==='@') {
      const name=dotted(i+1);
      if (!name) { annotations=[];visibility=undefined;continue; }
      let next=name.next,plain=true;
      if (at(next)==='(') {
        const end=matching(tokens,next);
        if (end<0) return [];
        plain=end===next+1;
        next=end+1;
      }
      annotations.push({name:imports.get(name.name)||name.name,plain});
      i=next-1;
      continue;
    }
    if (['public','internal','private'].includes(word)) {
      visibility=word;
      continue;
    }
    if (word==='fun' && pkg && ['public','internal',undefined].includes(visibility) && identifier.test(at(i+1)||'') &&
        at(i+2)==='(' && at(i+3)===')' && annotations.filter(item=>previewAnnotations.has(item.name)).length===1 &&
        annotations.some(item=>item.plain&&previewAnnotations.has(item.name)) && annotations.some(item=>item.name===composable)) {
      const target=tokens[i+1];
      if (['{','='].includes(at(i+4)) || at(i+4)===':' && at(i+5)==='Unit' && ['{','='].includes(at(i+6))) {
        functions.push({name:target.text,qualified:pkg+'.'+target.text,range:rangeAt(text,target.start,target.end)});
      }
    }
    annotations=[];visibility=undefined;
  }
  return functions;
}

function assertModel(model) {
  if (JSON.stringify(buildSnapshot(model.root,model.modules))!==JSON.stringify(model.digests)) {
    throw fail('Gradle settings changed. Inspect the Kotlin Multiplatform targets again.');
  }
}

function previewCandidates(model,file) {
  assertModel(model);
  const options=[];
  for (const module of model.modules) {
    const sources=module.sourceSets.filter(set=>set.directories.some(directory=>inside(directory,file)));
    const targets=module.targets.filter(target=>target.platform==='jvm'&&target.compileTask).flatMap(target=>{
      const owners=sources.filter(set=>target.main.includes(set.name));
      return owners.length===1 ? [{targetName:target.name,sourceSet:owners[0].name}] : [];
    });
    if (!targets.length) continue;
    const text=decode.decode(regular(file,model.root,512*1024));
    for (const entry of previewFunctions(text)) {
      for (const target of targets) options.push({...entry,modulePath:module.path,...target});
    }
  }
  if (options.length>32) throw fail('Choose a Kotlin file with up to 32 supported Compose previews.');
  return options;
}

function snapshotResources(model,module,targetName,cancellation) {
  const {main}=module.targets.find(target=>target.name===targetName);
  const roots=[...new Set(module.sourceSets.filter(set=>main.includes(set.name))
    .flatMap(set=>set.resourceDirectories||[]))].sort();
  const files=new Map(), fileLimit=16*1024*1024;
  let entries=0,total=0;
  const buildDirectory=module.buildDirectory && inside(model.root,module.buildDirectory) &&
    !inside(module.buildDirectory,module.directory) ? safeDirectory(model.root,module.buildDirectory) : undefined;
  function walk(directory,depth) {
    if (cancelled(cancellation)) throw fail('Compose preview cancelled.');
    if (depth>24 || path.relative(directory,sourceFs.realpathSync(directory))) {
      throw fail('Compose preview resource directories must be bounded physical workspace paths.');
    }
    const handle=sourceFs.opendirSync(directory);
    try {
      for (let entry; (entry=handle.readSync())!==null;) {
        if (cancelled(cancellation)) throw fail('Compose preview cancelled.');
        if (++entries>10000) throw fail('Compose preview resource scanning exceeded its directory limit.');
        const file=path.join(directory,entry.name);
        if (entry.isDirectory()) walk(file,depth+1);
        else if (entry.isFile()) {
          if (files.has(file)) continue;
          if (files.size>=1024) throw fail('Compose preview can inspect up to 1,024 project resource files.');
          const bytes=regular(file,model.root,fileLimit);
          if ((total+=bytes.length)>64*1024*1024) throw fail('Compose preview can inspect up to 64 MiB of project resources.');
          files.set(file,createHash('sha256').update(bytes).digest('hex'));
        } else throw fail('Compose preview resources must be physical workspace files.');
      }
    } finally {handle.closeSync();}
  }
  for (const root of roots) {
    safeDirectory(model.root,root);
    // Gradle generates these outputs during rendering. Bind the reported roots, not their derived contents.
    if (buildDirectory && inside(buildDirectory,root)) continue;
    const entry=sourceFs.lstatSync(root,{throwIfNoEntry:false});
    if (!entry) continue;
    if (!entry.isDirectory()||entry.isSymbolicLink()) throw fail('Compose preview resource roots must be physical workspace directories.');
    walk(root,0);
  }
  const sha256=createHash('sha256').update(JSON.stringify([roots,[...files].sort(([left],[right])=>left.localeCompare(right))])).digest('hex');
  return {roots,sha256,files:files.size,buildDirectory:module.buildDirectory};
}

function inspectPng(bytes,width,height) {
  if (bytes.length<45 || !bytes.subarray(0,8).equals(PNG) || bytes.readUInt32BE(8)!==13 ||
      bytes.toString('ascii',12,16)!=='IHDR' || bytes.readUInt32BE(16)!==width || bytes.readUInt32BE(20)!==height ||
      !bytes.subarray(-12).equals(IEND)) throw fail('Compose did not produce a complete PNG of the reviewed dimensions.');
}

function renderer(qualified,width,height) {
  return `package rocketbrain.preview

import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.ImageComposeScene
import androidx.compose.ui.unit.Density
import org.jetbrains.skia.EncodedImageFormat
import java.nio.file.Files
import java.nio.file.Path

@OptIn(ExperimentalComposeUiApi::class)
fun main(args: Array<String>) {
    val scene = ImageComposeScene(${width}, ${height}, density = Density(1f)) { ${qualified}() }
    try {
        scene.render().use { image ->
            requireNotNull(image.encodeToData(EncodedImageFormat.PNG)).use { data ->
                Files.write(Path.of(args.single()), data.bytes)
            }
        }
    } finally {
        scene.close()
    }
}
`;
}

async function renderComposePreview({model,file,modulePath,targetName,sourceSet,qualified,width=360,height=240,
  tools,runner,workspaceTrusted,allowProjectExecution,cancellation}) {
  if (workspaceTrusted!==true||allowProjectExecution!==true) throw fail('Explicitly choose the Compose preview in a trusted Gradle workspace.');
  if (cancelled(cancellation)) throw fail('Compose preview cancelled.');
  if (![width,height].every(value=>Number.isSafeInteger(value)&&value>=32&&value<=1024)) {
    throw fail('Choose a Compose preview between 32 and 1024 pixels per side.');
  }
  const effects=previewCandidates(model,file).filter(item=>item.modulePath===modulePath&&item.targetName===targetName&&
    item.qualified===qualified&&(sourceSet===undefined||item.sourceSet===sourceSet));
  if (effects.length!==1) throw fail('Choose one simple top-level @Preview and @Composable from a main source set of the selected JVM target.');
  const owner=effects[0].sourceSet;
  const module=model.modules.find(item=>item.path===modulePath);
  const inputs=snapshotKmpSources(model,module,[targetName],cancellation);
  const reviewed=inputs.files.get(fileKey(file));
  if (!reviewed || reviewed.sets.size!==1 || !reviewed.sets.has(owner) || !previewFunctions(reviewed.text).some(item=>item.qualified===qualified)) {
    throw fail('The selected Compose source changed. Review the preview again.');
  }
  const resources=snapshotResources(model,module,targetName,cancellation);
  const parent=await fs.realpath(os.tmpdir()),stage=await fs.mkdtemp(path.join(parent,'rb-compose-preview-'));
  const identity=await fs.lstat(stage,{bigint:true});
  try {
    const generated=path.join(stage,'kotlin'),init=path.join(stage,'preview.gradle'),output=path.join(stage,'render.png');
    const review=path.join(stage,'review.json');
    await fs.mkdir(generated);
    await fs.writeFile(path.join(generated,'PreviewMain.kt'),renderer(qualified,width,height),{flag:'wx'});
    await fs.writeFile(init,PREVIEW_INIT,{flag:'wx'});
    await fs.writeFile(review,JSON.stringify({file,sourceSet:owner,resourceRoots:resources.roots,buildDirectory:resources.buildDirectory}),{flag:'wx'});
    const taskPath=(modulePath===':'?':':modulePath+':')+task;
    const spec=await kmpSpec(model.root,tools,[taskPath],{discovery:true,initFile:init,output});
    for (const [key,value] of Object.entries({module:modulePath,target:targetName,source:generated,output,review})) {
      spec.args.push('-Drocketbrain.compose.'+key+'='+value);
    }
    const result=await runner.execute(spec,{cancellation,timeoutMs:240000});
    if (result.cancelled||cancelled(cancellation)) throw fail('Compose preview cancelled.');
    if (result.code!==0) throw fail('The selected Gradle JVM target could not render this Compose preview. See its task terminal.');
    assertModel(model);
    if (inputs.fingerprint!==snapshotKmpSources(model,module,[targetName],cancellation).fingerprint) {
      throw fail('Kotlin sources changed during rendering. Refresh the preview from saved files.');
    }
    if (resources.sha256!==snapshotResources(model,module,targetName,cancellation).sha256) {
      throw fail('Kotlin project resources changed during rendering. Refresh the preview from saved files.');
    }
    const png=regular(output,stage,6*1024*1024);
    inspectPng(png,width,height);
    return {png,report:{qualified,modulePath,targetName,sourceSet:owner,width,height,task:taskPath,bytes:png.length,
      resourceSha256:resources.sha256,resourceFiles:resources.files,
      sourceSha256:reviewed.sha256,imageSha256:createHash('sha256').update(png).digest('hex')}};
  } finally {
    const real=await fs.realpath(stage),observed=await fs.lstat(real,{bigint:true});
    if (path.relative(real,stage)||path.relative(parent,path.dirname(real))||!path.basename(real).startsWith('rb-compose-preview-')||
        observed.ino!==identity.ino||observed.dev!==identity.dev) throw fail('Compose preview staging directory ownership changed.');
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={previewFunctions,previewCandidates,renderComposePreview};
