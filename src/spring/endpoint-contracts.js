'use strict';

const { parseJavaTokens, lexJava, matching, splitTop, annotation, rangeAt, KNOWN } = require('./java');

const WEBFLUX = 'org.springframework.web.reactive.function.server.';
const HTTP_METHOD = 'org.springframework.http.HttpMethod';
const REQUEST_METHOD = 'org.springframework.web.bind.annotation.RequestMethod';
const SHORTCUTS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const VERBS = new Set([...SHORTCUTS,'TRACE','CONNECT']);
const MAPPINGS = new Map(['Get', 'Post', 'Put', 'Patch', 'Delete', 'Request'].map(name => [KNOWN[name + 'Mapping'], name.toUpperCase()]));
const QUALIFIERS = new Set(['accept', 'contentType', 'headers', 'queryParam', 'version', 'pathExtension']);
const MAX_DEPTH = 12;
const MAX_CALLS = 120;

function literalPath(tokens) {
  if (tokens?.length !== 1 || tokens[0].kind !== 'string') return null;
  const value = tokens[0].value;
  return isPath(value) ? value : null;
}

function isPath(value) {
  return typeof value === 'string' && value.length <= 1024 && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value) && !/[$#]\{|:\/\//.test(value);
}

function absolutePath(path) {
  return path && !path.startsWith('/') ? '/' + path : path;
}

function combinePath(base, suffix) {
  if (!suffix) return base || '/';
  return (base.endsWith('/') ? base.slice(0,-1) : base) + absolutePath(suffix);
}

function staticImports(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length;) {
    const value = tokens[i].text;
    if (value !== 'package' && value !== 'import') break;
    let end = i + 1;
    while (end < tokens.length && tokens[end].text !== ';') end++;
    if (end === tokens.length) break;
    if (value === 'import' && tokens[i+1]?.text === 'static') result.push(tokens.slice(i+2,end).map(token => token.text).join(''));
    i = end + 1;
  }
  return result;
}

function resolvesMember(call, owner, file) {
  if (call.qualifier) {
    if (file.localNames?.has(call.qualifier.split('.')[0])) return false;
    if (call.qualifier === owner) return true;
    const short = owner.split('.').at(-1);
    return call.qualifier === short && !file.types.some(type => type.name === short) &&
      (file.imports[short] ? file.imports[short] === owner : file.wildcards.includes(owner.slice(0,owner.lastIndexOf('.'))));
  }
  const exact = owner + '.' + call.name;
  // An explicit import of the same member from another type or a same-name
  // declaration makes an unqualified call ambiguous in this source model.
  if (file.types.some(type => type.methods.some(method => method.name === call.name))) return false;
  if (file.staticImports.includes(exact)) return !file.staticImports.some(value => value !== exact && value.endsWith('.' + call.name));
  const wildcard = owner + '.*';
  return file.staticImports.includes(wildcard) &&
    !file.staticImports.some(value => value !== wildcard && (value.endsWith('.*') || value.endsWith('.' + call.name)));
}

function argumentsOf(tokens) {
  const args = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const value = tokens[i].text;
    if ('({['.includes(value) && value.length === 1) {
      i = matching(tokens,i);
      if (i < 0) return null;
    } else if (value === ',') {
      args.push(tokens.slice(start,i));
      start = i + 1;
    }
  }
  if (tokens.length) args.push(tokens.slice(start));
  return args.some(arg => !arg.length) ? null : args;
}

function invocation(tokens, start = 0, allowQualifier = true) {
  if (tokens[start]?.kind !== 'id') return null;
  let index = start;
  while (allowQualifier && tokens[index+1]?.text === '.' && tokens[index+2]?.kind === 'id') index += 2;
  if (tokens[index+1]?.text !== '(') return null;
  const close = matching(tokens,index+1);
  if (close < 0) return null;
  const args = argumentsOf(tokens.slice(index+2,close));
  if (!args) return null;
  return { name:tokens[index].text, qualifier:tokens.slice(start,index).map(token => token.text).join('').slice(0,-1),
    args, start:tokens[start].start, end:tokens[index].end, next:close+1 };
}

function chain(tokens, start) {
  const calls = [];
  for (let i = start; i < tokens.length;) {
    if (calls.length >= MAX_CALLS || tokens[i].text !== '.') return null;
    const call = invocation(tokens,i+1,false);
    if (!call) return null;
    calls.push(call);
    i = call.next;
  }
  return calls;
}

