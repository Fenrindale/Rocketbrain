'use strict';
const {SaxesParser}=require('saxes'),{fail,sha}=require('./project-client');
const {inspectCatalogBuild}=require('./project-gradle-catalog');
const VERSION=/^\d+\.\d+\.\d+(?:[.\-][A-Za-z0-9.\-]+)?$/;
function xml(text){if(Buffer.byteLength(text)>1024*1024||/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text))throw fail('BUILD','Use a bounded POM without DTD, entities or CDATA.');let nodes=0;const parser=new SaxesParser();parser.on('error',()=>{throw fail('BUILD','The POM is not well-formed XML.');});parser.on('opentag',()=>{if(++nodes>20000)throw fail('BUILD','The POM exceeds its node limit.');});parser.write(text).close();const root={children:[]},stack=[root];let offset=0;while(offset<text.length){const start=text.indexOf('<',offset);if(start<0)break;if(text.startsWith('<!--',start)){const end=text.indexOf('-->',start+4);if(end<0)throw fail('BUILD','Unclosed XML comment.');offset=end+3;continue;}if(text.startsWith('<?',start)){offset=text.indexOf('?>',start+2)+2;continue;}let end=start+1,quote;for(;end<text.length;end++){const c=text[end];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}const token=text.slice(start,end+1),closing=/^<\//.test(token),name=/^<\/?([A-Za-z_][\w.:-]*)/.exec(token)?.[1];if(!name||name.includes(':'))throw fail('BUILD','Use ordinary unprefixed Maven POM elements.');if(closing){const node=stack.pop();if(node?.name!==name)throw fail('BUILD','Unsupported POM nesting.');node.closeStart=start;node.end=end+1;}else{const node={name,start,openEnd:end+1,children:[]};stack.at(-1).children.push(node);if(/\/\s*>$/.test(token)){node.selfClosing=true;node.closeStart=start+token.lastIndexOf('/');node.end=end+1;}else stack.push(node);}offset=end+1;}if(stack.length!==1||root.children.length!==1||root.children[0].name!=='project')throw fail('BUILD','Select one ordinary Maven project.');return root.children[0];}
const child=(node,name)=>{const items=node.children.filter(v=>v.name===name);if(items.length>1)throw fail('BUILD','Duplicate build configuration elements are unsupported.');return items[0];};
function content(text,node){return !node||node.selfClosing||node.children.length?null:text.slice(node.openEnd,node.closeStart).trim();}
function value(text,node){const result=content(text,node);return result&&/^[A-Za-z0-9_.\-]+$/.test(result)?result:null;}
const BOOT_GROUP='org.springframework.boot',BOOT_BOM='spring-boot-dependencies',BOOT_PARENT='spring-boot-starter-parent';
const localProperty=/^\$\{([A-Za-z][\w.-]{0,79})\}$/;
const mavenReserved=/^(?:(?:env|project|pom|settings|maven|session|java|user|system)\.|(?:basedir|project|pom|settings|session)$)/;
const ordinaryScopes=new Set(['compile','runtime','test']);

function managementVersion(text,root,expression){
 const property=localProperty.exec(expression||'')?.[1]||null;
 let version=expression;
 if(property){
  const properties=child(root,'properties');
  version=properties&&!mavenReserved.test(property)?value(text,child(properties,property)):null;
 }
 if(!version||version.length>80||!VERSION.test(version))throw fail('BUILD','Use a literal Boot BOM version or a uniquely declared literal property in this POM.');
 return {version,expression,property};
}

function supplementalManagement(source,expected){
 const raw=new TextDecoder('utf-8',{fatal:true}).decode(source.bytes),root=xml(raw);
 if(value(raw,child(root,'groupId'))!==expected.group||value(raw,child(root,'artifactId'))!==expected.artifact||
    value(raw,child(root,'version'))!==expected.version||value(raw,child(root,'packaging'))!=='pom'||
    ['parent','profiles','build','dependencies'].some(name=>child(root,name))) {
  throw fail('BUILD','Review a literal supplemental BOM with the exact pinned POM identity.');
 }
 return managementEntries(raw,root).map(entry=>{
  const {coordinate,type,scope,expression}=entry;
  const property=localProperty.exec(expression||'')?.[1];
  const properties=property&&child(root,'properties');
  const version=property?(properties&&!mavenReserved.test(property)?value(raw,child(properties,property)):null):expression;
  if(type!=='jar'||!ordinaryScopes.has(scope)||!version||version.length>80||!/^[A-Za-z0-9_.-]+$/.test(version))
   throw fail('BUILD','Supplemental BOMs need reviewed literal JAR management without nested imports.');
  return {coordinate,version,source:source.id};
 });
}

function managementEntries(text,root){
 const management=child(root,'dependencyManagement'),dependencies=management&&child(management,'dependencies');
 if(!dependencies||management.children.length!==1)throw fail('BUILD','Use a direct Spring Boot BOM import in dependency management.');
 const seen=new Set();
 return dependencies.children.map(node=>{
  if(node.name!=='dependency'||node.children.some(item=>!['groupId','artifactId','version','scope','type'].includes(item.name)))
   throw fail('BUILD','Use simple literal entries in Maven dependency management.');
  const group=value(text,child(node,'groupId')),artifact=value(text,child(node,'artifactId'));
  const typeNode=child(node,'type'),scopeNode=child(node,'scope');
  const type=typeNode?value(text,typeNode):'jar',scope=scopeNode?value(text,scopeNode):'compile';
  if(!group||!artifact||!type||!scope)throw fail('BUILD','Use literal Maven management coordinates, types and scopes.');
  const coordinate=group+':'+artifact;
  if(seen.has(coordinate))throw fail('BUILD','Duplicate Maven management coordinates are unsupported.');
  seen.add(coordinate);
  return {group,artifact,type,scope,coordinate,expression:content(text,child(node,'version'))};
 });
}

function mavenManagement(text,root,context){
 const parent=child(root,'parent'),management=child(root,'dependencyManagement');
 if(parent){
  if(value(text,child(parent,'groupId'))!==BOOT_GROUP||value(text,child(parent,'artifactId'))!==BOOT_PARENT)
   throw fail('BUILD','Choose a direct Spring Boot parent or a parentless POM with one Spring Boot BOM import.');
  const version=value(text,child(parent,'version'));
  if(!version||version.length>80||!VERSION.test(version))throw fail('BUILD','Resolve the Spring Boot parent version explicitly before editing starters.');
  if(management)throw fail('BUILD','Dependency management layered on a Spring Boot parent requires a separate Maven model review.');
  return {kind:'boot-parent',coordinate:BOOT_GROUP+':'+BOOT_PARENT,version,expression:version,property:null,overrides:[]};
 }
 let controlling;
 const overrides=[],supplemental=[],supplementalOverrides=[];
 for(const {group,artifact,type,scope,coordinate,expression} of managementEntries(text,root)){
  if(group===BOOT_GROUP&&artifact===BOOT_BOM){
   if(type!=='pom'||scope!=='import')throw fail('BUILD','The Spring Boot BOM requires pom type and import scope.');
   controlling={kind:'boot-bom-import',coordinate,...managementVersion(text,root,expression)};
   continue;
  }
  if(type==='pom'&&scope==='import'&&typeof context?.readMavenBom==='function'){
   const {version,property}=managementVersion(text,root,expression);
   const dependency={group,artifact,version};
   const source=context.readMavenBom(dependency);
   supplemental.push({coordinate:source.id,sha256:source.sha256,property});
   supplementalOverrides.push(...supplementalManagement(source,dependency));
   continue;
  }
  if(type!=='jar'||!ordinaryScopes.has(scope)||!expression||expression.length>80||!/^[A-Za-z0-9_.-]+$/.test(expression))
   throw fail('BUILD','Additional BOM imports or dynamic management overrides require a separate Maven model review.');
  overrides.push({coordinate,version:expression});
 }
 if(!controlling)throw fail('BUILD','Use one direct Spring Boot BOM import in dependency management.');
 return {...controlling,overrides:[...overrides,...supplementalOverrides],...(supplemental.length&&{supplemental})};
}

function mavenParentReference(text,root=xml(text)){
 const block=child(root,'parent');
 if(!block)return undefined;
 const group=value(text,child(block,'groupId')),artifact=value(text,child(block,'artifactId')),version=value(text,child(block,'version'));
 if(!group||!artifact||!version||version.length>80||version.endsWith('-SNAPSHOT'))
  throw fail('BUILD','Use exact release coordinates for the Maven parent being reviewed.');
 const relative=child(block,'relativePath');
 const relativePath=relative?(relative.selfClosing?'':content(text,relative)):'../pom.xml';
 if(relativePath===null || relativePath.length>180 ||
    (relativePath && (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(relativePath) || relativePath==='.' || relativePath==='..')))
  throw fail('BUILD','Use a literal relative Maven parent POM within the open reactor.');
 return {group,artifact,version,relativePath,officialBoot:group===BOOT_GROUP&&artifact===BOOT_PARENT};
}

function mavenDependencies(text,root){
 const block=child(root,'dependencies'),deps=[];
 for(const node of block?.children||[]){
  if(node.name!=='dependency')throw fail('BUILD','Unsupported direct dependency structure.');
  const groupId=value(text,child(node,'groupId')),artifactId=value(text,child(node,'artifactId'));
  const scopeNode=child(node,'scope'),scope=scopeNode?value(text,scopeNode):'compile',version=value(text,child(node,'version'));
  if(!groupId||!artifactId||!scope)throw fail('BUILD','Direct dependency coordinates and scopes must be literal.');
  const editable=ordinaryScopes.has(scope)&&node.children.every(item=>['groupId','artifactId','scope'].includes(item.name));
  deps.push({groupId,artifactId,scope,version,editable,start:node.start,end:node.end});
 }
 return {block,deps};
}

function mavenProfiles(text,root){
 const block=child(root,'profiles');
 const profiles=block?.children||[];
 if(profiles.length>16)throw fail('BUILD','Use at most sixteen explicitly selected Maven profiles.');
 const byId=new Map();
 for(const profile of profiles){
  if(profile.name!=='profile'||profile.children.some(node=>!['id','dependencies'].includes(node.name)))
   throw fail('BUILD','Only literal Maven profiles containing direct dependencies can be edited here.');
  const id=value(text,child(profile,'id'));
  if(!id||id.length>80||byId.has(id))throw fail('BUILD','Use distinct literal Maven profile IDs.');
  byId.set(id,{node:profile,...mavenDependencies(text,profile)});
 }
 return byId;
}

function inheritedMavenModel(text,root,parents,context){
 if(!Array.isArray(parents)||!parents.length||parents.length>4)
  throw fail('BUILD','Review the physical local Maven parents before editing inherited starters.');
 let required=mavenParentReference(text,root), terminal;
 const inherited=[],descendants=[root],chain=[];
 for(const [index,source] of parents.entries()){
  const parsed=xml(source.text), reference=mavenParentReference(source.text,parsed);
  const groupElement=child(parsed,'groupId'),versionElement=child(parsed,'version');
  const group=groupElement?value(source.text,groupElement):reference?.group;
  const version=versionElement?value(source.text,versionElement):reference?.version;
  const artifact=value(source.text,child(parsed,'artifactId'));
  if(!required || required.officialBoot || group!==required.group || artifact!==required.artifact || version!==required.version ||
     value(source.text,child(parsed,'packaging'))!=='pom' || child(parsed,'profiles'))
   throw fail('BUILD','The local Maven parent identity, literal POM packaging, or profile scope needs review.');
  chain.push({coordinate:[group,artifact,version].join(':'),source:source.name});
  inherited.push(...mavenDependencies(source.text,parsed).deps.map(dependency=>({...dependency,editable:false,inherited:true})));
  if(index===parents.length-1){
   if(reference)throw fail('BUILD','End the local Maven chain at a parentless POM importing the Spring Boot BOM.');
   terminal=mavenManagement(source.text,parsed,context);
  }else{
   if(child(parsed,'dependencyManagement'))throw fail('BUILD','Layered Maven dependency management in an intermediate parent needs a separate review.');
   descendants.push(parsed);
  }
  required=reference;
 }
 if(child(root,'dependencyManagement'))throw fail('BUILD','Layered child dependency management needs a separate Maven model review.');
 const importedVersions=[terminal.property,...(terminal.supplemental||[]).map(item=>item.property)].filter(Boolean);
 if(importedVersions.length && descendants.some(parsed=>{
  const properties=child(parsed,'properties');
  return properties && importedVersions.some(name=>child(properties,name));
 }))throw fail('BUILD','A child or intermediate POM redefines the inherited Boot BOM version property.');
 return {management:{...terminal,kind:'inherited-boot-bom',chain},inherited};
}

function pom(text,context){
 const root=xml(text);
 if(child(root,'modules'))throw fail('BUILD','Select an application POM within the Maven reactor.');
 const profiles=mavenProfiles(text,root),selected=context?.mavenProfile;
 if(selected!==undefined&&!profiles.has(selected))throw fail('BUILD','Choose an explicit Maven profile from this POM.');
 const target=selected===undefined?{node:root,...mavenDependencies(text,root)}:profiles.get(selected);
 const {block,deps}=target;
 const neighbors=selected===undefined?[]:[mavenDependencies(text,root)];
 for(const [id,profile] of profiles)if(id!==selected)neighbors.push(profile);
 for(const neighbor of neighbors)deps.push(...neighbor.deps.map(dependency=>({...dependency,editable:false})));
 const resolved=context?.mavenParents?.length?inheritedMavenModel(text,root,context.mavenParents,context):null;
 const management=resolved?.management||mavenManagement(text,root,context);
 if(resolved)deps.push(...resolved.inherited);
 return {kind:'maven',bootVersion:management.version,management,deps,block,root,insertAt:block?block.closeStart:target.node.closeStart,
  mavenProfiles:[...profiles.keys()],mavenProfile:selected,...((resolved||profiles.size||management.supplemental)&&{mavenContext:context})};
}
function tokens(text){if(Buffer.byteLength(text)>1024*1024)throw fail('BUILD','The build file exceeds1MiB.');const result=[];let i=0;while(i<text.length){const c=text[i];if(/\s/.test(c)){i++;continue;}if(text.startsWith('//',i)){i=text.indexOf('\n',i+2);if(i<0)break;continue;}if(text.startsWith('/*',i)){const end=text.indexOf('*/',i+2);if(end<0)throw fail('BUILD','Unclosed build comment.');i=end+2;continue;}if(c==='/'||text.startsWith('$/',i))throw fail('BUILD','Slashy Gradle literals or procedural expressions require manual editing.');if(c==='"'||c==="'"){const start=i,delimiter=text.startsWith(c.repeat(3),i)?c.repeat(3):c;i+=delimiter.length;let value='',escaped=false,closed=false;while(i<text.length){if(text.startsWith(delimiter,i)){i+=delimiter.length;closed=true;break;}if(text[i]==='\\'){escaped=true;value+=text[i++];if(i<text.length)value+=text[i++];}else value+=text[i++];}if(!closed)throw fail('BUILD','Unclosed Gradle string.');result.push({type:'string',value,start,end:i,literal:!escaped&&!value.includes('$')&&delimiter.length===1});continue;}const match=/^[A-Za-z_][\w$]*/.exec(text.slice(i));if(match){result.push({type:'id',value:match[0],start:i,end:i+match[0].length});i+=match[0].length;continue;}result.push({type:'punct',value:c,start:i,end:++i});if(result.length>50000)throw fail('BUILD','The build file exceeds its token limit.');}return result;}
function activePlugin(ts,start,end,id){let matches=0;for(let i=start;i<end;i++)if(ts[i].value==='id'){let j=i+1;if(ts[j]?.value==='(')j++;if(ts[j]?.type!=='string'||!ts[j].literal||ts[j].value!==id)continue;j++;if(ts[j]?.value===')')j++;if(ts[j]?.value!=='version'||ts[j+1]?.type!=='string'||!ts[j+1].literal||ts[j+2]?.value==='apply')throw fail('BUILD','Use a directly applied literal '+id+' plugin.');matches++;}return matches===1;}
function gradle(text,kind){const ts=tokens(text),blocks=[];let depth=0;for(let i=0;i<ts.length;i++){const t=ts[i];if(t.value==='{')depth++;else if(t.value==='}')depth--;else if(depth===0&&t.type==='id'&&ts[i+1]?.value==='{'){let d=1,j=i+2;for(;j<ts.length&&d;j++){if(ts[j].value==='{')d++;if(ts[j].value==='}')d--;}if(d)throw fail('BUILD','Unbalanced Gradle block.');blocks.push({name:t.value,start:i+2,end:j-1,closeStart:ts[j-1].start});}if(depth<0)throw fail('BUILD','Unbalanced Gradle braces.');}if(depth)throw fail('BUILD','Unbalanced Gradle braces.');const plugins=blocks.filter(b=>b.name==='plugins'),dependencies=blocks.filter(b=>b.name==='dependencies');if(plugins.length!==1||dependencies.length!==1)throw fail('BUILD','Use one literal plugins block and one direct dependencies block.');const p=plugins[0],boot=[];if(!activePlugin(ts,p.start,p.end,'io.spring.dependency-management')||!activePlugin(ts,p.start,p.end,'org.springframework.boot'))throw fail('BUILD','Use directly applied literal Boot/dependency-management plugins for versionless dependencies.');for(let i=p.start;i<p.end;i++)if(ts[i].value==='id'){let j=i+1;if(ts[j]?.value==='(')j++;if(ts[j]?.type==='string'&&ts[j].literal&&ts[j].value==='org.springframework.boot'){j++;if(ts[j]?.value===')')j++;boot.push(ts[j+1].value);}}if(boot.length!==1||!VERSION.test(boot[0]))throw fail('BUILD','Use one explicit Spring Boot plugin version.');const b=dependencies[0],deps=[],configs=new Set(['implementation','api','runtimeOnly','testImplementation','testRuntimeOnly','compileOnly','annotationProcessor','developmentOnly','testCompileOnly','testAnnotationProcessor']);for(let i=b.start;i<b.end;){const first=ts[i];if(first.value===';'){i++;continue;}if(first.type!=='id'||!configs.has(first.value))throw fail('BUILD','Only direct literal Gradle module dependencies can be edited; catalogs/platforms/projects/closures require manual editing.');let j=i+1,call=ts[j]?.value==='(';if(call)j++;const module=ts[j++];if(module?.type!=='string'||!module.literal||!/^[A-Za-z0-9_.\-]+:[A-Za-z0-9_.\-]+(?::[A-Za-z0-9_.\-]+)?$/.test(module.value))throw fail('BUILD','Use literal Gradle group:artifact[:version] dependencies.');if(call&&ts[j++]?.value!==')')throw fail('BUILD','Unsupported Gradle dependency call.');const end=ts[j-1].end;if(j<b.end&&ts[j].value!==';'&&!/[\r\n]/.test(text.slice(end,ts[j].start)))throw fail('BUILD','Unsupported Gradle dependency expression.');const[groupId,artifactId,version]=module.value.split(':'),scope=first.value.startsWith('test')?'test':first.value==='runtimeOnly'?'runtime':'compile';deps.push({groupId,artifactId,version,scope,configuration:first.value,editable:!version&&['implementation','runtimeOnly','testImplementation'].includes(first.value),start:first.start,end});i=j;}return{kind,bootVersion:boot[0],deps,insertAt:b.closeStart};}
function inspect(text,filename,context){
 if(filename==='pom.xml')return pom(text,context);
 const kind=filename.endsWith('.kts')?'gradle-kotlin':'gradle-groovy';
 if(context?.versionCatalog!==undefined){
  const parsed=tokens(text);
  if(parsed.some((token,index)=>token.type==='id'&&token.value==='libs'&&parsed[index+1]?.value==='.'))
   return inspectCatalogBuild(text,kind,context,tokens,parsed);
 }
 return gradle(text,kind);
}
function managed(dep){return!dep.bom&&!dep.repository&&!dep.version&&['compile','runtime','test'].includes(dep.scope)&&(/^(?:spring-boot-starter-)[A-Za-z0-9_.-]+$/.test(dep.artifactId)&&dep.groupId==='org.springframework.boot'||dep.groupId==='com.mysql'&&dep.artifactId==='mysql-connector-j'||dep.groupId==='org.mariadb.jdbc'&&dep.artifactId==='mariadb-java-client');}
const coordinate=dependency=>dependency.groupId+':'+dependency.artifactId;
function existingDependencies(model,dependency){return model.deps.filter(item=>coordinate(item)===coordinate(dependency));}
function localOverride(model,dependency){return model.management?.overrides.find(item=>item.coordinate===coordinate(dependency));}
function catalogAlias(model,module){
 const choices=model.catalogLibraries?.filter(item=>item.coordinate===module&&!item.version)||[];
 return choices.length===1?choices[0]:undefined;
}

function choices(model,catalog){
 return catalog.dependencies.filter(managed).map(dependency=>{
  const existing=existingDependencies(model,dependency),override=localOverride(model,dependency);
  const alias=catalogAlias(model,coordinate(dependency)),needsAlias=!!model.catalogLibraries&&!existing.length;
  return {...dependency,selected:existing.length>0,editable:!override&&(existing.length===1&&existing[0].editable||!existing.length&&(!needsAlias||!!alias)),
   ...(existing.some(item=>item.inherited)&&{inherited:true}),
   ...(alias&&{catalogAlias:alias.alias}),
   ...(override?{localManagementVersion:override.version}:{})};
 });
}

function change(text,model,catalog,{add=[],remove=[]}={}){
 if(!Array.isArray(add)||!Array.isArray(remove)||add.length+remove.length>50||!add.length&&!remove.length||new Set([...add,...remove]).size!==add.length+remove.length)
  throw fail('DEPENDENCY','Choose unique explicit dependencies to add or remove.');
 const edits=[],insert=[],seen=new Set(),newline=text.includes('\r\n')?'\r\n':'\n';
 const mavenIndent=model.mavenProfile?'\t\t\t':'\t';
 for(const id of [...add,...remove]){
  const dep=catalog.dependencies.find(d=>d.id===id);
  if(!dep||!managed(dep))throw fail('DEPENDENCY','This dependency needs unsupported version/BOM/repository changes.');
  const module=coordinate(dep);
  if(seen.has(module))throw fail('DEPENDENCY','Choose each module once, including aliases for the same coordinates.');
  seen.add(module);
  if(localOverride(model,dep))throw fail('DEPENDENCY','This module has a local Maven management override. Review that declaration before editing it.');
  const existing=existingDependencies(model,dep);
  if(!add.includes(id)){
   if(existing.length!==1||!existing[0].editable)throw fail('DEPENDENCY','Removal needs one unversioned ordinary direct declaration.');
   edits.push({start:existing[0].start,end:existing[0].end,text:''});
   continue;
  }
  if(existing.length)throw fail('DEPENDENCY','This module is already declared.');
  if(model.kind==='maven'){
   insert.push(['\t<dependency>','\t\t<groupId>'+dep.groupId+'</groupId>','\t\t<artifactId>'+dep.artifactId+'</artifactId>',
    ...(dep.scope==='compile'?[]:['\t\t<scope>'+dep.scope+'</scope>']),'\t</dependency>'].map(line=>mavenIndent+line).join(newline));
  }else{
   const config={compile:'implementation',runtime:'runtimeOnly',test:'testImplementation'}[dep.scope];
   if(model.catalogLibraries){
    const alias=catalogAlias(model,module);
    if(!alias)throw fail('DEPENDENCY','Adding this starter needs one existing unversioned catalog alias.');
    insert.push('\t'+config+'('+alias.accessor+')');
   }else insert.push('\t'+config+(model.kind==='gradle-kotlin'?'("'+module+'")':" '"+module+"'"));
  }
 }
 if(insert.length){
  let addition=newline+insert.join(newline)+newline,end=model.insertAt;
  if(model.kind==='maven'&&!model.block)addition=newline+mavenIndent+'<dependencies>'+addition+mavenIndent+'</dependencies>'+newline;
  else if(model.block?.selfClosing){addition='>'+addition+mavenIndent+'</dependencies>';end=model.block.end;}
  edits.push({start:model.insertAt,end,text:addition});
 }
 let after=text;
 for(const edit of edits.sort((a,b)=>b.start-a.start))after=after.slice(0,edit.start)+edit.text+after.slice(edit.end);
 const checked=inspect(after,model.kind==='maven'?'pom.xml':model.kind==='gradle-kotlin'?'build.gradle.kts':'build.gradle',
  model.mavenContext||model.catalogContext);
 if(checked.bootVersion!==model.bootVersion||JSON.stringify(checked.management)!==JSON.stringify(model.management))
  throw fail('BUILD','The Boot management declaration changed unexpectedly.');
 return {after,beforeSha256:sha(Buffer.from(text)),afterSha256:sha(Buffer.from(after)),add:[...add],remove:[...remove],kind:model.kind,bootVersion:model.bootVersion};
}
module.exports={inspect,choices,change,managed,tokens,mavenParentReference};
