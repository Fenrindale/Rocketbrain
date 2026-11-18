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
  project:['modelVersion','groupId','artifactId','version','packaging','modules','properties','name','description','parent','dependencies','profiles'],
  parent:['groupId','artifactId','version','relativePath'],modules:['module'],
  properties:['maven.compiler.release','project.build.sourceEncoding'],
  dependencies:['dependency'],dependency:['groupId','artifactId','version','scope'],
  profiles:['profile'],profile:['id','activation','dependencies'],
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
 const literal=value=>typeof value==='string'&&/^[\w.-]+$/.test(value);
 function readDependencies(node) {
  return children(children(node,'dependencies')[0],'dependency').map(dep=>{
   const group=value(dep,'groupId'),artifact=value(dep,'artifactId'),version=value(dep,'version'),scope=value(dep,'scope');
   if(![group,artifact,version].every(literal)||scope!==undefined&&!['compile','runtime','provided','test'].includes(scope))throw Error('Maven dependencies require explicit literal coordinates and a reviewed scope.');
   return {group,artifact,version,scope};
  });
 }
 const parent=children(root,'parent')[0];
 const parentModel=parent?{group:value(parent,'groupId'),artifact:value(parent,'artifactId'),version:value(parent,'version'),relativePath:value(parent,'relativePath')}:null;
 if(parentModel&&parentModel.relativePath!==undefined&&parentModel.relativePath!=='../pom.xml')throw Error('Maven parent paths must identify the reviewed reactor descriptor.');
 const profiles=children(children(root,'profiles')[0],'profile').map(profile=>{
  const id=value(profile,'id'),activation=children(profile,'activation')[0],property=children(activation,'property')[0];
  const name=value(property,'name'),expected=value(property,'value'),dependencies=readDependencies(profile);
  if(!literal(id)||!literal(name)||expected!==undefined&&!literal(expected)||!dependencies.length)throw Error('Only literal Maven property-activated dependency profiles are reviewed.');
  return {id,property:name,value:expected,dependencies};
 });
 if(new Set(profiles.map(profile=>profile.id)).size!==profiles.length)throw Error('Duplicate Maven dependency profile IDs require a separate Move review.');
 return {
  group:value(root,'groupId')||value(parent,'groupId'),artifact:value(root,'artifactId'),version:value(root,'version')||value(parent,'version'),
  modules:children(children(root,'modules')[0],'module').map(node=>node.text.trim()),dependencies:readDependencies(root),parent:parentModel,profiles
 };
}
function mavenBuild(root) {
 const file=path.join(root,'pom.xml'),parent=pom(file),roots=new Map(),files=[file],models=new Map();
 if(parent.parent||parent.dependencies.length||parent.profiles.length||!parent.modules.length||parent.modules.length>12||parent.modules.some(name=>!/^[$\w-]+$/.test(name))||new Set(parent.modules).size!==parent.modules.length)throw Error('Move requires a bounded literal sibling Maven reactor without inherited dependencies or profiles.');
 for(const name of parent.modules){
  const folder=path.join(root,name);
  if(fs.lstatSync(folder).isSymbolicLink()||!inside(fs.realpathSync(root),fs.realpathSync(folder)))throw Error('Maven modules must stay physically inside the reactor.');
  const descriptor=path.join(folder,'pom.xml'),model=pom(descriptor);
  if(model.modules.length||![model.group,model.artifact,model.version].every(value=>typeof value==='string'&&/^[\w.-]+$/.test(value))||model.parent&&(model.parent.group!==parent.group||model.parent.artifact!==parent.artifact||model.parent.version!==parent.version))throw Error('Nested, external-parent or unresolved Maven reactor coordinates require a separate Move review.');
  if([...models.values()].some(previous=>previous.group===model.group&&previous.artifact===model.artifact))throw Error('Duplicate Maven reactor coordinates prevent Move.');
  roots.set(name,folder);models.set(name,model);files.push(descriptor);
 }
 const coordinates=new Map([...models].map(([name,model])=>[model.group+':'+model.artifact,{name,model}]));
 const profiles=[...models].flatMap(([module,model])=>model.profiles.map(profile=>({module,...profile})));
 if(profiles.length>4)throw Error('Maven dependency profile scenario budget exceeded.');
 function scenario(active) {
  const graph=new Map();
  for(const [name,model] of models){
   const dependencies=[...model.dependencies,...active.filter(profile=>profile.module===name).flatMap(profile=>profile.dependencies)];
   const seen=new Set(),edges=[];
   for(const dep of dependencies){
    const identity=dep.group+':'+dep.artifact;
    if(seen.has(identity))throw Error('Maven profile dependency overrides require a separate Move review.');
    seen.add(identity);
    const target=coordinates.get(identity);
    if(!target)continue;
    if(dep.version!==target.model.version||dep.scope&&dep.scope!=='compile')throw Error('Only exact compile-scope Maven reactor dependencies are reviewed.');
    edges.push(target.name);
   }
   graph.set(name,edges);
  }
  dag(graph);
  return {kind:'maven-reactor',root,files,roots,graph};
 }
 if(!profiles.length)return scenario([]);
 // Explicit profile selection and external property values can change activation.
 // Review every subset, even if some subsets cannot be selected together.
 const scenarios=Array.from({length:2**profiles.length},(_,mask)=>scenario(profiles.filter((_,i)=>mask&(1<<i))));
 const graph=new Map([...roots.keys()].map(name=>[name,[...new Set(scenarios.flatMap(s=>s.graph.get(name)))]]));
 return {...scenarios[0],graph,scenarios,dynamicContracts:{mode:'all-finite-maven-profile-subsets',scenarioCount:scenarios.length,allScenariosCompileExposureRequired:true,executedBuildCode:false,profiles:profiles.map(({dependencies,...profile})=>profile)}};
}
function findBuild(source,target,workspace){let folder=path.dirname(source);while(inside(workspace,folder)){if(inside(folder,target)){if(fs.existsSync(path.join(folder,'settings.gradle')))return gradleBuild(folder);if(fs.existsSync(path.join(folder,'pom.xml')))return mavenBuild(folder);}if(key(folder)===key(workspace)||path.dirname(folder)===folder)break;folder=path.dirname(folder);}throw Error('Cross-project Move requires a reviewed literal Gradle DAG/composite or Maven reactor.');}
function reachable(graph,from,to,seen=new Set()){if(from===to)return true;if(seen.has(from))return false;seen.add(from);return (graph.get(from)||[]).some(next=>reachable(graph,next,to,seen));}
function compileReachable(build,from,to){if(build.scenarios)return build.scenarios.every(scenario=>compileReachable(scenario,from,to));if(build.kind==='maven-reactor')return reachable(build.graph,from,to);const visit=(name,first,seen=new Set())=>{if(name===to)return true;if(seen.has(name))return false;seen.add(name);return (build.graph.get(name)||[]).some(next=>(first||build.edgeKinds.get(name)?.get(next)==='api')&&visit(next,false,new Set(seen)));};return visit(from,true);}

