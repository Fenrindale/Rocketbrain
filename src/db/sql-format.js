'use strict';

const { tokenize } = require('./sql-policy');
const { formatProgram, splitFormatScript, keywordText } = require('./sql-format-script');

const statementHeads=new Set(['SELECT','WITH','INSERT','UPDATE','DELETE','REPLACE','EXPLAIN','SHOW','DESCRIBE','CREATE','ALTER','DROP','CALL','SET','TRUNCATE','USE']);
const clauseWords=new Set(['FROM','WHERE','HAVING','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','VALUES','RETURNING','ON']);
const casedClauses=new Set(['FROM','WHERE','HAVING','LIMIT','UNION','JOIN','ON']);
const pairWords=new Map([['GROUP','BY'],['ORDER','BY']]);
const joinPrefixes=new Set(['LEFT','RIGHT','INNER','OUTER','NATURAL','CROSS','FULL']);
const operatorWord=token=>token?.kind==='word'?token.upper:'';
const signature=(tokens,keywords,style)=>tokens.map((token,index)=>[token.kind,keywords?.has(index)?keywordText(token.value,style):token.value]);

function formatStatement(source,options) {
  if (!source.trim()) return source;
  let tokens;
  try { tokens=tokenize(source,false,options); }
  catch (error) { throw Error('This SQL statement is outside the reviewed formatting grammar.',{cause:error}); }
  if (!tokens.length) return source;
  const command=operatorWord(tokens[0]);
  if (!statementHeads.has(command)) throw Error('Select a query, data statement or ordinary table definition.');
  const changes=[], keywords=new Set([0]);
  let level=0, projection=false;
  let lastJoinPrefix=false;
  const indent=options.indent || '  ', eol=options.eol||'\n';
  for (const [index,token] of tokens.entries()) {
    const previous=tokens[index-1], next=tokens[index+1];
    if (token.kind==='symbol'&&token.value===')') level--;
    if (level<0) throw Error('Close the SQL parentheses before formatting.');
    if (index>0) {
      const gap=source.slice(previous.end,token.start);
      // Comments, compound token adjacency and quote spelling stay at their original offsets.
      if (/^[ \t\r\n]+$/.test(gap)) {
        const word=operatorWord(token), prior=operatorWord(previous), following=operatorWord(next);
        const compoundJoin=word==='JOIN'&&lastJoinPrefix;
        const join=joinPrefixes.has(word)&&tokens.slice(index,index+4).some(item=>operatorWord(item)==='JOIN');
        const startsClause=level===0&&(clauseWords.has(word)||word==='JOIN'&&!compoundJoin||
          pairWords.get(word)===following||word==='SET'&&command==='UPDATE'||join&&!lastJoinPrefix);
        if (startsClause) {
          if (casedClauses.has(word)||word==='SET'&&command==='UPDATE') keywords.add(index);
          if (pairWords.get(word)===following) { keywords.add(index); keywords.add(index+1); }
        }
        const wrapsProjection=level===0&&projection&&previous.kind==='symbol'&&previous.value===',';
        const newGap=options.style==='compact'?' ':startsClause?eol+(word==='ON'?indent:''):
          wrapsProjection?eol+indent:
          gap.includes('\n')&&level>0?eol+indent.repeat(Math.min(level,16)):
          ' ';
        if (newGap!==gap) changes.push({start:previous.end,end:token.start,text:newGap});
      }
    }
    if (keywords.has(index)) {
      const replacement=keywordText(token.value,options.keywordCase);
      if (replacement!==token.value) changes.push({start:token.start,end:token.end,text:replacement});
    }
    if (level===0&&operatorWord(token)==='SELECT') projection=true;
    if (level===0&&['FROM','INTO','UNION','INTERSECT','EXCEPT'].includes(operatorWord(token))) projection=false;
    lastJoinPrefix=joinPrefixes.has(operatorWord(token));
    if (token.kind==='symbol'&&token.value==='(') level++;
  }
  if (level!==0) throw Error('Close the SQL parentheses before formatting.');
  let formatted=source;
  for (const {start,end,text} of changes.reverse()) formatted=formatted.slice(0,start)+text+formatted.slice(end);
  if (JSON.stringify(signature(tokenize(formatted,false,options)))!==JSON.stringify(signature(tokens,keywords,options.keywordCase))) {
    throw Error('Formatting would change SQL tokens.');
  }
  return formatted;
}

function formatSql(text,options={}) {
  if (typeof text!=='string'||Buffer.byteLength(text)>128*1024||text.includes('\0')) throw Error('Format at most 128 KiB of SQL.');
  if (options.indent!==undefined&&!/^(?: {1,8}|\t)$/.test(options.indent)) throw Error('Use an indentation width of one to eight spaces or one tab.');
  if (options.style!==undefined&&!['expanded','compact'].includes(options.style)) throw Error('Use expanded or compact SQL layout.');
  if (options.keywordCase!==undefined&&!['preserve','upper','lower'].includes(options.keywordCase)) throw Error('Use preserve, upper or lower SQL keyword case.');
  if (/\r(?!\n)/.test(text)) throw Error('Use LF or CRLF SQL line endings.');
  const dialect=options.dialect||'mysql';
  if (!['mysql','mariadb'].includes(dialect)||options.sqlMode?.some(mode=>['ORACLE','MSSQL','POSTGRESQL','DB2','MAXDB'].includes(mode))) {
    throw Error('Use a MySQL or MariaDB formatting dialect.');
  }
  const settings={...options,dialect,keywordCase:options.keywordCase||'preserve',indent:options.indent||'  ',eol:text.includes('\r\n')?'\r\n':'\n'};
  const input=splitFormatScript(text,settings), pieces=[];
  let offset=0;
  for (const {start,end} of input.statements) {
    const source=text.slice(start,end);
    pieces.push(text.slice(offset,start),formatProgram(source,settings)??formatStatement(source,settings));
    offset=end;
  }
  pieces.push(text.slice(offset));
  const output=pieces.join('');
  const after=splitFormatScript(output,settings);
  const boundaries=script=>[script.directives,script.statements.map(({delimiter,terminated})=>[delimiter,terminated])];
  if (JSON.stringify(boundaries(input))!==JSON.stringify(boundaries(after))) throw Error('Formatting would change SQL statement boundaries.');
  return output;
}

module.exports={formatSql};