function httpConstant(tokens, owner, file) {
  const kind = tokens.at(-1)?.text, prefix = tokens.slice(0,-2).map(token => token.text).join('');
  if (!VERBS.has(kind) || (owner === REQUEST_METHOD && kind === 'CONNECT')) return null;
  if (tokens.length === 1) {
    const exact = owner + '.' + kind;
    return file.staticImports.includes(exact) && !file.staticImports.some(value => value !== exact && value.endsWith('.'+kind)) ? kind : null;
  }
  return tokens.at(-2).text === '.' &&
    (prefix === owner || resolvesMember({name:kind,qualifier:prefix},owner,file)) ? kind : null;
}

function predicate(tokens, file, depth) {
  if (depth > MAX_DEPTH) return null;
  const head = invocation(tokens);
  if (!head || !resolvesMember(head,WEBFLUX + 'RequestPredicates',file)) return null;
  let value = { path:null, verb:null, constrained:false };
  if ((head.name === 'path' || SHORTCUTS.has(head.name)) && head.args.length === 1) {
    value.path = literalPath(head.args[0]);
    if (value.path === null) return null;
    if (head.name !== 'path') value.verb = head.name;
  } else if (head.name === 'method' && head.args.length === 1) {
    value.verb = httpConstant(head.args[0],HTTP_METHOD,file);
    if (!value.verb) return null;
  } else if (QUALIFIERS.has(head.name)) value.constrained = true;
  else if (head.name === 'all' && !head.args.length) value.constrained = false;
  else return null;
  const tail = chain(tokens,head.next);
  if (!tail) return null;
  for (const call of tail) {
    if (call.name !== 'and' || call.args.length !== 1) return null;
    const next = predicate(call.args[0],file,depth+1);
    if (!next || (value.path !== null && next.path !== null) || (value.verb && next.verb && value.verb !== next.verb)) return null;
    value = { path:value.path ?? next.path, verb:value.verb ?? next.verb, constrained:value.constrained || next.constrained };
  }
  return value;
}

function lambdaCalls(tokens) {
  const parenthesized = tokens[0]?.text === '(' && tokens[2]?.text === ')';
  const parameter = tokens[parenthesized ? 1 : 0], arrow = parenthesized ? 3 : 1;
  if (parameter?.kind !== 'id' || tokens[arrow]?.text !== '-' || tokens[arrow+1]?.text !== '>') return null;
  const start = arrow + 2;
  if (tokens[start]?.text === parameter.text) return chain(tokens,start+1);
  if (tokens[start]?.text !== '{' || matching(tokens,start) !== tokens.length-1) return null;
  const calls = [];
  for (let at = start+1; at < tokens.length-1;) {
    if (tokens[at].text !== parameter.text) return null;
    let end = at+1;
    while (end < tokens.length-1 && tokens[end].text !== ';') {
      if (tokens[end].text === '(') end = matching(tokens,end);
      if (end < 0) return null;
      end++;
    }
    if (tokens[end]?.text !== ';') return null;
    const statement = chain(tokens.slice(at+1,end),0);
    if (!statement?.length || calls.length+statement.length > MAX_CALLS) return null;
    calls.push(...statement);
    at = end+1;
  }
  return calls;
}

