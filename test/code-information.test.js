'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {resolveLaunch,serverSettings}=require('../src/java/runtime');
const {kotlinEditorLaunch,kotlinProtocolUri}=require('../src/java/kotlin-editor-runtime');
const {positionAt}=require('../src/spring/java');
const {normalizeHover,normalizeSignatures,informationHtml}=require('../src/java/code-information');
const {javaInformationFixture,kotlinInformationFixture,binaryInformationFixture}=require('./helpers/code-information-fixture');
const {StdioLsp,until}=require('./helpers/stdio-lsp');
const run=promisify(execFile);

test('code information validates Ranged hover and highlights exact active parameters without rendering markup',()=>{
  const text='render(left, right)',label='String render(String left, String right)',start=label.indexOf('String right');
  const hit=normalizeSignatures({activeSignature:1,activeParameter:1,signatures:[
    {label:'String render(String left)',parameters:[{label:'String left'}]},
    {label,parameters:[{label:'String left'},{label:[start,start+'String right'.length],documentation:{kind:'markdown',value:'<script>disabled</script>'}}]}
  ]});
  assert.deepEqual(hit.signatures.map(item=>item.active),[false,true]);
  assert.equal(hit.signatures[1].parameters[hit.signatures[1].activeParameter].name,'String right');
  const html=informationHtml(hit);
  assert.match(html,/<mark>String right<\/mark>/);
  assert.match(html,/&lt;script&gt;disabled&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script|javascript:|<img/);
  const rejected=normalizeHover({range:{start:{line:0,character:0},end:{line:0,character:6}},contents:'valid'},text,9);
  assert.equal(rejected,null);
  const hover=normalizeHover({contents:[{language:'java',value:'String value'},'[documentation](https://example.invalid/)']},text,2);
  assert.match(informationHtml(hover),/<code>String value<\/code>/);
  assert.doesNotMatch(informationHtml(hover),/example.invalid/);
});

