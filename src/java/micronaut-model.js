'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { parseJavaFile,lexJava,matching,literal,rangeAt } = require('../spring/java');
const { parseProperties,parseYaml } = require('../spring/configuration');
const { pomFacts,gradleStatements } = require('./dependency-builds');
const { inside,fail,cancelled,LIMITS,buildFingerprint } = require('./workbench-model');

const KEY=/^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
const PART=/^[a-z][a-z0-9-]{0,39}$/;
const CONFIG_FILE=/^application(?:-([a-z][a-z0-9-]{0,39}))?\.(properties|ya?ml)$/;
const JAR_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
const RELEASE=/^5\.\d+\.\d+$/u;
const MAIN_CLASS=/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*){0,19}$/u;
const GRADLE_PLUGIN='io.micronaut.application';
const PACKAGE_CONFIG='io.micronaut.context.annotation.';
const HTTP='io.micronaut.http.annotation.';
const VERBS=['Get','Post','Put','Delete','Patch','Head','Options','Trace'];
const TYPES=new Set(['boolean','Boolean','byte','Byte','short','Short','int','Integer','long','Long','float','Float',
  'double','Double','String','java.lang.String','Duration','java.time.Duration','URI','java.net.URI']);
const annotation=(items,name) => items.find(item => item.name===name);
const normalize=text => text.replace(/\r\n/g,'\n');

function readPhysical(project,file,limit=512*1024) {
  const real=fs.realpathSync(file), stat=fs.lstatSync(file);
  if (path.relative(file,real) || !inside(project.root,real) || !stat.isFile() || stat.isSymbolicLink() || stat.size>limit) {
    throw fail('Micronaut analysis uses bounded physical files inside the selected project.');
  }
  const bytes=fs.readFileSync(real);
  if (bytes.length>limit) throw fail('A Micronaut source file exceeds its analysis limit.');
  return {path:real,uri:pathToFileURL(real).href,text:normalize(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),
    digest:createHash('sha256').update(bytes).digest('hex')};
}

function micronautMavenProject(project) {
  if (project?.tool!=='maven') throw fail('Choose an imported Maven Micronaut application.');
  const model=pomFacts(readPhysical(project,path.join(project.root,'pom.xml'),LIMITS.fileBytes));
  const parent=model.parent;
  if (model.packaging!=='jar' || parent?.group!=='io.micronaut.platform' || parent.artifact!=='micronaut-parent' ||
      !RELEASE.test(parent.version)) throw fail('Use a JAR module with a literal Micronaut 5 Maven platform parent.');
  const name=model.finalName || (model.gav.artifact && model.gav.version && model.gav.artifact+'-'+model.gav.version);
  if (!JAR_NAME.test(name || '')) throw fail('Use a literal Maven artifact name and version or finalName.');
  return {platformVersion:parent.version,jarName:name+'.jar'};
}

function gradleScript(project,names,required){
  const files=names.map(name=>path.join(project.root,name)).filter(file=>fs.existsSync(file));
  if(files.length>1||required&&!files.length)throw fail('Choose one saved Micronaut Gradle build or settings script.');
  if(!files.length)return [];
  const {text}=readPhysical(project,files[0]);
  const {tokens,issues}=lexJava(text);
  if(issues.length)throw fail('Use literal Micronaut Gradle application and plugin declarations.');
  return gradleStatements(text,tokens,text.length).map(tokens=>({tokens,text}));
}

function block(script,name){
  const hits=script.filter(({tokens})=>tokens[0]?.text===name&&tokens[1]?.text==='{');
  if(hits.length!==1)throw fail('Choose a Micronaut Gradle project with one top-level '+name+' block.');
  const {tokens,text}=hits[0], end=matching(tokens,1);
  if(end!==tokens.length-1)throw fail('Use a bounded '+name+' block in the saved Micronaut Gradle script.');
  return gradleStatements(text,tokens.slice(2,end),tokens[end].start);
}

function stringArgument(statement,at){
  const grouped=statement[at]?.text==='(';
  const token=statement[at+(grouped?1:0)];
  if(!['char','string'].includes(token?.kind)||token.value===null||
      grouped&&statement[at+2]?.text!==')')return undefined;
  return {value:token.value,next:at+(grouped?3:1)};
}

