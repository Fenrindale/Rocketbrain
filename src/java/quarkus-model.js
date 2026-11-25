'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { parseJavaFile,literal,rangeAt } = require('../spring/java');
const { parseProperties } = require('../spring/configuration');
const { mavenTasks } = require('./workbench-tasks');
const { fail,inside,cancelled,buildFingerprint } = require('./workbench-model');

const PROPERTY=/^[A-Za-z][A-Za-z0-9._-]{0,159}$/;
const PROFILE=/^[A-Za-z][A-Za-z0-9-]{0,45}$/;
const VERBS=['GET','POST','PUT','DELETE','PATCH','HEAD','OPTIONS'];
const CONFIG='org.eclipse.microprofile.config.inject.ConfigProperty';
const MAPPING='io.smallrye.config.ConfigMapping';
const byName=(items,name) => items.find(item => item.name === name);
const normalized=text => text.replace(/\r\n/g,'\n');
const kebab=value => value.replace(/([a-z0-9])([A-Z])/g,'$1-$2').toLowerCase();

function quarkusMavenProject(project) {
  if (project.tool !== 'maven') throw fail('Choose an imported Maven Quarkus application.');
  const candidates = mavenTasks(project).map(item =>
    /^((?:io\.quarkus\.platform|io\.quarkus):quarkus-maven-plugin:(3\.\d+\.\d+(?:\.\d+)?)):(?:build|generate-code|generate-code-tests|dev)$/.exec(item.name)
  ).filter(Boolean);
  const plugins=new Set(candidates.map(match => match[1]));
  if (plugins.size !== 1) throw fail('Observe one explicit Quarkus 3 Maven plugin coordinate in the module POM.');
  return {plugin:candidates[0][1],version:candidates[0][2],buildFingerprint:buildFingerprint(project.root)};
}

function pathFragment(annotation) {
  const value = literal(annotation,'value',annotation ? undefined : '');
  return typeof value === 'string' && /^[A-Za-z0-9_{}./-]*$/.test(value) &&
    !value.split('/').some(part => part === '..' || part === '.') ? value : undefined;
}

function profileKey(text) {
  if (!text.startsWith('%')) return PROPERTY.test(text) ? {key:text,profile:''} : null;
  const dot=text.indexOf('.');
  const profile=text.slice(1,dot), key=text.slice(dot+1);
  return PROFILE.test(profile) && PROPERTY.test(key) ? {key,profile} : null;
}

