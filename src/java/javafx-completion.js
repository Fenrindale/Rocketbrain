'use strict';

const path = require('node:path');
const { fxmlCompletionContext } = require('./javafx-completion-context');
const { fxmlComponent, inputsOf, inspectClasses } = require('./javafx-class-index');
const { workspaceRoots } = require('./workbench-model');

const node = 'javafx/scene/Node';
const containers = new Set(['javafx/scene/layout/Pane','javafx/scene/Group']);
const minimum = {import:2,tag:1,property:0,value:0};
const dotted = name => name.replaceAll('/','.');
const packageOf = name => dotted(name.slice(0,name.lastIndexOf('/')));
const simple = name => name.slice(name.lastIndexOf('/')+1);
const prefix = (value,start) => value.toLowerCase().startsWith(start.toLowerCase());

function family(entry, classes) {
  const lineage = [];
  while (entry && lineage.length < 32 && !lineage.includes(entry)) {
    lineage.push(entry);
    if (entry.name===node) return lineage;
    entry = classes.get(entry.parent);
  }
  return [];
}

function classFor(tag, imports, classes, packages) {
  if (tag.includes('.')) return classes.get(tag.replaceAll('.','/'));
  const direct = [...new Set(imports.filter(name=>name.endsWith('.'+tag)))];
  if (direct.length) return direct.length===1 ? classes.get(direct[0].replaceAll('.','/')) : undefined;
  const wildcards = [...new Set(imports.filter(name=>name.endsWith('.*')).map(name=>name.slice(0,-2)))];
  if (wildcards.some(name=>!packages.has(name))) return;
  const candidates = wildcards.map(name=>name+'.'+tag).filter(name=>classes.has(name.replaceAll('.','/')));
  return candidates.length===1 ? classes.get(candidates[0].replaceAll('.','/')) : undefined;
}

function properties(lineage) {
  const getters = new Map(), setters = new Map();
  for (const entry of lineage.filter(item=>item.visible)) {
    for (const [method,types] of entry.methods) {
      const kind = method.startsWith('is')?'is':method.slice(0,3);
      const member = method.slice(kind.length), target = kind==='set'?setters:getters;
      if (kind==='set') {
        if (!target.has(member)) target.set(member,new Set());
        for (const type of types) target.get(member).add(type);
      } else if (!target.has(method)) target.set(method,types);
    }
  }
  const available = new Map();
  for (const [member,accepted] of setters) {
    const offered = getters.get('get'+member)||getters.get('is'+member);
    if (offered?.size!==1) continue;
    const type = offered.values().next().value;
    if (accepted.has(type)) available.set(member[0].toLowerCase()+member.slice(1),type);
  }
  return available;
}

function acceptsNodes(hole, classes, packages) {
  if (!hole.parents.length) return true;
  const parent = hole.parents.at(-1);
  if (parent.includes(':')) return false;
  if (/^[a-z][\w]*$/u.test(parent) && hole.parents.length>1) {
    const receiver = classFor(hole.parents.at(-2),hole.imports,classes,packages);
    const lineage = family(receiver,classes);
    if (parent==='children' && lineage.some(entry=>containers.has(entry.name))) return true;
    return properties(lineage).get(parent)==='Ljavafx/scene/Node;';
  }
  const receiver = classFor(parent,hole.imports,classes,packages);
  return family(receiver,classes).some(entry=>containers.has(entry.name));
}

function suggestions(hole, classes) {
  const packages = new Set([...classes.keys()].map(packageOf));
  if (hole.kind==='tag' && !acceptsNodes(hole,classes,packages)) return [];
  if (hole.kind==='tag' || hole.kind==='import') {
    const result = [];
    for (const entry of classes.values()) {
      if (!entry.visible || !entry.constructor || !family(entry,classes).length) continue;
      const qualified = dotted(entry.name), name = simple(entry.name);
      const imported = classFor(name,hole.imports,classes,packages)===entry;
      if (hole.kind==='import' && hole.imports.includes(qualified)) continue;
      if (!prefix(qualified,hole.prefix) && (hole.kind==='import' || !prefix(name,hole.prefix))) continue;
      const text = hole.kind==='tag' && imported && !hole.prefix.includes('.') ? name : qualified;
      result.push({name:text,text,description:packageOf(entry.name),detail:entry.origin==='jar'?'OpenJFX class':'Built Java project class',
        kind:'class',score:text===name?0:1});
    }
    return result.sort((left,right)=>left.score-right.score||left.name.localeCompare(right.name)).slice(0,80);
  }
  const entry = classFor(hole.className,hole.imports,classes,packages);
  if (!entry?.visible || !entry.constructor) return [];
  const available = properties(family(entry,classes));
  if (hole.kind==='value') {
    if (!['Z','Ljava/lang/Boolean;'].includes(available.get(hole.property))) return [];
    return ['true','false'].filter(value=>prefix(value,hole.prefix)).map(text=>({name:text,text,kind:'value'}));
  }
  return [...available.entries()].filter(([name])=>prefix(name,hole.prefix)&&!hole.seen.has(name))
    .sort(([left],[right])=>left.localeCompare(right)).slice(0,80)
    .map(([name,type])=>({name,text:name,kind:'property',template:!hole.equals,type}));
}

