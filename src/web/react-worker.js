'use strict';

// Executed in a separate Node process using the selected project's TypeScript.
async function reactWorker(input) {
  const fs=require('node:fs');
  const path=require('node:path');
  const {createHash}=require('node:crypto');
  const ts=require(input.entry);
  const physicalPaths=new Map();
  function inside(candidate) {
    const relative=path.relative(input.root,candidate);
    return !path.isAbsolute(relative) && relative!=='..' && !relative.startsWith('..'+path.sep);
  }
  function physical(file) {
    const absolute=path.resolve(file);
    if (!inside(absolute)) return;
    if (!physicalPaths.has(absolute)) {
      let current;
      try { current=fs.realpathSync(absolute); } catch { /* The compiler probes candidate import paths. */ }
      physicalPaths.set(absolute,current && inside(current) ? current : undefined);
    }
    return physicalPaths.get(absolute);
  }
  let budget=40*1024*1024;
  const reads=new Map();
  function readFile(file) {
    const real=physical(file);
    if (!real) return;
    if (!path.relative(real,input.file)) return input.source;
    if (reads.has(real)) return reads.get(real);
    const stat=fs.statSync(real);
    if (!stat.isFile() || stat.size>4*1024*1024 || stat.size>budget) return;
    const bytes=fs.readFileSync(real);
    if (bytes.length>4*1024*1024 || bytes.length>budget) return;
    budget-=bytes.length;
    const value=bytes.toString('utf8').replace(/^\uFEFF/,'');
    reads.set(real,value);
    return value;
  }
  const fileExists=file=>Boolean(physical(file) && ts.sys.fileExists(file));
  const directoryExists=file=>Boolean(physical(file) && ts.sys.directoryExists(file));
  const readDirectory=(root,...args)=>directoryExists(root) ? ts.sys.readDirectory(root,...args).filter(physical) : [];
  const raw=ts.readConfigFile(input.config,readFile);
  if (raw.error) return;
  const parsed=ts.parseJsonConfigFileContent(raw.config,
    {useCaseSensitiveFileNames:ts.sys.useCaseSensitiveFileNames,readFile,fileExists,readDirectory},input.root);
  if (parsed.errors.length || parsed.projectReferences?.length || parsed.options.jsx===undefined || parsed.fileNames.length>256 ||
      !parsed.fileNames.some(file=>!path.relative(file,input.file))) return;
  const host={
    getCompilationSettings:()=>({...parsed.options,noEmit:true}),
    getScriptFileNames:()=>parsed.fileNames,
    getScriptVersion:()=>'0',
    getScriptSnapshot(file) {
      const text=readFile(file);
      return text===undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory:()=>input.root,
    getDefaultLibFileName:options=>ts.getDefaultLibFilePath(options),
    useCaseSensitiveFileNames:()=>ts.sys.useCaseSensitiveFileNames,
    fileExists,readFile,readDirectory,directoryExists,
    realpath:file=>physical(file)||file,
    getDirectories:file=>directoryExists(file)?ts.sys.getDirectories(file).filter(item=>physical(path.resolve(file,item))):[]
  };
  const service=ts.createLanguageService(host,ts.createDocumentRegistry());
  try {
    const program=service.getProgram(), source=program?.getSourceFile(input.file);
    if (!source) return;
    const tags=[];
    function findTags(node) {
      if ((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node)) &&
          ts.isIdentifier(node.tagName) && /^[A-Z]/.test(node.tagName.text)) tags.push(node);
      ts.forEachChild(node,findTags);
    }
    findTags(source);
    if (input.action==='check') {
      const diagnostics=service.getSemanticDiagnostics(input.file).filter(item=>Number.isSafeInteger(item.start) &&
        tags.some(tag=>tag.getStart(source)<=item.start&&item.start<tag.end)).slice(0,100);
      return {types:ts.version,diagnostics:diagnostics.map(item=>({
        code:item.code,start:item.start,end:item.start+(item.length||1),
        message:ts.flattenDiagnosticMessageText(item.messageText,'\n').slice(0,1600)
      }))};
    }
    const point=input.offset;
    const tag=tags.filter(item=>item.tagName.end<=point&&point<=item.end).sort((a,b)=>b.pos-a.pos)[0];
    if (!tag) return;
    const attributes=tag.attributes.properties;
    const attribute=attributes.find(item=>ts.isJsxAttribute(item)&&
      item.name.getStart(source)<=point&&point<=item.name.end);
    if (attributes.some(item=>item.getStart(source)<=point&&point<item.end&&item!==attribute)) return;
    const checker=program.getTypeChecker();
    const parameter=checker.getResolvedSignature(tag)?.parameters[0];
    if (!parameter) return;
    const props=checker.getTypeOfSymbolAtLocation(parameter,tag);
    if (props.flags&(ts.TypeFlags.Any|ts.TypeFlags.Unknown)) return;
    const all=checker.getPropertiesOfType(props).filter(item=>/^[A-Za-z_$][\w$]*$/u.test(item.name));
    const existing=new Set(attributes.filter(ts.isJsxAttribute).filter(item=>item!==attribute).map(item=>item.name.getText(source)));
    if (input.action==='complete') {
      return {types:ts.version,component:tag.tagName.text,props:all.filter(item=>!existing.has(item.name)).slice(0,120).map(item=>({
        name:item.name,type:checker.typeToString(checker.getTypeOfSymbolAtLocation(item,tag)).slice(0,240),
        optional:Boolean(item.flags&ts.SymbolFlags.Optional)
      }))};
    }
    const prop=attribute && all.find(item=>item.name===attribute.name.getText(source));
    if (!prop) return;
    const locations=[];
    const snapshots=new Map();
    function append(file,start,end,definition) {
      if (!physical(file)) return;
      if (!snapshots.has(file)) {
        const target=program.getSourceFile(file);
        snapshots.set(file,target && createHash('sha256').update(target.text).digest('hex'));
      }
      const sha256=snapshots.get(file);
      if (sha256) locations.push({file,start,end,sha256,definition});
    }
    if (input.action==='definition') {
      for (const declaration of prop.declarations||[]) {
        const origin=declaration.getSourceFile();
        if (declaration.name) append(origin.fileName,declaration.name.getStart(origin),declaration.name.end,true);
      }
    } else {
      for (const symbol of service.findReferences(input.file,attribute.name.getStart(source))||[]) {
        for (const reference of symbol.references) {
          const {start,length}=reference.textSpan;
          const definition=reference.fileName===symbol.definition.fileName && start===symbol.definition.textSpan.start;
          append(reference.fileName,start,start+length,definition);
          if (locations.length>=200) break;
        }
        if (locations.length>=200) break;
      }
    }
    return {types:ts.version,component:tag.tagName.text,prop:prop.name,locations};
  } finally {service.dispose();}
}

module.exports={reactWorker};
