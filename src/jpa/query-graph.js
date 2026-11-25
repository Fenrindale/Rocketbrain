'use strict';

const SET_WORDS = new Set(['union','intersect','except']);
const COLLISIONS = new Set(['with','select','from','where','join','on','as','order','group','having','union','intersect','except','recursive','all','distinct']);

function startsGraph(tokens) {
  return tokens.some((token,index) => (token.lower==='with'||SET_WORDS.has(token.lower)) && !['.',':'].includes(tokens[index-1]?.text) ||
    token.text==='(' && ['from','join',','].includes(tokens[index-1]?.lower??tokens[index-1]?.text) &&
      ['select','with','('].includes(tokens[index+1]?.lower ?? tokens[index+1]?.text));
}

function analyzeGraph(tokens,close) {
  const structural = new Set();
  let used = 0, relations = 0, operations = 0;
  const features = new Set();
  const word = at => tokens[at]?.lower;
  const symbol = at => tokens[at]?.text;
  const name = at => tokens[at]?.kind==='id' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(symbol(at)) && !COLLISIONS.has(word(at));
  function need(condition,message) { if (!condition) throw new RangeError(message); }
  function top(start,end) {
    const positions=[];
    for (let at=start;at<end;at++) {
      positions.push(at);
      if (symbol(at)==='(') at=close.get(at);
    }
    return positions;
  }
  function outputs(start,from) {
    const result=[];
    let at=start+(word(start+1)==='distinct'?2:1);
    for (const end of [...top(at,from).filter(index=>symbol(index)===','),from]) {
      const alias=word(end-2)==='as' && name(end-1) && end-2>at ? tokens[end-1] : null;
      result.push(alias);
      at=end+1;
    }
    need(result.length<=16,'HQL query graph projection exceeds the column analysis limit.');
    return result;
  }
  function leaf(start,end,depth) {
    need(start<end,'Empty HQL SELECT arm.');
    if (symbol(start)==='(' && close.get(start)===end-1) {
      const child=graph(start+1,end-1,depth+1);
      return {child,output:child.output};
    }
    need(word(start)==='select','A graph arm must start with an explicit SELECT.');
    const layout=top(start,end);
    const from=layout.find(at=>word(at)==='from' && symbol(at-1)!=='.');
    need(from>start+1,'HQL query graph arm lacks an explicit projection or FROM.');
    const derived=new Map();
    let inFrom=false;
    for (const at of layout) {
      if (at===from) inFrom=true;
      if (['where','group','having','order'].includes(word(at)) && symbol(at-1)!=='.') inFrom=false;
      const previous=word(at-1)??symbol(at-1);
      if (!inFrom || symbol(at)!=='(' || !['from','join',','].includes(previous) || !['select','with','('].includes(word(at+1)??symbol(at+1))) continue;
      const last=close.get(at), aliasAt=last+(word(last+1)==='as'?2:1);
      need(name(aliasAt) && ++relations<=12,'A derived relation requires a literal identification variable.');
      features.add('hql-derived-relation');
      const body=graph(at+1,last,depth+1);
      derived.set(at,{body,last,alias:tokens[aliasAt]});
    }
    return {start,end,derived,output:outputs(start,from)};
  }
  function graph(start,end,depth) {
    need(start<end && depth<=8 && ++used<=32,'HQL query graph exceeds the analysis limit.');
    const ctes=[], cteNames=new Set();
    const origin=start;
    if (word(start)==='with') {
      structural.add(start++);
      features.add('hql-common-table-expression');
      for (;;) {
        const alias=tokens[start];
        need(name(start) && !cteNames.has(alias.lower) && word(start+1)==='as' && symbol(start+2)==='(' && ++relations<=12,
          'With clauses require unique literal names and nonrecursive SELECT definitions.');
        cteNames.add(alias.lower);
        const last=close.get(start+2);
        need(last<end,'Unbalanced CTE definition.');
        for (let i=start+3;i<last;i++) {
          need(word(i)!==alias.lower || !['from','join',','].includes(word(i-1)??symbol(i-1)),'Recursive CTE binding is outside this source model.');
        }
        ctes.push({alias,body:graph(start+3,last,depth+1)});
        start=last+1;
        if (symbol(start)!==',') break;
        start++;
      }
    }
    const layout=top(start,end);
    const op=layout.filter(at=>SET_WORDS.has(word(at)) && !['.',':'].includes(symbol(at-1)));
    let order;
    let final=end;
    if (op.length) {
      const at=layout.find(index=>index>op.at(-1) && word(index)==='order'&&word(index+1)==='by');
      if (at!==undefined) { order={start:at+2,end}; final=at; }
      features.add('hql-set-operation');
    }
    const arms=[];
    for (const at of [...op,final]) {
      arms.push(leaf(start,at,depth));
      if (at===final) break;
      structural.add(at);
      need(++operations<=10,'HQL set-operation branch limit exceeded.');
      start=at+1;
      if (['all','distinct'].includes(word(start))) start++;
    }
    return {origin,end,ctes,arms,order,output:arms[0].output};
  }
  try {
    return {root:graph(0,tokens.length,0),structural,features:[...features]};
  } catch(error) {
    if (!(error instanceof RangeError)) throw error;
    return {reason:error.message};
  }
}

module.exports={analyzeGraph,startsGraph};
