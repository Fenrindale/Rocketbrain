'use strict';

const { tokenize } = require('./sql-policy');
const { statementRanges } = require('./sql-analysis');

const statementHeads=new Set(['SELECT','WITH','INSERT','UPDATE','DELETE','REPLACE','EXPLAIN','SHOW','DESCRIBE','CREATE','ALTER','DROP']);
const clauseWords=new Set(['FROM','WHERE','HAVING','LIMIT','OFFSET','UNION','INTERSECT','EXCEPT','VALUES','RETURNING','ON']);
const pairWords=new Map([['GROUP','BY'],['ORDER','BY']]);
const joinPrefixes=new Set(['LEFT','RIGHT','INNER','OUTER','NATURAL','CROSS','FULL']);
const operatorWord=token=>token?.kind==='word'?token.upper:'';
const signature=tokens=>tokens.map(token=>[token.kind,token.value]);

function formatStatement(source,options) {
  if (!source.trim()) return source;
  let tokens;
  try { tokens=tokenize(source,false,options); }
  catch (error) { throw Error('This SQL statement is outside the reviewed formatting grammar.',{cause:error}); }
  if (!tokens.length) return source;
  const command=operatorWord(tokens[0]);
  if (!statementHeads.has(command)) throw Error('Select a query, data statement or ordinary table definition.');
  if (['CREATE','ALTER','DROP'].includes(command)&&
      tokens.some(token=>['PROCEDURE','FUNCTION','TRIGGER','EVENT','PACKAGE','DELIMITER'].includes(operatorWord(token)))) {
    throw Error('Format table and view DDL separately from stored program bodies.');
  }
  const changes=[];
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
        const wrapsProjection=level===0&&projection&&previous.kind==='symbol'&&previous.value===',';
        const newGap=startsClause?eol+(word==='ON'?indent:''):
          wrapsProjection?eol+indent:
          gap.includes('\n')&&level>0?eol+indent.repeat(Math.min(level,16)):
          ' ';
        if (newGap!==gap) changes.push({start:previous.end,end:token.start,text:newGap});
      }
    }
    if (level===0&&operatorWord(token)==='SELECT') projection=true;
    if (level===0&&['FROM','INTO','UNION','INTERSECT','EXCEPT'].includes(operatorWord(token))) projection=false;
    lastJoinPrefix=joinPrefixes.has(operatorWord(token));
    if (token.kind==='symbol'&&token.value==='(') level++;
  }
  if (level!==0) throw Error('Close the SQL parentheses before formatting.');
  let formatted=source;
  for (const {start,end,text} of changes.reverse()) formatted=formatted.slice(0,start)+text+formatted.slice(end);
  if (JSON.stringify(signature(tokenize(formatted,false,options)))!==JSON.stringify(signature(tokens))) {
    throw Error('Formatting would change SQL tokens.');
  }
  return formatted;
}

function formatSql(text,options={}) {
  if (typeof text!=='string'||Buffer.byteLength(text)>128*1024||text.includes('\0')) throw Error('Format at most 128 KiB of SQL.');
  if (/^\s*DELIMITER\b/im.test(text)) throw Error('Format ordinary SQL separately from DELIMITER scripts.');
  if (options.indent!==undefined&&!/^(?: {1,8}|\t)$/.test(options.indent)) throw Error('Use an indentation width of one to eight spaces or one tab.');
  const eol=text.includes('\r\n')?'\r\n':'\n';
  const ranges=statementRanges(text,options);
  if (ranges.unknown.length||ranges.statements.length>100) throw Error('Format at most 100 SQL statements with known lexical structure.');
  let output=text;
  for (const part of [...ranges.statements].reverse()) {
    const formatted=formatStatement(text.slice(part.start,part.end),{...options,eol});
    output=output.slice(0,part.start)+formatted+output.slice(part.end);
  }
  return output;
}

module.exports={formatSql};