function moveClientProof(build,source,target){
 if(!build?.roots?.has(source)||!build.roots.has(target))throw Error('Move client contracts require known reviewed source and destination projects.');
 const scenarios=build.scenarios||[build];if(!Array.isArray(scenarios)||!scenarios.length||scenarios.length>16)throw Error('Move client contract scenario coverage is incomplete.');
 const names=[...build.roots.keys()],reviewedClients=[];for(const scenario of scenarios)if(!scenario.roots||JSON.stringify([...scenario.roots.keys()].sort())!==JSON.stringify([...names].sort()))throw Error('Move client contracts require identical reviewed project membership in every scenario.');
 for(const project of names){const sourceExposureByScenario=scenarios.map(scenario=>compileReachable(scenario,project,source)),destinationExposureByScenario=scenarios.map(scenario=>compileReachable(scenario,project,target)),sourceExposedInAnyScenario=sourceExposureByScenario.some(Boolean),destinationExposedInEveryScenario=destinationExposureByScenario.every(Boolean);if(sourceExposedInAnyScenario&&!destinationExposedInEveryScenario)throw Error('Move would hide the destination from reviewed compile client '+project+'. Every finite build scenario must compile-expose the destination to each possible source client.');reviewedClients.push({project,sourceExposedInAnyScenario,destinationExposedInEveryScenario,sourceExposureByScenario,destinationExposureByScenario});}
 return {mode:'all-reviewed-source-client-compile-exposure',source,target,scenarioCount:scenarios.length,policy:'Any source exposure scenario requires destination exposure in every scenario.',reviewedClients,executedBuildCode:false};
}
module.exports={gradleBuild,literalGradleBuild,mavenBuild,findBuild,reachable,compileReachable,moveClientProof,dag,gradleGrammar};
