'use strict';

const {literalValue} = require('./sql-json-expressions');
const bitOperators = new Set(['|','&','^','<<','>>','~']);
const booleanOperators = new Set(['OR','XOR','AND','&&','=','!=','<>','<','<=','>','>=','<=>']);
const priority = new Map([
  ['OR',0],['XOR',1],['AND',2],['&&',2],
  ['=',3],['!=',3],['<>',3],['<',3],['<=',3],['>',3],['>=',3],['<=>',3],
  ['|',4],['&',5],['<<',6],['>>',6],['+',7],['-',7],['*',8],['/',8],['%',8],['DIV',8],['MOD',8],
  ['^',9],['~',10]
]);
const unsafeRoot = new Set(['CASE','WHEN','THEN','ELSE','END','BETWEEN','LIKE','NOT','IS','IN','REGEXP','RLIKE',
  'EXISTS','COLLATE','AS','ESCAPE','OVER','INTERVAL','||',':=','!','->','->>']);
const numeric = new Set(['integer','decimal','floating']);
const asciiNumbers = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
const asciiInteger = /^[+-]?\d+$/u;
const bitType = type=>/^bit(?:\(|$)/i.test(type?.dbType||'');

function rootOperator(tokens,a,b,top) {
  if (b-a>512) return null;
  let root, bits=false, count=0, rejected=false;
  top(a,b,(token,index)=>{
    if (!['word','symbol'].includes(token.kind)) return undefined;
    const operator=token.upper||token.value, previous=tokens[index-1];
    if (unsafeRoot.has(operator)) {rejected=true;return true;}
    if (!priority.has(operator)) return undefined;
    const prefix=index===a||['word','symbol'].includes(previous?.kind)&&priority.has(previous.upper||previous.value);
    if (++count>64 || index>=b-1 || prefix&&!['~','+','-'].includes(operator) || !prefix&&operator==='~') {
      rejected=true;return true;
    }
    if (bitOperators.has(operator)) bits=true;
    if (prefix && operator!=='~' || prefix && index!==a) return undefined;
    const rank=priority.get(operator);
    if (!root || rank<=root.rank) root={operator,index,rank,prefix};
    return undefined;
  });
  return bits&&!rejected ? root : null;
}

function literalBits(raw) {
  const value = /^(?:[xX]'([\da-fA-F]*)'|0x([\da-fA-F]+)|[bB]'([01]*)'|0b([01]+))$/u.exec(raw);
  if (!value || (value[1]?.length??0)%2!==0) return null;
  const [,hex,hexNumber,bits,bitsNumber]=value;
  if (hex!==undefined||hexNumber!==undefined) {
    const digits=hex??hexNumber, octets=Math.ceil(digits.length/2);
    return {kind:hex!==undefined?'quoted-hex':'hex-number',octets,digits,wide:digits.replace(/^0+/u,'').length>16};
  }
  const digits=bits??bitsNumber, octets=Math.ceil(digits.length/8);
  return {kind:'bit-literal',octets,digits,wide:digits.replace(/^0+/u,'').length>64};
}

function binaryBytes(literal) {
  if (literal.kind==='bit-literal') {
    const padded=literal.digits.padStart(literal.octets*8,'0');
    const bytes=Buffer.alloc(literal.octets);
    for(let index=0;index<bytes.length;index++) bytes[index]=parseInt(padded.slice(index*8,index*8+8),2);
    return bytes;
  }
  const digits=literal.digits;
  return Buffer.from(digits.length%2 ? '0'+digits : digits,'hex');
}

function operand(a,b,settings) {
  const {tokens,source,sqlMode,span,read,top,physicalColumn,outerJoined}=settings;
  while (tokens[a]?.value==='('&&tokens[a].close===b-1) {a++;b--;}
  const at=span(a,b), first=tokens[a], second=tokens[a+1];
  const introducer=first?.upper==='_BINARY'||first?.upper==='BINARY';
  const begin=introducer?a+1:a;
  const raw=source.slice(tokens[begin]?.start??at.start,at.end);
  const literal=raw.length<=16384 ? literalBits(raw) : null;
  if (literal) {
    return {at,type:{family:'binary',nullable:false},literal,byteLength:literal.octets,contextual:!introducer,
      ...(introducer&&{numericText:binaryBytes(literal).toString('latin1')})};
  }
  if (b===begin+1 && tokens[begin]?.kind==='string') {
    const decoded=literalValue(source,tokens[begin],sqlMode);
    return {at,type:{family:introducer?'binary':'string',nullable:false},numericText:decoded,
      ...(introducer&&decoded!==undefined&&/^[\x00-\x7f]*$/u.test(decoded)&&{byteLength:decoded.length})};
  }
  if (b===a+1 && first?.upper==='NULL') return {at,type:{family:'null',nullable:true},knownNull:true};
  if (first?.upper==='CAST' && second?.value==='(' && second.close===b-1) {
    const as=top(a+2,b-1,(token,index)=>token.upper==='AS' ? index : undefined);
    if (as!==undefined && tokens[as+1]?.upper==='BINARY') {
      const size=tokens[as+3], exact=tokens[as+2]?.value==='('&&tokens[as+2].close===b-2&&
        b-2===as+4&&size?.kind==='number'&&/^\d{1,5}$/u.test(size.value)&&Number(size.value)<=65535;
      const {type,knownNull}=operand(a+2,as,settings);
      return {at,type:{family:'binary',nullable:knownNull||type.family==='null'||type.nullable!==false},
        ...((knownNull||type.family==='null')&&{knownNull:true}),...(exact&&{byteLength:Number(size.value)})};
    }
  }
  const type=read(a,b);
  const direct=[1,3,5].includes(b-a) && tokens.slice(a,b).every((part,index)=>index%2===0 ?
    ['word','identifier'].includes(part.kind) : part.value==='.');
  const fixed=direct && physicalColumn(tokens[b-1].start) ? /^binary\((\d{1,5})\)$/i.exec(type.dbType||'') : null;
  const root=rootOperator(tokens,a,b,top);
  const width=bitOperators.has(root?.operator) ? type.byteLength : undefined;
  return {at,type:fixed&&outerJoined?{...type,nullable:true}:type,byteLength:width??(fixed?Number(fixed[1]):undefined)};
}

function binaryCandidate(value) {return value.type.family==='binary'&&!bitType(value.type);}
function concreteBinary(value) {return binaryCandidate(value)&&!value.contextual;}
function numericCoercion(value,{dialect,issue,unknown},integerOnly=false) {
  if (value.knownNull || bitType(value.type)) return;
  const decimal=dialect==='mariadb'&&!integerOnly;
  let sample=value.numericText;
  if (value.literal && value.contextual) {
    if (dialect==='mysql' && value.literal.wide) {
      issue('sql.bitwise.coercion','This literal exceeds the unsigned 64-bit bitwise operand width.',value.at,'warning');
      return;
    }
    if (dialect==='mariadb' && value.literal.kind==='quoted-hex') sample=binaryBytes(value.literal).toString('latin1');
    else return;
  }
  if (sample!==undefined) {
    // This matches observed scalar-expression conversion. MariaDB decimal conversion
    // can diagnose trailing text that MySQL's integer parser accepts as whitespace.
    const trimmed=decimal ? sample.replace(/^[ \t\r\n\f\v]+/u,'') : sample.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/gu,'');
    if (!(decimal?asciiNumbers:asciiInteger).test(trimmed)) {
      issue('sql.bitwise.coercion','Bitwise numeric conversion can discard part or all of this literal.',value.at,'warning');
    }
  } else if (['binary','string','json','unknown'].includes(value.type.family)) {
    unknown('The bitwise numeric conversion depends on the operand value or its runtime type.',value.at.start);
  }
}

