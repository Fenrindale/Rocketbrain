'use strict';
const { registerSemanticSpring } = require('../spring/vscode');
const { registerRuntimeSpring } = require('../spring/runtime-vscode');
const { parseEndpointContracts, endpointContractFile, inheritedFeignContracts, mappingPaths } = require('../spring/endpoint-contracts');
const { lexJava, splitTop } = require('../spring/java');
const { yamlCompletionContext } = require('../spring/configuration-yaml');
const { metadataProperties,metadataModule,workspaceMetadata,selectMetadata,declarationAt,metadataJavaSource } = require('../spring/configuration-metadata');
const ENDPOINT_KINDS = { mvc: 'MVC server', webflux: 'WebFlux server', feign: 'Feign client' };

const BASIC_PROPERTIES = [
  ['server.port', 'java.lang.Integer', '8080', 'HTTP server port.'],
  ['server.servlet.context-path', 'java.lang.String', '', 'Application context path.'],
  ['spring.application.name', 'java.lang.String', '', 'Application name.'],
  ['spring.profiles.active', 'java.lang.String', '', 'Active profile names.'],
  ['spring.datasource.url', 'java.lang.String', '', 'JDBC connection URL.'],
  ['spring.datasource.username', 'java.lang.String', '', 'Database user name.'],
  ['spring.datasource.password', 'java.lang.String', '', 'Database password.'],
  ['spring.jpa.hibernate.ddl-auto', 'java.lang.String', '', 'Hibernate schema management mode.'],
  ['management.endpoints.web.exposure.include', 'java.lang.String', '', 'Actuator endpoints exposed over HTTP.']
].map(([name, type, defaultValue, description]) => ({ name, type, defaultValue, description, origin: 'Rocketbrain basic settings (not the complete Spring metadata catalog)' }));

function javaCodeMask(source) {
  const result = source.split('');
  let state = 'code';
  const blank = index => { if (source[index] !== '\n' && source[index] !== '\r') result[index] = ' '; };
  for (let i = 0; i < source.length; i++) {
    const char = source[i], next = source[i + 1];
    if (state === 'code') {
      if (char === '/' && next === '/') { blank(i); blank(++i); state = 'line'; }
      else if (char === '/' && next === '*') { blank(i); blank(++i); state = 'block'; }
      else if (source.startsWith('"""', i)) { blank(i); blank(++i); blank(++i); state = 'text'; }
      else if (char === '"' || char === "'") { blank(i); state = char; }
    } else {
      blank(i);
      if (state === 'line' && (char === '\n' || char === '\r')) state = 'code';
      else if (state === 'block' && char === '*' && next === '/') { blank(++i); state = 'code'; }
      else if (state === 'text' && source.startsWith('"""', i)) { blank(++i); blank(++i); state = 'code'; }
      else if ((state === '"' || state === "'") && char === '\\') { if (i + 1 < source.length) blank(++i); }
      else if (char === state) state = 'code';
    }
  }
  return result.join('');
}

function positionAt(text, offset) {
  const prefix = text.slice(0, offset).split('\n');
  return { line: prefix.length - 1, character: prefix[prefix.length - 1].length };
}

function literalPaths(args) {
  const {tokens,issues} = lexJava(args), attributes = Object.create(null);
  if (issues.length) return [];
  for (const entry of splitTop(tokens)) {
    if (!entry.length) continue;
    if (entry[0].kind === 'id' && entry[1]?.text === '=') attributes[entry[0].text] = entry.slice(2);
    else attributes.value = entry;
  }
  return mappingPaths({attributes}) || [];
}

