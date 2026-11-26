'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {test}=require('node:test');
const {captureFxmlPreview}=require('../src/java/javafx-preview-fxml');
const {renderFxmlPreview}=require('../src/java/javafx-preview-runtime');
const {springJdbcClasspath,runJavaFixture}=require('./helpers/instance-inline-fixture');
const fixture=require('./helpers/javafx-preview');

const javaConfig=process.env.ROCKETBRAIN_JAVA_TEST_CONFIG;
const classpathFile=process.env.ROCKETBRAIN_JAVAFX_SPRING_CLASSPATH;
const dbs=['mysql','mariadb'].map(engine=>[engine,process.env['ROCKETBRAIN_JAVAFX_'+engine.toUpperCase()+'_CONFIG']]);

async function temporary(t,run) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'rb-fxml-preview-test-'));
  t.after(async()=>{
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),parent);
    await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:250});
  });
  return run(root);
}

test('FXML preview stages saved built-in resources without controllers, preserving original wiring',t=>temporary(t,async root=>{
  await fs.cp(fixture.fixture,root,{recursive:true});
  const file=path.join(root,fixture.source),original=await fs.readFile(file,'utf8');
  const result=captureFxmlPreview(file,root);
  const staged=result.files.get(file).staged;
  assert.deepEqual(result.summary,{resourceCount:3,controllersOmitted:1,handlersOmitted:1});
  assert.match(staged,/fx:id="indicator"/u);
  assert.match(staged,/source="\.\.\/shared\/inset\.fxml"/u);
  assert.doesNotMatch(staged,/controller|recordClick/u);
  assert.equal(await fs.readFile(file,'utf8'),original);
  assert.throws(()=>captureFxmlPreview(file,root,{dirty:item=>item.endsWith('theme.css')}),/Save the selected FXML/u);
  for (const [change,error] of [
    [original.replace('fill="#cc3344"','fill="${controller.fill}"'),/static built-in properties/u],
    [original.replace('@theme.css','@https://example.invalid/theme.css'),/local .css/u],
    [original.replace('source="../shared/inset.fxml"','source="../../../../outside.fxml"'),/escapes its physical/u],
    [original.replace('<children>','<children><fx:script>controller.update()</fx:script>'),/Unsupported FXML preview element/u],
    [original.replace('<?import javafx.scene.layout.Pane?>','<?import dev.rocketbrain.CustomClass?>'),/built-in imports/u],
    [original.replace('<children>','<children><Rectangle fx:factory="choose"/>'),/Unsupported FXML preview attribute/u],
    [original.replace('source="../shared/inset.fxml"','source="inventory.fxml"'),/cyclic include/u]
  ]) {
    await fs.writeFile(file,change);
    assert.throws(()=>captureFxmlPreview(file,root),error);
  }
  await fs.writeFile(file,original);
  const stylesheet=path.join(root,fixture.stylesheet);
  for (const value of ['@import "https://example.invalid/styles.css";','Label { -fx-background-image: url/**/("remote"); }',
    'Label { -fx-skin: "dev.rocketbrain.CustomSkin"; }']) {
    await fs.writeFile(stylesheet,value);
    assert.throws(()=>captureFxmlPreview(file,root),/static CSS/u);
  }
  await assert.rejects(renderFxmlPreview({workspaceTrusted:true}),/trusted workspace/u);
}));

test('official OpenJFX headless loads the approved FXML and refreshes real PNG pixels after a saved CSS change',{
  skip:process.platform!=='win32'||process.arch!=='x64'||!javaConfig||!classpathFile||dbs.some(([,file])=>!file),timeout:160000
},t=>temporary(t,async owned=>{
  const workspace=path.join(owned,'scene'),file=path.join(workspace,fixture.source);
  await fs.cp(fixture.fixture,workspace,{recursive:true});
  const {javaHome}=JSON.parse(await fs.readFile(javaConfig,'utf8'));
  const storage=process.env.ROCKETBRAIN_JAVAFX_PREVIEW_STORAGE||path.join(owned,'runtime');
  const input={file,workspace,javaHome,storage,width:96,height:72,workspaceTrusted:true,allowPreview:true};
  const original=await fs.readFile(file,'utf8'),stylesheet=path.join(workspace,fixture.stylesheet);
  const initial=await renderFxmlPreview(input);
  const first=fixture.imageProof(initial.png,initial.report);
  assert.equal(initial.report.runtime,'26.0.2+3');
  assert.deepEqual([initial.report.controllersOmitted,initial.report.handlersOmitted,initial.report.resourceCount],[1,1,3]);
  await fs.writeFile(stylesheet,fixture.changed(await fs.readFile(stylesheet,'utf8')));
  const refreshed=await renderFxmlPreview(input);
  const second=fixture.imageProof(refreshed.png,refreshed.report,true);
  assert.notEqual(refreshed.report.resourcesSha256,initial.report.resourcesSha256);
  assert.notEqual(refreshed.report.imageSha256,initial.report.imageSha256);
  assert.equal(await fs.readFile(file,'utf8'),original);

  const include=path.join(workspace,'src/main/resources/shared/inset.fxml');
  await fs.writeFile(include,(await fs.readFile(include,'utf8')).replace('layoutX="48"','layoutX="60"'));
  const moved=await renderFxmlPreview(input);
  const layout=fixture.imageProof(moved.png,moved.report,true,true);
  assert.notEqual(moved.report.resourcesSha256,refreshed.report.resourcesSha256);
  assert.notEqual(moved.report.imageSha256,refreshed.report.imageSha256);
  assert.equal(await fs.readFile(file,'utf8'),original);

  const javaFile=path.join(owned,'SpringPreviewJdbc.java'),classes=path.join(owned,'classes');
  await fs.mkdir(classes);
  await fs.writeFile(javaFile,`import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
class SpringPreviewJdbc {
  public static void main(String[] args) {
    var jdbc = new JdbcTemplate(new DriverManagerDataSource(System.getenv("RB_INLINE_JDBC_URL"),
      System.getenv("RB_INLINE_JDBC_USER"), System.getenv("RB_INLINE_JDBC_PASSWORD")));
    System.out.print(jdbc.queryForObject("SELECT VERSION()", String.class) + "|" + jdbc.queryForObject("SELECT 42", Integer.class));
  }
}
`);
  const jdbc=[];
  for (const [engine,configFile] of dbs) {
    const config=JSON.parse(await fs.readFile(configFile,'utf8'));
    const classpath=await springJdbcClasspath(classpathFile,engine);
    const result=await runJavaFixture({javaHome,file:javaFile,binaryDirectory:classes,className:'SpringPreviewJdbc',classpath,config,engine});
    assert.equal(result.output,'42');
    jdbc.push(result);
  }
  const receipt=process.env.ROCKETBRAIN_JAVAFX_PREVIEW_RECEIPT;
  if (receipt) await fs.writeFile(receipt,JSON.stringify({runtime:initial.report.runtime,width:96,height:72,first,second,layout,jdbc,
    resourceCount:3,controllerAndHandlerOmitted:true,originalBindingsPreserved:true,headless:true},null,2)+'\n');
}));
