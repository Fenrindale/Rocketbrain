'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createRequire}=require('node:module');
const {inspectReactProps}=require('../src/web/react-tools');
const {jdbcReadback}=require('./java-source-analysis-host');

const component=`export interface InventoryProps {
  name: string;
  count: number;
  active?: boolean;
}
export function InventoryCard({name,count,active}: InventoryProps) {
  return <output data-active={String(active)}>{name}:{count}</output>;
}
`;
const application=`import { InventoryCard } from './InventoryCard';
export const card = <InventoryCard name="Fixture" count={3} />;
`;

async function withReactFixture(directory,work) {
  const parent=await fs.realpath(directory);
  const root=await fs.mkdtemp(path.join(parent,'rb-react-props-'));
  try {
    const seed=await fs.realpath(process.env.ROCKETBRAIN_REACT_TEST_DEPENDENCIES);
    const fixtureRequire=createRequire(path.join(seed,'package.json'));
    const packages=['typescript','react','react-dom','@types/react','@types/react-dom']
      .map(name=>[name,fixtureRequire.resolve(name+'/package.json')]);
    const manifests=new Map(packages);
    packages.push(['csstype',createRequire(manifests.get('@types/react')).resolve('csstype/package.json')]);
    packages.push(['scheduler',createRequire(manifests.get('react-dom')).resolve('scheduler/package.json')]);
    await fs.copyFile(path.join(seed,'package.json'),path.join(root,'package.json'));
    for (const [name,manifest] of packages) {
      const destination=path.join(root,'node_modules',name);
      await fs.mkdir(path.dirname(destination),{recursive:true});
      await fs.cp(path.dirname(manifest),destination,{recursive:true,dereference:true});
    }
    const config=path.join(root,'tsconfig.json');
    await fs.writeFile(config,JSON.stringify({
      compilerOptions:{strict:true,jsx:'react-jsx',target:'ES2022',module:'CommonJS',skipLibCheck:false,outDir:'output'},
      files:['InventoryCard.tsx','App.tsx']
    }),{flag:'wx'});
    const source=path.join(root,'InventoryCard.tsx'), file=path.join(root,'App.tsx');
    await fs.writeFile(source,component,{flag:'wx'});
    await fs.writeFile(file,application,{flag:'wx'});
    return await work(root,file,source,config);
  } finally {
    const real=await fs.realpath(root);
    assert.equal(path.relative(path.dirname(real),parent),'');
    assert.match(path.basename(real),/^rb-react-props-[a-z0-9]{6}$/iu);
    await fs.rm(real,{recursive:true,maxRetries:10,retryDelay:250});
  }
}

function offset(text,fragment) {
  const point=text.indexOf(fragment);
  assert.ok(point>=0);
  return point;
}

async function renderActualReact(root,config) {
  const local=createRequire(path.join(root,'package.json'));
  const ts=local('typescript');
  const inputs=ts.readConfigFile(config,ts.sys.readFile);
  assert.equal(inputs.error,undefined);
  const project=ts.parseJsonConfigFileContent(inputs.config,ts.sys,root);
  const program=ts.createProgram(project.fileNames,project.options);
  assert.deepEqual(ts.getPreEmitDiagnostics(program),[]);
  assert.equal(program.emit().emitSkipped,false);
  const {card}=local('./output/App.js');
  const html=local('react-dom/server').renderToStaticMarkup(card);
  assert.equal(html,'<output data-active="undefined">Fixture:3</output>');
  return html;
}