function scanFunctional(type, file, method, expression, publish) {
  function unresolved(span, reason = 'Route path or predicate is computed or unsupported.') {
    publish('webflux',type,method,span,{ state:'unresolved', reason });
  }
  function report(scope, path, verb, span, constrained) {
    publish('webflux',type,method,span,{ path:combinePath(scope.base,path), methods:[verb || 'ANY'], constrained:scope.constrained || constrained });
  }
  function withPrefix(scope, part) {
    return { base:part.path === null ? scope.base : combinePath(scope.base,part.path), constrained:scope.constrained || part.constrained };
  }
  function route(scope, call, depth) {
    const part = call.args.length === 2 && predicate(call.args[0],file,depth+1);
    if (part && part.path !== null) report(scope,part.path,part.verb,call,part.constrained);
    else unresolved(call);
  }
  function builder(scope, calls, depth) {
    if (depth > MAX_DEPTH) { unresolved(method,'Router nesting exceeds the analysis limit.'); return; }
    for (const call of calls) {
      const { name, args } = call;
      if (SHORTCUTS.has(name)) {
        const path = (args.length === 2 || args.length === 3) ? literalPath(args[0]) : null;
        if (path !== null) report(scope,path,name,call,args.length === 3);
        else {
          const part = args.length === 2 && predicate(args[0],file,depth+1);
          if (part && part.path !== null && (!part.verb || part.verb === name)) report(scope,part.path,name,call,part.constrained);
          else unresolved(call);
        }
      } else if (name === 'route') route(scope,call,depth);
      else if (name === 'path' || name === 'nest') {
        const part = args.length === 2 && (name === 'path'
          ? {path:literalPath(args[0]),verb:null,constrained:false}
          : predicate(args[0],file,depth+1));
        if (!part || part.verb || (name === 'path' && part.path === null)) {
          unresolved(call,'Nested route prefix or predicate is unresolved.');
          continue;
        }
        const nested = withPrefix(scope,part), children = lambdaCalls(args[1]);
        if (children) builder(nested,children,depth+1);
        else if (args[1].slice(0,4).map(token=>token.text).join('') === '()->') root(nested,args[1].slice(4),depth+1,call);
        else unresolved(call,'Nested router lambda is unresolved.');
      } else if (name === 'add' && args.length === 1) root(scope,args[0],depth+1,call);
      else if (!['build','filter','before','after','onError','withAttribute','withAttributes'].includes(name)) unresolved(call,'Unsupported WebFlux builder operation.');
    }
  }
  function root(scope, tokens, depth, span) {
    if (depth > MAX_DEPTH) { unresolved(span,'Router nesting exceeds the analysis limit.'); return; }
    const head = invocation(tokens);
    const rest = head && chain(tokens,head.next);
    if (!rest || !resolvesMember(head,WEBFLUX + 'RouterFunctions',file)) {
      unresolved(span || method,'Router expression does not resolve to a supported Spring factory.'); return;
    }
    if (head.name === 'route' && !head.args.length && rest.at(-1)?.name === 'build') { builder(scope,rest,depth+1); return; }
    if (head.name === 'route') route(scope,head,depth);
    else if (head.name === 'nest' && head.args.length === 2) {
      const part = predicate(head.args[0],file,depth+1);
      if (part && !part.verb) root(withPrefix(scope,part),head.args[1],depth+1,head);
      else unresolved(head);
    } else unresolved(head,'Unsupported WebFlux router factory operation.');
    for (const call of rest) {
      if (call.name === 'andRoute') route(scope,call,depth);
      else if (call.name === 'and' && call.args.length === 1) root(scope,call.args[0],depth+1,call);
      else if (!['filter','withAttribute','withAttributes'].includes(call.name)) unresolved(call,'Unsupported WebFlux router operation.');
    }
  }
  root({base:'',constrained:false},expression,0,method);
}

function mappingPaths(item) {
  const keys = ['path','value'].filter(key => Object.hasOwn(item.attributes,key));
  const paths = keys.length ? keys.map(key => {
    const tokens = item.attributes[key];
    if (tokens[0]?.text !== '{' || tokens.at(-1)?.text !== '}') return [literalPath(tokens)];
    const entries = tokens.slice(1,-1);
    if (entries.at(-1)?.text === ',') entries.pop();
    return entries.length ? splitTop(entries).map(literalPath) : [''];
  }) : [['']];
  if (paths.some(values => values.includes(null))) return null;
  if (paths.length === 2 && JSON.stringify(paths[0]) !== JSON.stringify(paths[1])) return null;
  return paths[0];
}

function feignClient(type, client) {
  const base = Object.hasOwn(client.attributes,'path') ? literalPath(client.attributes.path) : '';
  const reason = base === null ? 'Feign client path is computed or unresolved.'
    : annotation(type.annotations,'RequestMapping') ? 'Type-level RequestMapping is unsupported on a Feign client.'
      : Object.hasOwn(client.attributes,'configuration') ? 'Feign custom contract configuration needs runtime evidence.'
        : null;
  return {base,reason};
}

function feignMethod(method,file) {
  if (method.modifiers.some(value=>['default','static','private'].includes(value))) return null;
  const declarations = method.annotations.filter(item=>MAPPINGS.has(item.name));
  if (!declarations.length) return null;
  const [mapping] = declarations, verb = MAPPINGS.get(mapping.name), attr = mapping.attributes.method;
  let methods = [verb === 'REQUEST' ? 'GET' : verb];
  if (verb === 'REQUEST' && attr) {
    const array = attr[0]?.text === '{' && attr.at(-1)?.text === '}';
    const values = array ? attr.slice(1,-1) : attr;
    if (values.length) methods = splitTop(values).map(value=>httpConstant(value,REQUEST_METHOD,file));
  }
  const paths = mappingPaths(mapping);
  if (declarations.length !== 1 || methods.length !== 1 || !methods[0] || paths?.length !== 1) {
    return {mapping,state:'unresolved',reason:'Feign requires one supported HTTP method and one literal method path.'};
  }
  return {mapping,path:paths[0],methods,
    constrained:['consumes','produces','headers','params'].some(key=>Object.hasOwn(mapping.attributes,key))};
}

