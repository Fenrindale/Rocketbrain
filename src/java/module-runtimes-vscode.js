'use strict';

const { local } = require('./workbench-model');
const { reviewModuleRuntimes } = require('./module-runtimes');

const keys = [
  'org.eclipse.jdt.ls.core.outputPath','org.eclipse.jdt.ls.core.vm.location','org.eclipse.jdt.core.compiler.source',
  'org.eclipse.jdt.core.compiler.compliance','org.eclipse.jdt.core.compiler.codegen.targetPlatform',
  'org.eclipse.jdt.core.compiler.problem.enablePreviewFeatures'
];
const available = new Set(['compatible','preview-required','unmeasured']);
const previewFlag = '--enable-preview';

function description(candidate, report) {
  switch (candidate.state) {
    case 'compatible': return 'Matches the module classfile requirement';
    case 'unmeasured': return 'Build this module to measure its classfiles';
    case 'preview-required': return 'Requires '+previewFlag;
    case 'below-classfile-target': return 'Module classfiles require Java '+report.output.minimum+' or higher';
    case 'preview-version-mismatch': return 'Preview classfiles require Java '+report.output.previews[0];
    case 'mixed-preview-output': return 'Rebuild classfiles with one compatible preview release';
    case 'version-label-mismatch': return 'The configured name '+candidate.label+' does not match this JVM';
    default: return 'The configured JVM could not be verified';
  }
}