async function verifyCompiler(root,file,source,config) {
  const run=(action,text,point)=>inspectReactProps({workspace:root,file,source:text,offset:point,action,nodePath:process.execPath});
  const empty=application.replace('name="Fixture" count={3}','');
  const completion=await run('complete',empty,offset(empty,'/>'));
  assert.equal(completion.component,'InventoryCard');
  assert.deepEqual(completion.props.filter(prop=>['name','count','active'].includes(prop.name)),[
    {name:'name',type:'string',optional:false},{name:'count',type:'number',optional:false},
    {name:'active',type:'boolean | undefined',optional:true}
  ]);
  const point=offset(application,'count={3}')+1;
  const def=await run('definition',application,point);
  assert.equal(def.prop,'count');
  assert.equal(def.locations.length,1);
  assert.equal(path.relative(def.locations[0].file,source),'');
  assert.equal(component.slice(def.locations[0].start,def.locations[0].end),'count');
  const refs=await run('references',application,point);
  assert.ok(refs.locations.some(item=>!path.relative(item.file,source)));
  assert.ok(refs.locations.some(item=>!path.relative(item.file,file)));
  assert.ok(refs.locations.some(item=>item.definition && item.sha256===def.locations[0].sha256));
  assert.ok(refs.locations.every(item=>/^[0-9a-f]{64}$/u.test(item.sha256)));
  assert.equal((await run('check',application,0)).diagnostics.length,0);
  const bad=application.replace('count={3}','count="wrong"');
  const checked=await run('check',bad,0);
  assert.equal(checked.diagnostics.length,1);
  assert.equal(checked.diagnostics[0].code,2322);
  assert.match(checked.diagnostics[0].message,/string.*number/u);
  assert.equal((await fs.readFile(file,'utf8')),application);
  return {types:completion.types,props:completion.props.length,references:refs.locations.length,
    exactCrossFileDeclaration:true,snapshotLocations:true,unsavedTypeDiagnostic:true,reactRendered:await renderActualReact(root,config),
    jdbc:await jdbcReadback()};
}

async function runReactPropsChecks(api,vscode,checks) {
  const parent=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const config=vscode.workspace.getConfiguration('rocketbrain.react');
  const scope=vscode.ConfigurationTarget.Global;
  const keys=[['enableProps',true],['nodePath',process.env.ROCKETBRAIN_REACT_TEST_NODE]];
  const previous=keys.map(([key])=>[key,config.inspect(key)?.globalValue]);
  try {
    for (const [key,value] of keys) await config.update(key,value,scope);
    return await withReactFixture(parent,async(root,file,source,descriptor)=>{
      const document=await vscode.workspace.openTextDocument(file);
      try {
        const editor=await vscode.window.showTextDocument(document);
        const count=offset(application,'count={3}');
        const propPosition=document.positionAt(count+1);
        const completion=await vscode.commands.executeCommand('vscode.executeCompletionItemProvider',document.uri,propPosition);
        assert.ok(completion.items.some(item=>(item.label.label||item.label)==='count'&&item.detail==='InventoryCard · number'));
        const result=await api.react.inspect({document,position:propPosition,action:'definition'});
        assert.equal(path.relative(result.locations[0].file,source),'');
        const definition=await vscode.commands.executeCommand('vscode.executeDefinitionProvider',document.uri,propPosition);
        assert.ok(definition.some(item=>{
          const uri=item.uri??item.targetUri;
          return uri?.scheme==='file'&&!path.relative(uri.fsPath,source);
        }));
        const diagnostics=await vscode.commands.executeCommand('rocketbrain.react.checkProps');
        assert.equal(diagnostics.diagnostics.length,0);
        const valueAt=count+'count='.length;
        const range=length=>new vscode.Range(document.positionAt(valueAt),document.positionAt(valueAt+length));
        assert.equal(await editor.edit(edit=>edit.replace(range(3),'"wrong"')),true);
        try {
          const invalid=await vscode.commands.executeCommand('rocketbrain.react.checkProps');
          assert.equal(invalid.diagnostics[0]?.code,2322);
          assert.equal((await fs.readFile(file,'utf8')),application);
        } finally { assert.equal(await editor.edit(edit=>edit.replace(range(7),'{3}')),true); }
        checks.push('The installed React provider showed the exact number prop and directed the JSX call to its compiled TypeScript prop declaration.');
        return {types:result.types,typedCompletion:true,exactCrossFileDeclaration:true,unsavedTypeDiagnostic:true,
          realReactRender:await renderActualReact(root,descriptor),jdbc:await jdbcReadback()};
      } finally {
        const tabs=vscode.window.tabGroups.all.flatMap(group=>group.tabs).filter(tab=>
          tab.input?.uri?.scheme==='file'&&!path.relative(tab.input.uri.fsPath,file));
        if (tabs.length) await vscode.window.tabGroups.close(tabs);
      }
    });
  } finally {
    for (const [key,value] of previous) await config.update(key,value,scope);
  }
}

module.exports={runReactPropsChecks};
if (require.main===module) withReactFixture(path.resolve(__dirname,'../test-output'),verifyCompiler).then(result=>console.log(JSON.stringify(result)))
  .catch(error=>{console.error(error.stack);process.exitCode=1;});