function parseSpringEndpoints(source, uri = '', showUnresolved = false) {
  if (!/\b(?:RestController|Controller)\b/.test(source)) return [];
  const text = javaCodeMask(source);
  const classes = [...text.matchAll(/\b(?:class|record|interface|enum)\s+(\w+)/g)];
  // Multi-type/nested source requires a real Java AST. Skip it instead of inventing a class path.
  if (classes.length !== 1) return [];
  const classMatch = classes[0];
  const annotations = [];
  const names = /@([\w.]+)/g;
  for (let match; (match = names.exec(text));) {
    let cursor = names.lastIndex;
    while (/\s/.test(text[cursor] || '') && cursor < text.length) cursor++;
    let args = '', end = names.lastIndex;
    if (text[cursor] === '(') {
      const start = cursor; let depth = 1;
      while (depth && ++cursor < text.length) { if (text[cursor] === '(') depth++; else if (text[cursor] === ')') depth--; }
      if (depth) continue;
      end = cursor + 1; args = source.slice(start + 1, cursor);
    }
    annotations.push({ name: match[1].split('.').at(-1), start: match.index, end, args });
    names.lastIndex = end;
  }
  const prefix = annotations.filter(item => item.end <= classMatch.index);
  if (!prefix.some(item => item.name === 'RestController' || item.name === 'Controller')) return [];
  const classAnnotation = prefix.find(item => item.name === 'RequestMapping');
  const bases = classAnnotation ? literalPaths(classAnnotation.args) : [''];
  const structural = text.split('');
  for (const item of annotations) for (let i = item.start; i < item.end; i++) if (!/[\r\n]/.test(structural[i])) structural[i] = ' ';
  const structure = structural.join('');
  const bodyStart = structure.indexOf('{', classMatch.index);
  if (bodyStart < 0) return [];
  const endpoints = [];
  for (const annotation of annotations.filter(item => item.start > bodyStart && /^(?:Get|Post|Put|Delete|Patch|Request)Mapping$/.test(item.name))) {
    const before = structure.slice(bodyStart, annotation.start);
    const depth = [...before].reduce((value, char) => value + (char === '{' ? 1 : char === '}' ? -1 : 0), 0);
    if (depth !== 1) continue;
    const paths = literalPaths(annotation.args);
    const methodTail = structure.slice(annotation.end, annotation.end + 2000);
    const method = /^\s*(?:(?:public|protected|private|static|final|synchronized|abstract|default)\s+)*[\w.$<>?,\[\] \t]+?\s+(\w+)\s*\(/.exec(methodTail);
    if (!method) continue;
    const methods = annotation.name === 'RequestMapping' ? [...annotation.args.matchAll(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|TRACE)/g)].map(entry => entry[1]) : [annotation.name.replace('Mapping', '').toUpperCase()];
    if (showUnresolved && (!bases.length || !paths.length)) {
      endpoints.push({ name:'Unresolved MVC mapping', path:null, methods, method:method[1], containerName:classMatch[1], uri,
        kind:'mvc', state:'unresolved', reason:'Controller mapping path is computed or unresolved.',
        range:{start:positionAt(source,annotation.start),end:positionAt(source,annotation.end)} });
      continue;
    }
    for (const base of bases) for (const route of paths) {
      const routePath = ('/' + base + '/' + route).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const start = positionAt(source, annotation.start);
      endpoints.push({ name: `${methods.length ? methods.join('|') : 'ANY'} ${routePath}`, path: routePath, methods: methods.length ? methods : ['ANY'], method: method[1], containerName: classMatch[1], uri, range: { start, end: positionAt(source, annotation.end) } });
    }
  }
  return endpoints;
}

function sourceEndpoints(text, uri) {
  return [
    ...parseSpringEndpoints(text, uri, true).map(item => ({kind:'mvc',state:'declared',...item})),
    ...parseEndpointContracts(text, uri)
  ];
}

function endpointDescription(item) {
  return [ENDPOINT_KINDS[item.kind],item.containerName+'.'+item.method,item.declaringType&&'Inherited from '+item.declaringType,item.reason || (item.constrained ? 'Additional request conditions' : '')].filter(Boolean).join(' · ');
}

