'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL,fileURLToPath} = require('node:url');
const {test} = require('node:test');
const {createUsageSearch} = require('../src/java/usage-vscode');
const {xmlAnchors,configurationAnchors} = require('../src/java/usage-spring');
const {analyzeSpring} = require('../src/spring/model');
const {rangeAt} = require('../src/spring/java');
const {usageSources} = require('./helpers/java-symbol-navigation-fixture');
const {execute} = require('../src/java/testing/provision');

const fixture = usageSources('com.example','Proof');
const classFile = fixture.type+'.java';
const xmlFile = 'spring-usage-Proof.xml';
const configFile = 'application-usage-Proof.properties';
const occurrence = (text,marker,shift=0,length=marker.length) => {
  const start = text.indexOf(marker)+shift;
  return rangeAt(text,start,start+length);
};

test('Spring resource anchors report exact XML namespace attributes and configuration keys',() => {
  const text = fixture.files[xmlFile].replaceAll('\n','\r\n');
  const xml = xmlAnchors({uri:'file:///spring/src/main/resources/beans.xml',text});
  assert.equal(xml.unsupported,false);
  assert.deepEqual(xml.anchors.map(({key,provider,range})=>({key,provider,range})),[
    {key:fixture.fqn,provider:'spring-class',range:occurrence(text,fixture.fqn)},
    {key:fixture.property,provider:'spring-property',range:occurrence(text,fixture.property)},
    {key:'java.lang.String',provider:'spring-class',range:occurrence(text,'java.lang.String')}
  ]);
  assert.deepEqual(xmlAnchors({uri:'file:///ordinary.xml',text:text.replaceAll('http://www.springframework.org/schema/beans','https://example.invalid/ns')}).anchors,[]);
  assert.deepEqual(xmlAnchors({uri:'file:///unsafe.xml',text:'<!DOCTYPE beans SYSTEM "file:///hidden">'+text}),{anchors:[],unsupported:true});
  assert.deepEqual(xmlAnchors({uri:'file:///incomplete.xml',text:text.replace('</beans>','')}),{anchors:[],unsupported:true});
  const yaml = 'rocketbrain:\r\n  usage-proof:\n    label: example\r\n';
  const config = configurationAnchors({uri:'file:///spring/application-test.yml',text:yaml});
  assert.equal(config.anchors[0].key,fixture.property);
  assert.deepEqual(config.anchors[0].range.start,{line:2,character:4});
});

