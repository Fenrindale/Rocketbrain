'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {configuration,parseYaml,parseProperties,resolveTemplate}=require('../src/spring/configuration');
const {yamlCompletionContext}=require('../src/spring/configuration-yaml');
const {metadataProperties,metadataModule,workspaceMetadata,selectMetadata,declarationAt,metadataJavaSource}=require('../src/spring/configuration-metadata');

const file=(text,name='application.yml')=>({uri:'file:///workspace/example/src/main/resources/'+name,text});

test('Spring YAML follows explicit profiles and file precedence while retaining precise declarations',()=>{
  const yaml=file('spring.profiles.group.local: [common, data]\nfixture:\n  labels: &names {team: source, tier: base}\n  copy: {<<: *names, tier: kept}\n  rows: [4, 8]\n---\nspring.config.activate.on-profile: "data & !offline"\nfixture:\n  message: >-\n    active\n    document\n  rows: [5]\n---\nspring.config.activate.on-profile: offline\nfixture.message: inactive\n');
  const props=file('fixture.retries=2\r\n#---\r\nspring.config.activate.on-profile=data\r\nfixture.retries=5\r\n','application-local.properties');
  const data=configuration([yaml,props],{activeProfiles:['local']});
  assert.deepEqual(data.issues,[]);
  assert.deepEqual(data.profiles,['local','common','data']);
  const item=key=>data.entries.get('fixture.'+key);
  assert.deepEqual([item('copy.team').value,item('copy.tier').value],['source','kept']);
  assert.equal(item('message').value,'active document');
  assert.deepEqual(item('message').range.start,{line:8,character:2});
  assert.equal(item('rows[0]').value,'5');
  assert.equal(item('rows[1]').value,'8');
  assert.equal(item('retries').value,'5');
  assert.deepEqual(item('retries').range.start,{line:3,character:0});
});

test('YAML walks exact spans and bounds syntax, invalid aliases, recursive merges and document count',()=>{
  const yaml=file('group: { "branch-key": [false, 22], "quoted.key": >-\n    value}\n');
  assert.ok(parseYaml(yaml).issues.length);
  const simple=file('group: { "branch-key": [false, 22], "quoted.key": value }\n');
  const data=parseYaml(simple);
  assert.deepEqual(data.entries.map(entry=>entry.key),['group.branch-key[0]','group.branch-key[1]','group.quoted.key']);
  const literal=declarationAt(simple,{line:0,character:simple.text.indexOf('quoted.key')+2});
  assert.equal(literal.key,'group.quoted.key');
  assert.equal(simple.text.slice(literal.range.start.character,literal.range.end.character),'"quoted.key"');
  for(const input of ['group: [*missing]\n','group: &cycle [*cycle]\n','group: { name: x, name: y }\n',
    'group: !custom value\n',Array.from({length:33},()=> '---\nkey: true\n').join('')]){
    const result=parseYaml(file(input));
    assert.ok(result.issues.length);
    assert.deepEqual(result.entries,[]);
  }
  const incomplete='base:\n  value: 1\n---\nfixture:\n  catalog:\n    query-li\n';
  assert.deepEqual(yamlCompletionContext(incomplete,5),{prefix:'fixture.catalog',keyStart:4,keyEnd:12});
  assert.deepEqual(yamlCompletionContext('top:\n  - name\n',1),{prefix:'top[0]',keyStart:4,keyEnd:8});
});

test('source precedence distinguishes runtime-only conditions and preserves a definite higher document',()=>{
  const unknown=configuration([file('fixture.flag: base\n---\nspring.config.activate.on-cloud-platform: kubernetes\nfixture.flag: cloud\nfixture.value: from-cloud\n')]);
  assert.equal(resolveTemplate('${fixture.flag}',unknown.entries).state,'unknown');
  assert.equal(resolveTemplate('${fixture.value}',unknown.entries).state,'unknown');
  const known=configuration([file('fixture.flag: base\n---\nspring.config.activate.on-cloud-platform: kubernetes\nfixture.flag: cloud\n---\nfixture.flag: certain\n')]);
  assert.equal(resolveTemplate('${fixture.flag}',known.entries).value,'certain');
  const imports=configuration([file('spring.config.import: optional:file:outside.yml\nfixture.flag: base\n')]);
  assert.equal(imports.profileState,'unknown');
  assert.equal(resolveTemplate('${fixture.flag}',imports.entries).state,'unknown');
  assert.match(imports.issues.map(item=>item.message).join('\n'),/runtime for its effective origin/);
  const scoped=configuration([file('fixture.flag: yaml\n'),file('fixture.flag=properties\n','application.properties')],{activeProfiles:['local']});
  assert.equal(scoped.entries.get('fixture.flag').value,'properties');
  assert.equal(parseProperties(file('fixture.key=split\\\r\n next\r\n','application.properties')).entries[0].value,'splitnext');
});

test('compiled metadata stays in the owning module and maps exact Java declarations',()=>{
  const compiled='/workspace/a/build/classes/java/main/META-INF/spring-configuration-metadata.json';
  const records=[{moduleRoot:metadataModule(compiled),origin:compiled},{moduleRoot:'/workspace/b',origin:'different'}];
  assert.deepEqual(workspaceMetadata(records,'/workspace/a/src/main/resources/application.yml'),[records[0]]);
  assert.deepEqual(workspaceMetadata(records,'/workspace/a/config/application.yml'),[records[0]]);
  assert.deepEqual(workspaceMetadata(records,'/workspace/c/src/main/resources/application.yml'),[]);
  const [entry]=metadataProperties({properties:[{name:'fixture.catalog.query-limit',type:'java.lang.Integer',
    description:'Maximum test rows.',sourceType:'fixture.config.CatalogSettings',defaultValue:0}]},compiled);
  assert.equal(entry.defaultValue,0);
  const source={uri:'file:///workspace/a/CatalogSettings.java',text:'package fixture.config;\nclass CatalogSettings { private int queryLimit; }\n'};
  const definition=metadataJavaSource(source,entry);
  assert.equal(definition.range.start.line,1);
  assert.equal(source.text.split('\n')[1].slice(definition.range.start.character,definition.range.end.character),'queryLimit');
  assert.equal(metadataJavaSource({...source,text:source.text.replace('fixture.config','other.config')},entry),null);
  const [duplicate]=selectMetadata([entry,{...entry,sourceType:'other.config.CatalogSettings'}]);
  assert.equal(duplicate.ambiguous,true);
  assert.equal(duplicate.sourceType,null);
});
