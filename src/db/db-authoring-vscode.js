'use strict';
function registerDatabaseAuthoring(context,vscode,options){const designer=require('./schema-designer-vscode').registerTableDesigner(context,vscode,options),objects=require('./object-editor-vscode').registerObjectEditor(context,vscode,options);return{...designer,...objects,async dispose(){await designer.dispose();await objects.dispose();}};}
module.exports={registerDatabaseAuthoring};