function micronautGradleProject(project){
  const script=gradleScript(project,['build.gradle','build.gradle.kts'],true);
  const matches=block(script,'plugins').filter(tokens=>tokens[0]?.text==='id'&&stringArgument(tokens,1)?.value===GRADLE_PLUGIN);
  const plugin=matches[0], marker=plugin&&stringArgument(plugin,1);
  const version=marker&&plugin[marker.next]?.text==='version'&&stringArgument(plugin,marker.next+1);
  if(matches.length!==1||!version||version.next!==plugin.length||!RELEASE.test(version.value)){
    throw fail('Declare one applied Micronaut 5 application Gradle plugin with a literal version.');
  }
  const app=block(script,'application');
  const declarations=app.filter(tokens=>tokens[0]?.text==='mainClass');
  const setting=declarations[0], expression=setting?.slice(1,4).map(token=>token.text).join('');
  const main=setting&&(setting[1]?.text==='='?stringArgument(setting,2):
    expression==='.set('?stringArgument(setting,3):undefined);
  if(declarations.length!==1||!main||main.next!==setting.length||!MAIN_CLASS.test(main.value)){
    throw fail('Declare one literal mainClass in the Micronaut Gradle application block.');
  }
  const settings=gradleScript(project,['settings.gradle','settings.gradle.kts'],false)
    .map(entry=>entry.tokens).filter(tokens=>tokens[0]?.text==='rootProject');
  const root= settings[0];
  const rootName=root?.slice(0,4).map(token=>token.text).join('')==='rootProject.name='?stringArgument(root,4):undefined;
  const name=rootName?.value??path.basename(project.root);
  if(settings.length>1||settings.length&&(!rootName||rootName.next!==root.length)||!JAR_NAME.test(name)){
    throw fail('Use one literal Gradle root name for the standard Micronaut distribution.');
  }
  const properties=path.join(project.root,'gradle.properties');
  const versions=fs.existsSync(properties)?readPhysical(project,properties).text.split('\n')
    .filter(line=>/^\s*micronautVersion\b/u.test(line)).map(line=>/^\s*micronautVersion\s*=\s*(5\.\d+\.\d+)\s*$/u.exec(line)?.[1]):[];
  if(versions.length>1||versions.some(value=>!value))throw fail('Use one literal Micronaut 5 platform version when it is declared in gradle.properties.');
  return {tool:'gradle',plugin:GRADLE_PLUGIN,pluginVersion:version.value,platformVersion:versions[0],
    mainClass:main.value,distribution:name,buildFingerprint:buildFingerprint(project.root)};
}

function micronautProject(project){
  return project?.tool==='gradle'?micronautGradleProject(project):{tool:'maven',...micronautMavenProject(project)};
}

function resourceProfile(name) {return CONFIG_FILE.exec(name)?.[1] || '';}

function settingName(name) {
  const value=name.replace(/([A-Z]+)([A-Z][a-z])/g,'$1-$2').replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase();
  return KEY.test(value) ? value : undefined;
}

function route(annotationNode) {
  const names=['value','uri','uris'].filter(name => annotationNode.attributes[name]!==undefined);
  const value=names.length===0 ? '' : names.length===1 && names[0]!=='uris' ? literal(annotationNode,names[0]) : undefined;
  return typeof value==='string' && value.length<=300 &&
    value.split('/').every(part => !part || part!=='.' && part!=='..' && /^[A-Za-z0-9_{}.-]+$/.test(part)) ? value : undefined;
}

function modelMicronaut(javaSources,configurationSources) {
  const settings=[], configured=[], routes=[], injection=[], issues=[], types=[];
  for (const source of javaSources) {
    const file={...source,text:normalize(source.text)};
    const parsed=parseJavaFile(file);
    const sourceAt=node => ({uri:file.uri,range:rangeAt(file.text,node.start,node.end)});
    for (const type of parsed.types) {
      const binding=annotation(type.annotations,PACKAGE_CONFIG+'ConfigurationProperties');
      const controller=annotation(type.annotations,HTTP+'Controller');
      const singleton=annotation(type.annotations,'jakarta.inject.Singleton');
      if (binding || controller || singleton) types.push({name:type.fqn,source:sourceAt(type),kind:binding ? 'configuration' : controller ? 'controller' : 'singleton'});
      const prefix=literal(binding,'value');
      if (binding && typeof prefix==='string' && KEY.test(prefix)) {
        // The JavaBeans binding only emits unambiguous writable scalar properties, or interface accessors.
        const members=type.methods.filter(method => type.kind==='interface'
          ? /^get[A-Z]/.test(method.name) && !method.parameters.length && TYPES.has(method.type.raw)
          : /^set[A-Z]/.test(method.name) && method.parameters.length===1 && method.type.raw==='void' && TYPES.has(method.parameters[0].type.raw));
        for (const method of members) {
          if (type.methods.some(other => other!==method && other.name===method.name)) continue;
          const property=settingName(method.name.slice(3));
          if (property) settings.push({key:prefix+'.'+property,type:type.kind==='interface' ? method.type.raw : method.parameters[0].type.raw,
            kind:'configurationProperties',source:sourceAt(method)});
        }
      } else if (binding) issues.push({message:'Micronaut ConfigurationProperties needs a literal prefix.',source:sourceAt(type)});

      function readInjection(node) {
        const property=annotation(node.annotations,PACKAGE_CONFIG+'Property');
        const value=annotation(node.annotations,PACKAGE_CONFIG+'Value');
        if (!property && !value) return false;
        const literalValue=literal(value,'value');
        const placeholder=typeof literalValue==='string' && /^\$\{([a-z0-9_.-]+)(:[^{}]*)?}$/.exec(literalValue);
        const key=property ? literal(property,'name') : placeholder?.[1];
        if (typeof key==='string' && KEY.test(key)) settings.push({key,type:node.type.raw,kind:property ? 'property' : 'placeholder',
          hasDefault:Boolean(placeholder?.[2]),source:sourceAt(node)});
        else issues.push({message:'Only literal Micronaut property names and single placeholders have source navigation.',source:sourceAt(node)});
        return true;
      }
      for (const field of type.fields) readInjection(field);
      for (const method of type.methods) {
        for (const parameter of method.parameters) {
          if (readInjection(parameter)) continue;
          const constructors=type.methods.filter(item => item.constructor);
          if (method.constructor && (controller || singleton) && (constructors.length===1 || annotation(method.annotations,'jakarta.inject.Inject'))) {
            injection.push({from:type.fqn,type:parameter.type.name,source:sourceAt(parameter)});
          }
        }
        const verb=VERBS.find(name => annotation(method.annotations,HTTP+name));
        if (!controller || !verb) continue;
        const base=route(controller), leaf=route(annotation(method.annotations,HTTP+verb));
        if (base===undefined || leaf===undefined) continue;
        routes.push({verb:verb.toUpperCase(),path:('/'+base+'/'+leaf).replace(/\/{2,}/g,'/').replace(/\/$/,'') || '/',
          method:method.name,source:sourceAt(method)});
      }
    }
  }
  for (const file of configurationSources) {
    const safe={...file,text:normalize(file.text)};
    const parser=file.name.endsWith('.properties') ? parseProperties : parseYaml;
    const parsed=parser(safe);
    for (const entry of parsed.entries) {
      if (KEY.test(entry.key)) configured.push({key:entry.key,environment:resourceProfile(file.name),uri:entry.uri,range:entry.range});
    }
  }
  const bindings=injection.map(item => {
    const observed=types.filter(type => type.name===item.type);
    return {...item,targets:observed.map(type => type.source),state:observed.length===1 ? 'source-type' : 'unknown'};
  });
  return {settings:settings.sort((a,b) => a.key.localeCompare(b.key)),configured,routes,bindings,issues};
}

