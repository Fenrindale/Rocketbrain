'use strict';

const {PROFILES,qualified,resolveNullChecks}=require('./null-checks');

async function configureNullChecks(vscode) {
  const {workspace,window,ConfigurationTarget}=vscode;
  if(!workspace.isTrusted||!workspace.workspaceFolders?.length) {
    throw Error('Open a trusted workspace to select Java null-check annotations.');
  }
  const config=workspace.getConfiguration('rocketbrain.java'),current=config.get('nullChecks',{});
  const choice=await window.showQuickPick(Object.entries(PROFILES).map(([profile,details])=>({
    profile,label:details.label,
    description:profile===(current?.profile??'disabled')?'Current workspace profile':undefined
  })),{title:'Java Null Checks',placeHolder:'Choose annotations already available in your Java project'});
  if(!choice)return undefined;
  const next={profile:choice.profile};
  if(choice.profile==='custom') {
    for(const [key,label,optional] of [['nullable','Nullable annotation',false],['nonnull','Non-null annotation',false],
      ['nonnullByDefault','Default non-null annotation (optional)',true]]) {
      const input=await window.showInputBox({title:label,value:typeof current?.[key]==='string'?current[key]:'',
        placeHolder:'com.example.AnnotationName',ignoreFocusOut:true,validateInput:value=>{
          const name=value.trim();
          if(!name&&optional)return undefined;
          if(!qualified(name))return 'Enter a fully qualified Java annotation name.';
          if(Object.values(next).includes(name))return 'Use a distinct annotation name.';
          return undefined;
        }});
      if(input===undefined)return undefined;
      if(input.trim())next[key]=input.trim();
    }
  }
  resolveNullChecks(next);
  if(!workspace.isTrusted)throw Error('Trust the workspace before applying Java null-check annotations.');
  await config.update('nullChecks',next,ConfigurationTarget.Workspace);
  return next.profile;
}

module.exports={configureNullChecks};
