'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseJavaFile,literal,rangeAt } = require('../spring/java');
const { parseProperties,parseYaml } = require('../spring/configuration');
const { pomFacts } = require('./dependency-builds');
const { inside,fail,cancelled,LIMITS } = require('./workbench-model');

const KEY=/^[a-z][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*)*$/;
const PART=/^[a-z][a-z0-9-]{0,39}$/;
const CONFIG_FILE=/^application(?:-([a-z][a-z0-9-]{0,39}))?\.(properties|ya?ml)$/;
const JAR_NAME=/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
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
    throw fail('Micronaut analysis uses bounded physical files inside the selected Maven project.');
  }
  const bytes=fs.readFileSync(real);
  if (bytes.length>limit) throw fail('A Micronaut source file exceeds its analysis limit.');
  return {path:real,uri:pathToFileURL(real).href,text:normalize(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
}

function micronautMavenProject(project) {
  if (project?.tool!=='maven') throw fail('Choose an imported Maven Micronaut application.');
  const model=pomFacts(readPhysical(project,path.join(project.root,'pom.xml'),LIMITS.fileBytes));
  const parent=model.parent;
  if (model.packaging!=='jar' || parent?.group!=='io.micronaut.platform' || parent.artifact!=='micronaut-parent' ||
      !/^5\.\d+\.\d+$/.test(parent.version)) throw fail('Use a JAR module with a literal Micronaut 5 Maven platform parent.');
  const name=model.finalName || (model.gav.artifact && model.gav.version && model.gav.artifact+'-'+model.gav.version);
  if (!JAR_NAME.test(name || '')) throw fail('Use a literal Maven artifact name and version or finalName.');
  return {platformVersion:parent.version,jarName:name+'.jar'};
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

function inspectMicronautProject(project,cancellation) {
  const build=micronautMavenProject(project), java=[], configuration=[];
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
        if (entry.isSymbolicLink()) continue;
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
  return {...build,...modelMicronaut(java,configuration),projectUri:project.uri,resources};
}

module.exports = { modelMicronaut,inspectMicronautProject,micronautMavenProject,CONFIG_FILE,PART };
