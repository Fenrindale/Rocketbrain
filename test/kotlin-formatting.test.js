'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {kotlinFormatSpans}=require('../src/java/kotlin-format-lexical');
const {buildKotlinFormatEdits,kotlinFormatterOptions}=require('../src/java/kotlin-format-edits');
const {lineEnding}=require('../src/java/format-edits');
const {rangeAt}=require('../src/spring/java');
const {editedText}=require('../src/java/refactoring');
const {editorConfig,styleOptions}=require('../src/java/editorconfig');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {buildSpec}=require('../src/java/workbench-tasks');
const {execute}=require('../src/java/testing/provision');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const {kotlinFormatSource,assertKotlinFormat}=require('./helpers/kotlin-format-fixture');

const tabStyle={insertSpaces:false,indentSize:2,tabWidth:4};

test('Kotlin hard tabs change code leading whitespace and preserve nested template/comment/literal bytes',()=>{
  const scannerCases=['val raw = """start','        preserve   ','    end"""','val nested = "'+ '${if (ok) "inside" else "outside"}'+'"',
    'val dollars = $$"""', '        '+ '$${"inside"}', '        literal $digit', '"""', 'val quote = \'"\'', 'val `"safe"` = 1'];
  const from='class Value {\n'+scannerCases.map(line=>'    '+line).join('\n')+'\n    /* outer\n        /* nested */\n          keep block indent\n    */\n    fun value() = 7\n}\n';
  const before=kotlinFormatSpans(from);
  assert.equal(before.literalTokens.length,5);
  const output=editedText(from,buildKotlinFormatEdits(from,undefined,[],tabStyle,'\n'));
  assert.match(output,/\n\tfun value/);
  assert.match(output,/\n {10}keep block indent\n {4}\*\//);
  assert.deepEqual(kotlinFormatSpans(output).literalTokens,before.literalTokens);
  const changed=from.replace('preserve','altered ');
  assert.throws(()=>buildKotlinFormatEdits(from,undefined,[{range:rangeAt(from,0,from.length),newText:changed}],tabStyle,'\n'),/changed a string/);
  const partial=rangeAt(from,from.indexOf('    end'),from.indexOf('\n    val nested'));
  assert.throws(()=>buildKotlinFormatEdits(from,partial,[],tabStyle,'\n'),/Keep strings and block comments whole/);
  assert.throws(()=>kotlinFormatSpans('val raw = """incomplete'),/complete, unambiguous/);
});

test('Kotlin range formatting restores its enclosing indentation without extending the selection',()=>{
  const text='class Value {\nval untouched=7\n  fun value(){\nprintln("hello")\n}\nval trailing=5\n}\n';
  const from=text.indexOf('  fun'),to=text.indexOf('\nval trailing');
  const range=rangeAt(text,from,to);
  const raw=[{range,newText:'fun value() {\n  println("hello")\n}\n'}];
  const after=editedText(text,buildKotlinFormatEdits(text,range,raw,tabStyle,'\n'));
  assert.equal(after,'class Value {\nval untouched=7\n  fun value() {\n\tprintln("hello")\n  }\nval trailing=5\n}\n');
  assert.throws(()=>buildKotlinFormatEdits(text,range,[{range:rangeAt(text,0,text.length),newText:text}],tabStyle,'\n'),/outside the selected Kotlin range/);
});

const configFile=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,serverHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;

test('pinned Kotlin formatter uses nested widths and the resulting raw and inline literals compile and run unchanged',{
  skip:!configFile||!serverHome,timeout:260000
},async t=>{
  const {javaHome,gradleHome}=JSON.parse(await fs.readFile(configFile,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),owned=await fs.mkdtemp(path.join(parent,'rb-kt-fmt-'));
  t.after(async()=>{
    const real=await fs.realpath(owned);
    assert.equal(real,owned);
    assert.equal(path.dirname(real),parent);
    assert.match(path.basename(real),/^rb-kt-fmt-/);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const project=path.join(owned,'project'),rootUri=kotlinProtocolUri(project);
  await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  const directory=path.join(project,'src/main/kotlin/editor/fixture'), nested=path.join(directory,'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(project,'.editorconfig'),'root=true\n[*.{kt,java}]\nindent_style=space\nindent_size=2\nend_of_line=lf\n',{flag:'wx'});
  await fs.writeFile(path.join(nested,'.editorconfig'),'[*.kt]\nindent_style=tab\ntab_width=4\nend_of_line=crlf\n',{flag:'wx'});
  const variants=[['Soft','editor.fixture',directory],['Hard','editor.fixture.nested',nested]].map(([name,namespace,folder])=>({
    file:path.join(folder,name+'.kt'),fqcn:namespace+'.'+name+'Kt',name,...kotlinFormatSource(namespace,name)
  }));
  for (const input of variants) await fs.writeFile(input.file,input.source,{flag:'wx'});
  const gradleUserHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(owned,'gradle');
  const spec=buildSpec({root:project,tool:'gradle',uri:pathToFileURL(project).href,name:'Kotlin format'},{javaHome,gradleHome},['compileKotlin']);
  const compile=async()=>{
    const result=await execute(spec.command,spec.args,{cwd:spec.cwd,env:{...spec.env,GRADLE_USER_HOME:gradleUserHome},timeoutMs:110000});
    assert.equal(result.code,0,result.output);
    assert.match(result.output,/BUILD SUCCESSFUL/);
  };
  const java=path.join(javaHome,'bin',process.platform==='win32'?'java.exe':'java');
  async function run(input) {
    const classpath=[path.join(project,'build/classes/kotlin/main'),path.join(serverHome,'lib','*')].join(path.delimiter);
    const result=await execute(java,['-cp',classpath,input.fqcn]);
    assert.equal(result.code,0,result.output);
    assert.match(result.output,/^115,116,97,114,116,10,32,32,32,32,32,32,32,/);
    return result.output;
  }
  await compile();
  const before=await Promise.all(variants.map(run));
  const launch=await kotlinEditorLaunch({serverHome,javaHome,gradleHome,gradleUserHome,storageRoot:path.join(owned,'storage'),root:project});
  const lsp=new StdioLsp(launch),proof=[];
  try {
    const capabilities=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,workspaceFolders:[{uri:rootUri,name:'Kotlin formatting'}],
      capabilities:{workspace:{configuration:true,workspaceFolders:true}}},90000);
    assert.ok(capabilities.capabilities.documentFormattingProvider && capabilities.capabilities.documentRangeFormattingProvider);
    lsp.notify('initialized',{});
    for (const input of variants) {
      const {file,source,rangeStart,rangeEnd}=input,uri=kotlinProtocolUri(file),textDocument={uri};
      const style=styleOptions(editorConfig(file,project).settings,{tabSize:6,insertSpaces:true}),options=kotlinFormatterOptions(style);
      lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:'kotlin',version:1,text:source}});
      const full=await until(async()=>{
        const changes=await lsp.request('textDocument/formatting',{textDocument,options},45000);
        return changes?.length?changes:null;
      },65000);
      const formatted=editedText(source,buildKotlinFormatEdits(source,undefined,full,style,'\n'));
      assertKotlinFormat(formatted,input,style);
      const range=rangeAt(source,rangeStart,rangeEnd);
      const replacement=await lsp.request('textDocument/rangeFormatting',{textDocument,range,options},45000);
      const selected=editedText(source,buildKotlinFormatEdits(source,range,replacement,style,'\n'));
      assertKotlinFormat(selected,input,style);
      assert.ok(selected.startsWith(source.slice(0,rangeStart)) && selected.endsWith(source.slice(rangeEnd)));
      input.formatted=lineEnding(formatted,style.endOfLine==='crlf'?'\r\n':'\n');
      input.selected=selected;
      proof.push({file:path.basename(file),indentSize:style.indentSize,tabWidth:style.tabWidth,mode:style.insertSpaces?'space':'tab',
        endOfLine:style.endOfLine,exactRange:true,protectedLiteralBytes:true});
    }
  } finally {try {await lsp.close();} finally {await launch.dispose();}}
  await Promise.all(variants.map(input=>fs.writeFile(input.file,input.formatted)));
  await compile();
  assert.deepEqual(await Promise.all(variants.map(run)),before);
  await Promise.all(variants.map(input=>fs.writeFile(input.file,input.selected)));
  await compile();
  assert.deepEqual(await Promise.all(variants.map(run)),before);
  if (process.env.ROCKETBRAIN_KOTLIN_FORMAT_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_KOTLIN_FORMAT_RECEIPT,
    JSON.stringify({server:launch.serverVersion,compiler:launch.compilerVersion,actualGradleCompiles:3,executedVariants:6,formats:proof,literalRuntimeBytesUnchanged:true},null,2)+'\n');
});