function registerFxmlCompletion(vscode, java, selector) {
  const cache = new Map();
  let disposed = false;

  async function completions(document,position,cancellation) {
    if (disposed || cancellation?.isCancellationRequested || !vscode.workspace.isTrusted || document.isClosed ||
        document.uri.scheme!=='file' || document.uri.authority || !document.fileName.endsWith('.fxml')) return [];
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return [];
    const version = document.version, text = document.getText();
    const hole = fxmlCompletionContext(text,document.offsetAt(position));
    if (!hole || hole.prefix.length<minimum[hole.kind]) return [];
    try {
      const workspace = workspaceRoots([folder])[0];
      const component = await fxmlComponent({filename:document.fileName,workspace,
        request:java.requestWorkspaceCommand,cancellation});
      if (!component || disposed || cancellation?.isCancellationRequested || document.version!==version) return [];
      const javaHome = vscode.workspace.getConfiguration('rocketbrain.java',document.uri).get('javaHome')||java.getState().javaHome;
      if (typeof javaHome!=='string' || !path.isAbsolute(javaHome)) return [];
      const dirty = file => vscode.workspace.textDocuments.some(open=>open.isDirty && open.uri.scheme==='file' &&
        !path.relative(file,open.uri.fsPath));
      const inputs = inputsOf(component,dirty), fingerprint = JSON.stringify([javaHome,inputs]);
      const key = component.root+'\0'+component.scope;
      let record = cache.get(key);
      if (record?.fingerprint!==fingerprint) {
        if (cache.size>=4 && !record) {
          const oldest = cache.keys().next().value;
          cache.get(oldest).abort.abort();
          cache.delete(oldest);
        }
        record?.abort.abort();
        const abort = new AbortController();
        const result = inspectClasses(inputs,javaHome,abort.signal);
        record = {fingerprint,abort,result};
        cache.set(key,record);
        result.catch(()=>{if(cache.get(key)===record)cache.delete(key);});
      }
      const classes = await record.result;
      if (disposed || cancellation?.isCancellationRequested || document.isClosed || document.version!==version ||
          !vscode.workspace.isTrusted || !vscode.workspace.getWorkspaceFolder(document.uri) ||
          fingerprint!==JSON.stringify([javaHome,inputsOf(component,dirty)])) return [];
      return suggestions(hole,classes).map((candidate,index)=>{
        const kind = {class:vscode.CompletionItemKind.Class,property:vscode.CompletionItemKind.Property,value:vscode.CompletionItemKind.Value};
        const item = new vscode.CompletionItem(candidate.name,kind[candidate.kind]);
        item.detail = 'Rocketbrain FXML'+(candidate.detail?' · '+candidate.detail:'');
        if (candidate.description) item.documentation = candidate.description;
        item.range = new vscode.Range(document.positionAt(hole.start),document.positionAt(hole.end));
        item.insertText = candidate.template ? new vscode.SnippetString(candidate.text+'="${1}"') : candidate.text;
        item.sortText = '0'+String(index).padStart(3,'0');
        return item;
      });
    } catch {
      // Incomplete or unobserved module inputs must not yield guessed FXML suggestions.
      return [];
    }
  }

  const provider = vscode.languages.registerCompletionItemProvider(selector,{provideCompletionItems:completions},'<',' ','=','"',"'",'.');
  return { completions, dispose() {
    disposed=true;
    provider.dispose();
    for (const item of cache.values()) item.abort.abort();
    cache.clear();
  } };
}

module.exports = { registerFxmlCompletion, suggestions };
