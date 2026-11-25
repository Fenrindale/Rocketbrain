'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),yauzl=require('yauzl'),{SaxesParser}=require('saxes');
const H=require('./grid-xlsx').streamReaders;
const {Readable}=require('node:stream');
async function* readChunks(handle,start=0,end=Infinity){let position=start;while(position<end){const buffer=Buffer.alloc(Math.min(LIMITS.chunkBytes,end-position)),{bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;yield buffer.subarray(0,bytesRead);}}
const LIMITS={fileBytes:1024**3,expandedBytes:4*1024**3,worksheetBytes:2*1024**3,metadataBytes:8*1024**2,entries:1024,sheets:100,rows:1000000,columns:200,cellBytes:128*1024,rowBytes:1024**2,sharedStrings:20000,chunkBytes:16*1024};
const contentTypes = 'http://schemas.openxmlformats.org/package/2006/content-types';
const xlsxFamilies = [
 { variant: 'transitional', namespace: 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
   relationships: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships' },
 { variant: 'strict', namespace: 'http://purl.oclc.org/ooxml/spreadsheetml/main',
   relationships: 'http://purl.oclc.org/ooxml/officeDocument/relationships' }
];
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_IMPORT_SOURCE'});
const cancelled=token=>token?.aborted||token?.isCancellationRequested;
const check=options=>{if(cancelled(options.cancellation))throw fail('Import cancelled.');};
function crcStep(value,bytes){for(const byte of bytes){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return value;}
function identity(stat){return {size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:String(stat.ino),dev:String(stat.dev)};}
async function openSource(file){if(typeof file!=='string'||!path.isAbsolute(file)||file.startsWith('\\\\')||file.includes('\0'))throw fail('Choose a local absolute import file.');const handle=await fs.promises.open(file,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>LIMITS.fileBytes)throw fail('Import an ordinary local file no larger than 1 GiB.');return{handle,identity:identity(stat)};}catch(error){await handle.close();throw error;}}
async function fileHash(handle,options={}){const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(64*1024);let position=0;while(true){check(options);const {bytesRead}=await handle.read(buffer,0,buffer.length,position);if(!bytesRead)break;position+=bytesRead;if(position>LIMITS.fileBytes)throw fail('The source grew beyond 1 GiB.');hash.update(buffer.subarray(0,bytesRead));}return hash.digest('hex');}
async function* csvRows(handle,{delimiter=',',...options}={}){
 if(![',','\t'].includes(delimiter))throw fail('Choose comma CSV or tab TSV.');let cell='',row=[],quoted=[],state='start',cr=false,first=true,any=false,rowIndex=0;
 const push=()=>{if(Buffer.byteLength(cell)>LIMITS.cellBytes||cell.includes('\0'))throw fail('A source cell contains NUL or exceeds 128 KiB.');row.push(cell);quoted.push(state==='quoted'||state==='closed');if(row.length>LIMITS.columns)throw fail('Import at most 200 source fields.');cell='';state='start';};
 const finish=()=>{push();if(Buffer.byteLength(JSON.stringify(row))>LIMITS.rowBytes)throw fail('A source row exceeds 1 MiB.');const value={values:row,quoted,line:++rowIndex};row=[];quoted=[];return value;};
 const decoder=new TextDecoder('utf-8',{fatal:true}),stream=readChunks(handle);
 try{for await(const buffer of stream){check(options);let text;try{text=decoder.decode(buffer,{stream:true});}catch{throw fail('CSV/TSV must be valid UTF-8.');}for(const c of text){if(first){first=false;if(c==='\ufeff')continue;}any=true;if(cr){cr=false;if(c==='\n')continue;}
   if(state==='quoted'){if(c==='"')state='closed';else cell+=c;}
   else if(state==='closed'&&c==='"'){cell+='"';state='quoted';}
   else if(c===delimiter){push();}
   else if(c==='\r'||c==='\n'){yield finish();cr=c==='\r';}
   else if(c==='"'){if(state!=='start'||cell)throw fail('A CSV quote must start a field.');state='quoted';}
   else{if(state==='closed')throw fail('A quoted CSV cell must end at a delimiter or line ending.');cell+=c;state='plain';}
   if(cell.length>LIMITS.cellBytes)throw fail('A source cell exceeds its character limit.');
 }}try{decoder.decode();}catch{throw fail('CSV/TSV must be valid UTF-8.');}if(state==='quoted')throw fail('A quoted CSV field is not closed.');if(cell||row.length||state==='closed')yield finish();if(!any)throw fail('The import source is empty.');}finally{if(stream.destroy)stream.destroy();else await stream.return?.();}
}
async function zipIndex(handle){class Reader extends yauzl.RandomAccessReader{_readStreamForRange(start,end){return Readable.from(readChunks(handle,start,end),{objectMode:false});}}const size=(await handle.stat()).size;return new Promise((resolve,reject)=>yauzl.fromRandomAccessReader(new Reader(),size,{lazyEntries:true,autoClose:false,strictFileNames:true,validateEntrySizes:true},(error,zip)=>{if(error)return reject(fail('The source is not a readable XLSX archive.'));const entries=new Map();let count=0,expanded=0,done=false;const bad=error=>{if(!done){done=true;zip.close();reject(error?.code?error:fail('Invalid XLSX archive.'));}};zip.on('error',bad);zip.on('entry',entry=>{try{const name=entry.fileName;if(++count>LIMITS.entries||!name||name.includes('\\')||name.startsWith('/')||name.includes('\0')||name.split('/').some(p=>p==='..'||p==='.')||entries.has(name.toLowerCase()))throw fail('Unsafe, duplicate or excessive ZIP entries.');if(entry.generalPurposeBitFlag&1||![0,8].includes(entry.compressionMethod))throw fail('Encrypted or unsupported ZIP compression.');if(/vbaProject|activeX|embeddings|externalLinks|connections\.xml|queryTables/i.test(name))throw fail('Active or external-data workbooks are unsupported.');expanded+=entry.uncompressedSize;if(expanded>LIMITS.expandedBytes||entry.uncompressedSize>LIMITS.worksheetBytes)throw fail('Expanded XLSX content exceeds the streaming limit.');entries.set(name.toLowerCase(),entry);zip.readEntry();}catch(error){bad(error);}});zip.on('end',()=>{if(!done){done=true;resolve({zip,entries});}});zip.readEntry();}));}
function entryFor(book,name){const entry=book.entries.get(name.toLowerCase());if(!entry||entry.fileName!==name)throw fail('A workbook part is missing or has ambiguous letter case.');return entry;}
async function* partChunks(book,name,options={},max=LIMITS.metadataBytes){const entry=entryFor(book,name);if(entry.uncompressedSize>max)throw fail('Workbook metadata exceeds its bounded limit.');const stream=await new Promise((resolve,reject)=>book.zip.openReadStream(entry,(error,stream)=>error?reject(fail('Cannot read XLSX part.')):resolve(stream)));let size=0,crc=0xffffffff;try{for await(const buffer of stream){check(options);size+=buffer.length;if(size>max)throw fail('An expanded workbook part exceeds its limit.');crc=crcStep(crc,buffer);yield buffer;}if(size!==entry.uncompressedSize||((crc^0xffffffff)>>>0)!==entry.crc32)throw fail('XLSX part checksum or size mismatch.');}finally{if(stream.destroy)stream.destroy();else await stream.return?.();}}
async function partBuffer(book,name,options){const chunks=[];for await(const buffer of partChunks(book,name,options))chunks.push(buffer);return Buffer.concat(chunks);}
function rejectMixedNamespace(namespace, family) {
 if (namespace !== family.namespace && xlsxFamilies.some(other => other.namespace === namespace)) {
  throw fail('The workbook mixes Strict and Transitional SpreadsheetML namespaces.');
 }
}

function spreadsheetXml(buffer, label, expected, family) {
 const root = H.xml(buffer, label);
 if (root.name !== expected || root.uri !== family.namespace) throw fail(label + ' does not match the workbook SpreadsheetML namespace.');
 function check(node) {
  rejectMixedNamespace(node.uri, family);
  for (const child of node.children) check(child);
 }
 check(root);
 return root;
}

async function xlsxBook(handle, options = {}) {
 const book = await zipIndex(handle);
 try {
  for (const entry of book.entries.values()) {
   if (entry.fileName.endsWith('.rels')) {
    const base = entry.fileName === '_rels/.rels' ? '' : entry.fileName.replace(/_rels\/([^/]+)\.rels$/, '$1');
    H.relationships(await partBuffer(book, entry.fileName, options), base);
   }
  }
  const content = H.xml(await partBuffer(book, '[Content_Types].xml', options), 'Content types');
  if (content.name !== 'Types' || content.uri !== contentTypes ||
      content.children.some(node => /macroEnabled|vbaProject|oleObject|activeX/i.test(H.attr(node, 'ContentType') || ''))) {
   throw fail('Only ordinary XLSX workbooks are supported.');
  }
  const roots = H.relationships(await partBuffer(book, '_rels/.rels', options), '');
  const main = [...roots.values()].flatMap(relationship => {
   const family = xlsxFamilies.find(entry => relationship.type === entry.relationships + '/officeDocument');
   return family ? [{ path: relationship.target, family }] : [];
  });
  if (main.length !== 1) throw fail('Choose one ordinary XLSX workbook relationship.');
  const [{ path: mainPath, family }] = main;
  const { namespace, relationships: relationshipNamespace } = family;
  book.family = family;
  const overrides = H.children(content, 'Override', contentTypes).filter(node => H.attr(node, 'PartName') === '/' + mainPath);
  const defaults = H.children(content, 'Default', contentTypes)
   .filter(node => H.attr(node, 'Extension') === path.posix.extname(mainPath).slice(1));
  if (overrides.length > 1 || defaults.length > 1 ||
      H.attr(overrides[0] || defaults[0] || { attrs: {} }, 'ContentType') !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') {
   throw fail('Unsupported workbook content type.');
  }
  const root = spreadsheetXml(await partBuffer(book, mainPath, options), 'Workbook', 'workbook', family);
  const conformance = H.attr(root, 'conformance');
  if (conformance !== undefined && conformance !== family.variant) throw fail('The workbook namespace and conformance declaration disagree.');
  const relPath = path.posix.join(path.posix.dirname(mainPath), '_rels', path.posix.basename(mainPath) + '.rels');
  const relations = H.relationships(await partBuffer(book, relPath, options), mainPath);
  const roles = ['worksheet', 'sharedStrings', 'styles'];
  if ([...relations.values()].some(({ type }) => xlsxFamilies.some(other => other !== family &&
      roles.some(role => type === other.relationships + '/' + role)))) {
   throw fail('The workbook mixes Strict and Transitional worksheet, shared-string or style relationships.');
  }
  book.sheets = [];
  const sheets = H.child(root, 'sheets', namespace);
  for (const node of H.children(sheets || { children: [] }, 'sheet', namespace)) {
   const id = H.attr(node, 'sheetId'), name = H.attr(node, 'name');
   const alternateId = xlsxFamilies.some(other => other !== family && H.attr(node, 'id', other.relationships) !== undefined);
   const rel = relations.get(H.attr(node, 'id', relationshipNamespace));
   if (!id || !name || name.length > 100 || alternateId || book.sheets.some(sheet => sheet.id === id || sheet.name === name) ||
       rel?.type !== relationshipNamespace + '/worksheet') throw fail('Invalid workbook sheets.');
   book.sheets.push({ id, name, path: rel.target, state: H.attr(node, 'state') || 'visible' });
   if (book.sheets.length > LIMITS.sheets) throw fail('Import at most 100 worksheets.');
  }
  if (!book.sheets.length) throw fail('No ordinary worksheets.');
  const date = H.attr(H.child(root, 'workbookPr', namespace) || { attrs: {} }, 'date1904');
  if (date !== undefined && !['0', '1', 'true', 'false'].includes(date)) throw fail('Invalid date system.');
  book.date1904 = date === '1' || date === 'true';
  const shared = [...relations.values()].filter(rel => rel.type === relationshipNamespace + '/sharedStrings');
  const styles = [...relations.values()].filter(rel => rel.type === relationshipNamespace + '/styles');
  if (shared.length > 1 || styles.length > 1) throw fail('Duplicate metadata parts.');
  book.shared = [];
  if (shared.length) {
   const node = spreadsheetXml(await partBuffer(book, shared[0].target, options), 'Shared strings', 'sst', family);
   book.shared = H.children(node, 'si', namespace).map(text => H.stringText(text, namespace));
   if (book.shared.length > LIMITS.sharedStrings) throw fail('Too many shared strings for bounded import.');
  }
  book.styles = [null];
  if (styles.length) {
   const node = spreadsheetXml(await partBuffer(book, styles[0].target, options), 'Styles', 'styleSheet', family);
   const formats = new Map();
   for (const format of H.children(H.child(node, 'numFmts', namespace) || { children: [] }, 'numFmt', namespace)) {
    const id = Number(H.attr(format, 'numFmtId')), code = H.attr(format, 'formatCode');
    if (!Number.isInteger(id) || id < 0 || !code || formats.has(id)) throw fail('Invalid number formats.');
    formats.set(id, code);
   }
   const numbers = H.child(node, 'cellXfs', namespace) || { children: [] };
   const parsed = H.children(numbers, 'xf', namespace).map(format => {
    const id = Number(H.attr(format, 'numFmtId') || 0);
    if (!Number.isInteger(id) || id < 0) throw fail('Invalid style.');
    return H.formatKind(id, formats.get(id));
   });
   if (parsed.length) book.styles = parsed;
  }
  return book;
 } catch (error) {
  book.zip.close();
  throw error;
 }
}
function xlsxCell(cell,book,options){const { namespace } = book.family;const type=H.attr(cell,'t')||'n',v=H.child(cell,'v',namespace),f=H.child(cell,'f',namespace),inline=H.child(cell,'is',namespace),style=Number(H.attr(cell,'s')||0);if(!Number.isInteger(style)||style<0||style>=book.styles.length)throw fail('A cell references an unavailable style.');if(f&&(options.formulaPolicy!=='cached'||!v))throw fail('Formula cells require explicit cached values; formulas are never evaluated and missing caches are refused.');let value=null;
 if(type==='inlineStr'){if(f)throw fail('Invalid inline formula.');if(inline)value=H.stringText(inline,namespace);}else if(type==='s'){if(v){if(!/^\d+$/.test(v.text)||Number(v.text)>=book.shared.length)throw fail('Unavailable shared string.');value=book.shared[Number(v.text)];}}else if(type==='str'){if(v)value=v.text;}else if(type==='b'){if(!v||!['0','1'].includes(v.text))throw fail('Invalid Boolean.');value=v.text;}else if(type==='e')throw fail('Correct Excel error cells before import.');else if(type==='d'){if(!v||!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?)?$/.test(v.text)||!Number.isFinite(Date.parse(v.text.slice(0,10)))||new Date(v.text.slice(0,10)).toISOString().slice(0,10)!==v.text.slice(0,10))throw fail('Invalid calendar date.');value=v.text.replace('T',' ').replace(/Z$/,'');}else if(type==='n'){if(v&&v.text!=='')value=book.styles[style]?H.excelDate(v.text,book.date1904,book.styles[style]):H.numberText(v.text);}else throw fail('Unsupported XLSX cell type.');if(value!==null&&(value.includes('\0')||Buffer.byteLength(value)>LIMITS.cellBytes))throw fail('An XLSX cell contains NUL or exceeds 128 KiB.');return{value,blank:value===null,formula:Boolean(f)};}
async function* xlsxRows(book,options={}){const { namespace } = book.family;const sheet=book.sheets.find(s=>s.id===options.sheetId);if(!sheet)throw fail('Choose an available worksheet.');const parser=new SaxesParser({xmlns:true}),stack=[];let rootSeen=false,rowNode=null,rowDepth=0,rowNodes=0,lastRow=0,queue=[],queuedBytes=0;
 const bad=message=>{throw fail(message);};parser.on('doctype',()=>bad('DTD declarations are unsupported.'));parser.on('processinginstruction',()=>bad('Processing instructions are unsupported.'));parser.on('error',()=>bad('Malformed worksheet XML.'));parser.on('xmldecl',decl=>{if(decl.encoding&&!/^utf-8$/i.test(decl.encoding))bad('Use UTF-8 worksheet XML.');});
 parser.on('opentag',tag=>{if(stack.length>=40||Object.keys(tag.attributes).length>50)bad('Worksheet structure exceeds limits.');if(!rootSeen){rootSeen=true;if(tag.local!=='worksheet'||tag.uri!==namespace)bad('Invalid worksheet namespace.');}rejectMixedNamespace(tag.uri,book.family);if(tag.uri===namespace&&tag.local==='mergeCells')bad('Unmerge selected cells before importing.');const node={name:tag.local,uri:tag.uri,attrs:tag.attributes,children:[],text:''};if(rowNode){if(++rowNodes>2000)bad('A worksheet row has excessive XML nodes.');stack.at(-1).children.push(node);}else if(tag.local==='row'&&tag.uri===namespace){if(stack.at(-1)?.name!=='sheetData'||stack.at(-1)?.uri!==namespace)bad('Unexpected worksheet row.');rowNode=node;rowDepth=stack.length;rowNodes=1;}stack.push(node);});
 const text=value=>{if(rowNode){const n=stack.at(-1);n.text+=value;if(Buffer.byteLength(n.text)>LIMITS.cellBytes*2)bad('Worksheet cell text exceeds its limit.');}};parser.on('text',text);parser.on('cdata',text);
 parser.on('closetag',()=>{const node=stack.pop();if(rowNode&&stack.length===rowDepth){const index=Number(H.attr(node,'r')||lastRow+1);if(!Number.isInteger(index)||index<=lastRow||index>LIMITS.rows+(options.hasHeader?1:0))bad('Worksheet coordinates exceed 1 million ordered data rows.');lastRow=index;const values=[],nulls=[];let last=-1,formulas=0;for(const cell of H.children(node,'c',namespace)){const address=H.attr(cell,'r'),match=address&&/^([A-Z]{1,3})([1-9]\d*)$/.exec(address);let column=last+1;if(address){if(!match||Number(match[2])!==index)bad('Cell address does not match its row.');column=[...match[1]].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1;}if(column<=last||column>=LIMITS.columns)bad('Worksheet fields must be ordered within 200 columns.');last=column;const parsed=xlsxCell(cell,book,options);values[column]=parsed.value??'';nulls[column]=parsed.blank;formulas+=parsed.formula?1:0;}if(values.some((v,i)=>!nulls[i])){const row={values,nulls,quoted:values.map(()=>true),line:index,formulas};const bytes=Buffer.byteLength(JSON.stringify(row));if(bytes>LIMITS.rowBytes)bad('A worksheet row exceeds 1 MiB.');queuedBytes+=bytes;queue.push(row);if(queue.length>4096||queuedBytes>2*LIMITS.rowBytes)bad('Worksheet stream chunk has excessive queued rows.');}rowNode=null;}});
 const decoder=new TextDecoder('utf-8',{fatal:true});for await(const buffer of partChunks(book,sheet.path,options,LIMITS.worksheetBytes)){check(options);for(let offset=0;offset<buffer.length;offset+=LIMITS.chunkBytes){let text;try{text=decoder.decode(buffer.subarray(offset,offset+LIMITS.chunkBytes),{stream:true});}catch{bad('Worksheet must use valid UTF-8.');}parser.write(text);const ready=queue;queue=[];queuedBytes=0;for(const row of ready)yield row;}}try{decoder.decode();}catch{bad('Worksheet must use valid UTF-8.');}parser.close();for(const row of queue)yield row;if(!rootSeen)bad('Empty worksheet XML.');}
async function scanSource(input,{onRow,onMetadata,onStart,cancellation}={}){const options={hasHeader:true,formulaPolicy:'reject',blankPolicy:'empty',...input,cancellation},opened=await openSource(options.file);let book;
 try{const format=options.format||path.extname(options.file).slice(1).toLowerCase();if(!['csv','tsv','xlsx'].includes(format))throw fail('Choose CSV, TSV or ordinary XLSX.');if(!['reject','cached'].includes(options.formulaPolicy)||!['empty','null'].includes(options.blankPolicy))throw fail('Choose explicit formula and blank policies.');const hashBefore=await fileHash(opened.handle,{cancellation});await onStart?.({fileIdentity:opened.identity,fileHash:hashBefore});let rows;if(format==='xlsx'){book=await xlsxBook(opened.handle,options);if(!options.sheetId){return{format,fileIdentity:opened.identity,fileHash:hashBefore,xlsxVariant:book.family.variant,sheets:book.sheets.map(({id,name,state})=>({id,name,state})),needsSheet:true};}rows=xlsxRows(book,options);}else rows=csvRows(opened.handle,{...options,delimiter:format==='tsv'?'\t':options.delimiter||','});
 let headers=null,width=null,count=0,preview=[],formulaCount=0;const digest=crypto.createHash('sha256');for await(const source of rows){check(options);if(width===null){width=source.values.length;if(!width||width>LIMITS.columns)throw fail('The source requires 1 to 200 fields.');if(options.hasHeader){headers=Array.from({length:width},(_,i)=>source.values[i]??'');if(headers.some(v=>!v)||new Set(headers).size!==headers.length)throw fail('Headers must be nonempty and unique.');onMetadata?.({headers,width});continue;}onMetadata?.({headers:null,width});}if(source.values.length>width||format!=='xlsx'&&source.values.length!==width)throw fail('Every source row must match the selected field count.');const values=Array.from({length:width},(_,i)=>source.values[i]??''),nulls=Array.from({length:width},(_,i)=>format==='xlsx'?options.blankPolicy==='null'&&(source.nulls[i]??true):options.nullToken!==undefined&&values[i]===options.nullToken&&!source.quoted[i]);const row={values,nulls,quoted:source.quoted,line:source.line};if(++count>LIMITS.rows)throw fail('Import at most 1 million data rows.');formulaCount+=source.formulas||0;digest.update(JSON.stringify([values,nulls])+'\n');if(preview.length<10)preview.push(values.map((v,i)=>nulls[i]?null:v.slice(0,160)));await onRow?.(row,count);}
 if(!count)throw fail('The selected source has no data rows.');const after=identity(await opened.handle.stat());if(JSON.stringify(after)!==JSON.stringify(opened.identity))throw fail('The source file changed during scanning.');const hashAfter=await fileHash(opened.handle,{cancellation});if(hashAfter!==hashBefore)throw fail('The source bytes changed during scanning.');return{format,fileIdentity:opened.identity,fileHash:hashAfter,dataHash:digest.digest('hex'),headers,width,rowCount:count,preview,formulaCount,sheets:book?.sheets.map(({id,name,state})=>({id,name,state})),dateSystem:book?(book.date1904?'1904':'1900'):undefined,...(book&&{xlsxVariant:book.family.variant})};
 }finally{book?.zip.close();await opened.handle.close();}}
module.exports={LIMITS,scanSource,csvRows,openSource,fileHash,identity};
