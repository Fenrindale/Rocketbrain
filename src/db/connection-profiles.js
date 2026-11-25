'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {connectionSecurity,bindConnectionResource,identifyConnection,dnsName}=require('./connection-security');
const {openTunnel}=require('./connection-tunnel');
const { normalizeLocalTransport, transportKey } = require('./local-transport');
const savedFailures=new WeakMap();
const persistedProfileOnFailure=error=>savedFailures.get(error)||null;
const KEY='rocketbrain.database.profiles.v1',SCOPE='rocketbrain.database.secretScope.v1',MAX=32;
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_PROFILE'}),clone=structuredClone;
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('The connection profile contains unsupported fields. Keep passwords outside the profile.');}
function text(value,label,max,optional=false){if(optional&&(value===undefined||value===''))return'';if(typeof value!=='string'||!value.trim()||value.length>max||/[\0\r\n]/.test(value))throw fail('Enter a valid '+label+'.');return value.trim();}
function port(value,otherwise){value=value??otherwise;if(!Number.isInteger(value)||value<1||value>65535)throw fail('Ports must be integers from 1 to 65535.');return value;}
function localPath(value,label,optional=true){if(optional&&!value)return'';const result=text(value,label,4096);if(!path.isAbsolute(result)||/^\\\\/.test(result))throw fail('Select a local absolute '+label+' path.');return result;}
function normalizeProfile(value,{allowUnconfigured=false}={}){
 exact(value,['id','name','group','color','host','port','user','database','tls','ssh','transport']);
 const id=value.id||crypto.randomUUID();if(!/^[a-f0-9-]{36}$/i.test(id))throw fail('The profile identity is invalid.');
 const transport=normalizeLocalTransport(value.transport,{allowUnconfigured});
 let route;
 if(transport){
  if(value.host!==undefined||value.port!==undefined||value.tls&&value.tls.mode!=='disabled'||value.ssh!=null)throw fail('Local transports use OS permissions and cannot be combined with TCP, TLS, or SSH settings.');
  route={transport};
 }else{
  const host=text(value.host,'database host',253);
  if(!dnsName(host)&&!net.isIP(host))throw fail('Use a DNS name or IP address for the database host.');
  route={host,port:port(value.port,3306)};
 }
 const {host}=route;
 const color=value.color||'none';if(!['none','red','orange','yellow','green','blue','purple'].includes(color))throw fail('Choose a supported connection color.');
 const p={id,name:text(value.name,'connection name',120),group:text(value.group,'group',80,true),color,...route,user:text(value.user,'database user',128),database:text(value.database,'database schema',64),tls:{mode:'disabled'},ssh:null};
 if(value.tls){exact(value.tls,['mode','serverName','caPath','certPath','keyPath']);if(!['disabled','verify'].includes(value.tls.mode))throw fail('Choose disabled or verified TLS.');if(value.tls.mode==='verify'){const serverName=value.tls.serverName||(!net.isIP(host)?host:'');if(!dnsName(serverName))throw fail('Verified TLS needs the certificate DNS name, including for an IP connection.');p.tls={mode:'verify',serverName,caPath:localPath(value.tls.caPath,'CA certificate'),certPath:localPath(value.tls.certPath,'client certificate'),keyPath:localPath(value.tls.keyPath,'client private-key')};if(Boolean(p.tls.certPath)!==Boolean(p.tls.keyPath))throw fail('Select both the client certificate and private key.');}}
 if(value.ssh){exact(value.ssh,['host','port','user','knownHostsPath','privateKeyPath']);const sshHost=text(value.ssh.host,'SSH host',253);if(!dnsName(sshHost)&&!net.isIP(sshHost))throw fail('Use a DNS name or IP address for SSH.');p.ssh={host:sshHost,port:port(value.ssh.port,22),user:text(value.ssh.user,'SSH user',128),knownHostsPath:localPath(value.ssh.knownHostsPath,'verified known_hosts',false),privateKeyPath:localPath(value.ssh.privateKeyPath,'SSH key')};}
 return p;
}
function password(value){if(value===undefined)return undefined;if(typeof value!=='string'||Buffer.byteLength(value)>16384||value.includes('\0'))throw fail('Use a database password under 16 KiB.');return value;}
function sanitized(error){const safe=error?.code?.startsWith('ROCKETBRAIN_')?error:fail('The database connection could not be verified. Check the address, credentials, certificates and server availability.');const persisted=savedFailures.get(error);if(persisted)savedFailures.set(safe,persisted);return safe;}
async function readPem(file){const actual=await fs.realpath(file),stat=await fs.stat(actual);if(!stat.isFile()||stat.size>2*1024*1024)throw fail('Certificate/key files must be regular files under 2 MiB.');return fs.readFile(actual,'utf8');}
function createConnectionProfiles({state,secrets,connect,disconnect,getActiveProfile,isTrusted,createService,createTunnel=openTunnel}={}){
 const events=new EventEmitter(),records=new Map(),operations=new Set(),controllers=new Set();let disposed=false,busy=false,revision=0;const secretScope=state.get(SCOPE)||crypto.randomUUID();
 for(const saved of state.get(KEY,[])){try{if(records.size>=MAX)break;const p=normalizeProfile(saved.profile,{allowUnconfigured:true});if(records.has(p.id))continue;records.set(p.id,{profile:p,revision:Number.isInteger(saved.revision)?saved.revision:1,rememberPassword:saved.rememberPassword===true,verifiedAt:typeof saved.verifiedAt==='string'?saved.verifiedAt:null,observed:saved.observed||null});}catch{}}
 const trusted=()=>{if(disposed)throw fail('Database connection management is closed.');if(!isTrusted())throw fail('Trust this workspace before using saved database connections.');};
 const guard=ticket=>{trusted();if(ticket!==revision)throw fail('Connection profiles changed. Reopen the connection editor.');};
 const secretKey=id=>'rocketbrain.database.'+secretScope+'.'+id;
 const dto=record=>({id:record.profile.id,profile:clone(record.profile),revision:record.revision,hasSavedPassword:record.rememberPassword,verifiedAt:record.verifiedAt,observed:record.observed?clone(record.observed):null});
 const list=()=>[...records.values()].sort((a,b)=>a.profile.group.localeCompare(b.profile.group)||a.profile.name.localeCompare(b.profile.name)).map(dto);
 async function run(fn){trusted();if(busy)throw fail('Finish the current connection operation first.');busy=true;const ticket=revision,controller=new AbortController();controllers.add(controller);const operation=(async()=>{try{return await fn(ticket,controller.signal);}catch(error){throw sanitized(error);}finally{busy=false;controllers.delete(controller);events.emit('change');}})();operations.add(operation);try{return await operation;}finally{operations.delete(operation);}}
 async function credentials(profile,value){
  const explicit=password(value);
  if(explicit!==undefined)return explicit;
  const saved=records.get(profile.id)?.profile;
  if((profile.transport||saved?.transport)&&
     (profile.user!==saved?.user||JSON.stringify(transportKey(profile.transport))!==JSON.stringify(transportKey(saved?.transport))))return'';
  return(await secrets.get(secretKey(profile.id)))||'';
 }
 async function prepare(profile,pass,signal){
  if(profile.transport&&!profile.transport.address)throw fail('Edit this profile and enter the local socket path or pipe name before connecting.');
  const route=profile.transport?{transport:profile.transport}:{host:profile.host,port:profile.port};
  const config={...route,user:profile.user,database:profile.database,password:pass,readOnly:true};
  if(profile.tls.mode==='verify'){config.ssl={rejectUnauthorized:true,verifyIdentity:true,serverName:profile.tls.serverName};for(const [field,file]of [['ca',profile.tls.caPath],['cert',profile.tls.certPath],['key',profile.tls.keyPath]])if(file)config.ssl[field]=await readPem(file);connectionSecurity(config);}
  const observedRoute=profile.transport?{transport:{kind:profile.transport.kind}}:route;
  const info={id:profile.id,name:profile.name,group:profile.group,color:profile.color,...observedRoute,database:profile.database,tls:profile.tls.mode==='verify',ssh:Boolean(profile.ssh),
   connectionKey:require('./result-layouts').tableLayoutConnectionKey(config,profile)};
  let tunnel;if(profile.ssh){tunnel=await createTunnel(profile.ssh,{host:profile.host,port:profile.port},{cancellation:signal,onExit:()=>events.emit('change')});return{config:bindConnectionResource(config,{endpoint:tunnel.endpoint,dispose:tunnel.dispose,profile:info}),dispose:tunnel.dispose};}
  return{config:identifyConnection(config,info),dispose:async()=>{}};
 }
 async function verify(profile,pass,signal,schemas=false){let prepared,service;try{prepared=await prepare(profile,pass,signal);service=createService(prepared.config);const metadata=await service.metadata();const info=await service._metadataQuery('SELECT VERSION(), DATABASE(), CURRENT_USER()');const tls=await service._metadataQuery("SHOW SESSION STATUS LIKE 'Ssl_cipher'");const cipher=String(tls.rows[0]?.[1]||'');if(profile.tls.mode==='verify'&&!cipher)throw fail('The server did not confirm an encrypted TLS session.');const result={connected:true,database:metadata.database,serverVersion:String(info.rows[0]?.[0]||''),currentUser:String(info.rows[0]?.[2]||''),tables:metadata.tables.length,views:metadata.views.length,tls:profile.tls.mode==='verify',cipher:cipher||null,ssh:Boolean(profile.ssh),...(profile.transport&&{transport:{kind:profile.transport.kind}})};if(schemas){const available=await service._metadataQuery('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 200');result.schemas=available.rows.map(row=>String(row[0]));}return result;}finally{try{await service?.dispose();}finally{await prepared?.dispose();}}}
 async function persist(next,credentialChanges=[]){await state.update(SCOPE,secretScope);const before=[];try{for(const change of credentialChanges){const key=secretKey(change.id),old=await secrets.get(key);before.push({key,old});if(change.value===undefined)await secrets.delete(key);else await secrets.store(key,change.value);}await state.update(KEY,[...next.values()].map(value=>clone(value)));}catch(error){for(const saved of before.reverse())try{if(saved.old===undefined)await secrets.delete(saved.key);else await secrets.store(saved.key,saved.old);}catch{}throw fail('The profile or credential could not be saved. Previous profile metadata is retained.');}records.clear();for(const [id,value]of next)records.set(id,value);revision++;events.emit('change');}
 const api={
  list,
  onDidChange(listener){events.on('change',listener);return{dispose(){events.off('change',listener);}};},
  test(request){const input=clone(request);return run(async(ticket,signal)=>{const p=normalizeProfile(input.profile),pass=await credentials(p,input.password),result=await verify(p,pass,signal,true);guard(ticket);return result;});},
  save(request){const input=clone(request);return run(async(ticket,signal)=>{const p=normalizeProfile(input.profile),previous=records.get(p.id);if(previous&&input.expectedRevision!==previous.revision)throw fail('This profile edit is stale. Reopen it.');if(!previous&&records.size>=MAX)throw fail('At most 32 connection profiles are supported.');const remember=input.rememberPassword===true;if(input.rememberPassword!==undefined&&typeof input.rememberPassword!=='boolean')throw fail('Choose whether to remember this password.');const pass=await credentials(p,input.password);let observed=null;if(input.verify!==false)observed=await verify(p,pass,signal);else if(remember)throw fail('Verify the connection before saving credentials.');guard(ticket);const next=new Map(records),record={profile:p,revision:(previous?.revision||0)+1,rememberPassword:remember,verifiedAt:observed?new Date().toISOString():null,observed};next.set(p.id,record);await persist(next,[{id:p.id,value:remember?pass:undefined}]);if(input.connectAfterSave===true){try{trusted();let prepared,transferred=false;try{prepared=await prepare(p,pass,signal);trusted();await connect(prepared.config);transferred=true;trusted();}finally{if(!transferred)await prepared?.dispose();}return{...dto(record),connected:true};}catch(error){const failure=error instanceof Error?error:fail('Connection setup did not finish.');savedFailures.set(failure,Object.freeze({id:p.id,revision:record.revision}));throw failure;}}return dto(record);});},
  connect(request){const input=clone(request);return run(async(ticket,signal)=>{const record=records.get(input.id);if(!record)throw fail('Choose a saved connection.');const effective=clone(record.profile);if(input.database!==undefined)effective.database=text(input.database,'schema',64);const pass=await credentials(effective,input.password);let prepared,transferred=false;try{prepared=await prepare(effective,pass,signal);guard(ticket);await connect(prepared.config);transferred=true;guard(ticket);return{connected:true,profile:clone(effective),credentialSaved:record.rememberPassword};}finally{if(!transferred)await prepared?.dispose();}});},
  schemas(request){const input=clone(request);return run(async(ticket,signal)=>{const record=records.get(input.id);if(!record)throw fail('Choose a saved connection.');const pass=await credentials(record.profile,input.password),result=await verify(record.profile,pass,signal,true);guard(ticket);return result.schemas;});},
  federatedSelect(request) {
   const input = clone(request);
   return run(async (ticket, signal) => {
    const { parseFederatedSelect, executeFederatedSelect } = require('./federated-select');
    const query = parseFederatedSelect(input.sql);
    if (!Array.isArray(input.sources) || input.sources.length !== 2 || input.sources[0]?.id === input.sources[1]?.id) throw fail('Choose two distinct saved database profiles.');
    const chosen = input.sources.map(source => {
     const record = records.get(source?.id);
     if (!record || record.revision !== source.revision) throw fail('A selected profile changed. Choose both sources again.');
     return { record, password: source.password };
    });
    const opened = [];
    try {
     for (const { record, password } of chosen) {
      const pass = await credentials(record.profile, password);
      const resource = await prepare(record.profile, pass, signal);
      const item = { resource };
      opened.push(item);
      item.service = createService(resource.config);
     }
     guard(ticket);
     const result = await executeFederatedSelect(query, opened.map(({ service }) => ({
      catalog: () => service.metadata(),
      read: (sql, values, maxRows) => service.query(sql, { values, maxRows, timeoutMs: 10000 })
     })));
     guard(ticket);
     return result;
    } finally {
     const released = await Promise.allSettled(opened.map(async ({ service, resource }) => {
      try { await service?.dispose(); }
      finally { await resource.dispose(); }
     }));
     if (released.some(state => state.status === 'rejected')) throw fail('A federated connection did not close cleanly. Open a fresh review before retrying.');
    }
   });
  },
  disconnect(){return run(async()=>{await disconnect();return{disconnected:true};});},
  remove(request){const input=clone(request);return run(async(ticket)=>{const record=records.get(input.id);if(!record)throw fail('The connection profile no longer exists.');if(input.expectedRevision!==record.revision)throw fail('This profile edit is stale. Reopen it.');if(getActiveProfile()?.id===input.id){if(input.disconnect!==true)throw fail('Disconnect the active profile before removing it.');await disconnect();}guard(ticket);const next=new Map(records);next.delete(input.id);await persist(next,[{id:input.id,value:undefined}]);return{removed:true};});},
  exportProfiles(){
   trusted();
   const profiles=list().map(({profile})=>{
    const p=clone(profile);delete p.id;
    if(p.tls.mode==='verify')p.tls={mode:'verify',serverName:p.tls.serverName};
    if(p.ssh)p.ssh={host:p.ssh.host,port:p.ssh.port,user:p.ssh.user,requiresLocalKeyAndKnownHosts:true};
    if(p.transport)p.transport={kind:p.transport.kind};
    return p;
   });
   return{format:'RocketbrainConnectionProfiles',version:profiles.some(p=>p.transport)?2:1,credentialsIncluded:false,profiles};
  },
  importProfiles(request){
   const input=clone(request);
   return run(async()=>{
    exact(input,['format','version','credentialsIncluded','profiles']);
    if(input.format!=='RocketbrainConnectionProfiles'||![1,2].includes(input.version)||input.credentialsIncluded!==false||!Array.isArray(input.profiles)||input.profiles.length+records.size>MAX||Buffer.byteLength(JSON.stringify(input))>256*1024)throw fail('Use a credential-free profile export of at most 32 profiles and 256 KiB.');
    const normalized=input.profiles.map(value=>{
     if(value?.ssh)throw fail('Re-enter verified SSH host/key paths locally before importing an SSH profile.');
     if(value?.transport&&(input.version===1||Object.hasOwn(value.transport,'address')))throw fail('Re-enter local socket paths and pipe names in the connection editor after importing.');
     return normalizeProfile({...value,id:crypto.randomUUID()},{allowUnconfigured:true});
    }),next=new Map(records);
    for(const p of normalized)next.set(p.id,{profile:p,revision:1,rememberPassword:false,verifiedAt:null,observed:null});
    await persist(next);
    return{imported:normalized.length,connectionsAttempted:0};
   });
  },
  async dispose(){if(disposed)return;disposed=true;revision++;for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);events.removeAllListeners();}
 };
 return api;
}
module.exports={normalizeProfile,createConnectionProfiles,persistedProfileOnFailure};
