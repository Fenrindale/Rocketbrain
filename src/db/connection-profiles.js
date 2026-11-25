'use strict';
const path=require('node:path'),net=require('node:net'),crypto=require('node:crypto'),{EventEmitter}=require('node:events');
const {connectionSecurity,bindConnectionResource,identifyConnection,dnsName}=require('./connection-security');
const {openTunnel}=require('./connection-tunnel');
const { agentSelection } = require('./connection-ssh-agent');
const { normalizeLocalTransport, transportKey } = require('./local-transport');
const { normalizeRdsIam, validateRdsIamRoute } = require('./rds-iam');
const { normalizeWriteProtection } = require('./write-protection');
const { sessionLifecycle } = require('./session-lifecycle');
const { caFingerprint, expectReviewedTls } = require('./server-tls-trust');
const { readClientPem, readPkcs12Identity, clientPassphrase, readJksTrustStore, jksPassphrase } = require('./client-identity');
const savedFailures=new WeakMap();
const tlsReviewTtlMs=2*60*1000;
const persistedProfileOnFailure=error=>savedFailures.get(error)||null;
const KEY='rocketbrain.database.profiles.v1',SCOPE='rocketbrain.database.secretScope.v1',MAX=32;
const isPasswordFree=profile=>profile?.auth?.kind==='password-free';
const usesRdsIam=profile=>profile?.auth?.kind==='aws-rds-iam';
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_PROFILE'}),clone=structuredClone;
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fail('The connection profile contains unsupported fields. Keep passwords outside the profile.');}
function text(value,label,max,optional=false){if(optional&&(value===undefined||value===''))return'';if(typeof value!=='string'||!value.trim()||value.length>max||/[\0\r\n]/.test(value))throw fail('Enter a valid '+label+'.');return value.trim();}
function port(value,otherwise){value=value??otherwise;if(!Number.isInteger(value)||value<1||value>65535)throw fail('Ports must be integers from 1 to 65535.');return value;}
function localPath(value,label,optional=true){if(optional&&!value)return'';const result=text(value,label,4096);if(!path.isAbsolute(result)||/^\\\\/.test(result))throw fail('Select a local absolute '+label+' path.');return result;}
function normalizeProfileTls(value, host, allowUnconfigured) {
 if (!value) return {mode:'disabled'};
 exact(value,['mode','serverName','caPath','certPath','keyPath','clientIdentity','pfxPath','serverTrust','trustStorePath']);
 if (!['disabled','verify'].includes(value.mode)) throw fail('Choose disabled or verified TLS.');
 if (value.mode === 'disabled') {
  if (value.clientIdentity !== undefined || value.pfxPath) throw fail('Client identities require verified TLS.');
  if (value.serverTrust !== undefined || value.trustStorePath) throw fail('A JKS server truststore requires verified TLS.');
  return {mode:'disabled'};
 }
 const serverName = value.serverName || (!net.isIP(host) ? host : '');
 if (!dnsName(serverName)) throw fail('Verified TLS needs the certificate DNS name, including for an IP connection.');
 const tls = {
  mode:'verify', serverName, caPath:localPath(value.caPath,'CA certificate'),
  certPath:localPath(value.certPath,'client certificate'), keyPath:localPath(value.keyPath,'client private-key')
 };
 if (value.serverTrust === 'jks') {
  if (tls.caPath) throw fail('Choose either a JKS server truststore or a PEM CA file.');
  tls.serverTrust = 'jks';
  tls.trustStorePath = localPath(value.trustStorePath, 'JKS server truststore', allowUnconfigured);
 } else if (value.serverTrust !== undefined || value.trustStorePath) {
  throw fail('Select the JKS server trust option before choosing a truststore.');
 }
 if (value.clientIdentity === undefined) {
  if (value.pfxPath || Boolean(tls.certPath) !== Boolean(tls.keyPath)) throw fail('Select both the client certificate and private key, or use a PKCS#12 identity.');
 } else if (value.clientIdentity === 'encrypted-pem') {
  if (value.pfxPath || Boolean(tls.certPath) !== Boolean(tls.keyPath) || (!allowUnconfigured && !tls.keyPath)) {
   throw fail('Select both the client certificate and encrypted private key.');
  }
  tls.clientIdentity = 'encrypted-pem';
 } else if (value.clientIdentity === 'pkcs12') {
  if (tls.certPath || tls.keyPath) throw fail('Choose either a PKCS#12 client identity or a client certificate/private-key pair.');
  tls.clientIdentity = 'pkcs12';
  tls.pfxPath = localPath(value.pfxPath,'PKCS#12 identity',allowUnconfigured);
 } else throw fail('Choose a supported client identity.');
 return tls;
}
function profileRequiresClientPassphrase(profile) {
 return profile?.tls?.mode === 'verify' && Boolean(profile.tls.clientIdentity);
}
function profileUsesJksTrust(profile) {
 return profile?.tls?.mode === 'verify' && profile.tls.serverTrust === 'jks';
}
function normalizeProfile(value,{allowUnconfigured=false}={}){
 exact(value,['id','name','group','color','host','port','user','database','tls','ssh','transport','auth','writeProtection','sessionLifecycle']);
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
 p.tls=normalizeProfileTls(value.tls,host,allowUnconfigured);
 if(value.ssh){exact(value.ssh,['host','port','user','knownHostsPath','privateKeyPath','agent']);const sshHost=text(value.ssh.host,'SSH host',253);if(!dnsName(sshHost)&&!net.isIP(sshHost))throw fail('Use a DNS name or IP address for SSH.');p.ssh={host:sshHost,port:port(value.ssh.port,22),user:text(value.ssh.user,'SSH user',128),knownHostsPath:localPath(value.ssh.knownHostsPath,'verified known_hosts',false),privateKeyPath:localPath(value.ssh.privateKeyPath,'SSH key')};
  if (value.ssh.agent !== undefined) {
   if (p.ssh.privateKeyPath) throw fail('Choose either a selected SSH agent identity or a private-key file.');
   p.ssh.agent = agentSelection(value.ssh.agent);
  }
 }
 if(isPasswordFree(value)){
  exact(value.auth,['kind']);
  p.auth={kind:'password-free'};
 }else if(value.auth!==undefined){
  p.auth=normalizeRdsIam(value.auth,{allowUnconfigured});
  if (profileUsesJksTrust(p)) throw fail('Choose an AWS PEM CA bundle for an RDS IAM profile.');
  validateRdsIamRoute(p,p.tls.mode==='verify'?{serverName:p.tls.serverName,cert:p.tls.certPath,key:p.tls.keyPath,pfx:p.tls.clientIdentity}:undefined);
  if(!allowUnconfigured&&!p.tls.caPath)throw fail('Select the AWS RDS CA bundle for this IAM profile.');
 }
 const writeProtection=normalizeWriteProtection(value.writeProtection);
 if(writeProtection)p.writeProtection=writeProtection;
 const lifecycle=sessionLifecycle(value.sessionLifecycle);
 if(lifecycle)p.sessionLifecycle=lifecycle;
 return p;
}
function password(value){if(value===undefined)return undefined;if(typeof value!=='string'||Buffer.byteLength(value)>16384||value.includes('\0'))throw fail('Use a database password under 16 KiB.');return value;}
function profileNameKey({ group, name }) {
 return JSON.stringify([group.normalize('NFC').toLowerCase(), name.normalize('NFC').toLowerCase()]);
}
function availableCopyName(profile, used) {
 for (let number = 1; number <= MAX + 1; number++) {
  const suffix = number === 1 ? ' (copy)' : ` (copy ${number})`;
  const stem = profile.name.slice(0,120 - suffix.length).replace(/[\uD800-\uDBFF]$/u,'').trimEnd();
  const name = stem + suffix;
  if (!used.has(profileNameKey({ ...profile, name }))) return name;
 }
 throw fail('Choose a unique profile name.');
}
function sanitized(error){const safe=error?.code?.startsWith('ROCKETBRAIN_')?error:fail('The database connection could not be verified. Check the address, credentials, certificates and server availability.');const persisted=savedFailures.get(error);if(persisted)savedFailures.set(safe,persisted);return safe;}