const config=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG,kotlinHome=process.env.ROCKETBRAIN_KOTLIN_EDITOR_HOME;
for(const language of ['java','kotlin'])test('actual '+language+' provider supplies overload and documentation information',{
  skip:!config||language==='kotlin'&&!kotlinHome,timeout:175000
},async t=>{
  const {javaHome,serverPath,gradleHome}=JSON.parse(await fs.readFile(config,'utf8'));
  const kotlin=language==='kotlin',parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-code-info-'));
  t.after(async()=>{
    const verified=await fs.realpath(root);
    assert.equal(path.dirname(verified),parent);assert.match(path.basename(verified),/^rb-code-info-/);
    await fs.rm(verified,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const project=path.join(root,'project'),dir=path.join(project,kotlin?'src/main/kotlin/editor/fixture':'src/main/java/editor/fixture');
  if(kotlin)await fs.cp(path.join(__dirname,'fixtures/java/kotlin-editor'),project,{recursive:true});
  await fs.mkdir(dir,{recursive:true});
  if(!kotlin) {
    const external=path.join(root,'BinaryOnly.java'),classes=path.join(root,'classes'),jar=path.join(project,'binary-only.jar');
    await fs.writeFile(external,binaryInformationFixture,{flag:'wx'});
    const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
    await run(tool('javac'),['-parameters','-g:none','-d',classes,external],{timeout:22000,windowsHide:true});
    await run(tool('jar'),['--create','--file',jar,'-C',classes,'.'],{timeout:22000,windowsHide:true});
    const members=(await run(tool('jar'),['--list','--file',jar],{timeout:22000,windowsHide:true})).stdout;
    assert.match(members,/library\/BinaryOnly\.class/);assert.doesNotMatch(members,/\.java\b/);
    await fs.unlink(external);
    await fs.writeFile(path.join(project,'pom.xml'),[
      '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion>',
      '<groupId>fixture</groupId><artifactId>info-fixture</artifactId><version>1</version>',
      '<properties><maven.compiler.release>25</maven.compiler.release></properties>',
      '<dependencies><dependency><groupId>fixture</groupId><artifactId>binary-only</artifactId><version>1</version>',
      '<scope>system</scope><systemPath>'+jar.replaceAll('\\','/')+'</systemPath></dependency></dependencies></project>'
    ].join('\n'),{flag:'wx'});
  }
  const file=path.join(dir,kotlin?'KotlinInformation.kt':'JavaInformation.java');
  const text=kotlin?kotlinInformationFixture:javaInformationFixture('editor.fixture','JavaInformation');
  await fs.writeFile(file,text,{flag:'wx'});
  const uriFor=kotlin?kotlinProtocolUri:file=>pathToFileURL(file).href,uri=uriFor(file),rootUri=uriFor(project);
  const settings=serverSettings([{name:'JavaSE-25',path:javaHome,default:true}]);
  const launch=kotlin?await kotlinEditorLaunch({serverHome:kotlinHome,javaHome,gradleHome,root:project,
    gradleUserHome:process.env.ROCKETBRAIN_KOTLIN_EDITOR_GRADLE_HOME||path.join(root,'gradle'),storageRoot:path.join(root,'storage')}):
    resolveLaunch({javaHome,serverPath,storagePath:path.join(root,'storage')});
  const lsp=new StdioLsp(launch);
  try {
    const initialized=await lsp.request('initialize',{processId:process.pid,rootUri,rootPath:project,
      workspaceFolders:[{uri:rootUri,name:'Code Information Fixture'}],capabilities:{workspace:{configuration:true,workspaceFolders:true},
        textDocument:{hover:{contentFormat:['markdown','plaintext']},signatureHelp:{signatureInformation:{documentationFormat:['markdown','plaintext'],
          parameterInformation:{labelOffsetSupport:true},activeParameterSupport:true}}}},
      initializationOptions:{workspaceFolders:[rootUri],settings}},75000);
    assert.ok(initialized.capabilities.hoverProvider);
    lsp.notify('initialized',{});
    if(!kotlin)lsp.notify('workspace/didChangeConfiguration',{settings});
    lsp.notify('textDocument/didOpen',{textDocument:{uri,languageId:language,version:1,text}});
    const sourceMarker=kotlin?'report("seed", 2)':'render("seed", 2)',methodAt=text.indexOf(sourceMarker)+2;
    const helpAt=text.indexOf(', 2);')>=0?text.indexOf(', 2);')+2:text.indexOf(', 2)')+2;
    const wait=async (method,point,normalize)=>until(async()=>{
      const raw=await lsp.request('textDocument/'+method,{textDocument:{uri},position:positionAt(text,point)},32000);
      return normalize(raw)||undefined;
    },55000);
    const hover=await wait('hover',methodAt,raw=>normalizeHover(raw,text,methodAt));
    assert.match(hover.parts.map(part=>part.text).join('\n'),kotlin?/distinct Kotlin KDoc test result/:/Repeats the exact Java label/);
    let signatures,binary;
    if(initialized.capabilities.signatureHelpProvider) {
      signatures=await wait('signatureHelp',helpAt,normalizeSignatures);
      assert.ok(signatures.signatures.length>=2,JSON.stringify(signatures));
      const current=signatures.signatures.find(item=>item.active);
      assert.ok(current);
      assert.equal(current.activeParameter,1,JSON.stringify(signatures));
      assert.match(current.parameters[1].name,/count/);
      if(!kotlin) {
        const argument=text.indexOf(', 3);')+2;
        binary=await wait('signatureHelp',argument,normalizeSignatures);
        assert.ok(binary.signatures.length>=2,JSON.stringify(binary));
        assert.ok(binary.signatures.some(item=>item.label.includes('int')&&item.activeParameter===1),JSON.stringify(binary));
        assert.ok(binary.signatures.every(item=>!item.documentation));
      }
    } else assert.equal(kotlin,true);
    const destination=process.env.ROCKETBRAIN_CODE_INFORMATION_RECEIPTS;
    if(destination)await fs.writeFile(path.join(destination,'v75-'+language+'-code-information.json'),JSON.stringify({
      language,hover:hover.parts,signatures:signatures?.signatures??[],binary:binary?.signatures??[],
      providerSupportsSignatures:Boolean(initialized.capabilities.signatureHelpProvider)
    },null,2)+'\n');
  }finally{try{await lsp.close();}finally{await launch.dispose?.();}}
});