function evaluate(operator, at, left, right, settings) {
  const {dialect,issue,unknown}=settings, operands=right?[left,right]:[left];
  const nullable=operands.some(value=>value.type.nullable!==false);
  const shifting=operator==='<<'||operator==='>>';
  const lengthSensitive=right&&!shifting;
  const maybeBinary=dialect==='mysql'&&(
    concreteBinary(left) && (!lengthSensitive||binaryCandidate(right)||right.knownNull) ||
    lengthSensitive && concreteBinary(right) && (binaryCandidate(left)||left.knownNull)
  );
  const uncertainMode=dialect==='mysql'&&(
    left.type.family==='unknown' && (!lengthSensitive||binaryCandidate(right)||right.knownNull) ||
    lengthSensitive && right.type.family==='unknown' && (binaryCandidate(left)||left.knownNull)
  );
  if (uncertainMode) {
    unknown('The MySQL bitwise result depends on numeric or binary-string operand types.',at.start);
    return {family:'unknown',nullable};
  }
  if (maybeBinary) {
    if (shifting) numericCoercion(right,settings,true);
    const widths=operands.map(value=>value.byteLength);
    if (lengthSensitive && !operands.some(value=>value.knownNull)) {
      if (widths.every(Number.isInteger) && widths[0]!==widths[1]) {
        issue('sql.bitwise.binaryLength',nullable?'Non-NULL binary bitwise operands have unequal fixed byte lengths.':
          'Binary bitwise operands must have equal byte lengths.',at,nullable?'warning':'error');
      } else if (!widths.every(Number.isInteger)) unknown('The byte lengths of the binary bitwise operands depend on runtime values.',at.start);
    }
    const sameWidth=!lengthSensitive||widths.some(value=>!Number.isInteger(value))||widths[0]===widths[1];
    const byteLength=sameWidth ? left.byteLength??(lengthSensitive ? right.byteLength : undefined) : undefined;
    return {family:'binary',nullable,...(Number.isInteger(byteLength)&&{byteLength})};
  }
  if (operands.every(value=>!value.knownNull)) {
    numericCoercion(left,settings);
    if (right) numericCoercion(right,settings,shifting);
  }
  return {family:'integer',nullable,unsigned:true,bitLength:64};
}