test('usage search selects scope, deduplicates ranges, reveals exact bound usages and rejects stale reports',async t => {
  const parent = await fs.realpath(os.tmpdir()), owned = await fs.mkdtemp(path.join(parent,'rb-usages-'));
  t.after(async () => {
    const resolved = await fs.realpath(owned);
    assert.equal(resolved,owned);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^rb-usages-/);
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  const parse = value => {
    const url = new URL(value), scheme = url.protocol.slice(0,-1);
    return {scheme,authority:url.host,query:url.search,fragment:url.hash,path:url.pathname,
      fsPath:scheme==='file'?fileURLToPath(value):url.pathname,toString:()=>value};
  };
  const uri = file => parse(pathToFileURL(file).href);
  const folders = ['one','two'].map(name=>({uri:uri(path.join(owned,name)),name}));
  const sources = new Map(), documents = new Map();
  function getWorkspaceFolder(value) {
    return value.scheme==='file' && folders.find(folder=>{
      const relative = path.relative(folder.uri.fsPath,value.fsPath);
      return !relative.startsWith('..')&&!path.isAbsolute(relative);
    });
  }
  async function put(name,text,root=folders[0]) {
    const value = uri(path.join(root.uri.fsPath,name));
    await fs.mkdir(path.dirname(value.fsPath),{recursive:true});
    await fs.writeFile(value.fsPath,text,{flag:'wx'});
    sources.set(value.toString(),value);
    return value;
  }
  const source = await put(classFile,fixture.files[classFile]);
  const originUse = await put(fixture.caller+'.java',fixture.files[fixture.caller+'.java']);
  const external = await put('Another.java','class Another { int use(ServiceProof bean) { return bean.echo(200).length(); } }\n',folders[1]);
  const xml = await put(xmlFile,fixture.files[xmlFile]);
  const config = await put(configFile,fixture.files[configFile]);
  const kotlin = await put('Kotlin.kt','fun first() = 1\nfun second() = first()\n');
  const fileList = [...sources.values()];
  const model = analyzeSpring([{uri:source.toString(),text:fixture.files[classFile]}],[]);
  let shown, pick = 0, action, kotlinAt;
  const vscode = {Uri:{parse},Position:class {constructor(line,character){Object.assign(this,{line,character});}},
    Range:class {constructor(a,b,c,d){this.start={line:a,character:b};this.end={line:c,character:d};}},
    RelativePattern:class {constructor(folder,pattern){Object.assign(this,{folder,pattern});}},
    CancellationTokenSource:class {token={isCancellationRequested:false};cancel(){} dispose(){}},
    workspace:{isTrusted:true,get textDocuments(){return [...documents.values()];},getWorkspaceFolder,
      async findFiles(glob){
        const pattern = glob.pattern || glob;
        const relevant = pattern.includes('resources') ? file => file.path.endsWith('.xml') : pattern.includes('application*') ? file => file.path.endsWith('.properties') : file => file.path.endsWith('/'+classFile);
        return fileList.filter(file => relevant(file) && (!glob.folder || glob.folder===getWorkspaceFolder(file)));
      },async openTextDocument(value){
        if (!documents.has(value.toString())) {
          const text=await fs.readFile(value.fsPath,'utf8');
          documents.set(value.toString(),{uri:value,languageId:value.path.endsWith('.java')?'java':value.path.endsWith('.kt')?'kotlin':'plaintext',
            version:1,getText:()=>text,validatePosition:position=>position});
        }
        return documents.get(value.toString());
      }},
    window:{get activeTextEditor(){return action;},async showQuickPick(options){return pick++===0?options.find(item=>item.scope==='folder'):options.find(item=>item.target.uri===xml.toString());},
      async showTextDocument(document,options){shown={document,options};}}};
  const state = {state:'running',runtimeIdentity:'owned-jdt'};
  const kState = {state:'running',projectUri:folders[0].uri.toString()};
  const classRange = occurrence(fixture.files[classFile],'class '+fixture.type,6,fixture.type.length);
  const useRange = occurrence(fixture.files[fixture.caller+'.java'],'echo(42)',0,4);
  const reference = {uri:originUse.toString(),range:useRange};
  const java = {start:async()=>state,getState:()=>state,spring:{analyze:async()=>model},
    async navigationLocations(kind,params){
      if (kind==='declaration') return [];
      assert.equal(kind,'references');
      assert.equal(params.context.includeDeclaration,false);
      return [reference,reference,{uri:source.toString(),range:classRange},{uri:external.toString(),range:useRange},
        {uri:'https://example.invalid/Target.java',range:useRange}];
    },kotlinEditor:{start:async()=>kState,getState:()=>kState,definition:async()=>[{uri:kotlin.toString(),range:occurrence('fun first() = 1','first')}],
      async references(document,position){kotlinAt={document,position};return [{uri:kotlin.toString(),range:{start:{line:1,character:15},end:{line:1,character:20}}}];}}};
  const service = createUsageSearch(vscode,java,(_title,work)=>work());
  const document = await vscode.workspace.openTextDocument(source);
  action = {document,selection:{active:classRange.start}};
  const report = await service.choose();
  assert.deepEqual(report.providers,['java','spring-class']);
  assert.equal(report.targets.filter(item=>item.uri===originUse.toString()).length,1);
  assert.equal(report.targets.some(item=>item.uri===external.toString()),false);
  assert.equal(shown.document.uri.toString(),xml.toString());
  assert.deepEqual(shown.options.selection.start,occurrence(fixture.files[xmlFile],fixture.fqn).start);
  const xmlTarget = report.targets.find(target=>target.uri===xml.toString());
  await assert.rejects(service.reveal({...report},xmlTarget.id),/current usage search/);
  const usage = options => service.inspect({uri:source,position:classRange.start,...options});
  assert.equal((await usage({scope:'file'})).targets.length,1);
  assert.equal((await usage({scope:'workspace'})).targets.some(item=>item.uri===external.toString()),true);
  const xmlSearch = await service.inspect({uri:xml,position:occurrence(fixture.files[xmlFile],fixture.fqn).start});
  assert.equal(xmlSearch.symbol,fixture.fqn);
  assert.ok(xmlSearch.targets.some(item=>item.uri===originUse.toString()));
  const propSearch = await service.inspect({uri:config,position:occurrence(fixture.files[configFile],fixture.property+'=fixture').start,includeDeclaration:true});
  assert.equal(propSearch.symbol,fixture.property);
  assert.deepEqual(propSearch.targets.map(item=>item.provider).sort(),['spring-config','spring-property','spring-property']);
  const kotlinSearch = await service.inspect({uri:kotlin,position:{line:1,character:17},scope:'file'});
  assert.equal(kotlinAt.position.line,0);
  assert.equal(kotlinAt.position.character,5);
  assert.equal(kotlinSearch.targets[0].range.start.line,1);
  await fs.appendFile(xml.fsPath,'<!-- moved -->');
  await assert.rejects(service.reveal(report,xmlTarget.id),/usage location changed/);
  await assert.rejects(service.inspect({uri:source,position:classRange.start,cancellation:{isCancellationRequested:true}}),/cancelled/);
  vscode.workspace.isTrusted=false;
  await assert.rejects(usage({scope:'workspace'}),/Trust the workspace/);
  service.dispose();
});

const springLibrary = process.env.ROCKETBRAIN_SPRING_XML_RUNTIME_LIB;
const javaRuntime = process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;

test('actual Spring loads the indexed XML bean class and resolves the XML and Java placeholder against its application key',{
  skip:!springLibrary || !javaRuntime,timeout:45000
},async t => {
  const parent = await fs.realpath(os.tmpdir()), root = await fs.mkdtemp(path.join(parent,'rb-spring-usage-'));
  t.after(async () => {
    const resolved = await fs.realpath(root);
    assert.equal(resolved,root);
    assert.equal(path.dirname(resolved),parent);
    assert.match(path.basename(resolved),/^rb-spring-usage-/);
    await fs.rm(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:150});
  });
  const runtime = JSON.parse(await fs.readFile(javaRuntime,'utf8'));
  const home = runtime.javaHome || runtime.settings?.['rocketbrain.java.javaHome'];
  const bin = name => path.join(home,'bin',name+(process.platform==='win32'?'.exe':''));
  const classes = path.join(root,'classes'), runner = path.join(root,'UsageProbe.java');
  await fs.mkdir(classes);
  await Promise.all(Object.entries(fixture.files).map(([filename,source])=>fs.writeFile(path.join(root,filename),source,{flag:'wx'})));
  await fs.writeFile(runner,`import ${fixture.fqn};
import org.springframework.beans.factory.xml.XmlBeanDefinitionReader;
import org.springframework.context.annotation.AnnotationConfigUtils;
import org.springframework.context.support.GenericApplicationContext;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.support.ResourcePropertySource;

public class UsageProbe {
  public static void main(String[] args) throws Exception {
    try (var context = new GenericApplicationContext()) {
      context.getEnvironment().getPropertySources().addFirst(new ResourcePropertySource(new FileSystemResource(args[1])));
      var placeholders = new PropertySourcesPlaceholderConfigurer();
      placeholders.setEnvironment(context.getEnvironment());
      context.addBeanFactoryPostProcessor(placeholders);
      AnnotationConfigUtils.registerAnnotationConfigProcessors(context);
      context.registerBean("annotated", ${fixture.type}.class);
      new XmlBeanDefinitionReader(context).loadBeanDefinitions(new FileSystemResource(args[0]));
      context.refresh();
      var linked = context.getBean("linked", ${fixture.type}.class);
      var annotated = context.getBean("annotated", ${fixture.type}.class);
      System.out.print(linked.getClass().getName()+"|"+linked.echo(42)+"|"+annotated.echo(7));
    }
  }
}
`,{flag:'wx'});
  const libraries = path.join(await fs.realpath(springLibrary),'*');
  const compiled = await execute(bin('javac'),['-encoding','UTF-8','-cp',libraries,'-d',classes,path.join(root,classFile),runner]);
  assert.equal(compiled.code,0,compiled.output);
  const run = await execute(bin('java'),['-cp',classes+path.delimiter+libraries,'UsageProbe',path.join(root,xmlFile),path.join(root,configFile)]);
  assert.equal(run.code,0,run.output);
  assert.match(run.output,new RegExp(fixture.fqn.replaceAll('.','\\.')+'\\|fixture42\\|fixture7$'));
  if (process.env.ROCKETBRAIN_SPRING_XML_RECEIPT) await fs.writeFile(process.env.ROCKETBRAIN_SPRING_XML_RECEIPT,
    JSON.stringify({springContextLoaded:true,beanType:fixture.fqn,xmlPropertyValue:'fixture42',javaValue:'fixture7'},null,2)+'\n');
});
