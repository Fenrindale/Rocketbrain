'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {parseJavaFile,lexJava,rangeAt}=require('../spring/java');
const key=file=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file);
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const LIMITS=Object.freeze({depth:8,javaFiles:16,resourceFiles:8,resourceBytes:256*1024,resourceFileBytes:64*1024});
const V24_TEXT_FORMATS=new Set(['.txt','.csv','.json','.properties']),V24_OPAQUE_FORMATS=new Set(['.bin','.png','.jpg','.jpeg']);
function plainResourceData(text,extension){
 const scalar=value=>typeof value==='string'&&/^[\p{L}\p{N} _.,!?+-]*$/u.test(value),strings=[];
 if(extension==='.json'){let value;try{value=JSON.parse(text);}catch{throw Error('Package JSON resources require a valid flat scalar data object.');}if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length>64)throw Error('Package JSON resources require a bounded flat scalar data object.');const keys=[...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map(match=>JSON.parse('"'+match[1]+'"'));if(keys.length!==Object.keys(value).length||new Set(keys).size!==keys.length)throw Error('Duplicate or nested JSON metadata needs separate Package Move analysis.');for(const [name,item]of Object.entries(value)){if(!/^[A-Za-z_][\w-]*$/.test(name)||!(item===null||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)||scalar(item)))throw Error('JSON resource indirection, nested structures or nonliteral data needs separate analysis.');strings.push(name,...(typeof item==='string'?[item]:[]));}return {format:'flat-scalar-json',strings};}
 if(extension==='.properties'){const keys=new Set();for(const line of text.split(/\r?\n/)){if(!line||/^[#!]/.test(line))continue;const pair=/^([A-Za-z_][\w.-]*)=(.*)$/.exec(line);if(!pair||keys.has(pair[1])||!scalar(pair[2]))throw Error('Properties resources require distinct literal key=value data without escapes or indirection.');keys.add(pair[1]);strings.push(pair[1],pair[2]);if(keys.size>128)throw Error('Properties resource data exceeds its key limit.');}return {format:'literal-properties-data',strings};}
 if(extension==='.csv'){const lines=text.split(/\r?\n/);if(lines.at(-1)==='')lines.pop();const header=lines.shift()?.split(',');if(!header?.length||header.length>32||header.some(name=>!/^[_A-Za-z][\w]*$/.test(name))||new Set(header).size!==header.length||lines.length>1000)throw Error('CSV package resources require a bounded distinct literal header.');strings.push(...header);for(const line of lines){const cells=line.split(',');if(cells.length!==header.length||cells.some(value=>!scalar(value)))throw Error('CSV resources require an unquoted literal data table without references or expressions.');strings.push(...cells);}return {format:'literal-csv-data',strings};}
 return {format:'plain-utf8-text',strings:[text]};
}
const UNMODELED_RESOURCE_CLIENTS=new Set(['Files','Path','Paths','File','FileInputStream','FileOutputStream','FileReader','FileWriter','RandomAccessFile','FileSystem','FileSystems','FileChannel','AsynchronousFileChannel','URL','URI','URLClassLoader','ResourceLoader','ClassPathResource','FileSystemResource','ResourcePatternResolver','ResourceUtils','ResourceBundle']);
function within(parent,child){const relative=path.relative(path.resolve(parent),path.resolve(child));return relative!==''&&relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
function regularDirectory(folder){const stat=fs.lstatSync(folder);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Package Move requires plain existing package directories without links.');return {file:folder,real:fs.realpathSync(folder),ino:stat.ino,members:fs.readdirSync(folder).sort()};}
function collectTree(source,target,{resources=false,binary=false,formats='v23'}={}){
 if(!['v23','v24'].includes(formats))throw Error('Unknown package resource format policy.');
 if(key(source)===key(target)||within(source,target)||within(target,source))throw Error('Package Move source and destination trees cannot overlap.');
 const files=[],directories=[],destinations=[];let bytes=0;
 function walk(folder,relative='',depth=0){if(depth>LIMITS.depth)throw Error('Nested Package Move exceeds its directory depth limit.');const snapshot=regularDirectory(folder),destination=path.join(target,relative),dest=regularDirectory(destination);directories.push(snapshot);destinations.push(dest);
  for(const name of snapshot.members){const file=path.join(folder,name),rel=path.join(relative,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Nested Package Move cannot follow symbolic links or junctions.');if(stat.isDirectory()){if(!/^[$A-Za-z_][\w$]*$/.test(name))throw Error('Nested package directories require valid Java package names.');walk(file,rel,depth+1);continue;}
   const extension=path.extname(name),additional=resources&&binary&&formats==='v24';if(!stat.isFile()||!(resources?(additional?/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:txt|bin|csv|json|properties|png|jpg|jpeg)$/:binary?/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:txt|bin)$/:/^[A-Za-z0-9][A-Za-z0-9_.-]*\.txt$/):/^[$A-Za-z_][\w$]*\.java$/).test(name))throw Error(resources?'Package resources require reviewed literal text/data or opaque byte formats; metadata and other formats need separate analysis.':'Nested Java packages require Java sources only; custom/co-located resource roots need a proven build mapping.');
   if(files.length>=(resources?LIMITS.resourceFiles:LIMITS.javaFiles))throw Error('Nested Package Move exceeds its bounded file limit.');const next=path.join(target,rel);if(dest.members.some(existing=>existing.toLowerCase()===name.toLowerCase())||fs.existsSync(next))throw Error('A nested package destination already exists or collides by case.');const data=fs.readFileSync(file);bytes+=data.length;const opaque=resources&&binary&&(additional?V24_OPAQUE_FORMATS.has(extension):extension==='.bin');let format;if(resources){if(data.length>LIMITS.resourceFileBytes||bytes>LIMITS.resourceBytes)throw Error('Package resource Move exceeds its byte limit.');if(!opaque){let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(data);}catch{throw Error('Package resources must be valid UTF-8 text.');}if(data.includes(0))throw Error('Binary package resources need a separate Move review.');if(additional)format=plainResourceData(text,extension).format;}else if(additional)format='opaque-bytes';}files.push({file,newFile:next,relative:rel,bytes:data.length,sha256:hash(data),...(resources?{resource:true,...(opaque?{binary:true}:{}),...(format?{format}:{})}:{})});
  }
 }
 walk(source);if(!files.length&&!resources)throw Error('Choose a complete non-empty Java package tree.');
 return {source,target,files,directories,destinations,bytes,resources,binary,formats};
}
function verifyTree(tree){const fresh=tree.resourceRoots?resourceTree(...tree.reviewArguments):collectTree(tree.source,tree.target,{resources:tree.resources,binary:tree.binary,formats:tree.formats});for(const field of ['files','directories','destinations','resourceRoots','rootSnapshots','descriptor'])if(JSON.stringify(fresh?.[field])!==JSON.stringify(tree[field]))throw Error('The nested package membership, bytes, build mapping or destination directories changed after review.');}
function resourceDirectoryInsideProject(project,parts){
 const root=path.resolve(project),rootStat=fs.lstatSync(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||key(fs.realpathSync(root))!==key(root))throw Error('Package resources require a plain physical project directory without ancestor links.');
 let current=root;for(const part of parts){if(!part||part==='.'||part==='..'||path.isAbsolute(part)||part.includes('/')||part.includes('\\'))throw Error('Invalid package resource directory component.');current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT')return false;throw error;}if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('Package resource ancestors cannot contain symbolic links, junctions or non-directories.');const real=fs.realpathSync(current);if(!within(root,real)||key(real)!==key(current))throw Error('Package resource ancestors must remain physically inside the reviewed project.');}
 return true;
}
function resourceRoots(project,{sourceRoots=[]}={}){
 resourceDirectoryInsideProject(project,[]);const descriptor=path.join(project,'build.gradle'),standard=path.join(project,'src/main/resources');
 if(!fs.existsSync(descriptor))return {roots:[standard],descriptor:null,binary:false,kind:'standard-main-convention'};
 const stat=fs.lstatSync(descriptor);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256*1024)throw Error('Package resource mapping requires a bounded plain build.gradle.');const data=fs.readFileSync(descriptor),text=data.toString('utf8'),lexed=lexJava(text);if(lexed.issues.length)throw Error('Unmodeled build syntax prevents package resource root proof.');
 const normalized=lexed.tokens.map(token=>token.text).join(''),declarations=[...normalized.matchAll(/sourceSets\.main\.resources\.srcDir\((['"])([^'"]+)\1\);?/g)],roots=[standard];
 for(const match of declarations){const relative=match[2],parts=relative.split('/');if(parts[0]!=='src'||parts.length<2||parts.some(part=>!/^[_A-Za-z][_A-Za-z0-9-]*$/.test(part)))throw Error('Custom package resource roots require normalized literal src paths without dot or generated components.');if(parts.some(part=>['build','bin','out','target','generated','generated-resources'].includes(part)))throw Error('Generated package resource roots need separate analysis.');roots.push(path.join(project,...parts));}
 if(roots.length>4||new Set(roots.map(key)).size!==roots.length)throw Error('Package Move supports at most four distinct additive main resource roots.');
 // This exact repository block does not modify source/resource processing; all other DSL remains grammar checked.
 require('./move-builds').gradleGrammar(normalized.replace(/repositories\{mavenCentral\(\);?\}/g,''));
 // Buildship may expose resource entries in sourcePaths too. The exact declared resource entries are not Java roots;
 // literal Java declarations are retained separately so a dual-declared root is still rejected.
 const javaDeclarations=[...normalized.matchAll(/sourceSets\.main\.java\.srcDir\((['"])(src\/[^'"]+)\1\);?/g)].map(match=>path.join(project,match[2])),javaRoots=[path.join(project,'src/main/java'),path.join(project,'src/test/java'),...javaDeclarations,...sourceRoots.filter(root=>!roots.some(resource=>key(resource)===key(root)))];for(const root of roots){for(const other of roots)if(root!==other&&(within(root,other)||within(other,root)))throw Error('Package resource roots cannot overlap.');for(const java of javaRoots)if(key(root)===key(java)||within(root,java)||within(java,root))throw Error('Package resource roots cannot overlap Java source roots.');}
 let settingsProof;if(declarations.length){const settings=path.join(project,'settings.gradle');resourceDirectoryInsideProject(project,[]);const stat=fs.lstatSync(settings);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024)throw Error('Custom resource roots require a bounded plain single-project settings.gradle.');const bytes=fs.readFileSync(settings),settingsLex=lexJava(bytes.toString('utf8'));if(settingsLex.issues.length||!/^rootProject\.name=(['"])[A-Za-z0-9_-]+\1;?$/.test(settingsLex.tokens.map(token=>token.text).join('')))throw Error('Custom resource roots require literal single-project settings; included projects and injected settings need separate analysis.');settingsProof={file:settings,bytes:bytes.length,sha256:hash(bytes)};}
 return {roots,descriptor:{file:descriptor,sha256:hash(data),bytes:data.length,...(settingsProof?{settings:settingsProof}:{})},binary:true,kind:'literal-gradle-additive-main-resources'};
}
function expandedResourceTree(project,sourceRoot,targetRoot,oldPackage,newPackage,options){
 const main=path.join(project,'src/main/java'),mapping=resourceRoots(project,options),trees=[],rootSnapshots=[];
 // Validate every ancestor in every root before reading any selected resource bytes.
 for(const root of mapping.roots){const parts=path.relative(project,root).split(path.sep),exists=resourceDirectoryInsideProject(project,parts);if(!exists){rootSnapshots.push({root,exists:false});continue;}const sourceExists=resourceDirectoryInsideProject(project,[...parts,...oldPackage.split('.')]),targetExists=resourceDirectoryInsideProject(project,[...parts,...newPackage.split('.')]);rootSnapshots.push({root,exists:true,sourceExists,targetExists,...regularDirectory(root)});if(sourceExists&&!targetExists)throw Error('Choose existing plain destination resource directories in every populated resource root.');}
 for(const saved of rootSnapshots){if(saved.sourceExists){const tree=collectTree(path.join(saved.root,...oldPackage.split('.')),path.join(saved.root,...newPackage.split('.')),{resources:true,binary:mapping.binary,formats:options.formats});for(const file of tree.files)file.resourceRoot=saved.root;trees.push(tree);}}
 const files=trees.flatMap(tree=>tree.files),bytes=files.reduce((sum,file)=>sum+file.bytes,0);if(files.length&&(key(sourceRoot)!==key(main)||key(targetRoot)!==key(main)))throw Error('Package-linked resource movement requires the same standard main Java source set.');if(files.length>LIMITS.resourceFiles||bytes>LIMITS.resourceBytes)throw Error('Package resources exceed the combined root file or byte limit.');const identities=new Set();
 for(const file of files){const id=file.relative.split(path.sep).join('/').toLowerCase();if(identities.has(id))throw Error('Duplicate classpath resource identities across main roots require separate analysis.');identities.add(id);for(const root of mapping.roots){const destination=path.join(root,...newPackage.split('.'),file.relative);if(fs.existsSync(destination))throw Error('A destination classpath resource already exists in a reviewed main root.');}}
 return {resources:true,binary:mapping.binary,files,bytes,directories:trees.flatMap(tree=>tree.directories),destinations:trees.flatMap(tree=>tree.destinations),resourceRoots:{kind:mapping.kind,roots:mapping.roots,defaultRootPreserved:true,customRoots:mapping.roots.length-1},rootSnapshots,descriptor:mapping.descriptor,reviewArguments:[project,sourceRoot,targetRoot,oldPackage,newPackage,options]};
}
function resourceTree(project,sourceRoot,targetRoot,oldPackage,newPackage,options={}){
 if(options.expanded)return expandedResourceTree(project,sourceRoot,targetRoot,oldPackage,newPackage,options);
 const main=path.join(project,'src/main/java'),root=path.join(project,'src/main/resources'),old=path.join(root,...oldPackage.split('.')),next=path.join(root,...newPackage.split('.'));if(!resourceDirectoryInsideProject(project,['src','main','resources',...oldPackage.split('.')]))return null;
 if(key(sourceRoot)!==key(main)||key(targetRoot)!==key(main))throw Error('Package-linked resource movement requires the same standard main Java and resources source sets.');if(!resourceDirectoryInsideProject(project,['src','main','resources',...newPackage.split('.')]))throw Error('Choose existing plain destination resource directories before Package Move.');return collectTree(old,next,{resources:true});
}
function resolveClass(name,file){if(name.includes('.'))return name;if(file.imports[name])return file.imports[name];if(file.wildcards.length)throw Error('Resource class literals require an exact import or same-package type.');return (file.packageName?file.packageName+'.':'')+name;}
const SPRING_CORE_SHA256='a236f31a7c07e3a1a8e7839ec5c0d47b5cc75709132db50416d5dad320341f12';
const SPRING_RESOURCE_CLASS='org/springframework/core/io/ClassPathResource.class',SPRING_RESOURCE_SHA256='c0f7e65fe2c4a686d856c484c3ba563f20c6bdfc7c64e3c14c26ccb0b24497db';
function noDirectorySpringCore(root){
 let examined=0;for(const namespace of ['org/springframework/core','org/springframework/util']){let current=root,exists=true;for(const part of namespace.split('/')){current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;break;}if(stat.isSymbolicLink())throw Error('Linked Spring resource provider paths need separate analysis.');}if(!exists)continue;const stack=[{folder:current,depth:0}];while(stack.length){const {folder,depth}=stack.pop();if(depth>40)throw Error('Spring directory provider depth exceeds its bound.');for(const name of fs.readdirSync(folder)){if(++examined>20000)throw Error('Spring directory provider membership exceeds its bound.');const file=path.join(folder,name),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw Error('Linked Spring resource provider paths need separate analysis.');if(stat.isDirectory())stack.push({folder:file,depth:depth+1});else if(stat.isFile()&&name.endsWith('.class'))throw Error('Custom directory Spring core/util providers need separate analysis.');}}}
}
async function proveSpringResourceProvider(classpaths){
 if(!Array.isArray(classpaths)||!classpaths.length||classpaths.length>250)throw Error('Spring resource lookup requires bounded observed classpaths.');const providers=[],coreJars=[],jars=[],directories=[],deadline=Date.now()+30000,coreEntry=name=>/(?:^|\/)org\/springframework\/(?:core|util)\//.test(name);let entries=0,total=0;
 for(const input of [...new Set(classpaths)]){if(typeof input!=='string'||!path.isAbsolute(input))throw Error('Spring resource providers require absolute observed local classpaths.');const stat=fs.lstatSync(input);if(stat.isSymbolicLink())throw Error('Linked Spring resource providers need separate analysis.');const file=fs.realpathSync(input);
  if(stat.isDirectory()){noDirectorySpringCore(file);directories.push({input,file});continue;}if(!stat.isFile()||!file.toLowerCase().endsWith('.jar')||stat.size>64*1024*1024||(total+=stat.size)>256*1024*1024)throw Error('Spring resource providers require bounded regular observed JARs.');const saved={input,file,bytes:stat.size,sha256:hash(fs.readFileSync(file))};jars.push(saved);
  await new Promise((resolve,reject)=>require('yauzl').open(file,{lazyEntries:true},(error,zip)=>{if(error)return reject(error);let done=false,namespaceEntries=0;const timer=setTimeout(()=>fail(Error('Spring resource provider inspection timed out.')),Math.max(1,deadline-Date.now())),fail=error=>{if(!done){done=true;clearTimeout(timer);zip.close();reject(error);}};
   zip.on('error',fail);zip.on('entry',entry=>{if(++entries>500000||Date.now()>deadline)return fail(Error('Spring resource provider metadata exceeds its bounded inspection limit.'));if(coreEntry(entry.fileName))namespaceEntries++;if(entry.fileName.endsWith('/'+SPRING_RESOURCE_CLASS))return fail(Error('Versioned ClassPathResource overrides need separate analysis.'));if(entry.fileName!==SPRING_RESOURCE_CLASS){zip.readEntry();return;}if(entry.uncompressedSize>64*1024)return fail(Error('Spring resource provider class exceeds its byte limit.'));
    zip.openReadStream(entry,(error,stream)=>{if(error)return fail(error);const chunks=[];let bytes=0;stream.on('error',fail);stream.on('data',chunk=>{bytes+=chunk.length;if(bytes>64*1024){stream.destroy();fail(Error('Spring resource provider class exceeds its byte limit.'));}else chunks.push(chunk);});stream.on('end',()=>{if(done)return;const data=Buffer.concat(chunks);if(data.length!==entry.uncompressedSize)return fail(Error('Spring resource provider class has inconsistent length.'));providers.push({file,kind:'jar-class',entry:SPRING_RESOURCE_CLASS,bytes:data.length,sha256:hash(data),jarSha256:saved.sha256});zip.readEntry();});});});
   zip.on('end',()=>{if(done)return;try{if(hash(fs.readFileSync(file))!==saved.sha256)return fail(Error('Spring resource provider JAR changed during inspection.'));if(namespaceEntries){if(saved.sha256!==SPRING_CORE_SHA256)return fail(Error('Unknown or duplicate Spring core/util JAR providers need separate analysis.'));coreJars.push({file,sha256:saved.sha256,namespaceEntries});}done=true;clearTimeout(timer);resolve();}catch(error){fail(error);}});zip.readEntry();}));
 }
 if(coreJars.length!==1||providers.length!==1||providers[0].sha256!==SPRING_RESOURCE_SHA256||providers[0].jarSha256!==SPRING_CORE_SHA256)throw Error('Spring ClassPathResource requires one exact reviewed Spring7.0.10 provider; custom, duplicate or unknown providers need separate analysis.');
 const validate=()=>{for(const saved of jars){const stat=fs.lstatSync(saved.input);if(stat.isSymbolicLink()||!stat.isFile()||key(fs.realpathSync(saved.input))!==key(saved.file)||stat.size!==saved.bytes||hash(fs.readFileSync(saved.file))!==saved.sha256)throw Error('A Spring resource provider classpath JAR changed after review.');}for(const saved of directories){const stat=fs.lstatSync(saved.input);if(stat.isSymbolicLink()||!stat.isDirectory()||key(fs.realpathSync(saved.input))!==key(saved.file))throw Error('A Spring resource classpath directory changed after review.');noDirectorySpringCore(saved.file);}};validate();
 return {proof:{kind:'exact-spring-core-jar-and-class-bytes',version:'7.0.10',className:SPRING_RESOURCE_CLASS,sha256:SPRING_RESOURCE_SHA256,provider:providers[0],coreJar:coreJars[0],uniqueObservedProvider:true,coreAndUtilNamespaceOverridesRefused:true,reviewedClasspathJars:jars.length,constructor:'String,Class<?>',method:'getInputStream',projectCodeExecuted:false},validate};
}
const resourceDeclarationCache=new WeakMap();
function classLiteral(tokens,index,file){if(tokens[index]?.text!=='class'||tokens[index-1]?.text!=='.')throw Error('Resource owner must be an exact source class literal.');let start=index-2;while(start>=2&&tokens[start-1]?.text==='.'&&tokens[start-2]?.kind==='id')start-=2;const parts=tokens.slice(start,index-1);if(!parts.length||parts.some((token,i)=>i%2===0?token.kind!=='id':token.text!=='.'))throw Error('Resource owner must be an exact source class literal.');const name=parts.map(token=>token.text).join(''),owner=resolveClass(name,file),head=parts[0].text;let cache=resourceDeclarationCache.get(file);if(!cache){cache={counts:new Map(),types:new Map()};for(let i=0;i<tokens.length;i++)if(tokens[i].kind==='id'&&['class','interface','enum','record'].includes(tokens[i-1]?.text))cache.counts.set(tokens[i].text,(cache.counts.get(tokens[i].text)||0)+1);for(const type of file.types){const list=cache.types.get(type.name)||[];list.push(type);cache.types.set(type.name,list);}resourceDeclarationCache.set(file,cache);}const declarations=cache.counts.get(head)||0,declared=cache.types.get(head)||[];if(parts.length>1&&(file.imports[head]||file.wildcards.length||declarations)||parts.length===1&&(declarations!==declared.length||declared.some(type=>type.fqn!==owner)))throw Error('A source class literal head/import/type shadow needs separate resource lookup analysis.');return {owner,start};}
function readClassLiteral(tokens, start, file) {
 let end = start;
 while (end < tokens.length && end < start + 30 && tokens[end].text !== 'class') end++;
 if (end === start + 30) throw Error('Resource source class literal exceeds its bound.');
 const parsed = classLiteral(tokens, end, file);
 if (parsed.start !== start) throw Error('Resource owner must be one exact source class literal.');
 return { ...parsed, end };
}
const spelling = (tokens, index, words) => words.every((word, offset) => tokens[index + offset]?.text === word);
const CLASS_LOADER_TAIL = ['.', 'getClassLoader', '(', ')'];
const SYSTEM_LOADER = ['java', '.', 'lang', '.', 'ClassLoader', '.'];
const SERVICE_LOADER = ['java', '.', 'util', '.', 'ServiceLoader', '.', 'load', '('];
const SPRING_CONSTRUCTOR = ['new','org','.','springframework','.','core','.','io','.','ClassPathResource','('];
const ROOT_RELATIVE_LOADERS = new Set(['classloader', 'spring-classloader', 'system-classloader']);

function readServiceClient(tokens, index, file, services) {
 const start = index - 4;
 if (!spelling(tokens, start, SERVICE_LOADER)) {
  throw Error('Dynamic or configured package references require an exact Java service loader call.');
 }
 const first = readClassLiteral(tokens, index + 4, file), service = services.get(first.owner);
 if (tokens[first.end + 1]?.text !== ',' || !service) {
  throw Error('Service loading requires an exact reviewed service interface and explicit classloader.');
 }
 const second = readClassLiteral(tokens, first.end + 2, file);
 if (first.owner !== second.owner) throw Error('A service lookup must use its own source interface classloader.');
 const loaderStart = second.end + 1;
 if (!spelling(tokens, loaderStart, CLASS_LOADER_TAIL)) throw Error('Service classloaders require the exact interface-literal getClassLoader() call.');
 const end = loaderStart + CLASS_LOADER_TAIL.length;
 if (spelling(tokens, end, [')', '.', 'findFirst', '(', ')', '.', 'orElseThrow', '(', ')', '.', service.method, '(', ')'])) {
  return { service, loaderStart, end, methodEnd: end + 12, consumption: 'first' };
 }
 const parameter = tokens[end + 8];
 if (parameter?.kind === 'id' && spelling(tokens, end, [
  ')', '.', 'stream', '(', ')', '.', 'map', '(', parameter.text, '-', '>', parameter.text,
  '.', 'get', '(', ')', '.', service.method, '(', ')', ')', '.', 'toList', '(', ')'
 ])) {
  return { service, loaderStart, end, methodEnd: end + 19, consumption: 'ordered-list' };
 }
 throw Error('Service providers require immediate scalar consumption without caching or reflective provider access.');
}

function verifyServiceClients(reviewed, transformed, renames, services) {
 if (!services.size) return;
 const newServices = new Map([...services.values()].map(service => [
  service.nextService || service.service, { ...service, service: service.nextService || service.service }
 ]));
 const moved = new Map(renames.map(rename => [rename.oldUri, rename.newUri]));
 const expected = reviewed.map(call => JSON.stringify({
  uri: moved.get(call.uri) || call.uri,
  service: services.get(call.service).nextService || call.service,
  consumption: call.consumption
 })).sort();
 const actual = [];
 for (const source of transformed) {
  const { tokens } = lexJava(source.text), file = parseJavaFile(source);
  for (const [index, token] of tokens.entries()) {
   if (token.text !== 'ServiceLoader') continue;
   const { service, consumption } = readServiceClient(tokens, index, file, newServices);
   actual.push(JSON.stringify({ uri: source.uri, service: service.service, consumption }));
  }
 }
 if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) {
  throw Error('The Java engine changed the reviewed service consumer set or provider consumption.');
 }
}

function reviewLookups(sources, javaTree, resources, oldPackage, newPackage, services = new Map()) {
 const movedTypes = new Set(), sourceTypes = new Set(), lookup = [], edits = new Map(), bindings = [], serviceCalls = [];
 const oldPath = oldPackage.replaceAll('.', '/'), newPath = newPackage.replaceAll('.', '/'), byPath = new Map();
 let springConstructors = 0;
 for (const source of sources) if (source.file.endsWith('.java')) {
  for (const type of parseJavaFile(source).types) sourceTypes.add(type.fqn);
 }
 for (const file of javaTree.files) {
  const parsed = parseJavaFile({ uri: '', text: fs.readFileSync(file.file, 'utf8') });
  for (const type of parsed.types) movedTypes.add(type.fqn);
 }
 for (const file of resources?.files || []) {
  const relative = file.relative.split(path.sep).join('/');
  byPath.set(oldPath + '/' + relative, { ...file, newResourcePath: newPath + '/' + relative });
  if (file.binary) continue;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file.file));
  const data = plainResourceData(text, path.extname(file.file));
  if ([text, ...data.strings].some(value => value.includes(oldPackage) || value.includes(oldPath))) {
   throw Error('Embedded resource/package references in moved data need separate analysis; data bytes are never rewritten.');
  }
 }
 const springHeadShadow = sources.some(source => source.file.endsWith('.java') &&
  lexJava(source.text).tokens.some((token, index, tokens) => token.kind === 'id' && token.text === 'org' && tokens[index + 1]?.text !== '.')) ||
  [...sourceTypes].some(name => name.startsWith('org.springframework.core.') || name.startsWith('org.springframework.util.') || name.endsWith('.org'));

 for (const source of sources) {
  if (!source.file.endsWith('.java')) {
   if (source.text.includes(oldPackage) || source.text.includes(oldPath)) throw Error('Configured or resource-content package references require a separate Package Move review.');
   continue;
  }
  const file = parseJavaFile(source), lexed = lexJava(source.text), tokens = lexed.tokens;
  const acceptedStrings = new Set(), acceptedLoaders = new Set(), acceptedSpring = new Set();
  if (lexed.issues.length) throw Error('Unmodeled Java lexical syntax prevents complete package resource client review.');

  function addBinding(end, methodKey, resultType, after) {
   bindings.push({ uri: source.uri, end: tokens[end].end, methodKey, ...(resultType ? { resultType } : {}), ...(after ? { after } : {}) });
  }
  function sourceClassLoader(start) {
   if (!spelling(tokens, start, CLASS_LOADER_TAIL)) throw Error('Resource and service classloaders require the exact source class-literal getClassLoader() call.');
   acceptedLoaders.add(tokens[start + 1].start);
   addBinding(start + 3, 'java.lang.Class#getClassLoader()');
   return start + CLASS_LOADER_TAIL.length;
  }
  function consume(owner, literal, method, loader) {
   if (!byPath.size) throw Error('A package-relative resource client requires a reviewed resources tree.');
   const value = literal?.value, rootRelative = ROOT_RELATIVE_LOADERS.has(loader);
   if (literal?.kind !== 'string' || typeof value !== 'string' || !value || value.includes('\\') ||
       value.includes('?') || value.includes('#') || value.split('/').some(part => part === '..' || part === '.') ||
       value.includes('//') || rootRelative && value.startsWith('/')) {
    throw Error('Resource lookup requires one normalized literal path; classloader paths must be root-relative without a slash prefix.');
   }
   const absolute = rootRelative || value.startsWith('/');
   const resolved = rootRelative ? value : absolute ? value.slice(1) : owner.slice(0, owner.lastIndexOf('.')).replaceAll('.', '/') + '/' + value;
   const item = byPath.get(resolved);
   if (owner && (rootRelative || loader === 'spring-class' || item) && !sourceTypes.has(owner)) {
    throw Error('Classloader resource lookup requires a reviewed source class owner.');
   }
   if (!item) {
    if (!rootRelative && movedTypes.has(owner) || resolved === oldPath || resolved.startsWith(oldPath + '/')) {
     throw Error('A moved class resource lookup is missing from the reviewed package resources.');
    }
    return;
   }
   if (!absolute && !movedTypes.has(owner)) throw Error('A relative resource client outside the moved package would change its lookup base.');
   acceptedStrings.add(literal.start);
   const newValue = rootRelative ? item.newResourcePath : absolute ? '/' + item.newResourcePath : value;
   if (newValue !== value) {
    const list = edits.get(source.uri) || [];
    list.push({ range: rangeAt(source.text, literal.start, literal.end), newText: JSON.stringify(newValue) });
    edits.set(source.uri, list);
   }
   lookup.push({ uri: source.uri, method, owner, oldPath: resolved, newPath: item.newResourcePath, absolute,
    literal: value, newLiteral: newValue, resourceSha256: item.sha256, loader });
  }

  for (let index = 0; index < tokens.length; index++) {
   const token = tokens[index];
   if (token.text === 'new' && spelling(tokens, index, SPRING_CONSTRUCTOR.slice(0, -1))) {
    if (springHeadShadow || file.imports.org || file.wildcards.length || tokens[index - 1]?.text === '.') {
     throw Error('A source type or head-token shadow prevents exact Spring resource type resolution.');
    }
    const open = index + 10, literal = tokens[open + 1];
    if (tokens[open]?.text !== '(' || literal?.kind !== 'string' || tokens[open + 2]?.text !== ',') {
     throw Error('Spring resources require the exact literal String, source-class overload.');
    }
    const owner = readClassLiteral(tokens, open + 3, file);
    const classloader = spelling(tokens, owner.end + 1, CLASS_LOADER_TAIL);
    const end = classloader ? sourceClassLoader(owner.end + 1) : owner.end + 1;
    if (!spelling(tokens, end, [')', '.', 'getInputStream', '(', ')'])) {
     throw Error('Spring resources require an immediate exact class-literal or source-classloader getInputStream call; aliases and custom semantics need separate analysis.');
    }
    acceptedSpring.add(tokens[index + 9].start);
    springConstructors++;
    if (classloader) {
     addBinding(end, 'org.springframework.core.io.ClassPathResource#<init>(java.lang.String,java.lang.@org.jspecify.annotations.Nullable ClassLoader)');
     addBinding(end + 4, 'org.springframework.core.io.ClassPathResource#getInputStream()');
    }
    consume(owner.owner, literal, 'getInputStream', classloader ? 'spring-classloader' : 'spring-class');
   }
   if (token.text === 'ServiceLoader') {
    const { service, loaderStart, end, methodEnd, consumption } = readServiceClient(tokens, index, file, services);
    sourceClassLoader(loaderStart);
    const nextService = service.nextService || service.service;
    addBinding(end, 'java.util.ServiceLoader#load(java.lang.Class<S>,java.lang.ClassLoader)', 'java.util.ServiceLoader<' + service.service + '>',
     { resultType: 'java.util.ServiceLoader<' + nextService + '>' });
    addBinding(methodEnd, service.service + '#' + service.method + '()', undefined, { methodKey: nextService + '#' + service.method + '()' });
    if (consumption === 'ordered-list') {
     const provider = type => 'java.util.ServiceLoader.Provider<' + type + '>';
     addBinding(end + 4, 'java.util.ServiceLoader#stream()', 'java.util.stream.Stream<' + provider(service.service) + '>',
      { resultType: 'java.util.stream.Stream<' + provider(nextService) + '>' });
     addBinding(end + 15, 'java.util.ServiceLoader.Provider#get()', service.service, { resultType: nextService });
     addBinding(end + 20, 'java.util.stream.Stream#map(java.util.function.Function<? super T,? extends R>)');
     addBinding(end + 24, 'java.util.stream.Stream#toList()');
    }
    serviceCalls.push({ uri: source.uri, service: service.service, loader: 'source-service-classloader', method: service.method, consumption });
   }
   if (token.text === 'ClassLoader') {
    const method = tokens[index + 2]?.text, literal = tokens[index + 4];
    if (!spelling(tokens, index - 4, SYSTEM_LOADER) || !['getSystemResource', 'getSystemResourceAsStream'].includes(method) ||
        tokens[index + 3]?.text !== '(' || literal?.kind !== 'string' || tokens[index + 5]?.text !== ')') {
     throw Error('Custom or dynamic classloader references require a separate Package Move review.');
    }
    acceptedLoaders.add(token.start);
    addBinding(index + 5, 'java.lang.ClassLoader#' + method + '(java.lang.String)');
    consume(undefined, literal, method, 'system-classloader');
   }
  }

  for (let index = 0; index < tokens.length; index++) {
   const token = tokens[index];
   if (!['getResource', 'getResourceAsStream', 'getResources'].includes(token.text)) continue;
   if (token.text === 'getResources' || tokens[index - 1]?.text !== '.' || tokens[index + 1]?.text !== '(' ||
       tokens[index + 2]?.kind !== 'string' || tokens[index + 3]?.text !== ')') {
    throw Error('Dynamic, receiver-based or multiple resource lookup calls require a separate Package Move review.');
   }
   let literalIndex = index - 2, loader = 'class';
   if (spelling(tokens, index - 5, CLASS_LOADER_TAIL)) {
    literalIndex = index - 6;
    loader = 'classloader';
    acceptedLoaders.add(tokens[index - 4].start);
   }
   if (tokens[literalIndex]?.text !== 'class') throw Error('Dynamic, receiver-based or custom classloader resource lookup requires separate review.');
   consume(classLiteral(tokens, literalIndex, file).owner, tokens[index + 2], token.text, loader);
  }
  for (const token of tokens) {
   if (token.kind === 'id' && ((byPath.size && UNMODELED_RESOURCE_CLIENTS.has(token.text) &&
     !(token.text === 'ClassPathResource' && acceptedSpring.has(token.start))) ||
     token.text === 'getClassLoader' && !acceptedLoaders.has(token.start))) {
    throw Error('Filesystem, URI or resource-loader clients require a separate Package Move review; only exact modeled source-class loader expressions are supported.');
   }
   if (['string', 'char', 'text-block'].includes(token.kind) &&
       (String(token.value ?? token.text).includes(oldPackage) || String(token.value ?? token.text).includes(oldPath)) &&
       !acceptedStrings.has(token.start)) {
    throw Error('Unresolved Java string package or resource references require a separate Package Move review.');
   }
  }
 }
 for (const [resourcePath] of byPath) {
  if (!lookup.some(value => value.oldPath === resourcePath)) {
   throw Error('Each moved resource requires a known literal class-resource client; external or unobserved clients remain unverified.');
  }
 }
 for (const service of services.keys()) {
  if (!serviceCalls.some(call => call.service === service)) throw Error('Each changed service descriptor requires a reviewed Java source consumer.');
 }
 return { lookup, entries: [...edits].map(([uri, edits]) => ({ textDocument: { uri, version: null }, edits })),
  resources: byPath.size, mode:'literal-source-class-resource-paths', springConstructors, springProviderRequired: springConstructors > 0,
  serviceCalls, bindings, externalClientsVerified: false, embeddedDataReferencesRewritten: false, opaqueMediaValidityVerified: false };
}

function verifyResourceBindings(bindings, sources, entries, renames, before, after) {
 for (const binding of bindings) {
  const same = (call, expected) => call.methodKey === expected.methodKey && (!expected.resultType || expected.resultType === call.resultType);
  if (before.calls.filter(call => call.uri === binding.uri && call.end === binding.end && same(call, binding)).length !== 1) {
   throw Error('The Java compiler did not bind the reviewed resource or service call to its exact provider: ' + binding.methodKey);
  }
  const source = sources.find(item => item.uri === binding.uri);
  const entry = entries.find(item => item.textDocument.uri === binding.uri);
  const spans = editSpans(source.text, entry?.edits || []);
  if (spans.some(span => span.start < binding.end && span.end > binding.end)) {
   throw Error('A Java engine edit overlaps a verified resource or service call boundary.');
  }
  const end = spans.filter(span => span.end <= binding.end).reduce((offset, span) =>
   offset + span.newText.length - (span.end - span.start), binding.end);
  const uri = renames.find(rename => rename.oldUri === binding.uri)?.newUri || binding.uri;
  const expected = { ...binding, ...binding.after };
  if (after.calls.filter(call => call.uri === uri && call.end === end && same(call, expected)).length !== 1) {
   throw Error('The move would change a verified resource or service call binding: ' + binding.methodKey);
  }
 }
}
function mergeEntries(entries,additional){const result=structuredClone(entries);for(const entry of additional){const existing=result.find(value=>value.textDocument.uri===entry.textDocument.uri);if(existing)existing.edits.push(...entry.edits);else result.push(structuredClone(entry));}return result;}
function editSpans(text,edits){
 const lines=text.split('\n'),starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);const offset=position=>{if(!Number.isInteger(position?.line)||!Number.isInteger(position?.character)||position.line<0||position.line>=lines.length||position.character<0||position.character>lines[position.line].replace(/\r$/,'').length)throw Error('Invalid grouped package Move edit position.');return starts[position.line]+position.character;};
 const spans=edits.map(edit=>{if(typeof edit.newText!=='string'||edit.annotationId)throw Error('Annotated or invalid grouped package Move edits require separate review.');const start=offset(edit.range?.start),end=offset(edit.range?.end);if(end<start)throw Error('Invalid grouped package Move edit range.');return {start,end,newText:edit.newText};}).sort((a,b)=>a.start-b.start||a.end-b.end);
 for(let i=1;i<spans.length;i++)if(overlap(spans[i-1],spans[i]))throw Error('A Java engine response contains overlapping package edits.');return spans;
}
function overlap(a,b){return a.start===b.start||a.start<b.end&&b.start<a.end;}
function applySpans(text,spans){for(const span of [...spans].sort((a,b)=>b.start-a.start||b.end-a.end))text=text.slice(0,span.start)+span.newText+text.slice(span.end);return text;}
function explicitImports(text){
 if(/\/[/*]/.test(text))throw Error('Comments anywhere in overlapping import statements require separate review.');const lexed=lexJava(text);if(lexed.issues.length)throw Error('Unsupported syntax in grouped package import review.');const tokens=lexed.tokens,imports=[];let cursor=0;
 while(cursor<tokens.length){if(tokens[cursor].text!=='import')throw Error('Grouped package import spans must contain explicit imports and whitespace only.');const start=tokens[cursor++].start,names=[];while(cursor<tokens.length&&tokens[cursor].text!==';')names.push(tokens[cursor++]);if(tokens[cursor]?.text!==';'||!names.length||names.some((token,index)=>index%2===0?token.kind!=='id'||token.text==='static':token.text!=='.')||names.length%2!==1)throw Error('Static, wildcard or malformed grouped imports require separate review.');const end=tokens[cursor++].end;imports.push({name:names.map(token=>token.text).join(''),start,end});}
 let remaining=text;for(const item of [...imports].reverse())remaining=remaining.slice(0,item.start)+remaining.slice(item.end);if(remaining.trim())throw Error('Comments or other code in overlapping import edits require separate review.');if(new Set(imports.map(item=>item.name)).size!==imports.length)throw Error('Repeated explicit imports require separate grouped Move review.');return imports;
}
function importHeader(text){
 const lexed=lexJava(text);if(lexed.issues.length)throw Error('Unsupported Java syntax in grouped import review.');const tokens=lexed.tokens;let cursor=0,start=0;
 if(tokens[0]?.text==='package'){while(cursor<tokens.length&&tokens[cursor].text!==';')cursor++;if(!tokens[cursor])throw Error('A grouped package import review requires a complete package declaration.');start=tokens[cursor++].end;}
 while(tokens[cursor]?.text==='import'){while(cursor<tokens.length&&tokens[cursor].text!==';')cursor++;if(!tokens[cursor])throw Error('Unterminated import in grouped package Move.');cursor++;}
 const end=tokens[cursor]?.start??text.length,imports=explicitImports(text.slice(start,end));return {start,end,imports:imports.map(item=>item.name)};
}
function noSimpleNameConflicts(imports){const bySimple=new Map();for(const name of imports){const simple=name.slice(name.lastIndexOf('.')+1),previous=bySimple.get(simple);if(previous&&previous!==name)throw Error('Grouped package imports have conflicting simple names.');bySimple.set(simple,name);}}
function mergePackageEngineEdits(sources,groups){
 const byUri=new Map(),mergedImportFiles=[];for(const [groupIndex,group]of groups.entries()){const mapping=new Map(group.mapping.map(item=>[item.oldFqn,item.newFqn]));if(mapping.size!==group.mapping.length||new Set(mapping.values()).size!==mapping.size)throw Error('Grouped package Move requires unique source type mappings.');for(const entry of group.entries){const source=sources.find(value=>value.uri===entry.textDocument.uri);if(!source)throw Error('Grouped package Move edits leave the reviewed source snapshot.');const parts=byUri.get(source.uri)||[];parts.push({groupIndex,mapping,entry,spans:editSpans(source.text,entry.edits)});byUri.set(source.uri,parts);}}
 const entries=[];for(const [uri,parts]of byUri){const source=sources.find(value=>value.uri===uri),versions=new Set(parts.map(part=>part.entry.textDocument.version).filter(value=>value!==undefined&&value!==null));if(versions.size>1)throw Error('Grouped package Move returned conflicting document versions.');const unique=[];for(const part of parts)for(const span of part.spans)if(!unique.some(value=>value.start===span.start&&value.end===span.end&&value.newText===span.newText))unique.push(span);const conflicts=unique.filter((span,index)=>unique.some((other,next)=>index!==next&&overlap(span,other)));let combined=unique;
  if(conflicts.length){
   const header=importHeader(source.text),inHeader=span=>span.start>=header.start&&span.end<=header.end,touchesHeader=span=>span.start<header.end&&span.end>header.start||span.start===span.end&&span.start>=header.start&&span.start<=header.end;if(conflicts.some(span=>!inHeader(span)))throw Error('Overlapping non-import package edits require separate review.');
   const allMapping=new Map();for(const group of groups)for(const item of group.mapping){if(allMapping.has(item.oldFqn)&&allMapping.get(item.oldFqn)!==item.newFqn)throw Error('Conflicting grouped package type mappings.');allMapping.set(item.oldFqn,item.newFqn);}
   const additions=[],explained=[];for(const part of parts){for(const span of part.spans)if(touchesHeader(span)){if(!inHeader(span))throw Error('A grouped package import edit crosses into other Java code.');explicitImports(source.text.slice(span.start,span.end));explicitImports(span.newText);}const candidate=applySpans(source.text,part.spans),after=importHeader(candidate),expected=header.imports.map(name=>part.mapping.get(name)||name);if(expected.some(name=>!after.imports.includes(name)))throw Error('The Java engine dropped an unrelated baseline import during grouped Move.');const allowed=new Set([...expected,...part.mapping.values()]);if(after.imports.some(name=>!allowed.has(name)))throw Error('An added import is not explained by the exact reviewed package group.');noSimpleNameConflicts(after.imports);for(const name of after.imports)if(!header.imports.includes(name)&&!additions.includes(name))additions.push(name);explained.push({groupIndex:part.groupIndex,imports:after.imports,originalImportsRetained:true,addedImportsExplained:true});}
   const imports=[...new Set([...header.imports.map(name=>allMapping.get(name)||name),...additions])];noSimpleNameConflicts(imports);const newline=source.text.includes('\r\n')?'\r\n':'\n',newText=newline+(imports.length?imports.map(name=>'import '+name+';').join(newline)+newline:'')+newline;combined=[...unique.filter(span=>!touchesHeader(span)),{start:header.start,end:header.end,newText}];
   mergedImportFiles.push({uri,baselineImports:header.imports,finalImports:imports,groups:explained,originalImportsRetained:true,addedImportsExplained:true,staticWildcardOrCommentImportsAccepted:false,nonImportOverlapsAccepted:false});
  }
  combined.sort((a,b)=>a.start-b.start||a.end-b.end);for(let i=1;i<combined.length;i++)if(overlap(combined[i-1],combined[i]))throw Error('Grouped package edits still overlap after explicit import composition.');entries.push({textDocument:{uri,version:versions.size?[...versions][0]:null},edits:combined.map(span=>({range:rangeAt(source.text,span.start,span.end),newText:span.newText}))});
 }
 return {entries,proof:{mode:'explicit-baseline-imports-and-exact-group-type-mappings',groups:groups.length,mergedImportFiles,conflictAnnotationsAccepted:false,nonImportOverlapsAccepted:false}};
}
module.exports={LIMITS,UNMODELED_RESOURCE_CLIENTS,collectTree,verifyTree,resourceTree,resourceRoots,resourceDirectoryInsideProject,reviewLookups,verifyResourceBindings,verifyServiceClients,plainResourceData,proveSpringResourceProvider,SPRING_RESOURCE_SHA256,mergeEntries,mergePackageEngineEdits,within};