function micronautInputs(project,cancellation,{debug=false}={}) {
  const java=[], configuration=[];
  const sourceRoot=path.join(project.root,'src/main/java'), resources=path.join(project.root,'src/main/resources');
  let examined=0,bytes=0;
  function add(target,file) {
    const source=readPhysical(project,file);
    bytes+=Buffer.byteLength(source.text);
    if (bytes>8*1024*1024) throw fail('Micronaut source input exceeds its byte limit.');
    target.push({...source,name:path.basename(file)});
  }
  function visit(directory,depth,files,predicate,recursive) {
    if (depth>24 || path.relative(directory,fs.realpathSync(directory))) throw fail('Use physical Micronaut source directories.');
    const handle=fs.opendirSync(directory);
    try {
      for (let entry; (entry=handle.readSync())!==null;) {
        if (++examined>10000 || cancelled(cancellation)) throw fail('Micronaut source inspection exceeded its budget or was cancelled.');
        if (entry.isSymbolicLink()) {
          if (debug) throw fail('Use unlinked Micronaut source and configuration for debugging.');
          continue;
        }
        const file=path.join(directory,entry.name);
        if (recursive && entry.isDirectory()) visit(file,depth+1,files,predicate,recursive);
        else if (entry.isFile() && predicate(entry.name)) {
          if (files.length>=240) throw fail('Micronaut source inspection supports at most 240 files per group.');
          add(files,file);
        }
      }
    } finally {handle.closeSync();}
  }
  if (fs.existsSync(sourceRoot)) visit(sourceRoot,0,java,name => name.endsWith('.java'),true);
  if (fs.existsSync(resources)) visit(resources,0,configuration,name => CONFIG_FILE.test(name),false);
  configuration.sort((a,b) => a.name.localeCompare(b.name));
  return {java,configuration,resources,sourceRoot};
}

function snapshotMicronautDebugSources(project,cancellation) {
  const {java,configuration,sourceRoot}=micronautInputs(project,cancellation,{debug:true});
  if (!java.length) throw fail('Debug a Micronaut application with saved Java sources in src/main/java.');
  const files=[...java,...configuration].map(({path:file,digest})=>[file,digest]).sort((a,b)=>a[0].localeCompare(b[0]));
  return {sourcePaths:[sourceRoot],digest:buildFingerprint(project.root)+'/'+JSON.stringify(files)};
}

function inspectMicronautProject(project,cancellation) {
  const build=micronautProject(project), {java,configuration,resources}=micronautInputs(project,cancellation);
  return {...build,...modelMicronaut(java,configuration),projectUri:project.uri,resources};
}

module.exports = { modelMicronaut,inspectMicronautProject,micronautMavenProject,micronautProject,snapshotMicronautDebugSources,CONFIG_FILE,PART };
