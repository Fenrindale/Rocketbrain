'use strict';

const {randomUUID}=require('node:crypto');
const {mavenWarProject,listWarArtifacts,resolveWarArtifact,contextPattern}=require('./jakarta-war');
const {hashArchive}=require('./jakarta-tomcat');
const {inspectWildFlyRuntime,createWildFlyDeployment,inspectWar,VERSION}=require('./jakarta-wildfly');
const {fail}=require('./workbench-model');

const COMMANDS={
  deploy:'rocketbrain.jakarta.wildfly.deploy',
  status:'rocketbrain.jakarta.wildfly.status',
  stop:'rocketbrain.jakarta.wildfly.stop'
};

function registerWildFly(vscode,{trusted,withProgress,projectFor,chooseProject,saved,tools,output}) {
  const backend=createWildFlyDeployment({log:chunk=>output.append(chunk)});
  let pending,disposed=false;
  const guard=cancellation=>{
    if (disposed) throw fail('The WildFly workbench has stopped.');
    trusted(cancellation);
  };
  async function review({projectUri,warUri,context,cancellation}={}) {
    guard(cancellation);
    if (backend.status().state!=='stopped') throw fail('Stop the active WildFly deployment before reviewing a new WAR.');
    const project=await projectFor(projectUri,cancellation);
    saved(project);
    const selected=mavenWarProject(project);
    const name=context||selected.context;
    if (typeof name!=='string'||!contextPattern.test(name)) throw fail('Use a lowercase WildFly context name with letters, numbers and hyphens.');
    const artifact=resolveWarArtifact(project,warUri);
    const {wildflyHome,javaHome}=tools(project);
    const runtime=await inspectWildFlyRuntime(wildflyHome,javaHome);
    const sha256=await hashArchive(artifact);
    await inspectWar(artifact.file);
    guard(cancellation);
    if (backend.status().state!=='stopped') throw fail('Stop the active WildFly deployment before reviewing a new WAR.');
    const plan={id:randomUUID(),version:VERSION,artifact:artifact.name,size:artifact.size,
      context:name,sha256,home:runtime.home,java:runtime.java};
    pending={plan,root:project.uri,uri:artifact.uri,build:selected.buildFingerprint,
      runtime:runtime.fingerprint,expires:Date.now()+10*60*1000};
    return {...plan};
  }
  async function deploy({reviewId,allowDeploy,cancellation}={}) {
    guard(cancellation);
    if (allowDeploy!==true) throw fail('Approve the reviewed WildFly WAR deployment first.');
    const review=pending;
    if (!review||review.plan.id!==reviewId||review.expires<Date.now()) throw fail('Review the WildFly deployment again.');
    pending=undefined;
    const project=await projectFor(review.root,cancellation);
    saved(project);
    if (mavenWarProject(project).buildFingerprint!==review.build) throw fail('The Maven module changed. Review the WildFly deployment again.');
    const artifact=resolveWarArtifact(project,review.uri);
    const {wildflyHome,javaHome}=tools(project);
    guard(cancellation);
    const receipt=await backend.deploy({context:review.plan.context,artifact,expectedSha256:review.plan.sha256,
      expectedRuntime:review.runtime,wildflyHome,javaHome,allowDeploy,workspaceTrusted:vscode.workspace.isTrusted,cancellation});
    output.appendLine('WildFly '+receipt.version+' deployed '+receipt.artifact+' to '+receipt.url);
    output.appendLine('WAR SHA-256 '+receipt.sha256);
    return receipt;
  }
  async function deployCommand() {
    const project=await chooseProject();
    if (!project) return;
    const artifacts=listWarArtifacts(project);
    if (!artifacts.length) throw fail('Build a Maven WAR before deploying it to WildFly.');
    const item=await vscode.window.showQuickPick(artifacts.map(artifact=>({label:artifact.name,
      detail:artifact.uri,artifact})),{title:'Select Maven WAR for WildFly'});
    if (!item) return;
    const context=await vscode.window.showInputBox({title:'WildFly Application Context',value:mavenWarProject(project).context,
      validateInput:value=>contextPattern.test(value)?undefined:'Use lowercase letters, numbers and hyphens.'});
    if (!context) return;
    const plan=await withProgress('Review WildFly Deployment',cancellation=>
      review({projectUri:project.uri,warUri:item.artifact.uri,context,cancellation}));
    const approved=await vscode.window.showWarningMessage('Start the reviewed WAR in a local WildFly server?',{modal:true,
      detail:[plan.artifact+' → /'+plan.context,'WAR SHA-256 '+plan.sha256,'WildFly '+plan.version,
        plan.home,plan.java,'The WAR runs with your permissions on a new loopback server.'].join('\n')},'Deploy WAR');
    if (approved!=='Deploy WAR') {
      if (pending?.plan.id===plan.id) pending=undefined;
      return;
    }
    output.show(true);
    const result=await withProgress('Deploy WildFly WAR',cancellation=>
      deploy({reviewId:plan.id,allowDeploy:true,cancellation}));
    void vscode.window.showInformationMessage('WildFly deployment ready at '+result.url);
    return result;
  }
  async function statusCommand() {
    const state=backend.status();
    if (!state.url||state.state!=='running') {
      void vscode.window.showInformationMessage('WildFly deployment: '+state.state);
      return state;
    }
    const action=await vscode.window.showInformationMessage('WildFly '+state.version+' · '+state.artifact+' · '+state.url,
      'Open Application','Show Output');
    if (action==='Open Application'&&backend.status().url===state.url&&backend.status().state==='running') {
      await vscode.env.openExternal(vscode.Uri.parse(state.url));
    }
    if (action==='Show Output') output.show(true);
    return state;
  }
  async function stop() {
    guard();
    pending=undefined;
    return backend.stop();
  }
  return {review,deploy,status:backend.status,stop,
    commands:{[COMMANDS.deploy]:deployCommand,[COMMANDS.status]:statusCommand,[COMMANDS.stop]:stop},
    async dispose(){disposed=true;pending=undefined;return backend.dispose();}};
}

module.exports={registerWildFly,COMMANDS};
