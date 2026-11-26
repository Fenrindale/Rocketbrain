'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {inside}=require('./workbench-model');

function createKotlinEditorScope(root, active) {
  const opened=new Set();

  function owns(uri, allowMissing=false) {
    if (uri?.scheme!=='file' || uri.authority || uri.query || uri.fragment ||
        typeof uri.fsPath!=='string' || !path.isAbsolute(uri.fsPath) || !inside(root,uri.fsPath)) return false;
    let file=uri.fsPath;
    for (;;) {
      try {
        const physical=fs.realpathSync(file);
        return inside(root,physical) && path.relative(file,physical)==='';
      } catch (error) {
        if (!allowMissing || !['ENOENT','ENOTDIR'].includes(error.code) || !path.relative(root,file)) return false;
        file=path.dirname(file);
      }
    }
  }

  const id=document=>document.uri.toString();
  function available(document) {
    return active() && opened.has(id(document)) && owns(document.uri);
  }

  const middleware={
    async didOpen(document,next) {
      if (!active() || document.isClosed || document.languageId!=='kotlin' ||
          !document.uri.fsPath.endsWith('.kt') || !owns(document.uri)) return;
      const key=id(document);
      if (opened.has(key)) return;
      opened.add(key);
      try {await next(document);}
      catch (error) {opened.delete(key);throw error;}
    },
    async didChange(event,next) {
      if (available(event.document)) await next(event);
    },
    async willSave(event,next) {
      if (available(event.document)) await next(event);
    },
    willSaveWaitUntil(event,next) {
      return available(event.document)?next(event):Promise.resolve([]);
    },
    async didSave(document,next) {
      if (available(document)) await next(document);
    },
    async didClose(document,next) {
      // Closing or deleting an admitted source must still tell its original client.
      if (opened.delete(id(document))) await next(document);
    },
    handleDiagnostics(uri,diagnostics,next) {
      if (active()&&owns(uri)) next(uri,diagnostics);
    }
  };

  function request(document,...args) {
    const next=args.pop();
    return available(document)?next(document,...args):undefined;
  }

  return {owns,available,middleware,request};
}

module.exports={createKotlinEditorScope};
