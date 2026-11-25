'use strict';

const path=require('node:path');
const {rangeAt}=require('../spring/java');

const JAVA_GROUPS=Object.freeze({inherited:'Inherited members',nested:'Nested and anonymous types'});
const normalize=text=>text.replace(/\r\n/g,'\n');

function createTypedFileStructure(vscode,{
  java,assertReady,projects,findProject,classSources,compile,snapshot,assertUnchangedSourceSnapshots
}) {
  const reviews=new WeakMap();

  async function inspect({document,position,group,cancellation}) {
    assertReady(cancellation);
    if (!Object.hasOwn(JAVA_GROUPS,group)||document.languageId!=='java'||document.isDirty||document.isClosed) {
      throw Error('Save the current Java workspace source before inspecting its types.');
    }
    const version=document.version,text=document.getText(),source=await snapshot(document.uri,cancellation);
    if (normalize(source.text)!==normalize(text)) throw Error('Open the exact saved Java source before inspecting its types.');
    const state=await projects(cancellation),project=findProject(state.projects,document.uri);
    const sources=await classSources(project,cancellation),observed=sources.find(file=>
      !path.relative(vscode.Uri.parse(file.uri).fsPath,document.uri.fsPath) && file.sha===source.sha);
    if (!observed) throw Error('Open an imported Java production source to inspect its types.');
    const inputs=sources.map(file=>file===observed?{...file,text}:file);
    const offset=position?document.offsetAt(document.validatePosition(position)):0;
    const compiled=await compile(state,project,inputs,{kind:'typeStructure',uri:observed.uri,offset,group},cancellation);
    const proof=compiled.typeStructure;
    if (!proof || proof.error) throw Error(proof?.error||'Compiler File Structure is unavailable.');
    function checkAnchor() {
      assertReady();
      const active=java.getState();
      if (document.isClosed||document.isDirty||document.version!==version||document.getText()!==text||
          active.state!=='running'||active.runtimeIdentity!==state.runtimeIdentity) {
        throw Error('The source or its Java runtime changed. Open File Structure again.');
      }
    }
    checkAnchor();
    const files=new Map(inputs.map(file=>[file.uri,file]));
    const rows=proof.members.map((item,id)=>{
      const file=files.get(item.uri);
      const exact=file&&Number.isSafeInteger(item.start)&&Number.isSafeInteger(item.end)&&item.start>=0&&
        item.end>item.start&&item.end<=file.text.length;
      const range=exact?rangeAt(file.text,item.start,item.end):undefined;
      if (range) {Object.freeze(range.start);Object.freeze(range.end);Object.freeze(range);}
      return Object.freeze({id,label:item.label,kind:item.kind,path:item.path,signature:item.signature,detail:item.detail,
        origin:item.origin,sourced:Boolean(exact),uri:exact?file.uri:undefined,range});
    });
    const currentId=proof.members.findIndex(item=>item.current);
    const result=Object.freeze({language:'java',group,type:proof.type,currentId:currentId<0?undefined:currentId,
      stats:Object.freeze({limited:proof.limited,count:rows.length}),members:Object.freeze(rows)});
    reviews.set(result,{checkAnchor,compiled,files,sources});
    return result;
  }

  async function reveal(report,id) {
    const review=reviews.get(report);
    const row=Number.isSafeInteger(id)?report?.members[id]:undefined;
    if (!review||!row) throw Error('Select a known File Structure member.');
    if (!row.sourced) throw Error('The declaration source is unavailable in the analyzed Java project.');
    review.checkAnchor();
    assertUnchangedSourceSnapshots(review.sources);
    review.compiled.validateClasspath();
    const file=review.files.get(row.uri),uri=vscode.Uri.parse(file.uri);
    const document=await vscode.workspace.openTextDocument(uri);
    review.checkAnchor();
    if (document.isDirty||normalize(document.getText())!==normalize(file.text)) throw Error('The declaration source changed. Open File Structure again.');
    const {start,end}=row.range;
    return vscode.window.showTextDocument(document,{
      selection:new vscode.Range(start.line,start.character,end.line,end.character),preview:true,preserveFocus:false
    });
  }

  return {inspect,reveal};
}

module.exports={JAVA_GROUPS,createTypedFileStructure};
