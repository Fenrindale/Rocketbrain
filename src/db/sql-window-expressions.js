'use strict';

const orderRank = new Map([['UNBOUNDED PRECEDING',0],['PRECEDING',1],['CURRENT ROW',2],['FOLLOWING',3],['UNBOUNDED FOLLOWING',4]]);
const numeric = new Set(['integer','decimal','floating']);
const unprovedOrder = new Set(['unknown','null','binary','json','boolean']);
const aggregate = new Set(['COUNT','SUM','AVG','MIN','MAX']);
const frameUnits = new Set(['ROWS','RANGE','GROUPS']);
const windowParts = new Set(['PARTITION','ORDER',...frameUnits]);
const fixed = {
  ROW_NUMBER:[0,0,'integer'], RANK:[0,0,'integer'], DENSE_RANK:[0,0,'integer'],
  CUME_DIST:[0,0,'floating'], PERCENT_RANK:[0,0,'floating'], NTILE:[1,1,'integer'],
  FIRST_VALUE:[1,1,'argument'], LAST_VALUE:[1,1,'argument'], NTH_VALUE:[2,2,'argument'],
  LAG:[1,3,'argument'], LEAD:[1,3,'argument']
};
const windowOnly = name=>Object.hasOwn(fixed,name);
const isAggregate = name=>aggregate.has(name);
const intervalUnits = new Set(['YEAR','QUARTER','MONTH','WEEK','DAY','HOUR','MINUTE','SECOND','MICROSECOND']);
const orderSensitive = new Set(['RANK','DENSE_RANK','CUME_DIST','PERCENT_RANK','LAG','LEAD']);
const noMariaFrame = new Set(['ROW_NUMBER','RANK']);

function numberLiteral(tokens,a,b) {
  const first=tokens[a], second=tokens[a+1];
  if (first?.kind==='number' && b===a+1) return first.value;
  if ((first?.value==='-' || first?.value==='+') && second?.kind==='number' && b===a+2) return first.value+second.value;
  return undefined;
}

function windowReturn(name, location, args, {dialect, tokens, issue, unknown}) {
  const [min,max,family] = fixed[name];
  const offsetFunction = name==='LAG'||name==='LEAD';
  const maximum = dialect==='mariadb'&&offsetFunction ? 2 : max;
  if (args.some(arg=>arg.empty) || args.length<min || args.length>maximum) {
    issue('sql.window.arity',name + ' expects ' + (min===maximum ? min : min + ' to ' + maximum) + ' argument(s).',location);
    return {family:'unknown'};
  }
  const count = args[name==='NTILE' ? 0 : 1];
  const positive = name==='NTILE'||name==='NTH_VALUE'&&dialect==='mysql';
  if (count && (positive || offsetFunction && dialect==='mysql')) {
    const literal = numberLiteral(tokens,count.start,count.end);
    if (literal!==undefined && (/^-\d/u.test(literal) || positive && /^[-+]?0+$/u.test(literal))) {
      issue('sql.window.argument',name + ' expects ' + (positive ? 'a positive' : 'a nonnegative') + ' row offset here.',{start:tokens[count.start].start,end:tokens[count.end-1].end});
    }
  }
  if (family!=='argument') return {family,nullable:false};
  const type=args[0]?.type || {family:'unknown'}, fallback=args[2]?.type;
  if (fallback && !['null',type.family].includes(fallback.family)) {
    unknown(name + ' default value may change its result type through server coercion.',location.start);
    return {family:'unknown'};
  }
  return {...type,nullable:true};
}