function bitwiseExpression(a,b,settings) {
  const {tokens,top,span}=settings, root=rootOperator(tokens,a,b,top);
  if (!root) return null;
  const at=tokens[root.index], left=operand(root.prefix?root.index+1:a,root.prefix?b:root.index,settings);
  const right=root.prefix?null:operand(root.index+1,b,settings);
  if (bitOperators.has(root.operator)) return evaluate(root.operator,at,left,right,settings);
  if (booleanOperators.has(root.operator)) return {family:'boolean',nullable:root.operator!=='<=>'&&[left,right].some(value=>value.type.nullable!==false)};
  if ([left,right].every(value=>numeric.has(value.type.family))) {
    const floating=[left,right].some(value=>value.type.family==='floating');
    const decimal=root.operator==='/'||[left,right].some(value=>value.type.family==='decimal');
    return {family:floating?'floating':decimal?'decimal':'integer',nullable:[left,right].some(value=>value.type.nullable!==false)};
  }
  settings.unknown('Arithmetic around a bitwise result may use server coercion.',span(a,b).start);
  return {family:'unknown'};
}

function bitCount(a,b,settings) {
  const value=operand(a,b,settings);
  const {dialect,unknown}=settings;
  if (dialect==='mysql' && value.type.family==='unknown') {
    unknown('BIT_COUNT may count numeric bits or binary bytes depending on the operand type.',value.at.start);
  } else if (dialect==='mariadb' || !concreteBinary(value)) numericCoercion(value,settings);
  return {family:'integer',nullable:value.type.nullable!==false,unsigned:true};
}

module.exports={bitwiseExpression,bitCount};