function modelQuarkus(sources,properties) {
  const configuration=[],endpoints=[],templates=[],issues=[];
  for (const source of sources) {
    const file={...source,text:normalized(source.text)}, parsed=parseJavaFile(file);
    const sourceOf = member => ({uri:file.uri,range:rangeAt(file.text,member.start,member.end)});
    const register = (member,annotated) => {
      const key=literal(annotated,'name');
      if (typeof key !== 'string' || !PROPERTY.test(key)) {
        issues.push({message:'MicroProfile ConfigProperty requires a literal name for navigation.',source:sourceOf(member)});
        return;
      }
      configuration.push({kind:'configProperty',key,type:member.type.raw,hasDefault:annotated.attributes.defaultValue!==undefined,
        source:sourceOf(member)});
    };
    for (const type of parsed.types) {
      const mapping=byName(type.annotations,MAPPING);
      if (mapping && type.kind === 'interface') {
        const prefix=literal(mapping,'prefix','');
        if (typeof prefix !== 'string' || prefix && !PROPERTY.test(prefix) || mapping.attributes.namingStrategy) {
          issues.push({message:'ConfigMapping needs a literal prefix and default naming strategy.',source:sourceOf(type)});
        } else for (const method of type.methods) {
          if (method.parameters.length || type.methods.some(item =>
            item !== method && item.name === method.name) ||
            byName(method.annotations,'io.smallrye.config.WithParentName')) continue;
          const named=byName(method.annotations,'io.smallrye.config.WithName');
          const standardName=/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)*$/.test(method.name) ? kebab(method.name) : undefined;
          const suffix=literal(named,'value',named ? undefined : standardName);
          if (typeof suffix !== 'string' || !PROPERTY.test(suffix) ||
              !/^(?:boolean|byte|short|int|long|float|double|String|java\.lang\.String|Boolean|Integer|Long|Double)$/.test(method.type.raw)) continue;
          configuration.push({kind:'configMapping',key:prefix ? prefix+'.'+suffix : suffix,type:method.type.raw,
            hasDefault:Boolean(byName(method.annotations,'io.smallrye.config.WithDefault')),source:sourceOf(method)});
        }
      }
      for (const field of type.fields) {
        const property=byName(field.annotations,CONFIG);
        if (property) register(field,property);
        const location=byName(field.annotations,'io.quarkus.qute.Location'), name=literal(location,'value');
        if (location && field.type.name === 'io.quarkus.qute.Template' && typeof name === 'string' &&
            /^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/.test(name)) {
          templates.push({name,source:sourceOf(field)});
        }
      }
      const at=byName(type.annotations,'jakarta.ws.rs.Path');
      const base=pathFragment(at);
      for (const method of type.methods) {
        for (const parameter of method.parameters) {
          const property=byName(parameter.annotations,CONFIG);
          if (property) register(parameter,property);
        }
        const suffix=pathFragment(byName(method.annotations,'jakarta.ws.rs.Path'));
        const verb=VERBS.find(value => byName(method.annotations,'jakarta.ws.rs.'+value));
        if (!at || base===undefined || suffix===undefined || !verb) continue;
        endpoints.push({verb,path:('/'+base+'/'+suffix).replace(/\/{2,}/g,'/').replace(/\/$/,'') || '/',
          method:method.name,source:sourceOf(method)});
      }
    }
  }
  const configured=properties ? parseProperties({...properties,text:normalized(properties.text)}).entries.flatMap(item => {
    const name=profileKey(item.key);
    return name ? [{...name,uri:item.uri,range:item.range}] : [];
  }) : [];
  return {configuration:configuration.sort((a,b) => a.key.localeCompare(b.key)),configured,endpoints,templates,issues};
}

function inspectQuarkusProject(project,cancellation) {
  const model=quarkusMavenProject(project), root=project.root;
  const base=path.join(root,'src/main/java'), propertiesFile=path.join(root,'src/main/resources/application.properties');
  const sources=[];
  let entries=0, size=0;
  function readPhysical(file,max=512*1024) {
    const real=fs.realpathSync(file), stat=fs.lstatSync(file);
    if (!inside(root,real) || path.relative(file,real) || !stat.isFile() || stat.isSymbolicLink() || stat.size > max) {
      throw fail('Quarkus analysis uses bounded physical files inside the selected project.');
    }
    const data=fs.readFileSync(file);
    if (data.length > max || (size+=data.length)>8*1024*1024) throw fail('Quarkus source inputs exceed their byte limit.');
    return new TextDecoder('utf-8',{fatal:true}).decode(data);
  }
  function walk(directory,depth) {
    if (depth>32 || path.relative(directory,fs.realpathSync(directory))) throw fail('Unsupported Quarkus source directory.');
    const handle=fs.opendirSync(directory);
    try {
      for (let item; (item=handle.readSync()) !== null;) {
        if (++entries>10000 || cancelled(cancellation)) throw fail('Quarkus inspection exceeded its directory limit or was cancelled.');
        const file=path.join(directory,item.name);
        if (item.isSymbolicLink()) continue;
        if (item.isDirectory()) walk(file,depth+1);
        else if (item.isFile() && file.endsWith('.java')) {
          if (sources.length>=240) throw fail('Inspect at most 240 Quarkus Java sources.');
          sources.push({uri:pathToFileURL(file).href,text:readPhysical(file)});
        }
      }
    } finally { handle.closeSync(); }
  }
  if (fs.existsSync(base)) walk(base,0);
  const properties=fs.existsSync(propertiesFile)
    ? {uri:pathToFileURL(propertiesFile).href,text:readPhysical(propertiesFile)} : undefined;
  const report=modelQuarkus(sources,properties);
  for (const template of report.templates) {
    const file=path.join(root,'src/main/resources/templates',template.name);
    if (fs.existsSync(file)) {
      readPhysical(file);
      template.uri=pathToFileURL(file).href;
    }
  }
  return {...model,...report,projectUri:project.uri,propertiesFile};
}

module.exports = { modelQuarkus,inspectQuarkusProject,quarkusMavenProject,profileKey };