function createConnectionProfiles({state,secrets,connect,disconnect,getActiveProfile,isTrusted,createService,createTunnel=openTunnel,
 openProfileConsole,hasProfileConsole=()=>false,getJavaHome=()=>undefined}={}){
 const events=new EventEmitter(),records=new Map(),operations=new Set(),controllers=new Set(),tlsReviews=new Map();let disposed=false,busy=false,revision=0;const secretScope=state.get(SCOPE)||crypto.randomUUID();
 for(const saved of state.get(KEY,[])){try{if(records.size>=MAX)break;const p=normalizeProfile(saved.profile,{allowUnconfigured:true});if(records.has(p.id))continue;records.set(p.id,{profile:p,revision:Number.isInteger(saved.revision)?saved.revision:1,rememberPassword:!p.auth&&saved.rememberPassword===true,verifiedAt:typeof saved.verifiedAt==='string'?saved.verifiedAt:null,observed:saved.observed||null});}catch{}}
 const trusted=()=>{if(disposed)throw fail('Database connection management is closed.');if(!isTrusted())throw fail('Trust this workspace before using saved database connections.');};
 const guard=ticket=>{trusted();if(ticket!==revision)throw fail('Connection profiles changed. Reopen the connection editor.');};
 const secretKey=id=>'rocketbrain.database.'+secretScope+'.'+id;
 const dto=record=>({id:record.profile.id,profile:clone(record.profile),revision:record.revision,hasSavedPassword:record.rememberPassword,verifiedAt:record.verifiedAt,observed:record.observed?clone(record.observed):null});
 const list=()=>[...records.values()].sort((a,b)=>a.profile.group.localeCompare(b.profile.group)||a.profile.name.localeCompare(b.profile.name)).map(dto);
 const usedNames=()=>new Set([...records.values()].map(record => profileNameKey(record.profile)));
 function requireClosedProfileConsoles(id) {
  if(hasProfileConsole(id))throw fail('Close this profile’s dedicated SQL sessions before editing or removing it.');
 }
 async function run(fn){trusted();if(busy)throw fail('Finish the current connection operation first.');busy=true;const ticket=revision,controller=new AbortController();controllers.add(controller);const operation=(async()=>{try{return await fn(ticket,controller.signal);}catch(error){throw sanitized(error);}finally{busy=false;controllers.delete(controller);events.emit('change');}})();operations.add(operation);try{return await operation;}finally{operations.delete(operation);}}
 async function credentials(profile,value){
  if(isPasswordFree(profile)){
   if(value!==undefined&&value!=='')throw fail('This profile is set to connect without a database password.');
   return'';
  }
  if(usesRdsIam(profile)){
   if(value!==undefined&&value!=='')throw fail('An RDS IAM profile uses AWS credentials from the selected source.');
   return'';
  }
  const explicit=password(value);
  if(explicit!==undefined)return explicit;
  const record=records.get(profile.id),saved=record?.profile;
  if(isPasswordFree(saved)||(profile.transport||saved?.transport)&&
     (profile.user!==saved?.user||JSON.stringify(transportKey(profile.transport))!==JSON.stringify(transportKey(saved?.transport))))return'';
  const stored=await secrets.get(secretKey(profile.id));
  if(record?.rememberPassword&&stored===undefined)throw fail('The saved database password is unavailable. Enter it again or change the authentication mode.');
  return stored??'';
 }
 async function prepare(profile,pass,signal,{forceReadOnly=false,clientIdentityPassphrase,trustStorePassphrase,expectedAgentFingerprint}={}){
  if(profile.transport&&!profile.transport.address)throw fail('Edit this profile and enter the local socket path or pipe name before connecting.');
  if(usesRdsIam(profile)&&(!profile.auth.source||!profile.tls.caPath))throw fail('Select the local AWS credential source and RDS CA bundle before connecting.');
  const route=profile.transport?{transport:profile.transport}:{host:profile.host,port:profile.port};
  const config={...route,user:profile.user,database:profile.database,password:pass,readOnly:true,
   ...(profile.auth?{auth:profile.auth}:{}),...(profile.writeProtection?{writeProtection:profile.writeProtection}:{}),
   ...(profile.sessionLifecycle && {sessionLifecycle:profile.sessionLifecycle})};
  if(forceReadOnly)config.writeProtection={...config.writeProtection,connectionReadOnly:true};
  if (profileUsesJksTrust(profile) && !profile.tls.trustStorePath) {
   throw fail('Select a local JKS server truststore in the profile editor before connecting.');
  }
  const unlockTrust = jksPassphrase(trustStorePassphrase, profileUsesJksTrust(profile));
  const unlock = clientPassphrase(clientIdentityPassphrase,profileRequiresClientPassphrase(profile));
  if (profile.tls.mode === 'verify') {
   const { serverName, caPath, certPath, keyPath, clientIdentity, pfxPath } = profile.tls;
   config.ssl = { rejectUnauthorized:true, verifyIdentity:true, serverName };
   if (profileUsesJksTrust(profile)) {
    config.ssl.ca = await readJksTrustStore(profile.tls.trustStorePath, unlockTrust, getJavaHome(), signal);
   } else if (caPath) config.ssl.ca = await readClientPem(caPath);
   if (clientIdentity === 'pkcs12') {
    if (!pfxPath) throw fail('Select a local PKCS#12 client identity in the profile editor before connecting.');
    Object.assign(config.ssl, await readPkcs12Identity(pfxPath,unlock,getJavaHome(),signal));
   } else if (certPath && keyPath) {
    config.ssl.cert = await readClientPem(certPath);
    config.ssl.key = await readClientPem(keyPath);
    if (unlock) config.ssl.passphrase = unlock;
   } else if (clientIdentity) throw fail('Select the client certificate and encrypted private key in the profile editor before connecting.');
   connectionSecurity(config);
  }
  const observedRoute=profile.transport?{transport:{kind:profile.transport.kind}}:route;
  const info={id:profile.id,name:profile.name,group:profile.group,color:profile.color,...observedRoute,database:profile.database,tls:profile.tls.mode==='verify',ssh:Boolean(profile.ssh),
   ...(profile.auth?{authentication:profile.auth.kind}:{}),
   ...(profile.writeProtection?{writeProtection:profile.writeProtection}:{}),
   connectionKey:require('./result-layouts').tableLayoutConnectionKey(config,profile)};
  let tunnel;if(profile.ssh){tunnel=await createTunnel(profile.ssh,{host:profile.host,port:profile.port},{cancellation:signal,expectedAgentFingerprint,onExit:()=>events.emit('change')});return{config:bindConnectionResource(config,{endpoint:tunnel.endpoint,dispose:tunnel.dispose,profile:info}),dispose:tunnel.dispose,agentFingerprint:tunnel.agentFingerprint};}
  return{config:identifyConnection(config,info),dispose:async()=>{}};
 }
 function savedAgentFingerprint(record) {
  if (!record.profile.ssh?.agent) return undefined;
  const fingerprint = record.observed?.sshAgentFingerprint;
  if (typeof fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(fingerprint)) {
   throw fail('Verify and save the selected SSH agent identity first.');
  }
  return fingerprint;
 }
 async function verify(profile,pass,signal,{schemas=false,clientIdentityPassphrase,trustStorePassphrase,expectedAgentFingerprint}={}){let prepared,service;try{prepared=await prepare(profile,pass,signal,{clientIdentityPassphrase,trustStorePassphrase,expectedAgentFingerprint});service=createService(prepared.config);const metadata=await service.metadata();const info=await service._metadataQuery('SELECT VERSION(), DATABASE(), CURRENT_USER()');const tls=await service._metadataQuery("SHOW SESSION STATUS LIKE 'Ssl_cipher'");const cipher=String(tls.rows[0]?.[1]||'');if(profile.tls.mode==='verify'&&!cipher)throw fail('The server did not confirm an encrypted TLS session.');const tlsPeer=profile.tls.mode==='verify'?service.serverTlsEvidence?.():null;const result={connected:true,...(tlsPeer&&{tlsPeer}),database:metadata.database,serverVersion:String(info.rows[0]?.[0]||''),currentUser:String(info.rows[0]?.[2]||''),tables:metadata.tables.length,views:metadata.views.length,tls:profile.tls.mode==='verify',cipher:cipher||null,ssh:Boolean(profile.ssh),...(profileUsesJksTrust(profile)&&{serverTrust:"jks"}),...(prepared.agentFingerprint&&{sshAgentFingerprint:prepared.agentFingerprint}),...(profile.transport&&{transport:{kind:profile.transport.kind}})};if(schemas){const available=await service._metadataQuery('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME LIMIT 200');result.schemas=available.rows.map(row=>String(row[0]));}return result;}finally{try{await service?.dispose();}finally{await prepared?.dispose();}}}
 async function persist(next,credentialChanges=[]){await state.update(SCOPE,secretScope);const before=[];try{for(const change of credentialChanges){const key=secretKey(change.id),old=await secrets.get(key);before.push({key,old});if(change.value===undefined)await secrets.delete(key);else await secrets.store(key,change.value);}await state.update(KEY,[...next.values()].map(value=>clone(value)));}catch(error){for(const saved of before.reverse())try{if(saved.old===undefined)await secrets.delete(saved.key);else await secrets.store(saved.key,saved.old);}catch{}throw fail('The profile or credential could not be saved. Previous profile metadata is retained.');}records.clear();for(const [id,value]of next)records.set(id,value);revision++;events.emit('change');}
 function decodeProfiles(input) {
  exact(input,['format','version','credentialsIncluded','profiles']);
  if(input.format!=='RocketbrainConnectionProfiles'||![1,2,3,4,5,6,7,8].includes(input.version)||input.credentialsIncluded!==false||
     !Array.isArray(input.profiles)||input.profiles.length>MAX||Buffer.byteLength(JSON.stringify(input))>256*1024) {
   throw fail('Use a credential-free profile export of at most 32 profiles and 256 KiB.');
  }
  return input.profiles.map(value=>{
   if(value?.writeProtection!==undefined&&input.version<4)throw fail('Write protection requires the current profile export format.');
   if(value?.sessionLifecycle!==undefined&&input.version<5)throw fail('Session lifecycle settings require profile format 5.');
   if(value?.tls?.clientIdentity!==undefined&&(input.version<6||value.tls.caPath||value.tls.certPath||value.tls.keyPath||value.tls.pfxPath))throw fail('Client identity exports require format 6 and local paths must be selected after import.');
   if (value?.tls?.serverTrust !== undefined && (input.version < 7 ||
       ['caPath','trustStorePath','certPath','keyPath','pfxPath'].some(field => Object.hasOwn(value.tls, field)))) {
    throw fail('JKS truststore exports require format 7. Select local files after import.');
   }
   if(value?.ssh)throw fail('Re-enter verified SSH host/key paths locally before importing an SSH profile.');
   if(value?.transport&&(input.version===1||Object.hasOwn(value.transport,'address')))throw fail('Re-enter local socket paths and pipe names in the connection editor after importing.');
   if(isPasswordFree(value)){
    if(input.version<8)throw fail('Password-free profiles require profile export format 8.');
    exact(value.auth,['kind']);
   }else if(value?.auth){
    if(input.version<3)throw fail('RDS IAM profiles require the current export format.');
    exact(value.auth,['kind','region']);
    if(value.tls?.caPath||value.tls?.certPath||value.tls?.keyPath||value.tls?.pfxPath)throw fail('Select the RDS CA bundle locally after importing an IAM profile.');
   }
   return normalizeProfile({...value,id:crypto.randomUUID()},{allowUnconfigured:true});
  });
 }
 const profileDigest = input => crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
 const api={
  list,
  reviewTlsTrust(request) {
   const input=clone(request);
   return run(async(ticket,signal)=>{
    const record=records.get(input.id);
    if(!record||record.revision!==input.revision||record.profile.tls.mode!=='verify')throw fail('Choose the current saved profile with verified TLS enabled.');
    const pass=await credentials(record.profile,input.password);
    const observed=await verify(record.profile,pass,signal,{clientIdentityPassphrase:input.clientIdentityPassphrase,
     trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});
    guard(ticket);
    if(!observed.tlsPeer)throw fail('The verified connection did not expose a complete server TLS identity.');
    const previous=record.observed?.tlsPeer||null;
    const fields={leafSha256:'Server certificate',issuerSha256:'Issuing certificate',caMaterialSha256:'Loaded CA material',
     notBefore:'Valid from',notAfter:'Expires at',protocol:'TLS protocol'};
    const changes=previous?Object.entries(fields).filter(([key])=>previous[key]!==observed.tlsPeer[key]).map(([,label])=>label):[];
    const now=Date.now(),reviewId=crypto.randomUUID(),expiresAt=now+tlsReviewTtlMs;
    for(const [id,review] of tlsReviews)if(review.expiresAt<=now||review.id===input.id)tlsReviews.delete(id);
    while(tlsReviews.size>=8)tlsReviews.delete(tlsReviews.keys().next().value);
    tlsReviews.set(reviewId,{id:input.id,revision:record.revision,observed,expiresAt});
    return {id:input.id,reviewId,expiresAt,profile:record.profile.name,previous:clone(previous),current:clone(observed.tlsPeer),changes,
     hasBaseline:Boolean(previous)};
   });
  },
  reconnectReviewedTlsTrust(request) {
   const input=clone(request);
   return run(async(ticket,signal)=>{
    if(input.approved!==true)throw fail('Approve the reviewed TLS identity before reconnecting.');
    const review=tlsReviews.get(input.reviewId);
    if(!review||review.id!==input.id)throw fail('Prepare a new TLS trust review.');
    tlsReviews.delete(input.reviewId);
    const record=records.get(input.id);
    if(!record||record.revision!==review.revision||review.expiresAt<=Date.now())throw fail('The TLS trust review changed or expired. Review the profile again.');
    const pass=await credentials(record.profile,input.password);
    let prepared,transferred=false;
    try{
     prepared=await prepare(record.profile,pass,signal,{clientIdentityPassphrase:input.clientIdentityPassphrase,
      trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});
     guard(ticket);
     if(review.expiresAt<=Date.now())throw fail('The TLS trust review expired. Review the profile again.');
     if(caFingerprint(prepared.config.ssl)!==review.observed.tlsPeer.caMaterialSha256)throw fail('The selected CA material changed after review. Review it again.');
     expectReviewedTls(prepared.config,review.observed.tlsPeer);
     await connect(prepared.config);
     transferred=true;
     guard(ticket);
     const next=new Map(records);
     next.set(input.id,{...record,revision:record.revision+1,verifiedAt:new Date().toISOString(),observed:review.observed});
     try{await persist(next);}catch{return {connected:true,observationSaved:false};}
     return {connected:true,observationSaved:true};
    }finally{if(!transferred)await prepared?.dispose();}
   });
  },
  onDidChange(listener){events.on('change',listener);return{dispose(){events.off('change',listener);}};},
  test(request){const input=clone(request);return run(async(ticket,signal)=>{const p=normalizeProfile(input.profile),pass=await credentials(p,input.password),result=await verify(p,pass,signal,{schemas:true,clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase});guard(ticket);return result;});},
  save(request){const input=clone(request);return run(async(ticket,signal)=>{const p=normalizeProfile(input.profile),previous=records.get(p.id);requireClosedProfileConsoles(p.id);if(previous&&input.expectedRevision!==previous.revision)throw fail('This profile edit is stale. Reopen it.');if(previous&&getActiveProfile()?.id===p.id&&(JSON.stringify(previous.profile.writeProtection)!==JSON.stringify(p.writeProtection)||JSON.stringify(previous.profile.sessionLifecycle)!==JSON.stringify(p.sessionLifecycle)))throw fail('Disconnect this profile before changing its write protection or session lifecycle.');if(!previous&&records.size>=MAX)throw fail('At most 32 connection profiles are supported.');const remember=input.rememberPassword===true;if(input.rememberPassword!==undefined&&typeof input.rememberPassword!=='boolean')throw fail('Choose whether to remember this password.');if(remember&&isPasswordFree(p))throw fail('Password-free profiles cannot save a database password.');if(remember&&usesRdsIam(p))throw fail('RDS IAM profiles use temporary tokens without saving a database password.');const pass=await credentials(p,input.password);let observed=null;if(input.verify!==false)observed=await verify(p,pass,signal,{clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase});else if(profileUsesJksTrust(p))throw fail('Verify the selected JKS truststore before saving.');else if(p.ssh?.agent)throw fail('Verify the selected SSH agent identity before saving.');else if(remember)throw fail('Verify the connection before saving credentials.');guard(ticket);const next=new Map(records),record={profile:p,revision:(previous?.revision||0)+1,rememberPassword:remember,verifiedAt:observed?new Date().toISOString():null,observed};next.set(p.id,record);await persist(next,[{id:p.id,value:remember?pass:undefined}]);if(input.connectAfterSave===true){try{trusted();let prepared,transferred=false;try{prepared=await prepare(p,pass,signal,{clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});trusted();await connect(prepared.config);transferred=true;trusted();}finally{if(!transferred)await prepared?.dispose();}return{...dto(record),connected:true};}catch(error){const failure=error instanceof Error?error:fail('Connection setup did not finish.');savedFailures.set(failure,Object.freeze({id:p.id,revision:record.revision}));throw failure;}}return dto(record);});},
  connect(request){const input=clone(request);return run(async(ticket,signal)=>{const record=records.get(input.id);if(!record)throw fail('Choose a saved connection.');const effective=clone(record.profile);if(input.database!==undefined)effective.database=text(input.database,'schema',64);const pass=await credentials(effective,input.password);let prepared,transferred=false;try{prepared=await prepare(effective,pass,signal,{clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});guard(ticket);await connect(prepared.config);transferred=true;guard(ticket);return{connected:true,profile:clone(effective),credentialSaved:record.rememberPassword};}finally{if(!transferred)await prepared?.dispose();}});},
  openDedicatedConsole(request) {
   const input = clone(request);
   return run(async (ticket, signal) => {
    if (!openProfileConsole) throw fail('Dedicated profile consoles are unavailable.');
    const record = records.get(input.id);
    if (!record || input.revision !== record.revision) throw fail('The saved profile changed. Choose it again.');
    const pass = await credentials(record.profile, input.password);
    const prepared = await prepare(record.profile, pass, signal, {clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});
    let transferred = false;
    try {
     guard(ticket);
     const opened = await openProfileConsole(prepared.config);
     transferred = true;
     guard(ticket);
     return opened;
    } finally { if (!transferred) await prepared.dispose(); }
   });
  },
  duplicate(request) {
   const input=clone(request);
   return run(async ticket=>{
    const source=records.get(input.id);
    if(!source||input.revision!==source.revision)throw fail('The saved profile changed. Choose it again.');
    if(records.size>=MAX)throw fail('At most 32 connection profiles are supported.');
    const profile={...clone(source.profile),id:crypto.randomUUID(),name:availableCopyName(source.profile,usedNames())};
    const record={profile,revision:1,rememberPassword:false,verifiedAt:null,observed:null};
    const next=new Map(records);
    next.set(profile.id,record);
    guard(ticket);
    await persist(next);
    return dto(record);
   });
  },
  schemas(request){const input=clone(request);return run(async(ticket,signal)=>{const record=records.get(input.id);if(!record)throw fail('Choose a saved connection.');const pass=await credentials(record.profile,input.password),result=await verify(record.profile,pass,signal,{schemas:true,clientIdentityPassphrase:input.clientIdentityPassphrase,trustStorePassphrase:input.trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});guard(ticket);return result.schemas;});},
  federatedSelect(request) {
   const input = clone(request);
   return run(async (ticket, signal) => {
    const { parseFederatedSelect, executeFederatedSelect } = require('./federated-select');
    const query = parseFederatedSelect(input.sql);
    if (!Array.isArray(input.sources) || input.sources.length !== 2 || input.sources[0]?.id === input.sources[1]?.id) throw fail('Choose two distinct saved database profiles.');
    const chosen = input.sources.map(source => {
     const record = records.get(source?.id);
     if (!record || record.revision !== source.revision) throw fail('A selected profile changed. Choose both sources again.');
     return { record, password: source.password, clientIdentityPassphrase:source.clientIdentityPassphrase, trustStorePassphrase:source.trustStorePassphrase };
    });
    const opened = [];
    try {
     for (const { record, password, clientIdentityPassphrase, trustStorePassphrase } of chosen) {
      const pass = await credentials(record.profile, password);
      const resource = await prepare(record.profile, pass, signal, {clientIdentityPassphrase,trustStorePassphrase,expectedAgentFingerprint:savedAgentFingerprint(record)});
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
  remove(request){const input=clone(request);return run(async(ticket)=>{const record=records.get(input.id);if(!record)throw fail('The connection profile no longer exists.');if(input.expectedRevision!==record.revision)throw fail('This profile edit is stale. Reopen it.');requireClosedProfileConsoles(input.id);if(getActiveProfile()?.id===input.id){if(input.disconnect!==true)throw fail('Disconnect the active profile before removing it.');await disconnect();}guard(ticket);const next=new Map(records);next.delete(input.id);await persist(next,[{id:input.id,value:undefined}]);return{removed:true};});},
  exportProfiles(){
   trusted();
   const profiles=list().map(({profile})=>{
    const p=clone(profile);delete p.id;
    if(p.tls.mode==='verify')p.tls={mode:'verify',serverName:p.tls.serverName,...(p.tls.clientIdentity&&{clientIdentity:p.tls.clientIdentity}),...(profileUsesJksTrust(p)&&{serverTrust:'jks'})};
    if(p.ssh)p.ssh={host:p.ssh.host,port:p.ssh.port,user:p.ssh.user,requiresLocalKeyAndKnownHosts:true};
    if(p.transport)p.transport={kind:p.transport.kind};
    if(usesRdsIam(p))p.auth={kind:p.auth.kind,region:p.auth.region};
    return p;
   });
   const version=profiles.some(isPasswordFree)?8:profiles.some(profileUsesJksTrust)?7:profiles.some(profileRequiresClientPassphrase)?6:profiles.some(p=>p.sessionLifecycle)?5:profiles.some(p=>p.writeProtection)?4:profiles.some(p=>p.auth)?3:profiles.some(p=>p.transport)?2:1;
   return{format:'RocketbrainConnectionProfiles',version,credentialsIncluded:false,profiles};
  },
  reviewProfileImport(request) {
   trusted();
   const input=clone(request), profiles=decodeProfiles(input), used=usedNames();
   const rows=profiles.map(profile=>{
    const key=profileNameKey(profile), conflicts=used.has(key);
    used.add(key);
    return { group:profile.group, name:profile.name, database:profile.database, conflicts };
   });
   return { revision, digest:profileDigest(input), rows, conflicts:rows.filter(item=>item.conflicts).length };
  },
  importProfiles(request, options){
   const input=clone(request);
   const approval=options && clone(options);
   return run(async ticket=>{
    const normalized=decodeProfiles(input),next=new Map(records),used=usedNames();
    if(approval&&(!['rename','skip'].includes(approval.strategy)||approval.review?.revision!==ticket||approval.review?.digest!==profileDigest(input))) {
     throw fail('The imported file or saved profiles changed. Review the import again.');
    }
    const reserved=new Set([...used,...normalized.map(profileNameKey)]);
    let imported=0, skipped=0, renamed=0;
    for(const profile of normalized) {
     if(approval&&used.has(profileNameKey(profile))) {
      if(approval.strategy==='skip') { skipped++; continue; }
      profile.name=availableCopyName(profile,reserved);
      renamed++;
     }
     used.add(profileNameKey(profile));
     reserved.add(profileNameKey(profile));
     next.set(profile.id,{profile,revision:1,rememberPassword:false,verifiedAt:null,observed:null});
     imported++;
    }
    if(next.size>MAX)throw fail('At most 32 connection profiles are supported.');
    guard(ticket);
    if(imported)await persist(next);
    return {imported,connectionsAttempted:0,...(approval&&{skipped,renamed})};
   });
  },
  async dispose(){if(disposed)return;disposed=true;revision++;for(const controller of controllers)controller.abort();await Promise.allSettled([...operations]);tlsReviews.clear();events.removeAllListeners();}
 };
 const datasetProfile = binding => {
  trusted();
  const record = records.get(binding?.id);
  if (!record || record.revision !== binding.revision) throw fail('The saved source profile changed. Choose the source and save a new comparison.');
  if (profileRequiresClientPassphrase(record.profile)) throw fail('This comparison opens its saved source in the background. Choose a source without an interactive client identity passphrase.');
  if (profileUsesJksTrust(record.profile)) throw fail('Choose a saved comparison source that connects without a JKS truststore passphrase.');
  return record;
 };
 Object.defineProperty(api, 'datasetProfileSource', { value: {
  list() {
   trusted();
   return list().filter(({profile}) => !profileRequiresClientPassphrase(profile) && !profileUsesJksTrust(profile)).map(({ id, revision, profile, observed }) => ({ id, revision, label: profile.name,
    description: [profile.group, profile.database, observed?.serverVersion].filter(Boolean).join(' · ') }));
  },
  assertCurrent(binding) { datasetProfile(binding); },
  withProfile(binding, action) {
   return run(async (ticket, signal) => {
    const record = datasetProfile(binding);
    const { profile } = record;
    const pass = await credentials(profile);
    const resource = await prepare(profile, pass, signal, { forceReadOnly: true, expectedAgentFingerprint: savedAgentFingerprint(record) });
    let db;
    try {
     guard(ticket);
     db = createService(resource.config);
     const current = () => { guard(ticket); datasetProfile(binding); return !signal.aborted; };
     const result = await action({ db, guard: current, label: profile.name });
     current();
     return result;
    } finally {
     try { await db?.dispose(); }
     finally { await resource.dispose(); }
    }
   });
  }
 } });
 return api;
}
module.exports={normalizeProfile,createConnectionProfiles,persistedProfileOnFailure,profileRequiresClientPassphrase,profileUsesJksTrust};
