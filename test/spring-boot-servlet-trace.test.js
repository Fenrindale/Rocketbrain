'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {test}=require('node:test');
const {parseRegistrationTrace}=require('../src/spring/registration-trace');
const {exercise}=require('./helpers/spring-boot-servlet-trace-fixture');
const {registerSpringRegistrationTrace}=require('../src/spring/registration-trace-vscode');

const input=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile=process.env.ROCKETBRAIN_REGISTRY_CLASSPATH;
const databases=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_REGISTRY_'+engine.toUpperCase()+'_CONFIG']]);
const helpers=['RegistrationTrace.java','BootServletRegistrationTrace.java'].map(name=>
  path.resolve(__dirname,'../runtime/spring-registration/src/rocketbrain/spring',name));

test('factory traces preserve an actual callback identity and reject malformed mode or stack fields',()=>{
  const header={kind:'spring-registration',version:2,mode:'bean-factory'};
  const begin={kind:'begin',id:1,label:'boot'};
  const origin={type:'fixture.Callback',method:'initialize',file:'Callback.java',line:18};
  const event={kind:'mutation',id:1,operation:'register',name:'sample',origin,provider:origin};
  const late={...event,operation:'remove',provider:null};
  const finish={kind:'end',id:1,outcome:'returned'};
  const rows=(...values)=>values.map(value=>JSON.stringify(value)).join('\n')+'\n';
  const result=parseRegistrationTrace(rows(header,begin,event,late,finish));
  assert.equal(result.mode,'bean-factory');
  assert.deepEqual(result.mutations.map(item=>item.provider),[origin,null]);
  assert.throws(()=>parseRegistrationTrace(rows({...header,mode:'unknown'},begin,event,finish)),/invalid record/);
  assert.throws(()=>parseRegistrationTrace(rows(header,begin,{...event,provider:undefined},finish)),/invalid record/);
});

test('owned Spring Boot servlet factory captures unwrapped registrations and preserves actual lifecycle on both engines',{
  skip:!input || !classpathFile || !databases.every(([,file])=>file),timeout:180000
},async t=>{
  const {javaHome}=JSON.parse(await fs.readFile(input,'utf8'));
  const parent=await fs.realpath(os.tmpdir()), owned=await fs.mkdtemp(path.join(parent,'rb-boot-registry-'));
  const identity=await fs.lstat(owned,{bigint:true});
  t.after(async()=>{
    const real=await fs.realpath(owned), stat=await fs.lstat(real,{bigint:true});
    assert.equal(path.dirname(real),parent);
    assert.deepEqual([stat.dev,stat.ino],[identity.dev,identity.ino]);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  const results=await Promise.all(databases.map(async([engine,configFile])=>{
    const work=await fs.mkdtemp(path.join(owned,engine+'-'));
    return exercise({javaHome,classpathFile,helperFiles:helpers,work,engine,configFile});
  }));
  if(process.env.ROCKETBRAIN_BOOT_REGISTRY_RECEIPT)await fs.writeFile(process.env.ROCKETBRAIN_BOOT_REGISTRY_RECEIPT,
    JSON.stringify({results},null,2)+'\n',{flag:'wx'});
});

test('owned Boot helper copy leaves differing sources in place and serializes competing installations',async t=>{
  const parent=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(parent,'rb-boot-helper-copy-'));
  const target=path.join(root,'src'), legacy=path.join(root,'legacy');
  const uri=fsPath=>({scheme:'file',fsPath,toString:()=>pathToFileURL(fsPath).href});
  const context={subscriptions:[],asAbsolutePath:name=>helpers.find(file=>path.basename(file)===path.basename(name))};
  const vscode={Uri:{file:uri},workspace:{isTrusted:true,workspaceFolders:[{uri:uri(root)}]},
    commands:{registerCommand(){return {dispose(){}};}}};
  const service=registerSpringRegistrationTrace(context,vscode);
  t.after(async()=>{
    service.dispose();
    const real=await fs.realpath(root);
    assert.equal(path.dirname(real),parent);
    await fs.rm(real,{recursive:true,force:true,maxRetries:8,retryDelay:200});
  });
  await fs.mkdir(target);
  await fs.mkdir(path.join(legacy,'rocketbrain','spring'),{recursive:true});
  const earlier=path.join(legacy,'rocketbrain','spring','RegistrationTrace.java');
  await fs.writeFile(earlier,'existing workspace helper',{flag:'wx'});
  await assert.rejects(service.copyBootHelpers(uri(legacy)),/existing Spring trace helper/);
  assert.deepEqual(await fs.readdir(path.dirname(earlier)),['RegistrationTrace.java']);
  assert.equal(await fs.readFile(earlier,'utf8'),'existing workspace helper');
  const attempts=await Promise.allSettled([service.copyBootHelpers(uri(target)),service.copyBootHelpers(uri(target))]);
  const accepted=attempts.filter(item=>item.status==='fulfilled');
  assert.equal(accepted.length,1);
  assert.equal(attempts.filter(item=>item.status==='rejected').length,1);
  for(const [index,file] of accepted[0].value.entries()) {
    assert.deepEqual(await fs.readFile(file.fsPath),await fs.readFile(helpers[index]));
  }
});
