'use strict';

const integer=value=>value.toLocaleString();
const label=object=>object.kind==='class'?'Class mirror · '+object.type:object.type;
const size=object=>object.retainedPayloadBytes===null?'No strong path to a recorded GC root':
  integer(object.retainedPayloadBytes)+' retained payload bytes · '+integer(object.retainedObjects)+' objects';

function describeMetrics(metrics) {
  return [
    integer(metrics.fileBytes)+' file bytes',
    integer(metrics.objects)+' object records · '+integer(metrics.reachable)+' GC-reachable · '+integer(metrics.unreachable)+' unreachable',
    integer(metrics.roots)+' GC roots · '+integer(metrics.edges)+' modeled references',
    integer(metrics.retainedPayloadBytes)+' reachable payload bytes',
    integer(metrics.excludedNonStrongReferences)+' Reference.referent edges excluded',
    integer(metrics.unresolvedReferences)+' references to absent object records',
    'Retained size sums field and array payload in the observed graph.'
  ];
}

async function showHeapAnalysis(vscode,analysis,show) {
  const detail=describeMetrics(analysis.metrics);
  const entries=[
    {label:'Heap Summary',action:'summary',description:detail[1]},
    {label:'Largest Retained Objects',action:'largest'},
    {label:'Find Objects by Java Type',action:'classes'},
    {label:'Inspect an Object ID',action:'address'}
  ];
  const choose=(items,title,placeHolder)=>vscode.window.showQuickPick(items,{title,placeHolder,matchOnDescription:true});
  for(;;){
    const found=await choose(entries,'JVM Heap Dump','Retained sizes use HPROF field and array payload');
    if(!found)return;
    if(found.action==='summary'){show('JVM Heap Dump Summary',detail);continue;}
    let key;
    if(found.action==='address'){
      key=await vscode.window.showInputBox({title:'HPROF Object ID',placeHolder:'0x…',validateInput:value=>{
        try{analysis.inspect(value.trim());return undefined;}catch(error){return error.message;}
      }});
      key=key?.trim();
    }else{
      let type;
      if(found.action==='classes'){
        const query=await vscode.window.showInputBox({title:'Java Type Filter',placeHolder:'Filter by fully qualified name'});
        if(query===undefined)continue;
        const classes=analysis.classes({query,limit:200});
        if(!classes.total){void vscode.window.showInformationMessage('The heap dump has no matching Java type.');continue;}
        type=(await choose(classes.rows.map(row=>({label:label(row),description:integer(row.instances)+' records',
          detail:integer(row.shallowPayloadBytes)+' shallow payload bytes',key:row.key})),
          'Java Types · '+classes.total,'Choose a type to inspect its instances'))?.key;
        if(!type)continue;
      }
      const objects=analysis.objects({type,limit:200});
      key=(await choose(objects.rows.map(object=>({label:label(object),description:object.address,detail:size(object),key:object.address})),
        'Heap Objects · '+objects.total,'Choose an object by retained size or object ID'))?.key;
    }
    while(key){
      const object=analysis.inspect(key);
      const selected=await choose([
        {label:'Object Summary',action:'summary',description:size(object)},
        {label:'Path to GC Root',action:'path',description:object.root?object.root+' · '+object.pathLength+' steps':'No modeled root path'},
        ...(object.dominator?[{label:'Open Immediate Dominator',key:object.dominator.address,description:label(object.dominator)}]:[]),
        {label:'Incoming References',action:'incoming',description:integer(object.incoming.total)+' references'},
        {label:'Outgoing References',action:'outgoing',description:integer(object.outgoing.total)+' references'},
        {label:'Return to Heap',action:'back'}
      ],label(object)+' · '+object.address);
      if(!selected||selected.action==='back')break;
      if(selected.key){key=selected.key;continue;}
      if(selected.action==='summary'){
        show(label(object)+' · '+object.address,[
          integer(object.shallowPayloadBytes)+' shallow payload bytes',size(object),
          integer(object.unresolvedOutgoing)+' outgoing references to absent object records'
        ]);
      }else if(selected.action==='path'){
        const path=object.path.map(step=>step.via+' → '+label(step.object)+' '+step.object.address);
        const shortened=object.pathTruncated?['Showing the last '+object.path.length+' steps from the recorded '+object.root+' root.']:[];
        show('Path to GC Root · '+object.address,path.length?[...shortened,...path]:['No strong path to a recorded GC root.']);
      }else{
        const path=object[selected.action];
        const related=await choose(path.rows.map(step=>({label:step.label,detail:label(step.object),
          description:step.object.address,key:step.object.address})),selected.label+' · '+path.total,'Choose a reference to follow');
        if(related)key=related.key;
      }
    }
  }
}

module.exports={showHeapAnalysis};