function scanFeign(type, client, file, publish) {
  const {base,reason}=feignClient(type,client);
  if (reason || type.superTypes.length) publish('feign',type,null,client,{state:'unresolved',
    reason:reason || 'Inherited Feign contracts require cross-file resolution.'});
  if (reason) return;
  for (const method of type.methods) {
    const route=feignMethod(method,file);
    if (!route) continue;
    const {mapping,path,...details}=route;
    publish('feign',type,method,mapping,{...details,...(route.state!=='unresolved'?{
      path:combinePath(absolutePath(base).replace(/\/$/,''),path)
    }:{})});
  }
}

const PRIMITIVES=new Set(['boolean','byte','short','char','int','long','float','double']);
const IDENTIFIER=/^[\p{L}_$][\p{L}\p{N}_$]*$/u;
function sourceMethodKey(method,file,tokens,offsets) {
  const start=offsets.get(method.start)+1,end=matching(tokens,start);
  if(tokens[start]?.text!=='('||end<0||(end-start>1?splitTop(tokens.slice(start+1,end)).length:0)!==method.parameters.length)return null;
  const argumentTypes=method.parameters.map(({type})=>{
    const raw=type.raw.replace(/(?:\[\]|\.\.\.)$/,'');
    const array=raw!==type.raw;
    const name=PRIMITIVES.has(raw)?raw:raw.includes('.')?raw:
      (Object.hasOwn(file.imports,raw)?file.imports[raw]:type.name.startsWith('java.lang.')?type.name:null);
    return name?.split('.').every(part=>IDENTIFIER.test(part))?name+(array?'[]':''):null;
  });
  return argumentTypes.includes(null)?null:method.name+'('+argumentTypes.join(',')+')';
}

function interfaceRecord(type,file,tokens,offsets) {
  const name=offsets.get(type.start);
  const header=tokens.slice(name+1,tokens.findIndex((token,index)=>index>name&&token.text==='{'));
  const inheritance=header.findIndex(token=>token.text==='extends');
  const permits=header.findIndex(token=>token.text==='permits');
  const parentTokens=inheritance>=0?header.slice(inheritance+1,permits<0?header.length:permits):[];
  const parent=parentTokens.map(token=>token.text).join('');
  const plainParent=parent?parent.split('.').every(part=>IDENTIFIER.test(part)):true;
  const client=annotation(type.annotations,'FeignClient');
  return {fqn:type.fqn,name:type.name,uri:file.uri,packageName:file.packageName,imports:file.imports,wildcards:file.wildcards,
    parent:plainParent?parent:null,hasParents:type.superTypes.length>0,unsupported:header.some(token=>token.text==='<')||
      !!annotation(type.annotations,'RequestMapping')||!plainParent,
    client:client?{...feignClient(type,client),range:rangeAt(file.text,client.start,client.end)}:null,
    methods:type.methods.filter(method=>!method.modifiers.some(value=>['static','private'].includes(value))).map(method=>{
      const route=feignMethod(method,file);
      return {key:sourceMethodKey(method,file,tokens,offsets),name:method.name,requiresRoute:!method.modifiers.includes('default'),route:route?{path:route.path,methods:route.methods,
        constrained:route.constrained,state:route.state,reason:route.reason,range:rangeAt(file.text,route.mapping.start,route.mapping.end)}:null};
    })};
}

function feignParent(record,index) {
  const raw=record.parent;
  if (!raw) return null;
  if (raw.includes('.')) return index.get(raw);
  if (Object.hasOwn(record.imports,raw)) return index.get(record.imports[raw]);
  const local=(record.packageName?record.packageName+'.':'')+raw;
  if (index.has(local)) return index.get(local);
  if (record.wildcards.length===1) return index.get(record.wildcards[0]+'.'+raw);
  return null;
}

