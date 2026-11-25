'use strict';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 2000);
const tableName = value => typeof value === 'string' ? value : value?.physicalName || value?.name || value?.value || 'unresolved';

/** A native, read-only view. Expanding a node never connects to an application. */
function registerAnalysisTree(context, vscode, { spring, jpa }) {
  const events = new vscode.EventEmitter();
  let comparison, disposed = false;
  const refresh = () => { if (!disposed) events.fire(); };
  function node(label, description, children = [], icon = 'symbol-namespace', source) {
    const item = new vscode.TreeItem(clean(label), children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.description = clean(description); item.iconPath = new vscode.ThemeIcon(icon); item.children = children;
    item.tooltip = clean([label, description].filter(Boolean).join('\n'));
    if (source?.uri && source?.range) {
      try {
        const uri = vscode.Uri.parse(source.uri);
        if (uri.scheme === 'file' && vscode.workspace.getWorkspaceFolder(uri)) {
          item.command = { command: 'vscode.open', title: 'Open Source', arguments: [uri, { selection: new vscode.Range(source.range.start.line, source.range.start.character, source.range.end.line, source.range.end.character) }] };
        }
      } catch { /* A runtime-only element has no source navigation. */ }
    }
    return item;
  }
  function limited(values, build) {
    const entries = Array.isArray(values) ? values : [];
    const nodes = entries.slice(0, 500).map(build);
    if ((values?.length || 0) > 500) nodes.push(node('More entries omitted', 'First 500 entries shown. Use the dedicated search command.'));
    return nodes;
  }
  async function roots() {
    const runtime = spring.runtime?.snapshot?.() || { state: 'disconnected', contexts: [] };
    const source = await spring.analyze();
    const model = await jpa.snapshot();
    const providerRuntime=jpa.observer?.snapshot?.()||{state:'disconnected',factories:[],events:[]};
    const contextNodes = limited(runtime.contexts, app => node(app.id, app.parentId ? `parent: ${app.parentId}` : 'observed application context', limited(app.beans, bean => {
      const candidates = (source.beans || []).filter(item => item.name === bean.name);
      const location = candidates.length === 1 ? candidates[0] : undefined;
      return node(bean.name, `${bean.type || 'unknown type'} · ${bean.scope || 'scope unknown'}${location ? ' · source name match; revision unverified' : ''}`, limited(bean.dependencies, dependency => node(dependency, 'observed dependency', [], 'symbol-reference')), 'symbol-class', location);
    }), 'server-process'));
    const conditions = [true, false].map(matched => node(matched ? 'Matched conditions' : 'Unmatched conditions', 'Observed report; missing entries are not a negative proof', limited((runtime.conditions || []).filter(item => item.matched === matched), item => node(item.source, item.condition, [], matched ? 'pass' : 'circle-slash')), 'filter'));
    const endpoints = Object.entries(runtime.endpoints || {}).map(([name, result]) => node(name, `${result.state}${result.status ? ` · HTTP ${result.status}` : ''}`, [], result.state === 'available' ? 'pass' : 'info'));
    const healthState = spring.runtime?.health?.snapshot?.();
    const health = node('Actuator Health', healthState?.state === 'observed' ?
      [healthState.path.at(-1)?.name, healthState.observation.status].filter(Boolean).join(' · ') : 'Open to observe', [], 'heart');
    health.command = { command: 'rocketbrain.spring.runtimeHealth', title: 'Open Spring Actuator Health' };
    const runtimeChildren = [
      health,
      node('Endpoint coverage', runtime.fetchedAt ? `${runtime.fetchedAt} · use Refresh Runtime Snapshot to fetch again` : 'No runtime snapshot; connect explicitly', endpoints, 'checklist'),
      node('Bean contexts', `${runtime.counts?.beans || 0} observed beans`, contextNodes, 'symbol-class'),
      node('Conditions', `${runtime.counts?.conditions || 0} report entries`, conditions, 'filter'),
      node('Configuration keys', 'Values are not retained', limited(runtime.configurationProperties, item => node(item.prefix || item.bean, item.bean, limited(item.keys, key => node(key, 'observed key; value omitted')), 'settings-gear')), 'settings-gear'),
      node('HTTP mappings', `${runtime.counts?.mappings || 0} observed mappings`, limited(runtime.mappings, item => node(`${(item.methods || []).join('|') || 'ANY'} ${(item.paths || []).join(', ')}`, [item.handlerType, item.handlerMethod].filter(Boolean).join('.'), [], 'link')), 'link')
    ];
    const entityNodes = limited(model.entities, entity => {
      const fields = entity.attributes || entity.fields || [];
      const attributes=limited(fields, field => node(field.name, [field.javaType || field.type?.name || field.type, field.columns?.length ? `columns: ${field.columns.map(tableName).join(', ')}` : field.column ? `column: ${tableName(field.column)}` : '', field.kind || field.relationship || field.association || '',field.status==='unknown'?'mapping unresolved':''].filter(value => typeof value === 'string').join(' · '), [], field.id || field.primaryKey ? 'key' : 'symbol-field', field));
      if(Array.isArray(entity.columnMappings))attributes.push(node('Physical column mappings',`${entity.columnMappings.length} bindings · configured naming assumptions`,limited(entity.columnMappings,binding=>node(binding.property,[tableName(binding.storageTable),binding.column?tableName(binding.column):'column unresolved',binding.status,binding.column?.dbType?.certainty==='known'?(binding.column.dbType.expectedFamilies||[]).join('/'):(binding.column?.dbType?.reason||binding.reason||'')].filter(Boolean).join(' · '),[],'symbol-field',binding)),'table'));
      return node(entity.name || entity.entityName || entity.className, `table: ${tableName(entity.table)} · ${entity.mappingState||'source mapping'}`, attributes, 'symbol-class', entity);
    });
    if (jpa.catalogComparison) comparison = jpa.catalogComparison();
    const catalogGroups = comparison ? [
      node('Matched mappings', `${comparison.matches?.length || 0}`, limited(comparison.matches, issue => node([issue.entity, issue.property].filter(Boolean).join('.'), [issue.table, issue.column].filter(Boolean).join('.'), [], 'pass', issue)), 'pass'),
      node('Catalog findings', `${comparison.mismatches?.length || 0}`, limited(comparison.mismatches, issue => node(issue.message || issue.reason || issue.code, [issue.entity, issue.property].filter(Boolean).join('.'), [], 'info', issue)), 'info'),
      node('Unresolved mappings', `${comparison.unknowns?.length || 0}`, limited(comparison.unknowns, issue => node(issue.message || issue.reason || 'Unknown mapping', [issue.entity, issue.property].filter(Boolean).join('.'), [], 'question', issue)), 'question')
    ] : [];
    const relationships = node('JPA Relationships', 'Open the source or observed Hibernate entity diagram', [], 'type-hierarchy');
    relationships.command = { command: 'rocketbrain.jpa.relationshipDiagram', title: 'JPA: Show Entity Relationship Diagram' };
    const jpaChildren = [
      relationships,
      node('JPA provider runtime', `${providerRuntime.state} · ${providerRuntime.fetchedAt||'Connect explicitly to observe'}`, [
        ...limited(providerRuntime.factories, factory=>node(factory.id,`${factory.provider} ${factory.version} · runtime/source revision unverified`,[
          node('Runtime mappings',`${factory.entities?.length||0} entities`,limited(factory.entities,entity=>node(entity.name||entity.javaType,entity.javaType,limited(entity.attributes,attribute=>node(attribute.name,[attribute.javaType,JSON.stringify(attribute.columns||[])].filter(Boolean).join(' · '),[],'symbol-field')),'symbol-class')),'table'),
          node('Provider functions',`${factory.functions?.length||0} registry entries · signatures alone do not prove types`,limited(factory.functions,fn=>node(fn.name,fn.signature||fn.state||'observed registration')),'symbol-method')
        ],'server-process')),
        node('Observed query events',`${providerRuntime.events?.length||0} bounded events · bound values omitted`,limited(providerRuntime.events,event=>node([event.origin||'origin unreported',event.kind||event.state||'query event'].join(' · '),event.query||event.reason||'query text capture disabled')),'history')
      ],'pulse'),
      node('Entities', `${model.entities?.length || 0} source entities`, entityNodes, 'symbol-class'),
      node('Embeddables', `${model.embeddables?.length || 0} source types`, limited(model.embeddables, item => node(item.name || item.className, 'source mapping', [], 'symbol-struct', item)), 'symbol-struct'),
      node('Queries', `${model.queries?.length || 0} query declarations`, limited(model.queries, query => {
        const types=query.typeAnalysis,details=[];
        if(types){details.push(...limited(types.selectionTypes,(type,index)=>node('Result '+(index+1),type.javaType||type.kind||'unknown',[],'symbol-variable')));details.push(...limited(types.parameters,parameter=>{const symbolic=query.symbolicParameters?.find(item=>item.name===parameter.name);return node(symbolic?'SpEL '+(symbolic.expression||'argument'):'Parameter '+(parameter.name||'?'+parameter.position),[parameter.state,(parameter.expectedTypes||[]).map(t=>typeof t==='string'?t:t.javaType||t.kind||'unknown').join('/')].filter(Boolean).join(' · '),[],'symbol-parameter');}));}
        return node(query.name || query.text || query.query || 'JPQL query', [query.status==='known'?'paths resolved':query.status,types?'types: '+types.state:'type analysis unavailable',query.reason||'Runtime validity unverified'].filter(Boolean).join(' · '), details, 'search', query);
      }), 'search'),
      node('ORM XML mappings', `${model.mappingDocuments?.length||0} documents`,limited(model.mappingDocuments,document=>node(document.uri,`${document.version} · ${document.managedTypes?.length||0} declared types${document.metadataComplete?' · XML metadata complete':''}`,[],'file-code',{uri:document.uri,range:{start:{line:0,character:0},end:{line:0,character:0}}})),'files'),
      node('Catalog comparison', comparison ? `Last read-only comparison · ${comparison.observedAt || 'time unavailable'}` : 'Not run; connect a DB and use Compare JPA with Database', catalogGroups, 'database')
    ];
    return [node('Spring runtime', `${runtime.state || 'disconnected'}${runtime.fetchedAt ? ` · ${runtime.fetchedAt}` : ''}`, runtimeChildren, 'pulse'), node('JPA source model', `${model.entities?.length || 0} entities · static analysis`, jpaChildren, 'database')];
  }
  const provider = {
    onDidChangeTreeData: events.event,
    getTreeItem: item => item,
    async getChildren(item) {
      if (item) return item.children || [];
      try { return await roots(); }
      catch (error) { return [node('Analysis unavailable', error.message, [], 'info')]; }
    }
  };
  const subscriptions = [events, vscode.window.registerTreeDataProvider('rocketbrain.analysis', provider),
    vscode.commands.registerCommand('rocketbrain.analysis.refresh', async () => { await jpa.refresh(); await spring.refresh(); refresh(); }),
    vscode.commands.registerCommand('rocketbrain.analysis.compareCatalog', async () => {
      try { comparison = await jpa.compareCatalog(); refresh(); return comparison; }
      catch (error) { await vscode.window.showErrorMessage(`Rocketbrain JPA: ${error.message}`); }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh), vscode.workspace.onDidSaveTextDocument(refresh)
  ];
  if (spring.runtime?.onDidChange) subscriptions.push(spring.runtime.onDidChange(refresh));
  if (spring.runtime?.health?.onDidChange) subscriptions.push(spring.runtime.health.onDidChange(refresh));
  if (jpa.onDidChange) subscriptions.push(jpa.onDidChange(refresh));
  return {
    refresh,
    clearCatalog() { comparison = undefined; refresh(); },
    async snapshot() { const runtime = spring.runtime?.snapshot?.() || { state: 'disconnected' }; const model = await jpa.snapshot(); return { runtimeState: runtime.state, observedBeans: runtime.counts?.beans || 0, entities: model.entities?.length || 0,mappingDocuments:model.mappingDocuments?.length||0,physicalMappings:(model.entities||[]).reduce((n,entity)=>n+(entity.columnMappings?.length||0),0), catalogCompared: Boolean(jpa.catalogComparison?.() || comparison) }; },
    dispose() { disposed = true; for (const item of subscriptions) item.dispose(); }
  };
}

module.exports = { registerAnalysisTree };