function yamlPrefix(text,line){return yamlCompletionContext(text,line)?.prefix||'';}
function registerSpringFeatures(vscode, context, output, { verifiedLocalPid } = {}) {
  const subscriptions = [], cache = new Map();
  const semantic = registerSemanticSpring(vscode, context, output);
  const runtime = registerRuntimeSpring(vscode, context, output, { analyze: semantic.analyze, verifiedLocalPid });
  subscriptions.push(semantic);
  subscriptions.push(runtime);
  const enabled = () => vscode.workspace.getConfiguration('rocketbrain.spring').get('enabled', true);
  const invalidate = () => cache.clear();
  async function properties(documentUri,token) {
    const candidates=[], limit=100;
    const excludes='**/{node_modules,.git,.idea,.gradle,test-output,.vscode-test}/**';
    const metadata=await vscode.workspace.findFiles('**/META-INF/*spring-configuration-metadata.json',excludes,limit+1,token);
    const owner=documentUri&&vscode.workspace.getWorkspaceFolder(documentUri);
    const records=metadata.flatMap(uri=>{
      if(owner&&vscode.workspace.getWorkspaceFolder(uri)?.uri.toString()!==owner.uri.toString())return [];
      return [{uri,moduleRoot:metadataModule(uri.path)}];
    });
    let total=0;
    for(const item of workspaceMetadata(records,documentUri?.path).slice(0,limit)){
      if(token?.isCancellationRequested)return [];
      try{
        const stat=await vscode.workspace.fs.stat(item.uri);
        if(stat.size>2*1024*1024||total+stat.size>8*1024*1024)continue;
        const contents=await vscode.workspace.fs.readFile(item.uri);
        if(contents.byteLength>2*1024*1024)continue;
        total+=contents.byteLength;
        const json=JSON.parse(Buffer.from(contents).toString('utf8'));
        candidates.push(...metadataProperties(json,vscode.workspace.asRelativePath(item.uri)).map(entry=>({...entry,moduleRoot:item.moduleRoot})));
      }catch{output.appendLine('Spring metadata file was unavailable or malformed.');}
    }
    const result=new Map(BASIC_PROPERTIES.map(item=>[item.name,item]));
    for(const item of selectMetadata(candidates))result.set(item.name,item);
    return [...result.values()];
  }
  async function propertyDefinition(document,position,token){
    if(!enabled()||document.getText().length>1024*1024)return [];
    const version=document.version, target=declarationAt({uri:document.uri.toString(),text:document.getText()},position);
    if(!target)return [];
    const entries=await properties(document.uri,token);
    const entry=entries.find(item=>item.name===target.key);
    if(!entry?.sourceType||entry.sourceType.includes('$')||token.isCancellationRequested||document.version!==version)return [];
    const simple=entry.sourceType.split('.').at(-1);
    const root=document.uri.with({path:entry.moduleRoot});
    const files=await vscode.workspace.findFiles(new vscode.RelativePattern(root,'**/'+simple+'.java'),
      '**/{node_modules,.git,.idea,build,target,.gradle,test-output,.vscode-test}/**',17,token);
    if(files.length>16)return [];
    const definitions=[];
    for(const uri of files){
      try{
        const doc=await vscode.workspace.openTextDocument(uri);
        if(doc.getText().length>1024*1024)continue;
        const definition=metadataJavaSource({uri:uri.toString(),text:doc.getText()},entry);
        if(definition)definitions.push(definition);
      }catch{continue;}
    }
    if(definitions.length!==1||token.isCancellationRequested||document.version!==version)return [];
    const match=definitions[0], {start,end}=match.range;
    return [new vscode.Location(vscode.Uri.parse(match.uri),new vscode.Range(start.line,start.character,end.line,end.character))];
  }
  async function endpoints(token) {
    if (!enabled()) return [];
    const uris = await vscode.workspace.findFiles('**/*.java', '**/{node_modules,.git,.idea,target,build}/**', 2000, token);
    const result = [], byWorkspace = new Map();
    function collect(uri, sheet) {
      result.push(...sheet.items);
      const scope = vscode.workspace.getWorkspaceFolder(uri)?.uri.toString();
      if (!scope || !sheet.interfaces.length) return;
      if (!byWorkspace.has(scope)) byWorkspace.set(scope,[]);
      byWorkspace.get(scope).push(...sheet.interfaces);
    }
    function scan(text, uri) {
      const contracts=endpointContractFile(text,uri,true);
      return {items:[...parseSpringEndpoints(text,uri,true).map(item=>({kind:'mvc',state:'declared',...item})),
        ...contracts.items],interfaces:contracts.interfaces};
    }
    for (const uri of uris) {
      if (token?.isCancellationRequested) return [];
      try {
        const uriString = uri.toString();
        const open = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uriString);
        if (open) {
          const text=open.getText();
          if (text.length<=1024*1024) collect(uri,scan(text,uriString));
          continue;
        }
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size>1024*1024) continue;
        const key = stat.mtime+'|'+stat.size, previous=cache.get(uriString);
        if (previous?.key === key) { collect(uri,previous); continue; }
        const bytes=await vscode.workspace.fs.readFile(uri);
        if(bytes.byteLength>1024*1024)continue;
        const sheet=scan(Buffer.from(bytes).toString('utf8'),uriString);
        if(cache.size>=2000&&!cache.has(uriString))cache.delete(cache.keys().next().value);
        cache.set(uriString,{key,...sheet});
        collect(uri,sheet);
      } catch (error) { output.appendLine('Spring endpoint scan: '+error.message); }
    }
    const resolved=new Set(), inherited=[];
    for (const records of byWorkspace.values()) {
      const group=inheritedFeignContracts(records);
      for(const key of group.replacements)resolved.add(key);
      inherited.push(...group.inherited);
    }
    return [...result.filter(item=>!(item.kind==='feign'&&item.reason==='Inherited Feign contracts require cross-file resolution.'&&
      resolved.has(item.uri+'\0'+item.containerName))),...inherited];
  }
  const selector = [{ scheme: 'file', pattern: '**/application*.properties' }, { scheme: 'file', pattern: '**/application*.yml' }, { scheme: 'file', pattern: '**/application*.yaml' }];
  subscriptions.push(vscode.languages.registerDefinitionProvider(selector,{provideDefinition:propertyDefinition}));
  subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    async provideCompletionItems(document, position, token) {
      if (!enabled()) return [];
      const line = document.lineAt(position.line).text;
      const yaml = /\.ya?ml$/i.test(document.uri.path);
      if (/^\s*[#!]/.test(line)) return [];
      if (yaml ? line.slice(0, position.character).includes(':') : /[=:]/.test(line.slice(0, position.character))) return [];
      const version=document.version;
      const parsed=yaml?yamlCompletionContext(document.getText(),position.line):null;
      if(yaml&&!parsed)return [];
      const prefix=parsed?.prefix||'';
      const prefixWithDot = prefix ? prefix + '.' : '';
      const entries = await properties(document.uri,token);
      if (token.isCancellationRequested||document.version!==version) return [];
      const seen = new Set();
      return entries.filter(entry => !prefix || entry.name.startsWith(prefixWithDot)).flatMap(entry => {
        const label = entry.name.slice(prefixWithDot.length);
        if (seen.has(label)) return []; seen.add(label);
        const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Property);
        item.insertText = label;
        const keyStart = parsed?.keyStart??/^\s*/.exec(line)[0].length;
        const separator = yaml ? line.indexOf(':') : line.search(/[=:]/);
        const keyEnd = parsed?.keyEnd??(separator >= 0 ? line.slice(0, separator).trimEnd().length : line.trimEnd().length);
        item.range = new vscode.Range(position.line, Math.min(keyStart, position.character), position.line, Math.max(position.character, keyEnd));
        item.detail = `${entry.type} · ${entry.origin}`;
        item.documentation = entry.description + (entry.defaultValue !== undefined && entry.defaultValue !== '' ? `\nDefault: ${String(entry.defaultValue)}` : '');
        return [item];
      });
    }
  }, '.', '-'));
  subscriptions.push(vscode.languages.registerWorkspaceSymbolProvider({
    async provideWorkspaceSymbols(query, token) {
      const items = await endpoints(token);
      if (token.isCancellationRequested) return [];
      const needle = query.replace(/^@\//, '/').toLowerCase();
      return items.filter(item => (item.name+' '+endpointDescription(item)).toLowerCase().includes(needle)).map(item => new vscode.SymbolInformation(item.name, vscode.SymbolKind.Method, item.containerName, new vscode.Location(vscode.Uri.parse(item.uri), new vscode.Range(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character))));
    }
  }));
  subscriptions.push(vscode.commands.registerCommand('rocketbrain.spring.endpoints', async (endpoint) => {
    const items = await endpoints();
    let item;
    if (endpoint) {
      item = items.find(candidate => candidate.uri === endpoint.uri && candidate.kind === endpoint.kind &&
        candidate.path === endpoint.path && candidate.method === endpoint.method && candidate.clientType === endpoint.clientType &&
        candidate.range.start.line === endpoint.range?.start?.line && candidate.range.start.character === endpoint.range?.start?.character);
    } else {
      const selected = await vscode.window.showQuickPick(items.map(item => ({label:item.name,description:endpointDescription(item),detail:vscode.workspace.asRelativePath(vscode.Uri.parse(item.uri)),endpoint:item})),
        {title:'Spring endpoints · source declarations',matchOnDescription:true,matchOnDetail:true,placeHolder:items.length ? 'Select a server mapping or client contract' : 'No Spring route declarations found'});
      item = selected?.endpoint;
    }
    if (!item) return;
    await vscode.window.showTextDocument(vscode.Uri.parse(item.uri), { selection: new vscode.Range(item.range.start.line, item.range.start.character, item.range.end.line, item.range.end.character) });
    return item;
  }));
  subscriptions.push(vscode.workspace.onDidChangeTextDocument(invalidate), vscode.workspace.onDidCreateFiles(invalidate), vscode.workspace.onDidDeleteFiles(invalidate), vscode.workspace.onDidRenameFiles(invalidate));
  return { endpoints, properties, analyze: semantic.analyze, snapshot: semantic.snapshot, definitions: semantic.definitions, refresh: semantic.refresh,
    beanGraph:semantic.beanGraph,autowiring:semantic.autowiring,qualifierInputs:semantic.qualifierInputs,runtime,
    dispose() { for (const item of subscriptions) item.dispose(); cache.clear(); } };
}

module.exports = { parseSpringEndpoints, sourceEndpoints, metadataProperties, yamlPrefix, registerSpringFeatures };