function inheritedFeignContracts(interfaces) {
  const index=new Map(), replacements=new Set(), inherited=[];
  for (const record of interfaces) index.set(record.fqn,index.has(record.fqn)?null:record);
  for (const child of interfaces) {
    if (!child.client||child.client.reason||!child.hasParents||child.unsupported||index.get(child.fqn)!==child||inherited.length>=2000) continue;
    const seen=new Set([child.fqn]),methods=new Set();
    let current=child,chain=[],safe=true;
    while (current.hasParents && safe) {
      const parent=feignParent(current,index);
      if (!parent||parent.unsupported||seen.has(parent.fqn)||chain.length>=12) {safe=false;break;}
      seen.add(parent.fqn);
      chain.push(parent);
      current=parent;
    }
    if (!safe || [child,...chain].some(record=>record.methods.some(method=>!method.key)||
      new Set(record.methods.map(method=>method.key)).size!==record.methods.length)) continue;
    for (const method of child.methods) {
      methods.add(method.key);
      if (method.requiresRoute&&!method.route) safe=false;
    }
    const additions=[];
    for (const parent of chain) for (const method of parent.methods) {
      if (methods.has(method.key)) continue;
      methods.add(method.key);
      const route=method.route;
      if (!route) {if(method.requiresRoute)safe=false;continue;}
      const state=route.state||'declared',path=state==='declared'?combinePath(absolutePath(child.client.base).replace(/\/$/,''),route.path):null;
      const verbs=route.methods||[];
      additions.push({kind:'feign',state,name:state==='declared'?verbs.join('|')+' '+path:'Unresolved Feign contract',
        path,methods:verbs,constrained:!!route.constrained,reason:route.reason,method:method.name,containerName:child.name,
        clientType:child.fqn,declaringType:parent.fqn,inherited:true,uri:parent.uri,range:route.range});
    }
    if(!safe||inherited.length+additions.length>2000)continue;
    replacements.add(child.uri+'\0'+child.name);
    inherited.push(...additions);
  }
  return {replacements,inherited};
}

function returnExpression(tokens, nameIndex) {
  const parameters = matching(tokens,nameIndex+1);
  if (parameters < 0) return [];
  let open = parameters + 1;
  while (open < tokens.length && !['{',';'].includes(tokens[open].text)) open++;
  if (tokens[open]?.text !== '{') return [];
  const close = matching(tokens,open);
  if (close < 0 || tokens[open+1]?.text !== 'return' || tokens[close-1]?.text !== ';') return [];
  const expr = tokens.slice(open+2,close-1);
  // A direct return avoids making path assertions for local flow and multiple branches.
  for (let i = 0; i < expr.length; i++) {
    const token = expr[i].text;
    if (token === '(') i = matching(expr,i);
    else if (token === ';' || token === '{') return [];
    if (i < 0) return [];
  }
  return expr;
}

function endpointContractFile(text, uri = '', includeInterfaces = false) {
  const result = [], interfaces = [];
  if (text.length > 1024 * 1024 || !/\b(?:RouterFunction|FeignClient)\b/.test(text)&&!(includeInterfaces&&/\binterface\b/.test(text))) return {items:result,interfaces};
  const lexical = lexJava(text);
  if (lexical.issues.length || lexical.tokens.length > 64000) return {items:result,interfaces};
  const file = parseJavaTokens({text,uri},lexical), tokens = lexical.tokens;
  file.staticImports = staticImports(tokens);
  const offsets = new Map(tokens.map((token,index) => [token.start,index]));
  function publish(kind,type,method,span,details) {
    if (result.length >= 500) return;
    const {path = null,methods = [],state = 'declared',reason,constrained = false} = details;
    const name = state === 'unresolved' ? 'Unresolved ' + (kind === 'webflux' ? 'WebFlux route' : 'Feign contract')
      : methods.join('|') + ' ' + path;
    result.push({kind,state,name,path,methods,constrained,reason,method:method?.name || type.name,
      containerName:type.name,uri,range:rangeAt(text,span.start,span.end)});
  }
  for (const type of file.types) {
    const client = annotation(type.annotations,'FeignClient');
    if (client && type.kind === 'interface') scanFeign(type,client,file,publish);
    if (includeInterfaces && type.kind === 'interface') interfaces.push(interfaceRecord(type,file,tokens,offsets));
    for (const method of type.methods) {
      if (!annotation(method.annotations,'Bean') || method.type.name !== KNOWN.RouterFunction ||
          (method.type.raw.startsWith('RouterFunction') && file.types.some(item => item.name === 'RouterFunction'))) continue;
      const localNames = new Set([...type.fields,...method.parameters].map(item=>item.name));
      scanFunctional(type,{...file,localNames},method,returnExpression(tokens,offsets.get(method.start)),publish);
    }
  }
  return {items:result,interfaces};
}

function parseEndpointContracts(text,uri) { return endpointContractFile(text,uri).items; }

module.exports = { parseEndpointContracts, endpointContractFile, inheritedFeignContracts, mappingPaths };
