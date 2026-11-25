'use strict';

const {propertyLimit,springLaunchOptions}=require('./spring-launch');
const sourceChoices=[
  {id:'environment',label:'OS environment variable'},
  {id:'jvm',label:'JVM system property (-D)'},
  {id:'arguments',label:'Spring application argument (--)'}
];

async function chooseSpringLaunch(window,check){
  const selection=await window.showInputBox({title:'Active Spring Boot profiles',prompt:'Comma-separated literal profiles. Leave empty for the application defaults.',ignoreFocusOut:true});
  check();if(selection===undefined)return;
  const profiles=selection.trim()?selection.split(',').map(value=>value.trim()):[];
  let profileSource;
  if(profiles.length){
    const selected=await window.showQuickPick(sourceChoices,{title:'Deliver active Spring Boot profiles',ignoreFocusOut:true});
    check();if(!selected)return;
    profileSource=selected.id;
  }
  const properties=[];
  for(let i=0;i<propertyLimit;i++){
    const key=await window.showInputBox({title:'Spring Boot property (optional)',prompt:'Enter a canonical property such as server.port. Leave empty when done.',ignoreFocusOut:true});
    check();if(key===undefined)return;if(!key)break;
    const selected=await window.showQuickPick(sourceChoices,{title:'Deliver '+key,ignoreFocusOut:true});
    check();if(!selected)return;
    const hint=selected.id==='environment'?'The value is stored in VS Code Secret Storage.':'Use this source for values suitable for local process arguments.';
    const value=await window.showInputBox({title:'Value for '+key,password:true,prompt:hint,ignoreFocusOut:true});
    check();if(value===undefined)return;
    properties.push({key,source:selected.id,value});
  }
  const result=springLaunchOptions({profiles,profileSource,properties});
  const sourceLabel=id=>sourceChoices.find(choice=>choice.id===id)?.label;
  const detail=[
    ...(profiles.length?['Active profiles · '+profiles.join(', ')+' · '+sourceLabel(profileSource)]:[]),
    ...properties.map(property=>property.key+' · '+sourceLabel(property.source))
  ].join('\n');
  const confirmed=await window.showInformationMessage('Save Spring Boot launch settings?',{modal:true,detail},'Save settings');
  check();if(confirmed==='Save settings')return result;
}

module.exports={chooseSpringLaunch};
