'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {test} = require('node:test');
const {editorConfig,styleOptions} = require('../src/java/editorconfig');
const {buildFormatEdits,formatterOptions} = require('../src/java/format-edits');
const {registerJavaFormatting} = require('../src/java/format-vscode');
const {editedText} = require('../src/java/refactoring');
const {rangeAt} = require('../src/spring/java');
const {resolveLaunch,serverSettings} = require('../src/java/runtime');
const {StdioLsp,until} = require('./helpers/stdio-lsp');
const {formatSource,assertFormat} = require('./helpers/java-format-fixture');

async function ownedDirectory(t) {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent,'rb-format-'));
  t.after(async () => {
    const real = await fs.realpath(root);
    assert.equal(real,root);
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-format-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  return root;
}

test('nested EditorConfig matches Java globs, honors root and unset, and records newly added files',async t => {
  const root=await ownedDirectory(t), project=path.join(root,'workspace'), module=path.join(project,'module'), deep=path.join(module,'java');
  await fs.mkdir(deep,{recursive:true});
  await fs.writeFile(path.join(root,'.editorconfig'),'[*.java]\nindent_size=9\n');
  await fs.writeFile(path.join(project,'.editorconfig'),'root=true\n[*.{java,kt}]\nindent_style = space\nindent_size=2\nend_of_line=lf\n[/*.java]\nindent_size=3\n');
  await fs.writeFile(path.join(module,'.editorconfig'),'[java/**/*[0-9].java]\nindent_style=tab\nindent_size=tab\ntab_width=8\n[*.java]\nend_of_line=UNSET\n');
  const file=path.join(deep,'Value2.java'), unrelated=path.join(deep,'Value.scala');
  const first=editorConfig(file,project);
  assert.deepEqual(first.settings,{indent_style:'tab',indent_size:'tab',tab_width:'8'});
  assert.deepEqual(styleOptions(first.settings,{tabSize:3,insertSpaces:true}),{insertSpaces:false,indentSize:8,tabWidth:8,endOfLine:undefined});
  assert.deepEqual(editorConfig(unrelated,project).settings,{});
  assert.equal(editorConfig(path.join(project,'Top.java'),project).settings.indent_size,'3');
  await fs.writeFile(path.join(deep,'.editorconfig'),'ROOT = TRUE\n[*.java]\nindent_size=4\nend_of_line=crlf\n');
  const override=editorConfig(file,project);
  assert.deepEqual(override.settings,{indent_size:'4',end_of_line:'crlf'});
  assert.notEqual(override.fingerprint,first.fingerprint);
  assert.equal(override.sources.length,1);
});

test('mixed tab stops preserve text blocks and selected boundaries and reject out-of-range edits',() => {
  const before='class Value {\n    String value() {\n        return """\n            data\n            """;\n    }\n}\n';
  const style={insertSpaces:false,indentSize:2,tabWidth:4};
  assert.deepEqual(formatterOptions(style),{insertSpaces:true,tabSize:2});
  const tabs=editedText(before,buildFormatEdits(before,undefined,[],style,'\n'));
  assert.match(tabs,/\n\tString value/);
  assert.match(tabs,/\n {12}data\n {12}""";/);
  const range={start:{line:1,character:0},end:{line:1,character:20}};
  assert.throws(()=>buildFormatEdits(before,range,[{range:{start:{line:0,character:0},end:{line:0,character:1}},newText:'x'}],style,'\n'),/outside the selected Java range/);
  const selected=editedText(before,buildFormatEdits(before,range,[],style,'\n'));
  assert.equal(selected.split('\n')[2],before.split('\n')[2]);
});

test('the native provider delegates the original request when EditorConfig sets no Java formatting keys',async t => {
  const root=await ownedDirectory(t);
  await fs.writeFile(path.join(root,'.editorconfig'),'root=true\n[*.kt]\nindent_size=6\n[*.java]\ncharset=utf-8\n');
  const vscode={workspace:{isTrusted:true,getWorkspaceFolder:()=>({uri:{fsPath:root}})},commands:{registerCommand:()=>({dispose(){}})}};
  const service=registerJavaFormatting(vscode,{request:()=>assert.fail('native fallback must own the request'),output:{appendLine:assert.fail}});
  t.after(()=>service.dispose());
  const document={uri:{scheme:'file',fsPath:path.join(root,'Example.java')},languageId:'java'};
  const stock=[{newText:'original provider'}];
  assert.equal(await service.native(document,undefined,{tabSize:5,insertSpaces:true},undefined,()=>stock),stock);
});

const configFile=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('actual pinned JDT formats full Java documents and exact selections with inherited formatting widths',{
  skip:!configFile,timeout:145000
},async t => {
  const config=JSON.parse(await fs.readFile(configFile,'utf8')), settings=config.settings||config;
  const javaHome=config.javaHome||settings['rocketbrain.java.javaHome'];
  const serverPath=config.serverPath||settings['rocketbrain.java.serverPath'];
  const root=await ownedDirectory(t), project=path.join(root,'project'), dir=path.join(project,'src/main/java/fmtcase');
  await fs.mkdir(dir,{recursive:true});
  await fs.copyFile(path.join(__dirname,'fixtures/java/debugger/pom.xml'),path.join(project,'pom.xml'));
  await fs.writeFile(path.join(project,'.editorconfig'),'root=true\n[*.java]\nindent_style=space\nindent_size=2\nend_of_line=lf\n');
  await fs.writeFile(path.join(dir,'.editorconfig'),'[Mixed.java]\nindent_style=tab\ntab_width=4\nend_of_line=crlf\n[Tabs.java]\nindent_style=tab\nindent_size=tab\ntab_width=8\n');
  const fixtures=['Spaces','Mixed','Tabs'].map(name=>({name,file:path.join(dir,name+'.java'),...formatSource('fmtcase',name)}));
  for (const {file,source} of fixtures) await fs.writeFile(file,source,{flag:'wx'});
  const launch=resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'jdt')});
  const server=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]), rootUri=pathToFileURL(project).href;
  const lsp=new StdioLsp(launch), proof=[];
  try {
    const ready=await lsp.request('initialize',{processId:process.pid,rootUri,workspaceFolders:[{uri:rootUri,name:'Formatting fixture'}],
      capabilities:{workspace:{configuration:true}},initializationOptions:{workspaceFolders:[rootUri],settings:server}},75000);
    assert.ok(ready.capabilities.documentFormattingProvider && ready.capabilities.documentRangeFormattingProvider);
    lsp.notify('initialized',{});
    lsp.notify('workspace/didChangeConfiguration',{settings:server});
    for (const {name,file,source,from,until:to} of fixtures) {
      const uri=pathToFileURL(file).href, textDocument={uri};
      lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'java',version:1,text:source}});
      await until(async()=>(await lsp.request('textDocument/documentSymbol',{textDocument}))?.length,60000);
      const style=styleOptions(editorConfig(file,project).settings,{tabSize:6,insertSpaces:true}), options=formatterOptions(style);
      const full=await lsp.request('textDocument/formatting',{textDocument,options});
      const formatted=editedText(source,buildFormatEdits(source,undefined,full,style,'\n'));
      assertFormat(formatted,style);
      const range=rangeAt(source,from,to);
      const raw=await lsp.request('textDocument/rangeFormatting',{textDocument,range,options});
      const selected=editedText(source,buildFormatEdits(source,range,raw,style,'\n'));
      assertFormat(selected,style,{range:true});
      assert.ok(selected.startsWith(source.slice(0,from)));
      assert.ok(selected.endsWith(source.slice(to)));
      proof.push({name,indentSize:style.indentSize,tabWidth:style.tabWidth,endOfLine:style.endOfLine,exactRange:true});
    }
  } finally { await lsp.close(); }
  if (process.env.ROCKETBRAIN_JAVA_FORMAT_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_JAVA_FORMAT_RECEIPT,
    JSON.stringify({jdt:'1.63.0',formats:proof},null,2)+'\n');
});
