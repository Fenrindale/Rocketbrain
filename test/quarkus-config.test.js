'use strict';

const assert=require('node:assert/strict');
const test=require('node:test');
const {modelQuarkus}=require('../src/java/quarkus-model');
const {parseJavaFile}=require('../src/spring/java');
const {profileFile}=require('../src/java/quarkus-config-mapping');
const {normalizeQuarkusConfigOrigins}=require('../src/java/quarkus-config-origin');
const {renderQuarkusConfigOrigins}=require('../src/java/quarkus-config-origin-vscode');

test('Quarkus typed mapping resolves declared nested and imported groups and keeps exact source ranges',()=>{
  const root={uri:'file:///Project/Settings.java',text:[
    'package own;',
    'import io.smallrye.config.ConfigMapping;',
    'import io.smallrye.config.WithName;',
    'import io.smallrye.config.WithParentName;',
    'import io.smallrye.config.WithDefault;',
    'import java.time.Duration;',
    'import java.util.Optional;',
    'import external.Foreign;',
    '@ConfigMapping(prefix = "service", namingStrategy = ConfigMapping.NamingStrategy.SNAKE_CASE)',
    'interface Settings {',
    '  @WithName("network") Transport listener();',
    '  @WithParentName Foreign local();',
    '  Missing dynamic();',
    '  Cyclic cycle();',
    '  interface Transport {',
    '    @WithName("max-q") int capacity();',
    '    @WithDefault("private-source-value") String rawLabel();',
    '    Optional<Duration> maxWait();',
    '    default String handwritten() { return "not-a-property"; }',
    '  }',
    '  interface Cyclic { Cyclic another(); }',
    '}'
  ].join('\n')};
  const foreign={uri:'file:///Project/Foreign.java',text:'package external;\npublic interface Foreign {\n  long maxRetries();\n}\n'};
  const files=[{uri:'file:///Project/application.properties',text:'%review.service.network.max-q=private-inline-value\n'},
    {uri:'file:///Project/application-review.properties',profile:'review',text:'service.network.max-q=private-profile-value\n'}];
  const report=modelQuarkus([root,foreign],files);
  assert.deepEqual(report.configuration.map(item=>[item.key,item.type,item.groups]),
    [['service.max_retries','long',['local']],['service.network.max_wait','Optional<Duration>',['listener']],
      ['service.network.max-q','int',['listener']],['service.network.raw_label','String',['listener']]].sort((a,b)=>a[0].localeCompare(b[0])));
  const declarations=report.configuration.map(item=>{
    const file=item.source.uri===root.uri?root:foreign;
    const {start,end}=item.source.range;
    assert.equal(start.line,end.line);
    return file.text.split('\n')[start.line].slice(start.character,end.character);
  });
  assert.ok(declarations.includes('capacity')&&declarations.includes('maxRetries'));
  assert.equal(report.configuration.find(item=>item.key==='service.network.raw_label').hasDefault,true);
  assert.deepEqual(report.configured.map(item=>[item.key,item.profile,item.uri]),[
    ['service.network.max-q','review',files[0].uri],['service.network.max-q','review',files[1].uri]
  ]);
  assert.ok(report.issues.some(item=>item.message.includes('cyclic')));
  assert.ok(report.issues.some(item=>item.message.includes('uniquely resolved')));
  assert.doesNotMatch(JSON.stringify(report),/private-inline-value|private-profile-value|private-source-value|handwritten/u);
  assert.equal(profileFile('application-review.properties'),'review');
  assert.equal(profileFile('application-review.yml'),null);
  assert.equal(profileFile('application-../review.properties'),null);
  assert.equal(parseJavaFile(root).types[0].nested,undefined);
  assert.ok(parseJavaFile(root).issues.includes('Nested types are excluded from the Spring model'));
});

test('Quarkus never navigates a guessed external or ambiguous group and preserves competing leaf evidence',()=>{
  const root={uri:'file:///Root.java',text:[
    'package p;',
    'import io.smallrye.config.ConfigMapping;',
    'import io.smallrye.config.WithParentName;',
    '@ConfigMapping(prefix="example") interface Root {',
    '  @WithParentName One first();',
    '  @WithParentName Two second();',
    '  Ambiguous unsupported();',
    '  interface One { String name(); }',
    '  interface Two { String name(); }',
    '}'
  ].join('\n')};
  const one={uri:'file:///A.java',text:'package p; interface Ambiguous { String one(); }'};
  const two={uri:'file:///B.java',text:'package p; interface Ambiguous { String two(); }'};
  const result=modelQuarkus([root,one,two]);
  assert.deepEqual(result.configuration.map(item=>[item.key,item.declaringType]),[
    ['example.name','p.Root.One'],['example.name','p.Root.Two']
  ]);
  assert.ok(result.issues.some(item=>item.message.includes('uniquely resolved')));
});

test('Quarkus runtime origin projection omits all values and bounds contexts, approved keys and source labels',()=>{
  const data={state:'ready',processId:42,keys:['sample.listener.port','sample.password'],
    contexts:[{id:'config-1',activeProfiles:['review'],classLoader:'/private-path',origins:[
      {key:'sample.listener.port',kind:'classpath-properties',file:'application-review.properties',ordinal:250,line:2,
        selectedProfile:'review',value:'private-port',sourceName:'jar:file:/private/source'},
      {key:'sample.password',kind:'environment',file:null,ordinal:300,line:null,selectedProfile:null,rawValue:'private-password'}
    ]}]};
  const clean=normalizeQuarkusConfigOrigins(data);
  assert.deepEqual(clean.contexts[0].origins[0],{key:'sample.listener.port',kind:'classpath-properties',
    file:'application-review.properties',ordinal:250,line:2,selectedProfile:'review'});
  assert.doesNotMatch(JSON.stringify(clean),/private/u);
  const page=renderQuarkusConfigOrigins(clean);
  assert.match(page,/application-review\.properties · line 2/u);
  assert.match(page,/Active profiles review/u);
  assert.match(page,/Environment/u);
  assert.doesNotMatch(page,/private|<script/u);
  for(const change of [
    value=>value.contexts[0].origins[0].file='../application-review.properties',
    value=>value.contexts[0].origins[0].key='unapproved',
    value=>value.contexts[0].origins[1].line=2,
    value=>value.contexts[0].activeProfiles=['<script>'],
    value=>value.contexts[0].origins.push(value.contexts[0].origins[0]),
    value=>value.contexts.push(value.contexts[0]),
    value=>value.state='disabled',
    value=>value.keys=Array.from({length:25},(_item,index)=>'sample.'+index)
  ]){
    const invalid=structuredClone(data);
    change(invalid);
    assert.throws(()=>normalizeQuarkusConfigOrigins(invalid),/Unsupported/);
  }
});
