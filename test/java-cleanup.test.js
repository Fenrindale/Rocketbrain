'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {test}=require('node:test');
const {analyzeJavaSources}=require('../src/java/signature-compiler');
const {cleanupDraft,verifyCleanup}=require('../src/java/java-cleanup');
const {cleanupFixture,counts}=require('./helpers/java-cleanup-fixture');

const run=promisify(execFile),configured=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const springCache=process.env.ROCKETBRAIN_CLEANUP_SPRING_CACHE;

test('cleanup draft accepts only exact, bounded, nonoverlapping recipe edits',()=>{
  const source='return(value);\r\n',fingerprint='a'.repeat(64);
  const edit=(start,end,newText='')=>({start,end,newText});
  const recipe=(kind,...edits)=>({kind,edits});
  const report=(...findings)=>({lexical:true,fingerprint,findings});
  const parentheses=recipe('redundant-parentheses',edit(6,7,' '),edit(12,13));
  const draft=cleanupDraft(source,report(parentheses));
  assert.equal(draft.text,'return value;\r\n');
  assert.deepEqual(draft.counts,{'redundant-parentheses':1});
  assert.throws(()=>cleanupDraft(source,report(parentheses,parentheses)),/overlapping/);
  assert.throws(()=>cleanupDraft(source,report(recipe('unused-type-import',edit(0,13)))),/invalid cleanup recipe/);
  assert.throws(()=>cleanupDraft(source,report(recipe('empty-block-statement',edit(13,99)))),/outside the reviewed/);
  assert.throws(()=>cleanupDraft(source,{lexical:false}),/Unicode escapes/);
  assert.throws(()=>verifyCleanup(report(),{lexical:true,fingerprint:'b'.repeat(64)}),/change attributed syntax or bindings/);
});

async function withJava(t) {
  const {javaHome}=JSON.parse(await fs.readFile(configured,'utf8'));
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-java-cleanup-'));
  t.after(async()=>{
    const actual=await fs.realpath(root);
    assert.equal(path.dirname(actual),parent);assert.match(path.basename(actual),/^rb-java-cleanup-/);
    await fs.rm(actual,{recursive:true,maxRetries:8,retryDelay:200});
  });
  const file=path.join(root,'CleanupChoice.java'),uri=pathToFileURL(file).href;
  const tool=name=>path.join(javaHome,'bin',name+(process.platform==='win32'?'.exe':''));
  const inspect=async(text,stage,classpath=[])=>{
    const result=await analyzeJavaSources({javaHome,storagePath:root,classpath,sources:[{uri,text}],inspection:{kind:'cleanup',uri,stage}});
    assert.deepEqual(result.errors,[]);
    return result;
  };
  return {file,root,tool,inspect};
}

test('Javac verifies one whole-file cleanup and refuses a compiling precedence change',{
  skip:!configured,timeout:105000
},async t=>{
  const {inspect}=await withJava(t);
  const before=cleanupFixture('fixture','CleanupChoice',{eol:'\r\n'});
  const baseline=await inspect(before,'plan'),draft=cleanupDraft(before,baseline.cleanup);
  assert.deepEqual(draft.counts,counts);
  assert.equal(draft.edits.length,12);
  assert.ok(!draft.text.replace(/\r\n/g,'').includes('\n'));
  assert.match(draft.text,/^    if \(value == 0\);\r?$/mu);
  assert.match(draft.text,/^    for \(; value < 0; value\+\+\);\r?$/mu);
  assert.match(draft.text,/return score\(values\.getFirst\(\)\) \+ ":" \+ score\(0\.5d\) \+ ":" \+ \(2 \+ 3\) \* 4;/u);
  const after=await inspect(draft.text,'plan');
  verifyCleanup(baseline.cleanup,after.cleanup);
  assert.equal(after.classpathFingerprint,baseline.classpathFingerprint);
  assert.deepEqual(after.cleanup.findings,[]);
  const stale=await inspect(draft.text.replace('(2 + 3) * 4','2 + 3 * 4'),'verify');
  assert.throws(()=>verifyCleanup(baseline.cleanup,stale.cleanup),/change attributed syntax or bindings/);
});

async function pinnedJar(group,name,version) {
  const dir=path.join(springCache,group,name,version),hits=[];
  for(const entry of await fs.readdir(dir,{withFileTypes:true})) {
    if(!entry.isDirectory()||!/^\p{ASCII_Hex_Digit}{1,40}$/u.test(entry.name))continue;
    const candidate=path.join(dir,entry.name,name+'-'+version+'.jar');
    if(await fs.stat(candidate).then(info=>info.isFile(),()=>false))hits.push(candidate);
  }
  assert.equal(hits.length,1,name);
  return hits[0];
}