function createRuntimeReview(vscode,{trusted,java,ensureProject,request,config,save,getConfiguration}) {
  const reviews = new WeakMap();

  async function input(project,cancellation) {
    trusted();
    const observed = await request('java.project.getSettings',[project.uri,keys],cancellation);
    const paths = await request('java.project.getClasspaths',[project.uri,{scope:'runtime'}],cancellation);
    if (!observed || !Array.isArray(paths?.classpaths) || !Array.isArray(paths.modulepaths)) {
      throw Error('Refresh the imported Java module before reviewing its runtime.');
    }
    const outputPaths = [...new Set([observed[keys[0]],...paths.classpaths,...paths.modulepaths].flatMap(value=>{
      try { return [local(value)]; } catch { return []; }
    }))];
    const preferredHome = observed[keys[1]] || project.jdk;
    const entries = config().get('projectJdks',[]);
    if (!Array.isArray(entries)) throw Error('Configure Java project runtimes as a list of local JDKs.');
    const candidates = [{home:preferredHome,label:'Imported project JDK'},{home:java.getState().javaHome,label:'Language server JDK'},
      ...entries.map(entry=>({home:entry?.path,label:entry?.name}))].filter(item=>typeof item.home==='string'&&item.home);
    const unique = [...new Map(candidates.map(item=>[item.home,item])).values()];
    return {root:project.root,outputPaths,preferredHome,candidates:unique,settings:{source:observed[keys[2]],
      compliance:observed[keys[3]],target:observed[keys[4]],preview:observed[keys[5]]},cancellation};
  }

  async function inspect({projectUri,projectId,cancellation}={}) {
    const project=await ensureProject(projectUri||projectId), options=await input(project,cancellation);
    const result=await reviewModuleRuntimes(options);
    trusted();
    const report = Object.freeze({projectUri:project.uri,projectName:project.name,...result,
      output:Object.freeze({...result.output,roots:Object.freeze(result.output.roots),previews:Object.freeze(result.output.previews)}),
      candidates:Object.freeze(result.candidates.map(item=>Object.freeze(item))),warnings:Object.freeze(result.warnings)});
    reviews.set(report,{project,settings:JSON.stringify(options.settings),runtime:java.getState().runtimeIdentity});
    return report;
  }

  function selection(report,home,enablePreview) {
    trusted();
    const record=reviews.get(report), choice=record&&report.candidates.find(item=>item.home===home);
    if (!choice || !available.has(choice.state)) throw Error('Choose a runtime marked usable in the current module review.');
    if (choice.requiresPreview && enablePreview!==true) throw Error('Explicitly enable preview features for this Java runtime.');
    return {record,choice};
  }

  async function verify(report,home,enablePreview,cancellation) {
    const {record,choice}=selection(report,home,enablePreview);
    if (record.runtime!==java.getState().runtimeIdentity) throw Error('The Java runtime configuration changed. Review the module again.');
    const project=await ensureProject(record.project.uri),options=await input(project,cancellation);
    const current=await reviewModuleRuntimes({...options,candidates:options.candidates.filter(item=>item.home===choice.configuredHome)});
    if (!current.candidates.some(item=>item.identity===choice.identity&&item.state===choice.state) ||
        current.output.fingerprint!==report.output.fingerprint || JSON.stringify(options.settings)!==record.settings) {
      throw Error('The module settings, classfile requirements or selected JVM changed. Review the runtime again.');
    }
    trusted();
    return choice;
  }

  async function apply(report,{configurationId,home,enablePreview=false,cancellation}={}) {
    const {choice}=selection(report,home,enablePreview);
    const configuration=getConfiguration(configurationId);
    if (!configuration || configuration.projectUri!==report.projectUri || typeof configuration.id!=='string') {
      throw Error('Choose a saved run configuration for the reviewed Java module.');
    }
    const vmArgs = [...configuration.vmArgs];
    if (choice.requiresPreview && !vmArgs.includes(previewFlag)) vmArgs.push(previewFlag);
    if (choice.major<12&&vmArgs.includes(previewFlag)) throw Error('The saved preview flag requires Java 12 or newer.');
    return save({configurationId:configuration.id,projectUri:configuration.projectUri,mainClass:configuration.mainClass,
      projectName:configuration.projectName,name:configuration.name,args:configuration.args,vmArgs,javaHome:choice.home,cancellation},
      async()=>{
        await verify(report,choice.home,enablePreview,cancellation);
        if (JSON.stringify(getConfiguration(configuration.id))!==JSON.stringify(configuration)) {
          throw Error('The saved Java launch changed. Review its runtime again.');
        }
      });
  }

  function rows(report,candidates) {
    return candidates.map(item=>({label:item.version?'Java '+item.version:'Unavailable JVM',
      description:item.home,detail:description(item,report),item}));
  }

  async function show(project) {
    const report=await inspect({projectUri:project.uri});
    const source=report.source?'source '+report.source:'source level unavailable';
    const output=report.output.minimum?'bytecode Java '+report.output.minimum:'bytecode not yet measured';
    await vscode.window.showQuickPick(rows(report,report.candidates),{title:project.name+' · '+source+' · '+output,
      placeHolder:report.warnings.join(' ')||'Compare installed JVMs against this module’s local class files'});
    return report;
  }

  async function choose(project) {
    const report=await inspect({projectUri:project.uri});
    const usable=report.candidates.filter(item=>available.has(item.state));
    if (!usable.length) throw Error('No verified JVM matches the module classfiles. Review Java Runtime Compatibility.');
    const picked=await vscode.window.showQuickPick(rows(report,usable),{title:'Independent JDK for '+project.name,
      placeHolder:report.output.minimum?'Module classfiles target Java '+report.output.minimum:'Compile to measure module classfile versions'});
    if (!picked) return;
    const choice=picked.item;
    const enablePreview=choice.requiresPreview && 'Enable Preview'===await vscode.window.showWarningMessage(
      'This module uses Java '+choice.major+' preview classfiles.',{modal:true,detail:'Save the '+previewFlag+' runtime option for this launch.'},'Enable Preview');
    if (choice.requiresPreview&&!enablePreview) return;
    return {report,choice,enablePreview,vmArgs:enablePreview?[previewFlag]:[]};
  }

  return {inspect,show,choose,verify,apply};
}

module.exports={createRuntimeReview};
