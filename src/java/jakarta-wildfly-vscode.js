'use strict';

const {randomUUID}=require('node:crypto');
const {mavenWarProject,listWarArtifacts,resolveWarArtifact,mavenEarProject,listEarArtifacts,resolveEarArtifact,
  contextPattern}=require('./jakarta-war');
const {hashArchive}=require('./jakarta-tomcat');
const {inspectWildFlyRuntime,createWildFlyDeployment,inspectWar,VERSION}=require('./jakarta-wildfly');
const {inspectEar}=require('./jakarta-ear');
const {fail}=require('./workbench-model');

const COMMANDS={
  deploy:'rocketbrain.jakarta.wildfly.deploy',
  deployEar:'rocketbrain.jakarta.wildfly.deployEar',
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
  async function reviewArchive({projectUri,uri,context,cancellation},enterprise) {
    guard(cancellation);
    const label=enterprise?'EAR':'WAR', model=enterprise?mavenEarProject:mavenWarProject;
    const resolve=enterprise?resolveEarArtifact:resolveWarArtifact;
    const verifyStopped=()=>{
      if (backend.status().state!=='stopped') throw fail('Stop the active WildFly deployment before reviewing a new '+label+'.');
    };
    verifyStopped();
    const project=await projectFor(projectUri,cancellation,model);
    saved(project);
    const selected=model(project);
    let name=context||selected.context, ear;
    if (!enterprise&&(typeof name!=='string'||!contextPattern.test(name))) {
      throw fail('Use a lowercase WildFly context name with letters, numbers and hyphens.');
    }
    const artifact=resolve(project,uri);
    const {wildflyHome,javaHome}=tools(project);
    const runtime=await inspectWildFlyRuntime(wildflyHome,javaHome);
    const sha256=await hashArchive(artifact);
    if (enterprise) {
      ear=await inspectEar(artifact.file);
      name=ear.context;
      if (context!==undefined&&context!==name) throw fail('The EAR uses the context in its packaged application.xml.');
    } else await inspectWar(artifact.file);
    guard(cancellation);
    verifyStopped();
    const plan={id:randomUUID(),version:VERSION,artifact:artifact.name,size:artifact.size,
      context:name,sha256,home:runtime.home,java:runtime.java,...(ear?{kind:'ear',ear}:{})};
    pending={plan,root:project.uri,uri:artifact.uri,build:selected.buildFingerprint,
      runtime:runtime.fingerprint,expires:Date.now()+10*60*1000};
    return structuredClone(plan);
  }
  const review=({warUri,...options}={})=>reviewArchive({...options,uri:warUri},false);
  const reviewEar=({earUri,...options}={})=>reviewArchive({...options,uri:earUri},true);
  async function deploy({reviewId,allowDeploy,cancellation}={}) {
    guard(cancellation);
    if (allowDeploy!==true) throw fail('Approve the reviewed WildFly WAR deployment first.');
    const review=pending;
    if (!review||review.plan.id!==reviewId||review.expires<Date.now()) throw fail('Review the WildFly deployment again.');
    pending=undefined;
    const {ear}=review.plan, model=ear?mavenEarProject:mavenWarProject;
    const project=await projectFor(review.root,cancellation,model);
    saved(project);
    if (model(project).buildFingerprint!==review.build) throw fail('The Maven module changed. Review the WildFly deployment again.');
    const artifact=(ear?resolveEarArtifact:resolveWarArtifact)(project,review.uri);
    const {wildflyHome,javaHome}=tools(project);
    guard(cancellation);
    const receipt=await backend.deploy({context:review.plan.context,artifact,expectedSha256:review.plan.sha256,
      expectedRuntime:review.runtime,wildflyHome,javaHome,allowDeploy,ear,workspaceTrusted:vscode.workspace.isTrusted,cancellation});
    output.appendLine('WildFly '+receipt.version+' deployed '+receipt.artifact+' to '+receipt.url);
    output.appendLine((ear?'EAR':'WAR')+' SHA-256 '+receipt.sha256);
    return receipt;
  }
  async function deployCommand(enterprise=false) {
    const label=enterprise?'EAR':'WAR', model=enterprise?mavenEarProject:mavenWarProject;
    const project=await chooseProject(model);
    if (!project) return;
    const artifacts=(enterprise?listEarArtifacts:listWarArtifacts)(project);
    if (!artifacts.length) throw fail('Build a Maven '+label+' before deploying it to WildFly.');
    const item=await vscode.window.showQuickPick(artifacts.map(artifact=>({label:artifact.name,
      detail:artifact.uri,artifact})),{title:'Select Maven '+label+' for WildFly'});
    if (!item) return;
    let context;
    if (!enterprise) {
      context=await vscode.window.showInputBox({title:'WildFly Application Context',value:model(project).context,
        validateInput:value=>contextPattern.test(value)?undefined:'Use lowercase letters, numbers and hyphens.'});
      if (!context) return;
    }
    const plan=await withProgress('Review WildFly Deployment',cancellation=>
      reviewArchive({projectUri:project.uri,uri:item.artifact.uri,context,cancellation},enterprise));
    const modules=plan.ear?['Web module '+plan.ear.web.name,'EJB module '+plan.ear.ejb.name,
      ...plan.ear.libraries.map(library=>'Library '+library)]:[];
    const approved=await vscode.window.showWarningMessage('Start the reviewed '+label+' in a local WildFly server?',{modal:true,
      detail:[plan.artifact+' → /'+plan.context,label+' SHA-256 '+plan.sha256,'WildFly '+plan.version,...modules,
        plan.home,plan.java,'The '+label+' runs with your permissions on a new loopback server.'].join('\n')},'Deploy '+label);
    if (approved!=='Deploy '+label) {
      if (pending?.plan.id===plan.id) pending=undefined;
      return;
    }
    output.show(true);
    const result=await withProgress('Deploy WildFly '+label,cancellation=>
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
  return {review,reviewEar,deploy,status:backend.status,stop,
    commands:{[COMMANDS.deploy]:()=>deployCommand(),[COMMANDS.deployEar]:()=>deployCommand(true),
      [COMMANDS.status]:statusCommand,[COMMANDS.stop]:stop},
    async dispose(){disposed=true;pending=undefined;return backend.dispose();}};
}

module.exports={registerWildFly,COMMANDS};