test('the original and the reviewed Java cleanup return identical Spring bean values in the owned JDK',{
  skip:!configured||!springCache,timeout:115000
},async t=>{
  const {file,root,tool,inspect}=await withJava(t);
  const classpath=await Promise.all([
    ...['spring-aop','spring-beans','spring-context','spring-core','spring-expression'].map(name=>pinnedJar('org.springframework',name,'7.0.10')),
    pinnedJar('commons-logging','commons-logging','1.3.6')
  ]);
  const source=cleanupFixture('fixture','CleanupChoice',{spring:true});
  const baseline=await inspect(source,'plan',classpath),draft=cleanupDraft(source,baseline.cleanup);
  assert.deepEqual(draft.counts,counts);
  const prospective=await inspect(draft.text,'verify',classpath);
  verifyCleanup(baseline.cleanup,prospective.cleanup);
  assert.equal(prospective.classpathFingerprint,baseline.classpathFingerprint);
  const launcher=path.join(root,'RunBeans.java');
  await fs.writeFile(launcher,[
    'package fixture;',
    'import java.sql.DriverManager;',
    'import java.util.StringJoiner;',
    'import org.springframework.context.annotation.AnnotationConfigApplicationContext;',
    'class RunBeans { public static void main(String[] args) throws Exception {',
    '  try (var context = new AnnotationConfigApplicationContext(CleanupChoice.class)) {',
    '    var bean = context.getBean(CleanupChoice.class);',
    '    if (args.length == 0) {',
    '      System.out.print(bean.evaluate(-3) + "/" + bean.evaluate(0) + "/" + bean.evaluate(4));',
    '      return;',
    '    }',
    '    try (var connection = DriverManager.getConnection(System.getenv("RB_CLEANUP_JDBC_URL"),',
    '        System.getenv("RB_CLEANUP_JDBC_USER"), System.getenv("RB_CLEANUP_JDBC_PASSWORD"));',
    '        var query = connection.prepareStatement("SELECT -3 AS probe UNION ALL SELECT 0 UNION ALL SELECT 4 ORDER BY probe");',
    '        var rows = query.executeQuery()) {',
    '      var output = new StringJoiner("/");',
    '      while (rows.next()) output.add(bean.evaluate(rows.getInt(1)));',
    '      System.out.print(connection.getMetaData().getDatabaseProductVersion() + "\\n" + output);',
    '    }',
    '  }',
    '} }',''
  ].join('\n'),{flag:'wx'});
  const observed=[],compiled=[];
  const expected='2:2.0:20/2:2.0:20/5:2.0:20';
  for(const [label,text] of [['original',source],['cleanup',draft.text]]) {
    const out=path.join(root,label);
    await fs.mkdir(out);
    await fs.writeFile(file,text);
    await run(tool('javac'),['-proc:none','-classpath',classpath.join(path.delimiter),'-d',out,file,launcher],{timeout:15000,windowsHide:true});
    const entries=[out,...classpath];
    compiled.push(entries);
    const result=await run(tool('java'),['-classpath',entries.join(path.delimiter),'fixture.RunBeans'],{timeout:15000,windowsHide:true});
    observed.push(result.stdout);
  }
  assert.deepEqual(observed,[expected,expected]);
  const databases=[];
  for(const [engine,group,artifact,version] of [
    ['mysql','com.mysql','mysql-connector-j','9.7.0'],['mariadb','org.mariadb.jdbc','mariadb-java-client','3.5.10']
  ]) {
    const setting=process.env['ROCKETBRAIN_CLEANUP_'+engine.toUpperCase()+'_CONFIG'];
    if(!setting)continue;
    const config=JSON.parse(await fs.readFile(setting,'utf8'));
    assert.equal(config.host,'127.0.0.1');
    assert.ok(Number.isInteger(config.port)&&config.port>0&&config.port<65536);
    assert.match(config.database,/^[a-z_]+$/u);
    const driver=await pinnedJar(group,artifact,version),results=[];
    const env={...process.env,RB_CLEANUP_JDBC_URL:'jdbc:'+engine+'://127.0.0.1:'+config.port+'/'+config.database+
      (engine==='mysql'?'?sslMode=DISABLED&allowPublicKeyRetrieval=true':''),
    RB_CLEANUP_JDBC_USER:config.user,RB_CLEANUP_JDBC_PASSWORD:config.password};
    for(const entries of compiled) {
      const result=await run(tool('java'),['-classpath',[...entries,driver].join(path.delimiter),'fixture.RunBeans','jdbc'],
        {env,timeout:15000,windowsHide:true});
      const [server,output]=result.stdout.split('\n');
      assert.match(server,engine==='mysql'?/^8\.4\./u:/^11\.4\..*MariaDB/u);
      assert.equal(output,expected);
      results.push({server,output});
    }
    assert.deepEqual(results[0],results[1]);
    databases.push({engine,driver:version,...results[0]});
  }
  if(process.env.ROCKETBRAIN_CLEANUP_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_CLEANUP_RECEIPT,JSON.stringify({
    springFramework:'7.0.10',jdk:'Temurin 25.0.5+8',counts,edits:draft.edits.length,bindingsPreserved:true,observed,databases,processorsEnabled:false
  })+'\n');
});
