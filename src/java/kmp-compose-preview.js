'use strict';

const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const {createHash}=require('node:crypto');
const {lexJava,matching,rangeAt}=require('../spring/java');
const {fileKey}=require('./dependency-builds');
const {snapshotKmpSources}=require('./kmp-sources');
const {buildSnapshot,kmpSpec,regular}=require('./kmp-gradle');
const {fail,cancelled,inside}=require('./workbench-model');

const identifier=/^[A-Za-z_][A-Za-z0-9_]{0,95}$/u;
const previewAnnotations=new Set(['androidx.compose.ui.tooling.preview.Preview','org.jetbrains.compose.ui.tooling.preview.Preview']);
const composable='androidx.compose.runtime.Composable';
const task='rocketbrainComposePreview';
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const IEND=Buffer.from([0,0,0,0,73,69,78,68,174,66,96,130]);
const decode=new TextDecoder('utf-8',{fatal:true});

const PREVIEW_INIT=`gradle.beforeProject { project ->
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
    const common=module.sourceSets.find(item=>item.name==='commonMain');
    if (!common?.directories.some(directory=>inside(directory,file))) continue;
    const targets=module.targets.filter(item=>item.platform==='jvm'&&item.compileTask&&item.main.includes('commonMain'));
    if (!targets.length) continue;
    const text=decode.decode(regular(file,model.root,512*1024));
    for (const entry of previewFunctions(text)) {
      for (const target of targets) options.push({...entry,modulePath:module.path,targetName:target.name});
    }
  }
  if (options.length>32) throw fail('Choose a common Kotlin file with up to 32 supported Compose previews.');
  return options;
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

async function renderComposePreview({model,file,modulePath,targetName,qualified,width=360,height=240,
  tools,runner,workspaceTrusted,allowProjectExecution,cancellation}) {
  if (workspaceTrusted!==true||allowProjectExecution!==true) throw fail('Explicitly choose the Compose preview in a trusted Gradle workspace.');
  if (cancelled(cancellation)) throw fail('Compose preview cancelled.');
  if (![width,height].every(value=>Number.isSafeInteger(value)&&value>=32&&value<=1024)) {
    throw fail('Choose a Compose preview between 32 and 1024 pixels per side.');
  }
  const effects=previewCandidates(model,file).filter(item=>item.modulePath===modulePath&&item.targetName===targetName&&item.qualified===qualified);
  if (effects.length!==1) throw fail('Choose one simple top-level @Preview and @Composable from the selected commonMain JVM target.');
  const module=model.modules.find(item=>item.path===modulePath);
  const inputs=snapshotKmpSources(model,module,[targetName],cancellation);
  const reviewed=inputs.files.get(fileKey(file));
  if (!reviewed || !previewFunctions(reviewed.text).some(item=>item.qualified===qualified)) {
    throw fail('The selected Compose source changed. Review the preview again.');
  }
  const parent=await fs.realpath(os.tmpdir()),stage=await fs.mkdtemp(path.join(parent,'rb-compose-preview-'));
  const identity=await fs.lstat(stage,{bigint:true});
  try {
    const generated=path.join(stage,'kotlin'),init=path.join(stage,'preview.gradle'),output=path.join(stage,'render.png');
    await fs.mkdir(generated);
    await fs.writeFile(path.join(generated,'PreviewMain.kt'),renderer(qualified,width,height),{flag:'wx'});
    await fs.writeFile(init,PREVIEW_INIT,{flag:'wx'});
    const taskPath=(modulePath===':'?':':modulePath+':')+task;
    const spec=await kmpSpec(model.root,tools,[taskPath],{discovery:true,initFile:init,output});
    for (const [key,value] of Object.entries({module:modulePath,target:targetName,source:generated,output})) {
      spec.args.push('-Drocketbrain.compose.'+key+'='+value);
    }
    const result=await runner.execute(spec,{cancellation,timeoutMs:240000});
    if (result.cancelled||cancelled(cancellation)) throw fail('Compose preview cancelled.');
    if (result.code!==0) throw fail('The selected Gradle JVM target could not render this Compose preview. See its task terminal.');
    assertModel(model);
    if (inputs.fingerprint!==snapshotKmpSources(model,module,[targetName],cancellation).fingerprint) {
      throw fail('Kotlin sources changed during rendering. Refresh the preview from saved files.');
    }
    const png=regular(output,stage,6*1024*1024);
    inspectPng(png,width,height);
    return {png,report:{qualified,modulePath,targetName,width,height,task:taskPath,bytes:png.length,
      sourceSha256:reviewed.sha256,imageSha256:createHash('sha256').update(png).digest('hex')}};
  } finally {
    const real=await fs.realpath(stage),observed=await fs.lstat(real,{bigint:true});
    if (path.relative(real,stage)||path.relative(parent,path.dirname(real))||!path.basename(real).startsWith('rb-compose-preview-')||
        observed.ino!==identity.ino||observed.dev!==identity.dev) throw fail('Compose preview staging directory ownership changed.');
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  }
}

module.exports={previewFunctions,previewCandidates,renderComposePreview};
