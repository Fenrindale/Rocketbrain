'use strict';

const path = require('node:path');
const { editedText } = require('./refactoring');

const EXTRACT_INTERFACE_KIND = 'refactor.extract.interface';

function interfaceMembers(reply) {
  if (!reply || typeof reply.subTypeName !== 'string' || !Array.isArray(reply.members) ||
      !reply.members.length || reply.members.length > 200) throw Error('JDT found no supported members for interface extraction.');
  const seen = new Set();
  return reply.members.map(candidate => {
    const {name,typeName,parameters,handleIdentifier} = candidate || {};
    if (typeof name !== 'string' || !name || name.length > 200 || typeof typeName !== 'string' || typeName.length > 500 ||
        typeof handleIdentifier !== 'string' || !handleIdentifier || handleIdentifier.length > 8192 ||
        seen.has(handleIdentifier) || parameters != null && (!Array.isArray(parameters) ||
          parameters.length > 100 || parameters.some(value => typeof value !== 'string' || value.length > 500))) {
      throw Error('JDT returned an unsupported extractable member.');
    }
    seen.add(handleIdentifier);
    return { id:handleIdentifier,name,type:typeName,...(parameters != null && {parameters:[...parameters]}) };
  });
}

function localKey(uri) {
  if (uri?.scheme !== 'file' || uri.authority || uri.query || uri.fragment ||
      !path.isAbsolute(uri.fsPath)) throw Error('Interface extraction requires local Java source files.');
  const normalized = path.resolve(uri.fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function reviewedNewTypeFile(reply,{owner,created,sources,replaceUsages,parseUri,artifact='interface'}) {
  const edit = reply?.edit;
  if (reply?.errorMessage) throw Error('JDT refused the new '+artifact+' operation: ' + String(reply.errorMessage).slice(0,1000));
  if (!edit || reply.command || Object.keys(edit.changeAnnotations || {}).length ||
      !Array.isArray(edit.documentChanges)) throw Error('JDT did not return independently reviewable '+artifact+' edits.');
  const ownerKey = localKey(owner), targetKey = localKey(created);
  const sourceByKey = new Map(sources.map(source => [localKey(parseUri(source.uri)),source]));
  let createdFile = false,newText;
  const existing = new Map(), after = new Map();
  function add(uri,edits,version) {
    const key = localKey(parseUri(uri));
    if (!Array.isArray(edits) || !edits.length || edits.some(item => item?.annotationId || typeof item?.newText !== 'string')) {
      throw Error('JDT returned unsupported or annotated '+artifact+' edits.');
    }
    if (key === targetKey) {
      if (!createdFile || newText !== undefined || edits.length !== 1 ||
          ![edits[0].range?.start,edits[0].range?.end].every(point => point?.line === 0 && point?.character === 0)) {
        throw Error('JDT did not return a single initial text for the approved '+artifact+' file.');
      }
      newText = edits[0].newText;
      return;
    }
    const source = sourceByKey.get(key);
    if (!source || !replaceUsages && key !== ownerKey) {
      throw Error('JDT proposed a change outside the reviewed Java usage scope.');
    }
    const previous = existing.get(key);
    if (previous?.textDocument.version != null && version != null && version !== previous.textDocument.version) {
      throw Error('JDT returned conflicting source versions.');
    }
    existing.set(key,{textDocument:{uri:source.uri,version:version ?? previous?.textDocument.version ?? null},
      edits:[...(previous?.edits || []),...edits]});
  }
  for (const [uri,edits] of Object.entries(edit.changes || {})) add(uri,edits);
  for (const item of edit.documentChanges) {
    if (item?.kind === 'create') {
      if (createdFile || localKey(parseUri(item.uri)) !== targetKey || item.options?.overwrite || item.annotationId) {
        throw Error('JDT proposed an unexpected '+artifact+' file creation.');
      }
      createdFile = true;
    } else if (!item?.kind && item?.textDocument) {
      add(item.textDocument.uri,item.edits,item.textDocument.version);
    } else throw Error('The new '+artifact+' accepts just the approved file creation and reviewed Java edits.');
  }
  if (!existing.has(ownerKey) || !createdFile || !newText?.trim() || newText.includes('\0') ||
      Buffer.byteLength(newText) > 512 * 1024 || existing.size >= 30 || sourceByKey.has(targetKey)) {
    throw Error('JDT did not return one new '+artifact+' and an update to its owner within the review limits.');
  }
  for (const [key,{textDocument,edits}] of existing) {
    const source = sourceByKey.get(key);
    const text = editedText(source.text,edits);
    if (text === source.text || Buffer.byteLength(text) > 512 * 1024) {
      throw Error('A proposed '+artifact+' change is empty or exceeds the Java source size limit.');
    }
    after.set(textDocument.uri,text);
  }
  return { createJavaFile:{uri:created.toString(),text:newText},
    edit:{documentChanges:[...existing.values()]},
    updated:sources.map(source => ({...source,text:after.get(source.uri) ?? source.text})),
    callerFiles:existing.size - 1 };
}

module.exports = { EXTRACT_INTERFACE_KIND, interfaceMembers, interfaceEdit:reviewedNewTypeFile, reviewedNewTypeFile, localKey };