function createWindowAnalysis({tokens, top, split, id, span, expression, dialect, issue, unknown, reference, supported}) {
  const states = new WeakMap();
  const problem = (message,token)=>unknown(message,token?.start);
  const remember = (token,scope,entry,definition=false)=>{
    reference(token,definition?'window-definition':'window',token.value,{family:'unknown'},entry.definition,{scopeId:scope.id});
  };

  function bound(a,b) {
    const first=tokens[a], last=tokens[b-1], tag=last?.upper;
    if (b===a+2 && first.upper==='CURRENT' && tag==='ROW') return {kind:'CURRENT ROW',at:span(a,b)};
    if (!['PRECEDING','FOLLOWING'].includes(tag)) return null;
    if (b===a+2 && first.upper==='UNBOUNDED') return {kind:'UNBOUNDED '+tag,at:span(a,b)};
    if (a===b-1) return null;
    const amount=span(a,b-1);
    if (first.upper==='INTERVAL') {
      const unit=tokens[b-2]?.upper, literal=numberLiteral(tokens,a+1,b-2);
      return {kind:tag,offset:'interval',at:span(a,b),amount,literal,complete:intervalUnits.has(unit)&&literal!==undefined};
    }
    const literal=numberLiteral(tokens,a,b-1);
    return {kind:tag,offset:'number',at:span(a,b),amount,literal,complete:literal!==undefined};
  }

  function frames(a,b,orders,complete) {
    const start=tokens[a], unit=start.upper;
    if (unit==='GROUPS' || top(a+1,b,token=>token.upper==='EXCLUDE'?true:undefined)) {
      problem('GROUPS and EXCLUDE window framing have no verified source contract.',start);
      return false;
    }
    const between=tokens[a+1]?.upper==='BETWEEN';
    const separator=between?top(a+2,b,(token,index)=>token.upper==='AND'?index:undefined):undefined;
    const first=between ? separator!==undefined && bound(a+2,separator) : bound(a+1,b);
    const last=between ? separator!==undefined && bound(separator+1,b) : {kind:'CURRENT ROW',at:start};
    if (!first || !last) {
      problem('The window frame is incomplete or outside the supported boundary syntax.',start);
      return false;
    }
    if (first.kind==='UNBOUNDED FOLLOWING') issue('sql.window.frame.boundary','A frame cannot start with UNBOUNDED FOLLOWING.',first.at);
    else if (last.kind==='UNBOUNDED PRECEDING') issue('sql.window.frame.boundary','A frame cannot end with UNBOUNDED PRECEDING.',last.at);
    else if (orderRank.get(first.kind)>orderRank.get(last.kind)) {
      issue('sql.window.frame.boundary','This frame end precedes its start.',between?last.at:first.at);
    }
    const offsets=[first,last].filter(value=>value.offset);
    for (const value of offsets) {
      if (!value.complete) problem('A computed or compound frame offset requires server validation.',value.amount);
      else if (value.literal.startsWith('-') && Number(value.literal)<0) {
        issue('sql.window.frame.offset','A frame offset must be nonnegative.',value.amount);
      }
      if (unit==='ROWS' && value.complete && (value.offset==='interval' || !/^[+]?\d+$/u.test(value.literal))) {
        issue('sql.window.frame.offset','ROWS offsets must be nonnegative integers.',value.amount);
      }
    }
    if (unit==='RANGE' && offsets.length && complete) {
      if (orders.length!==1) issue('sql.window.frame.orderCount','An offset RANGE frame requires one ORDER BY expression.',start);
      else {
        const type=orders[0].type.family;
        for (const value of offsets) {
          if (value.offset==='interval' && dialect==='mariadb') {
            issue('sql.window.frame.interval','MariaDB does not support temporal INTERVAL offsets in RANGE frames.',value.amount);
          } else if (value.offset==='interval' && type!=='temporal' && !unprovedOrder.has(type)) {
            issue('sql.window.frame.orderType','A RANGE INTERVAL offset requires a temporal ORDER BY expression.',orders[0].at);
          } else if (value.offset==='number' && value.complete && !numeric.has(type) && !unprovedOrder.has(type)) {
            issue('sql.window.frame.orderType','A numeric RANGE offset requires a numeric ORDER BY expression.',orders[0].at);
          } else if (unprovedOrder.has(type)) problem('The RANGE order type is not established by the static catalog.',orders[0].at);
        }
      }
    }
    return offsets.every(value=>value.complete);
  }

  function named(at,scope,owner) {
    const state=states.get(scope), entry=state?.entries.get(at.value.toLowerCase());
    if (entry && dialect==='mariadb' && owner && entry.start>=owner.start) {
      issue('sql.window.name','Reference an earlier WINDOW declaration on MariaDB.',at);
      return null;
    }
    if (entry && entry!==false) {
      remember(at,scope,entry);
      return entry;
    }
    if (entry===false || state?.partial) problem('The named window cannot be bound in this partial declaration list.',at);
    else issue('sql.window.name','Unknown window name '+at.value+' in this SELECT block.',at);
    return null;
  }

  function resolved(entry,scope,depth) {
    if (!entry) return null;
    if (depth>32 || entry.resolving) {
      problem('The named window dependency is cyclic or exceeds the source-analysis depth.',tokens[entry.start]);
      return null;
    }
    if (!entry.spec) {
      entry.resolving=true;
      try { entry.spec=specification(entry.start,entry.end,scope,entry,depth+1); }
      finally { entry.resolving=false; }
    }
    return entry.spec;
  }

  function specification(a,b,scope,owner=null,depth=0) {
    let complete=true, base=null;
    if (a<b && id(tokens[a]) && !windowParts.has(tokens[a].upper)) {
      base=resolved(named(tokens[a],scope,owner),scope,depth);
      if (!base) complete=false;
      a++;
    }
    const parts=[];
    top(a,b,(token,index)=>{if (windowParts.has(token.upper)) parts.push({token,index});});
    if (!complete || a<b && parts[0]?.index!==a) {
      if (complete) problem('A window specification uses unsupported syntax.',tokens[a]);
      return {complete:false,orders:[],frame:null};
    }
    if (base?.frame) {
      problem('Reusing a framed window inside parentheses can have vendor-specific restrictions.',tokens[a-1]);
      return {complete:false,orders:base.orders,frame:base.frame};
    }
    const orders=base?.orders ? [...base.orders] : [];
    complete=base?.complete ?? true;
    let frame=null, phase=-1;
    for (const [index,part] of parts.entries()) {
      const name=part.token.upper, start=part.index, end=parts[index+1]?.index??b;
      const group=name==='PARTITION'?0:name==='ORDER'?1:2;
      if (group<=phase) { complete=false;problem('Window clauses are repeated or out of order.',part.token);break; }
      if (base && (group===0 || group===1 && orders.length)) {
        complete=false;
        problem('Replacing partition or order clauses in an inherited window requires server validation.',part.token);
        continue;
      }
      phase=group;
      if (group===2) {
        frame=part.token;
        complete=frames(start,end,orders,complete)&&complete;
        continue;
      }
      if (tokens[start+1]?.upper!=='BY' || end<=start+2) {
        complete=false;
        problem('An incomplete window '+name+' BY clause could not be bound.',part.token);
        continue;
      }
      for (const [x,y] of split(start+2,end)) {
        const finish=['ASC','DESC'].includes(tokens[y-1]?.upper)?y-1:y;
        if (x>=finish) {complete=false;problem('A window sort or partition expression is incomplete.',tokens[x]);continue;}
        const type=expression(x,finish,scope,{windowClause:'WINDOW'});
        if (group===1) orders.push({type,at:span(x,finish)});
      }
    }
    return {complete,orders,frame};
  }

  function declare(a,b,scope) {
    const entries=new Map(), state={entries,partial:false};
    states.set(scope,state);
    const declarations=split(a,b);
    if (declarations.length>64) { state.partial=true;problem('Window declaration limit reached.',tokens[a]);return; }
    for (const [start,end] of declarations) {
      const name=tokens[start], body=tokens[start+2];
      if (!id(name) || tokens[start+1]?.upper!=='AS' || body?.value!=='(' || body.close!==end-1) {
        state.partial=true;
        problem('The named WINDOW declaration is incomplete.',name);
        continue;
      }
      const key=name.value.toLowerCase();
      if (entries.has(key)) {
        issue('sql.window.name.duplicate','A window with this name already exists in this SELECT block.',name);
        entries.set(key,false);
      } else {
        const entry={start:start+3,end:body.close,definition:span(start,start+1)};
        entries.set(key,entry);
        remember(name,scope,entry,true);
      }
    }
    for (const entry of entries.values()) if (entry) resolved(entry,scope,0);
    supported.add('named-window-declarations');
  }

  function apply(name,a,b,scope,context) {
    const over=tokens[a], next=tokens[a+1], placement=context.windowClause;
    if (placement && placement!=='ORDER') issue('sql.window.location','Window functions are available in SELECT and ORDER BY expressions.',over);
    if (!windowOnly(name) && !isAggregate(name)) problem('No verified window function contract for '+name+'.',over);
    if (!next || a+1>=b) { problem('Missing window specification after OVER.',over);return a; }
    let match,end;
    if (next.value==='(' && next.close<b) {
      match=specification(a+2,next.close,scope);
      end=next.close;
    } else if (id(next)) {
      match=resolved(named(next,scope),scope,0);
      end=a+1;
    } else { problem('Incomplete window specification after OVER.',over);return a; }
    if (dialect==='mariadb' && match?.complete && orderSensitive.has(name) && !match.orders.length) {
      issue('sql.window.order.required',name+' requires ORDER BY on MariaDB.',over);
    }
    if (dialect==='mariadb' && match?.frame && noMariaFrame.has(name)) {
      issue('sql.window.frame.function',name+' does not allow an explicit frame on MariaDB.',match.frame);
    }
    supported.add('window-expression');
    return end;
  }
  return {declare,apply};
}

module.exports={createWindowAnalysis,windowReturn,windowOnly,isAggregate};
