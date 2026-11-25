'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gitRead,invokeGit,supportedPath,inside } = require('./changelist-git');

const PATCH_BYTES = 512 * 1024, FILE_BYTES = 2 * 1024 * 1024, PATHS = 48, HUNKS = 240;
const utf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
const HASH=/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const digest=value=>createHash('sha256').update(value).digest('hex');
const shelfPath=value=>supportedPath(value)&&!value.includes('"')&&
  value.split('/').every(part=>!/[. ]$/u.test(part)&&part.toLowerCase()!=='.gitattributes');

function parsePatch(patch,file) {
  if (!shelfPath(file)||typeof patch!=='string'||Buffer.byteLength(patch)>PATCH_BYTES||
      !patch.endsWith('\n')||patch.includes('\x00')) throw Error('Invalid bounded Git Shelf patch.');
  const lines=patch.slice(0,-1).split('\n'), head=lines.slice(0,4);
  const index=/^index ([a-f0-9]+)\.\.([a-f0-9]+) (100644|100755)$/u.exec(head[1]||'');
  const fileHeader=(line,prefix)=>line===prefix+file||line===prefix+file+'\t';
  if (head[0]!=='diff --git a/'+file+' b/'+file||!index||!HASH.test(index[1])||!HASH.test(index[2])||
      !fileHeader(head[2],'--- a/')||!fileHeader(head[3],'+++ b/')) {
    throw Error('Git Shelf supports tracked text hunks without file or mode changes.');
  }
  const hunks=[];
  let cursor=4;
  while(cursor<lines.length) {
    const first=cursor, marker=/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/u.exec(lines[cursor++]);
    if (!marker||hunks.length===HUNKS) throw Error('Invalid Git Shelf hunk header.');
    const oldLine=Number(marker[1]), newLine=Number(marker[3]), expectedOld=Number(marker[2]??1), expectedNew=Number(marker[4]??1);
    if ([oldLine,newLine,expectedOld,expectedNew].some(number=>!Number.isSafeInteger(number)||number>FILE_BYTES)) {
      throw Error('Git Shelf hunk exceeds its line bounds.');
    }
    const before=[],after=[];
    let changed=false, body=false;
    while (cursor<lines.length&&!lines[cursor].startsWith('@@ ')) {
      const raw=lines[cursor++], prefix=raw[0], content=raw.slice(1).replace(/\r$/u,'');
      if (raw==='\\ No newline at end of file'&&body) {body=false;continue;}
      if (![' ','+','-'].includes(prefix)) throw Error('Invalid Git Shelf hunk body.');
      body=true;
      changed ||= prefix!==' ';
      if (prefix!=='+') before.push(content);
      if (prefix!=='-') after.push(content);
    }
    if (!changed||before.length!==expectedOld||after.length!==expectedNew) throw Error('Invalid Git Shelf hunk counts.');
    hunks.push({oldLine,newLine,before,after,patch:lines.slice(first,cursor).join('\n')+'\n'});
  }
  if (!hunks.length) throw Error('No tracked text hunks are available in this file.');
  return {header:head.join('\n')+'\n',base:index[1],mode:index[3],hunks};
}

function readText(bytes) {
  if (bytes.length>FILE_BYTES||bytes.includes(0)) throw Error('Git Shelf needs a bounded plain UTF-8 text file.');
  let value;
  try { value=utf8.decode(bytes); } catch { throw Error('Git Shelf needs a bounded plain UTF-8 text file.'); }
  if (value.startsWith('\uFEFF')||/\r(?!\n)/u.test(value)||(/\r\n/u.test(value)&&/(^|[^\r])\n/u.test(value))) {
    throw Error('Git Shelf needs consistent line endings in a plain UTF-8 text file.');
  }
  return value;
}

async function physicalFile(root,name) {
  if (!shelfPath(name)) throw Error('Choose an ordinary tracked file path in the Git working tree.');
  const candidate=path.resolve(root,...name.split('/'));
  if (!inside(root,candidate)||!path.relative(root,candidate)||path.relative(candidate,await fs.realpath(candidate))) {
    throw Error('The Git Shelf file path changed or contains a link.');
  }
  const stat=await fs.lstat(candidate);
  if (!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>FILE_BYTES) {
    throw Error('Git Shelf needs a bounded, ordinary tracked text file.');
  }
  return {file:candidate,bytes:await fs.readFile(candidate)};
}

async function fileSnapshot(repo,name,guard) {
  guard(name);
  const {file,bytes}=await physicalFile(repo.root,name), text=readText(bytes);
  const [attributeBytes,indexBytes]=await Promise.all([
    gitRead(repo.root,['check-attr','-z','filter','ident','working-tree-encoding','--',name]),
    gitRead(repo.root,['ls-files','--stage','-v','-z','--',name])
  ]);
  const attrs=utf8.decode(attributeBytes).split('\0');
  if(attrs.pop()!==''||attrs.length!==9||attrs.some((item,index)=>index%3===0&&item!==name)||
      [2,5,8].some(index=>!['unspecified','unset'].includes(attrs[index]))) {
    throw Error('Git Shelf cannot safely apply this file’s Git conversion filters.');
  }
  const staged=utf8.decode(indexBytes);
  const entry=/^H (100644|100755) ([a-f0-9]+) 0\t([^\0]+)\0$/u.exec(staged);
  if (!entry||entry[3]!==name||!HASH.test(entry[2])) throw Error('Git Shelf needs an ordinary tracked path without an index conflict.');
  const checkout=readText(await gitRead(repo.root,['cat-file','--filters','--path='+name,entry[2]]));
  const eol=value=>value.includes('\r\n')?'CRLF':value.includes('\n')?'LF':null;
  if (eol(checkout)&&eol(text)&&eol(checkout)!==eol(text)) throw Error('The worktree line endings differ from Git’s checkout format.');
  guard(name);
  if (!bytes.equals((await physicalFile(repo.root,name)).bytes)) throw Error('The Git Shelf file changed during review.');
  return {file,text,hash:digest(bytes),index:entry[2],mode:entry[1],checkout:digest(checkout)};
}

async function readDiff(repo,name) {
  return utf8.decode(await gitRead(repo.root,['-c','core.quotePath=false','diff','--no-ext-diff','--no-textconv','--no-renames',
    '--no-color','--full-index','--src-prefix=a/','--dst-prefix=b/','--inter-hunk-context=0','-U3','--',name]));
}

function uniqueContext(text,atoms) {
  if (!atoms.length) return text.length===0;
  const source='\n'+text.replaceAll('\r\n','\n').replace(/\n$/u,'')+'\n';
  const needle='\n'+atoms.join('\n')+'\n', first=source.indexOf(needle);
  return first>=0&&source.indexOf(needle,first+1)<0;
}

async function applyPatch(root,patch,{reverse=false,check=false}={}) {
  try {
    await invokeGit(root,['-c','apply.ignoreWhitespace=no','apply','-p1','--whitespace=nowarn',
      ...(reverse?['--reverse']:[]),...(check?['--check']:[]),'-'],patch);
    return true;
  } catch(error) {
    if(check&&error.code===1&&/patch does not apply|patch failed:|does not exist in working directory/iu.test(error.stderr?.toString())) return false;
    throw Error(check?'Git could not review the shelf patch.':'Git could not finish applying the shelf patch. The saved shelf is still available.');
  }
}

module.exports={PATCH_BYTES,PATHS,HUNKS,FILE_BYTES,HASH,digest,shelfPath,parsePatch,fileSnapshot,readDiff,uniqueContext,applyPatch};
