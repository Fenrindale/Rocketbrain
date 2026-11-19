'use strict';
const fs=require('node:fs'),path=require('node:path');
const {SaxesParser}=require('saxes');
const {inside}=require('./testing-projects');
const key=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const strip=text=>text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'');
function gradleGrammar(text,{root=false}={}){
 let remainder=strip(text).replace(/\s+/g,'');
 const java="java\\{sourceCompatibility=JavaVersion\\.VERSION_\\d+;?targetCompatibility=JavaVersion\\.VERSION_\\d+;?\\}",compile="tasks\\.withType\\(JavaCompile\\)\\.configureEach\\{options\\.encoding=['\"]UTF-8['\"];?options\\.incremental=false;?\\}";
 if(root){if(!remainder)return;const block=/^subprojects\{([\s\S]*)\}$/.exec(remainder);if(!block)throw Error('Injected root Gradle configuration requires a separate Move review.');remainder=block[1].replace(/applyplugin:['"]java(?:-library)?['"];?/g,'').replace(/repositories\{mavenCentral\(\);?\}/g,'').replace(new RegExp(java,'g'),'').replace(new RegExp(compile,'g'),'');}
 else{remainder=remainder.replace(/dependencies\{([^{}]*)\}/g,(_all,body)=>{const rest=body.replace(/(?:implementation|api|runtimeOnly|testImplementation|testRuntimeOnly)(?:project\(['"]:[A-Za-z_$][\w$-]*['"]\)|platform\(['"][\w$.-]+:[\w$.-]+:[\w$.-]+['"]\)|['"][\w$.-]+:[\w$.-]+(?::[\w$.-]+)?['"]);?/g,'');if(rest)throw Error('Computed, conditional or extended Gradle dependency declarations require a separate Move review.');return '';}).replace(/plugins\{id['"]java(?:-library)?['"];?\}/g,'').replace(/(?:group|version)=['"][\w$.-]+['"];?/g,'').replace(new RegExp(java,'g'),'').replace(new RegExp(compile,'g'),'').replace(/sourceSets\.main\.(?:java|resources)\.srcDir\(['"]src\/[\w$./-]+['"]\);?/g,'').replace(/tasks\.register\(['"]writeClasspath['"]\)\{dependsOnclasses;doLast\{layout\.buildDirectory\.file\(['"]runtime-classpath\.txt['"]\)\.get\(\)\.asFile\.text=sourceSets\.main\.runtimeClasspath\.asPath\}\}/g,'');}
 if(remainder.replace(/;/g,''))throw Error('Computed or unreviewed Gradle build code requires a separate Move review.');
}
function plain(file){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('Move build descriptors must be bounded plain local files.');return fs.readFileSync(file,'utf8');}
function dag(graph){const done=new Set(),visit=(name,active=new Set())=>{if(active.has(name))throw Error('Cyclic project dependencies prevent this Move.');if(done.has(name))return;for(const next of graph.get(name)||[]){if(!graph.has(next))throw Error('A build dependency leaves the reviewed project set.');visit(next,new Set([...active,name]));}done.add(name);};for(const name of graph.keys())visit(name);}
function gradleSettings(configuration) {
 const names=[],included=[];
 const projectName=String.raw`['"]:?[A-Za-z_][\w-]*['"]`;
 const include=new RegExp(`^include\\s+(${projectName}(?:\\s*,\\s*${projectName})*)$`);
 let hasRootName=false;
 for(const sourceLine of strip(configuration).split(/\r?\n/)){
  const line=sourceLine.trim();
  if(!line)continue;
  if(!hasRootName&&/^rootProject\.name\s*=\s*(['"])[\w.-]+\1$/.test(line)){
   hasRootName=true;
   continue;
  }
  const siblings=include.exec(line);
  if(siblings){
   for(const literal of siblings[1].split(',').map(value=>value.trim())){
    if(literal[0]!==literal.at(-1))throw Error('Invalid Gradle project name quotation.');
    names.push(literal.slice(1,-1).replace(/^:/,''));
   }
   continue;
  }
  const composite=/^includeBuild\s*(\()?\s*(['"])([A-Za-z_][\w-]*)\2\s*(\))?$/.exec(line);
  if(composite&&Boolean(composite[1])===Boolean(composite[4])){
   included.push(composite[3]);
   continue;
  }
  throw Error('Computed Gradle settings require a separate Move review.');
 }
 if(!names.length||new Set(names).size!==names.length||names.length>12)throw Error('Move requires up to 12 unique literal sibling Gradle projects.');
 if(new Set([...names,...included]).size!==names.length+included.length||names.length+included.length>12)throw Error('Only unique literal local included Gradle builds are reviewed.');
 return {names,included};
}
function literalGradleBuild(root,overrides){
 const read=file=>overrides?.get(key(file))??plain(file);
 const files=[],roots=new Map(),rawEdges=new Map(),edgeKinds=new Map(),coordinates=new Map(),settings=path.join(root,'settings.gradle'),rootBuild=path.join(root,'build.gradle');
 const {names,included}=gradleSettings(read(settings));files.push(settings,rootBuild);const rootText=strip(read(rootBuild));gradleGrammar(rootText,{root:true});
 for(const name of names)roots.set(name,path.join(root,name));
 for(const name of included){const folder=path.join(root,name),includedSettings=path.join(folder,'settings.gradle'),text=strip(read(includedSettings));files.push(includedSettings);const match=/^\s*rootProject\.name\s*=\s*['"]([\w$.-]+)['"]\s*$/.exec(text.trim());if(!match)throw Error('Included builds require one literal root name without nested settings or substitution rules.');roots.set(name,folder);coordinates.set(name,{artifact:match[1]});}
 for(const [name,folder]of roots){if(!inside(fs.realpathSync(root),fs.realpathSync(folder))||fs.lstatSync(folder).isSymbolicLink())throw Error('Move Gradle projects must remain physically inside the reviewed build.');const file=path.join(folder,'build.gradle'),text=strip(read(file));files.push(file);
  gradleGrammar(text);const edges=[...text.matchAll(/\b(implementation|api)\s+project\s*\(\s*['"]:([A-Za-z_$][\w$-]*)['"]\s*\)/g)];if((text.match(/\bproject\s*\(/g)||[]).length!==edges.length||/\b(?:allprojects|subprojects|apply\s+from|evaluationDependsOn|includeBuild|dependencySubstitution)\b/.test(text))throw Error('Dynamic or non-runtime Gradle dependencies require a separate Move review.');
  if(edges.some(edge=>!names.includes(edge[2])))throw Error('Gradle project(...) dependencies must name projects in this build; included builds require reviewed coordinate substitution.');
  const libraryPlugin=/plugins\s*\{\s*id\s*['"]java-library['"]/.test(text)||!included.includes(name)&&/['"]java-library['"]/.test(rootText);if(/\bapi\s*(?:project|['"])/.test(text)&&!libraryPlugin)throw Error('Gradle api declarations require the reviewed java-library plugin.');rawEdges.set(name,edges.map(m=>m[2]));edgeKinds.set(name,new Map(edges.map(m=>[m[2],edges.some(other=>other[2]===m[2]&&other[1]==='api')?'api':m[1]])));const coordinate=coordinates.get(name);if(coordinate){const group=/^\s*group\s*=\s*['"]([\w$.-]+)['"]\s*$/m.exec(text),version=/^\s*version\s*=\s*['"]([\w$.-]+)['"]\s*$/m.exec(text);if(!group||!version)throw Error('Included Gradle builds require literal group/version coordinates.');Object.assign(coordinate,{group:group[1],version:version[1]});}
 }
 for(const [name,folder]of roots){const text=strip(read(path.join(folder,'build.gradle')));for(const match of text.matchAll(/\b(implementation|api)\s+['"]([\w$.-]+):([\w$.-]+):([\w$.-]+)['"]/g)){for(const [includedName,coordinate]of coordinates)if(match[2]===coordinate.group&&match[3]===coordinate.artifact){if(match[4]!==coordinate.version)throw Error('Composite substitution version must match its reviewed literal included build.');rawEdges.get(name).push(includedName);if(edgeKinds.get(name).get(includedName)!=='api')edgeKinds.get(name).set(includedName,match[1]);}}
 }
 for(const name of included)if(rawEdges.get(name).length)throw Error('Included Gradle leaf builds cannot depend on other reviewed local projects.');const graph=new Map([...rawEdges].map(([name,edges])=>[name,[...new Set(edges)]]));dag(graph);return {kind:included.length?'gradle-composite':'gradle-dag',root,files,roots,graph,edgeKinds};
}
function gradleBuild(root){
 const {names,included}=gradleSettings(plain(path.join(root,'settings.gradle')));
 const contracts=[],variants=[];for(const name of [...new Set([...names,...included])]){const folder=path.join(root,name);if(fs.lstatSync(folder).isSymbolicLink()||!inside(fs.realpathSync(root),fs.realpathSync(folder)))throw Error('Gradle contract projects must remain physically inside the reviewed build.');const file=path.join(folder,'build.gradle'),source=plain(file);if(!/\bdef\b|\bproviders\s*\.\s*gradleProperty\b/.test(source))continue;const normalized=require('./move-build-contracts').normalizeGradleContracts(source);if(!normalized.contract.constants.length&&!normalized.contract.predicates.length)continue;contracts.push({file,...normalized.contract});variants.push({file,texts:normalized.variants});}
 if(!contracts.length)return literalGradleBuild(root);
 let maps=[new Map()];for(const variant of variants){maps=maps.flatMap(previous=>variant.texts.map(text=>new Map([...previous,[key(variant.file),text]])));if(maps.length>16)throw Error('Gradle build contract scenario budget exceeded.');}
 const scenarios=maps.map(overrides=>literalGradleBuild(root,overrides)),first=scenarios[0],graph=new Map([...first.roots.keys()].map(name=>[name,[]])),edgeKinds=new Map([...first.roots.keys()].map(name=>[name,new Map()]));
 for(const scenario of scenarios)for(const [from,targets]of scenario.graph)for(const target of targets){if(!graph.get(from).includes(target))graph.get(from).push(target);const exposure=scenario.edgeKinds.get(from).get(target);if(edgeKinds.get(from).get(target)!=='api')edgeKinds.get(from).set(target,exposure);}
 return {...first,graph,edgeKinds,scenarios,dynamicContracts:{mode:'all-finite-source-branches',scenarioCount:scenarios.length,allScenariosCompileExposureRequired:true,executedBuildCode:false,contracts}};
}
function pom(file) {
 const text=plain(file);
 if(/<!DOCTYPE|<!ENTITY|\$\{|<build\b|<repositories\b/.test(text))throw Error('Dynamic Maven properties, plugins or repositories require a separate Move review.');
 const parser=new SaxesParser({xmlns:false}),stack=[];
 let error,root;
 parser.on('error',value=>{error=value;});
 parser.on('opentag',tag=>{
  const allowedAttributes=stack.length?[]:['xmlns','xmlns:xsi','xsi:schemaLocation'];
  if(Object.keys(tag.attributes).some(name=>!allowedAttributes.includes(name)))throw Error('Unreviewed Maven descriptor attributes require a separate Move review.');
  if(stack.length>12)throw Error('Maven descriptor nesting budget exceeded.');
  stack.push({name:tag.name,text:'',children:[]});
 });
 parser.on('text',value=>{if(stack.length)stack.at(-1).text+=value;});
 parser.on('cdata',()=>{throw Error('Maven descriptor CDATA requires a separate Move review.');});
 parser.on('closetag',()=>{
  const node=stack.pop();
  if(stack.length)stack.at(-1).children.push(node);
  else root=node;
 });
 parser.write(text).close();
 if(error||stack.length||root?.name!=='project')throw Error('Invalid Maven reactor descriptor.');
 const allowed={
  project:['modelVersion','groupId','artifactId','version','packaging','modules','properties','name','description','parent','dependencies','dependencyManagement','profiles'],
  parent:['groupId','artifactId','version','relativePath'],modules:['module'],
  properties:['maven.compiler.release','project.build.sourceEncoding'],
  dependencyManagement:['dependencies'],dependencies:['dependency'],dependency:['groupId','artifactId','version','scope'],
  profiles:['profile'],profile:['id','activation','dependencies','dependencyManagement'],
  activation:['property'],property:['name','value']
 };
 function validate(node) {
  const seen=new Set();
  if(allowed[node.name]&&node.text.trim())throw Error('Mixed Maven descriptor content requires a separate Move review.');
  for(const child of node.children){
   if(!(allowed[node.name]||[]).includes(child.name)||seen.has(child.name)&&!['modules','dependencies','profiles'].includes(node.name))throw Error('Duplicate or unreviewed Maven configuration requires a separate Move review.');
   seen.add(child.name);
   validate(child);
  }
 }
 validate(root);
 const children=(node,name)=>(node?.children||[]).filter(child=>child.name===name);
 const value=(node,name)=>children(node,name)[0]?.text.trim();
 if(value(root,'modelVersion')!=='4.0.0')throw Error('Only the Maven 4.0.0 POM model is reviewed.');
 const literal=value=>typeof value==='string'&&/^[\w.-]+$/.test(value);
 function readDependencies(node,{managed=false}={}) {
  const seen=new Set();
  return children(children(node,'dependencies')[0],'dependency').map(dep=>{
   const group=value(dep,'groupId'),artifact=value(dep,'artifactId'),version=value(dep,'version'),scope=value(dep,'scope');
   if(![group,artifact].every(literal)||(managed||version!==undefined)&&!literal(version)||scope!==undefined&&!['compile','runtime','provided','test'].includes(scope))throw Error('Maven dependencies require literal coordinates, literal managed versions and a reviewed scope.');
   const identity=group+':'+artifact;
   if(seen.has(identity))throw Error('Duplicate Maven dependencies in one declaration layer require a separate Move review.');
   seen.add(identity);
   return {group,artifact,version,scope};
  });
 }
 const readManagement=node=>readDependencies(children(node,'dependencyManagement')[0],{managed:true});
 const parent=children(root,'parent')[0];
 const parentModel=parent?{group:value(parent,'groupId'),artifact:value(parent,'artifactId'),version:value(parent,'version'),relativePath:value(parent,'relativePath')}:null;
 if(parentModel&&parentModel.relativePath!==undefined&&parentModel.relativePath!=='../pom.xml')throw Error('Maven parent paths must identify the reviewed reactor descriptor.');
 const profiles=children(children(root,'profiles')[0],'profile').map(profile=>{
  const id=value(profile,'id'),activation=children(profile,'activation')[0],property=children(activation,'property')[0];
  const name=value(property,'name'),expected=value(property,'value'),dependencies=readDependencies(profile),management=readManagement(profile);
  if(!literal(id)||!literal(name)||expected!==undefined&&!literal(expected)||!dependencies.length&&!management.length)throw Error('Only literal Maven property-activated dependency profiles are reviewed.');
  return {id,property:name,value:expected,dependencies,management};
 });
 if(new Set(profiles.map(profile=>profile.id)).size!==profiles.length)throw Error('Duplicate Maven dependency profile IDs require a separate Move review.');
 return {
  group:value(root,'groupId')||value(parent,'groupId'),artifact:value(root,'artifactId'),version:value(root,'version')||value(parent,'version'),
  packaging:value(root,'packaging'),modules:children(children(root,'modules')[0],'module').map(node=>node.text.trim()),dependencies:readDependencies(root),management:readManagement(root),parent:parentModel,profiles
 };
}
function dependencyIdentity(dep) {
 // The descriptor grammar permits only unclassified default JAR dependencies.
 return dep.group+':'+dep.artifact;
}
function mavenDeclarationLayers(model,profiles) {
 const dependencies=new Map(model.dependencies.map(dep=>[dependencyIdentity(dep),dep]));
 const management=new Map(model.management.map(dep=>[dependencyIdentity(dep),dep]));
 const overrides=[];
 for(const profile of profiles){
  for(const [entries,byIdentity,section] of [
   [profile.dependencies,dependencies,'dependencies'],
   [profile.management,management,'dependencyManagement']
  ]){
   for(const dep of entries){
    const identity=dependencyIdentity(dep);
    if(byIdentity.has(identity))overrides.push({identity,profile:profile.id,section});
    byIdentity.set(identity,dep);
   }
  }
 }
 return {dependencies,management,overrides};
}
function effectiveMavenModel(layers,parent) {
 // A declaration in the child replaces the corresponding inherited declaration.
 // Management fills missing fields after inheritance and profile replacement.
 const declarations=new Map([...(parent?.dependencies||[]),...layers.dependencies]);
 const management=new Map([...(parent?.management||[]),...layers.management]);
 const dependencies=new Map(),managed=[];
 for(const [identity,dep] of declarations){
  const defaults=management.get(identity);
  const version=dep.version??defaults?.version,scope=dep.scope??defaults?.scope??'compile';
  if(version===undefined)throw Error('Maven dependency '+identity+' requires a literal version or a matching reviewed management declaration.');
  dependencies.set(identity,{version,scope});
  const fields=[];
  if(dep.version===undefined)fields.push('version');
  if(dep.scope===undefined&&defaults?.scope!==undefined)fields.push('scope');
  if(fields.length)managed.push({identity,fields});
 }
 const inherited=parent?[...parent.dependencies.keys()].filter(identity=>!layers.dependencies.has(identity)):[];
 return {dependencies,management,managed,inherited};
}
function validateTransitiveManagement(graph,edgeKinds,models,coordinates) {
 for(const [module,model] of models){
  const direct=graph.get(module);
  for(const [identity,managed] of model.management){
   const target=coordinates.get(identity);
   if(!target||direct.includes(target.name))continue;
   // A managed entry alone never creates a direct dependency. Maven may apply
   // it during transitive resolution, which requires a separate review if it
   // could change a reviewed path's version or scope.
   const pending=[...direct],visited=new Set();
   while(pending.length){
    const via=pending.pop();
    if(visited.has(via))continue;
    visited.add(via);
    const scope=edgeKinds.get(via).get(target.name);
    if(scope&&(managed.version!==target.model.version||managed.scope!==undefined&&managed.scope!==scope)){
     throw Error('Maven transitive dependencyManagement changes a reviewed reactor path from '+module+' to '+target.name+'; review mediation separately.');
    }
    pending.push(...graph.get(via));
   }
  }
 }
}
function mavenBuild(root) {
 const file=path.join(root,'pom.xml'),parent=pom(file),roots=new Map(),files=[file],models=new Map();
 if(parent.parent||parent.packaging!=='pom'||![parent.group,parent.artifact,parent.version].every(value=>typeof value==='string'&&/^[\w.-]+$/.test(value))||!parent.modules.length||parent.modules.length>12||parent.modules.some(name=>!/^[$\w-]+$/.test(name))||new Set(parent.modules).size!==parent.modules.length)throw Error('Move requires a bounded literal sibling Maven reactor with one local parent.');
 for(const name of parent.modules){
  const folder=path.join(root,name);
  if(fs.lstatSync(folder).isSymbolicLink()||!inside(fs.realpathSync(root),fs.realpathSync(folder)))throw Error('Maven modules must stay physically inside the reactor.');
  const descriptor=path.join(folder,'pom.xml'),model=pom(descriptor);
  if(model.modules.length||(model.packaging??'jar')!=='jar'||![model.group,model.artifact,model.version].every(value=>typeof value==='string'&&/^[\w.-]+$/.test(value))||model.parent&&(model.parent.group!==parent.group||model.parent.artifact!==parent.artifact||model.parent.version!==parent.version))throw Error('Nested, non-JAR, external-parent or unresolved Maven reactor modules require a separate Move review.');
  if([...models.values()].some(previous=>previous.group===model.group&&previous.artifact===model.artifact))throw Error('Duplicate Maven reactor coordinates prevent Move.');
  roots.set(name,folder);models.set(name,model);files.push(descriptor);
 }
 const coordinates=new Map([...models].map(([name,model])=>[model.group+':'+model.artifact,{name,model}]));
 const profiles=[[null,parent],...models].flatMap(([module,model])=>model.profiles.map(profile=>({module,...profile})));
 if(profiles.length>4)throw Error('Maven dependency profile scenario budget exceeded.');
 function scenario(active) {
  const graph=new Map(),edgeKinds=new Map(),effective=new Map(),modelContracts=[];
  const parentLayers=mavenDeclarationLayers(parent,active.filter(profile=>profile.module===null));
  const overrides=parentLayers.overrides.map(override=>({module:null,...override}));
  const parentModel=effectiveMavenModel(parentLayers);
  for(const [identity,dep] of parentModel.dependencies){
   const target=coordinates.get(identity);
   if(target&&dep.version!==target.model.version)throw Error('Maven profile and base dependencies must use the exact reviewed reactor version.');
   if(target?.model.parent)throw Error('An inherited Maven dependency would make a module depend on itself.');
  }
  for(const [name,model] of models){
   const layers=mavenDeclarationLayers(model,active.filter(profile=>profile.module===name));
   const merged=effectiveMavenModel(layers,model.parent?parentLayers:undefined);
   effective.set(name,merged);
   overrides.push(...layers.overrides.map(override=>({module:name,...override})));
   modelContracts.push({module:name,localParent:Boolean(model.parent),inheritedDependencies:merged.inherited,managedFields:merged.managed});
   const edges=new Map();
   for(const [identity,dep] of merged.dependencies){
    const target=coordinates.get(identity);
    if(!target)continue;
    if(dep.version!==target.model.version)throw Error('Maven profile and base dependencies must use the exact reviewed reactor version.');
    edges.set(target.name,dep.scope);
   }
   edgeKinds.set(name,edges);
   graph.set(name,[...edges.keys()]);
  }
  dag(graph);
  validateTransitiveManagement(graph,edgeKinds,effective,coordinates);
  return {kind:'maven-reactor',root,files,roots,graph,edgeKinds,modelContracts,overrides,activeProfiles:active.map(({module,id})=>({module,id}))};
 }
 if(!profiles.length)return scenario([]);
 // Explicit profile selection and external property values can change activation.
 // Review every subset, even if some subsets cannot be selected together.
 const scenarios=Array.from({length:2**profiles.length},(_,mask)=>scenario(profiles.filter((_,i)=>mask&(1<<i))));
 const graph=new Map([...roots.keys()].map(name=>[name,[...new Set(scenarios.flatMap(s=>s.graph.get(name)))]]));
 const edgeKinds=new Map([...graph].map(([name,edges])=>[name,new Map(edges.map(target=>{
  const scopes=new Set(scenarios.map(value=>value.edgeKinds.get(name).get(target)));
  return [target,scopes.size===1?[...scopes][0]:'varies-by-profile'];
 }))]));
 return {...scenarios[0],graph,edgeKinds,scenarios,dynamicContracts:{mode:'all-finite-maven-profile-subsets',scenarioCount:scenarios.length,
  dependencyMerge:'later-active-declaration-replaces-matching-default-jar',allScenariosCompileExposureRequired:true,executedBuildCode:false,
  profiles:profiles.map(({dependencies,management,...profile})=>profile),scenarios:scenarios.map(({activeProfiles,overrides,modelContracts})=>({activeProfiles,overrides,modelContracts}))}};
}
function findBuild(source,target,workspace){let folder=path.dirname(source);while(inside(workspace,folder)){if(inside(folder,target)){if(fs.existsSync(path.join(folder,'settings.gradle')))return gradleBuild(folder);if(fs.existsSync(path.join(folder,'pom.xml')))return mavenBuild(folder);}if(key(folder)===key(workspace)||path.dirname(folder)===folder)break;folder=path.dirname(folder);}throw Error('Cross-project Move requires a reviewed literal Gradle DAG/composite or Maven reactor.');}
function reachable(graph,from,to,seen=new Set()){if(from===to)return true;if(seen.has(from))return false;seen.add(from);return (graph.get(from)||[]).some(next=>reachable(graph,next,to,seen));}
function transitiveMavenScope(parent,dependency) {
 if(parent===undefined)return dependency;
 if(dependency==='provided'||dependency==='test')return null;
 if(parent==='provided'||parent==='test')return parent;
 if(parent==='runtime'||dependency==='runtime')return 'runtime';
 return 'compile';
}
function mavenExposure(build,from,to) {
 if(from===to)return {possible:true,guaranteed:true,testVisible:true};
 const direct=build.edgeKinds.get(from)?.get(to);
 if(direct==='compile'||direct==='provided')return {possible:true,guaranteed:true,testVisible:true};
 const seen=new Set();
 let possible=false,competing=false,testVisible=false;
 function visit(name,scope) {
  if(name===to){
   testVisible=true;
   if(scope==='compile'||scope==='provided')possible=true;
   else competing=true;
   return;
  }
  const state=name+':'+scope;
  if(seen.has(state))return;
  seen.add(state);
  for(const [next,dependency] of build.edgeKinds.get(name)||[]){
   const derived=transitiveMavenScope(scope,dependency);
   if(derived!==null)visit(next,derived);
  }
 }
 visit(from,undefined);
 // A restricted direct or competing path may affect Maven's effective
 // scope. Retain a potential client while withholding destination proof.
 return {possible,guaranteed:possible&&!competing,testVisible};
}
function compileReachable(build,from,to){if(build.scenarios)return build.scenarios.every(scenario=>compileReachable(scenario,from,to));if(build.kind==='maven-reactor')return mavenExposure(build,from,to).guaranteed;const visit=(name,first,seen=new Set())=>{if(name===to)return true;if(seen.has(name))return false;seen.add(name);return (build.graph.get(name)||[]).some(next=>(first||build.edgeKinds.get(name)?.get(next)==='api')&&visit(next,false,new Set(seen)));};return visit(from,true);}

function moveClientProof(build,source,target){
 if(!build?.roots?.has(source)||!build.roots.has(target))throw Error('Move client contracts require known reviewed source and destination projects.');
 const scenarios=build.scenarios||[build];if(!Array.isArray(scenarios)||!scenarios.length||scenarios.length>16)throw Error('Move client contract scenario coverage is incomplete.');
 const names=[...build.roots.keys()],reviewedClients=[];for(const scenario of scenarios)if(!scenario.roots||JSON.stringify([...scenario.roots.keys()].sort())!==JSON.stringify([...names].sort()))throw Error('Move client contracts require identical reviewed project membership in every scenario.');
 const maven=build.kind==='maven-reactor';
 for(const project of names){
  const sourceCoverage=maven?scenarios.map(scenario=>mavenExposure(scenario,project,source)):null;
  const targetCoverage=maven?scenarios.map(scenario=>mavenExposure(scenario,project,target)):null;
  const sourceExposureByScenario=maven?sourceCoverage.map(value=>value.possible):scenarios.map(scenario=>compileReachable(scenario,project,source));
  const destinationExposureByScenario=maven?targetCoverage.map(value=>value.guaranteed):scenarios.map(scenario=>compileReachable(scenario,project,target));
  const sourceExposedInAnyScenario=sourceExposureByScenario.some(Boolean);
  const destinationExposedInEveryScenario=destinationExposureByScenario.every(Boolean);
  if(sourceExposedInAnyScenario&&!destinationExposedInEveryScenario)throw Error('Move would hide the destination from reviewed compile client '+project+'. Every finite build scenario must compile-expose the destination to each possible source client.');
  const review={project,sourceExposedInAnyScenario,destinationExposedInEveryScenario,sourceExposureByScenario,destinationExposureByScenario};
  if(maven){
   review.sourceTestExposureByScenario=sourceCoverage.map(value=>value.testVisible);
   review.destinationTestExposureByScenario=targetCoverage.map(value=>value.testVisible);
   if(review.sourceTestExposureByScenario.some(Boolean)&&!review.destinationTestExposureByScenario.every(Boolean))throw Error('Move would hide the destination from reviewed Maven test client '+project+'. Every finite build scenario must expose the destination to each possible test client.');
  }
  reviewedClients.push(review);
 }
 return {mode:'all-reviewed-source-client-compile-exposure',source,target,scenarioCount:scenarios.length,policy:'Any source exposure scenario requires destination exposure in every scenario.',reviewedClients,executedBuildCode:false,...(maven?{mavenTestClasspathReviewed:true}:{})};
}
module.exports={gradleBuild,literalGradleBuild,mavenBuild,findBuild,reachable,compileReachable,moveClientProof,dag,gradleGrammar};
