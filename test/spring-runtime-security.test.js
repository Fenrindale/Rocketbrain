'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {once}=require('node:events');
const {ActuatorClient}=require('../src/spring/runtime-client');
const {auditRequest,normalizeSecurityEvents}=require('../src/spring/runtime-security');
const {renderSecurity}=require('../src/spring/runtime-security-vscode');

test('audit requests encode filters and keep a bounded list of published outcomes',()=>{
  const now=Date.parse('2026-11-25T08:00:00Z');
  const filter=auditRequest({minutes:5,principal:'오퍼레이터&other=true',type:'AUTHORIZATION_FAILURE'},now);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(filter.suffix)),{after:'2026-11-25T07:55:00.000Z',
    principal:'오퍼레이터&other=true',type:'AUTHORIZATION_FAILURE'});
  assert.equal(filter.selection.filteredPrincipal,true);
  assert.throws(()=>auditRequest({minutes:700}),/5, 15 or 60/);
  assert.throws(()=>auditRequest({principal:'hi\nthere'}),/control/);
  assert.throws(()=>auditRequest({type:'arbitrary'}),/supported/);
  const events=Array.from({length:210},(_,i)=>({timestamp:new Date(now+i).toISOString(),type:'AUTHENTICATION_FAILURE',
    principal:'fixture-user',data:{authorization:'private',ipAddress:'127.0.0.1'}}));
  events.push({timestamp:new Date(now).toISOString(),principal:'unknown',type:'BUSINESS_EVENT'},{timestamp:'not a time',type:'AUTHORIZATION_SUCCESS'});
  const result=normalizeSecurityEvents({events});
  assert.deepEqual({matched:result.matched,returned:result.returned,truncated:result.truncated,length:result.events.length},
    {matched:210,returned:212,truncated:true,length:200});
  assert.equal(result.events[0].timestamp,new Date(now+209).toISOString());
  assert.equal(Object.hasOwn(result.events[0],'data'),false);
});

test('Spring Security HTTP observations remain separate and do not retain credential or raw audit details',async t=>{
  const secret='fixture-private-token',authorization='Bearer '+secret;
  const received=[];
  let endpointCode=200;
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    received.push({path:url.pathname,auth:req.headers.authorization,method:req.method,query:url.searchParams});
    let data;
    if (url.pathname==='/actuator/beans') data={contexts:{app:{beans:{chain:{type:'org.springframework.security.web.DefaultSecurityFilterChain'},
      springSecurityFilterChain:{type:'jakarta.servlet.Filter'},other:{type:'fixture.SomeBean'}}}}};
    else if (url.pathname==='/actuator/auditevents') {
      if (endpointCode!==200) {res.writeHead(endpointCode,{Location:'http://127.0.0.1:'+server.address().port+'/logged'}).end();return;}
      data={events:[{timestamp:'2026-11-25T08:00:00.123456Z',type:'AUTHORIZATION_FAILURE',principal:'<Fixture '+secret+'>',
        data:{password:'raw-audit-secret',detail:'session-specific'}}]};
    } else if (url.pathname==='/actuator/conditions') data={contexts:{app:{positiveMatches:{'org.springframework.boot.security.auto.Fixture':
      [{condition:'MatchingCondition',message:'condition-private'}]},negativeMatches:{}}}};
    else {res.writeHead(404).end();return;}
    res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(data));
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const client=new ActuatorClient({url:'http://127.0.0.1:'+server.address().port+'/actuator',authorization});
  t.after(()=>client.dispose());
  const filters={minutes:60,principal:'Fixture&time',type:'AUTHORIZATION_FAILURE'};
  const observed=await client.security(filters);
  assert.equal(observed.state,'observed');
  assert.deepEqual(observed.beans.map(({kind})=>kind),['filter-chain','framework-registration']);
  assert.equal(observed.conditions.length,1);
  assert.deepEqual(observed.audit.events[0],{timestamp:'2026-11-25T08:00:00.123456Z',type:'AUTHORIZATION_FAILURE',
    principal:'<Fixture [REDACTED]>',outcome:'Authorization denied'});
  const query=received.find(item=>item.path.endsWith('auditevents')).query;
  assert.equal(query.get('principal'),filters.principal);
  assert.equal(query.get('type'),filters.type);
  assert.deepEqual([...new Set(received.map(item=>item.method))],['GET']);
  assert.ok(received.every(item=>item.auth===authorization));
  const output=JSON.stringify(observed);
  for (const privateText of [secret,'session-specific','raw-audit-secret','condition-private',filters.principal]) {
    assert.equal(output.includes(privateText),false);
  }
  const html=renderSecurity({state:'observed',report:observed},'fixtureNonce',3);
  assert.match(html,/Authorization denied/);
  assert.match(html,/&lt;Fixture \[REDACTED\]&gt;/);
  assert.equal(html.includes('<Fixture'),false);
  endpointCode=403;
  const rejected=await client.security();
  assert.equal(rejected.state,'partial');
  assert.deepEqual(rejected.endpoints.auditevents,{state:'unavailable',code:'AUTH_REQUIRED',status:403});
  assert.equal(rejected.audit,null);
  endpointCode=302;
  assert.equal((await client.security()).endpoints.auditevents.code,'REDIRECT_BLOCKED');
  assert.equal(received.some(req=>req.path==='/logged'),false);
});
