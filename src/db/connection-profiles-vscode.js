'use strict';
const {randomUUID,randomBytes}=require('node:crypto');
const {createConnectionProfiles,persistedProfileOnFailure,profileRequiresClientPassphrase,profileUsesJksTrust}=require('./connection-profiles');
const {MysqlService}=require('./mysql');
const { transportLabel } = require('./local-transport');
const { createProfileTree, registerProfileCatalogViewer, sessionDescription } = require('./profile-session-view');
function connectionHtml(nonce){return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'"><style>body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:900px}form{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{display:flex;flex-direction:column;gap:4px}input,select,button,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:7px}fieldset,p,pre,.actions{grid-column:1/-1}fieldset{display:grid;grid-template-columns:1fr 1fr;gap:10px}button{cursor:pointer}[hidden]{display:none!important}pre{white-space:pre-wrap}h1{font-size:20px}</style></head><body><h1>MySQL / MariaDB connection</h1><p>Profiles are stored in this workspace. A saved password goes into VS Code Secret Storage only after verification. The active catalog drives shared schema tools. Other saved profiles can keep dedicated SQL consoles and have their own read-only catalogs.</p><form id="form"><label>Name<input id="name" required maxlength="120"></label><label>Group<input id="group" maxlength="80"></label><label>Color<select id="color"><option>none</option><option>red</option><option>orange</option><option>yellow</option><option>green</option><option>blue</option><option>purple</option></select></label><label>Transport<select id="transport"><option value="tcp">TCP/IP</option><option value="unix-socket">Unix socket</option><option value="named-pipe">Windows named pipe</option></select></label><fieldset id="tcpAddress"><legend>Network address</legend><label>Host<input id="host" required></label><label>Port<input id="port" type="number" min="1" max="65535" value="3306"></label></fieldset><label id="localAddress" hidden><span id="localAddressLabel">Socket path</span><input id="transportPath" required disabled maxlength="256" autocomplete="off" spellcheck="false"></label><label>User<input id="user" required></label><label>Schema<input id="database" required maxlength="64"></label><label id="authentication-field">Authentication<select id="authKind"><option value="password">Password</option><option value="aws-rds-iam">AWS RDS IAM</option></select></label><label id="password-field">Password<input id="password" type="password" autocomplete="off"></label><label id="remember-field"><span>Remember password</span><input id="remember" type="checkbox"></label><fieldset id="iamSettings" hidden><legend>AWS RDS IAM</legend><label>Region<input id="awsRegion" maxlength="32"></label><label>Credential source<select id="awsSource"><option value="">Select credentials</option><option value="environment">AWS environment credentials</option><option value="profile">Named AWS CLI profile</option></select></label><label id="aws-profile-field">AWS CLI profile<input id="awsProfile" maxlength="128"></label></fieldset><fieldset id="tlsSettings"><legend>Verified TLS</legend><label>Mode<select id="tls"><option value="disabled">Disabled</option><option value="verify">Verify CA and server identity</option></select></label><label>Certificate DNS name<input id="serverName" placeholder="Required for an IP connection"></label><label id="server-trust-field">Server trust source<select id="serverTrust"><option value="pem">PEM CA or system trust</option><option value="jks">JKS CA truststore</option></select></label><label id="ca-path-field">PEM CA certificate path<input id="caPath"></label><label id="trust-store-field" hidden>Local JKS truststore path<input id="trustStorePath" spellcheck="false"></label><label id="trust-passphrase-field" hidden>JKS truststore passphrase (this attempt only)<input id="trustStorePassphrase" type="password" autocomplete="off"></label><label id="client-identity-field">Client identity<select id="clientIdentity"><option value="none">None</option><option value="pem">PEM certificate and key</option><option value="encrypted-pem">PEM certificate and encrypted key</option><option value="pkcs12">PKCS#12 identity (.p12 / .pfx)</option></select></label><label id="client-cert-field">Client certificate path<input id="certPath"></label><label id="client-key-field">Client private-key path<input id="keyPath"></label><label id="client-pfx-field">PKCS#12 client identity path<input id="pfxPath"></label><label id="client-passphrase-field">Client key passphrase (this attempt only)<input id="clientPassphrase" type="password" autocomplete="off"></label></fieldset><fieldset id="sshSettings"><legend>SSH tunnel · system OpenSSH</legend><label><span>Enable SSH</span><input id="ssh" type="checkbox"></label><label>SSH host<input id="sshHost"></label><label>SSH port<input id="sshPort" type="number" value="22"></label><label>SSH user<input id="sshUser"></label><label>Verified known_hosts path<input id="knownHostsPath"></label><label id="ssh-auth-field">SSH authentication<select id="sshAuth"><option value="default-agent">Default OpenSSH agent</option><option value="key-file">Private-key file</option><option value="selected-agent">Use one agent identity</option></select></label><label id="ssh-key-file-field" hidden>Private-key path<input id="privateKeyPath"></label><label id="ssh-agent-endpoint-field" hidden>Local agent pipe or socket<input id="sshAgentEndpoint" spellcheck="false" autocomplete="off"></label><label id="ssh-agent-key-field" hidden>OpenSSH Ed25519 public-key file<input id="sshAgentPublicKeyPath" spellcheck="false" autocomplete="off"></label></fieldset><fieldset><legend>Session lifecycle</legend><label style="grid-column:1/-1">Initialization SQL<textarea id="initialSql" rows="3" maxlength="2048" placeholder="SET SESSION time_zone = &apos;+00:00&apos;;" spellcheck="false"></textarea></label><label>Keep-alive interval (seconds)<input id="keepAliveSeconds" type="number" min="0" max="3600" value="0"></label><label>Idle disconnect (seconds)<input id="idleSeconds" type="number" min="0" max="86400" value="0"></label></fieldset><fieldset><legend>Write protection</legend><label><span>Lock this connection to read-only mode</span><input id="connectionReadOnly" type="checkbox"></label><label>Protected tables<textarea id="protectedTables" rows="3" maxlength="8400" placeholder="app.orders&#10;app.customers" spellcheck="false"></textarea><span>One schema.table per line</span></label></fieldset><p>SSH host keys must already be verified in the selected known_hosts file. Local transports use paths on the machine running this extension. Credentials and local paths are excluded from profile exports. Unsaved table edits and open transactions must be resolved before switching connections.</p><div class="actions"><button type="button" data-action="test">Test connection</button> <button type="button" data-action="save">Verify and save</button> <button type="button" data-action="connect">Save and connect</button></div><pre id="status" role="status"></pre></form><script nonce="${nonce}">
const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);let editorId,busy=false;
const localNames={'unix-socket':'Unix socket','named-pipe':'Windows named pipe'};
function syncClientIdentity(local,iam) {
 const tls = !local && !iam && $('tls').value === 'verify';
 const identity = $('clientIdentity').value;
 const pem = tls && ['pem','encrypted-pem'].includes(identity);
 const pfx = tls && identity === 'pkcs12';
 const unlock = pfx || pem && identity === 'encrypted-pem';
 for (const [field,input,visible,required] of [
  ['client-identity-field','clientIdentity',tls,false],['client-cert-field','certPath',pem,pem],
  ['client-key-field','keyPath',pem,pem],['client-pfx-field','pfxPath',pfx,pfx],
  ['client-passphrase-field','clientPassphrase',unlock,unlock]
 ]) {
  $(field).hidden = !visible; $(input).disabled = !visible; $(input).required = required;
 }
 if (!unlock) $('clientPassphrase').value = '';
}
function syncServerTrust(local, iam) {
 const verified = !local && $('tls').value === 'verify';
 const jks = verified && !iam && $('serverTrust').value === 'jks';
 for (const [field,input,visible,required] of [
  ['server-trust-field','serverTrust',verified&&!iam,false],
  ['ca-path-field','caPath',verified&&!jks,iam],
  ['trust-store-field','trustStorePath',jks,jks],
  ['trust-passphrase-field','trustStorePassphrase',jks,jks]
 ]) {
  $(field).hidden = !visible; $(input).disabled = !visible; $(input).required = visible && required;
 }
 if (!jks) $('trustStorePassphrase').value = '';
}
function tlsProfile() {
 if ($('tls').value !== 'verify') return {mode:'disabled'};
 const tls = {mode:'verify',serverName:$('serverName').value};
 if ($('serverTrust').value === 'jks') Object.assign(tls,{serverTrust:'jks',trustStorePath:$('trustStorePath').value});
 else tls.caPath = $('caPath').value;
 const identity = $('clientIdentity').value;
 if (identity === 'pkcs12') return {...tls,clientIdentity:identity,pfxPath:$('pfxPath').value};
 if (identity === 'encrypted-pem') tls.clientIdentity = identity;
 if (identity !== 'none') Object.assign(tls,{certPath:$('certPath').value,keyPath:$('keyPath').value});
 return tls;
}
function syncSsh(local, iam) {
 const enabled = !local && !iam && $('ssh').checked;
 const mode = $('sshAuth').value;
 for (const [field,input,visible,required] of [
  ['ssh-auth-field','sshAuth',enabled,false],
  ['ssh-key-file-field','privateKeyPath',enabled&&mode==='key-file',true],
  ['ssh-agent-endpoint-field','sshAgentEndpoint',enabled&&mode==='selected-agent',true],
  ['ssh-agent-key-field','sshAgentPublicKeyPath',enabled&&mode==='selected-agent',true]
 ]) {
  $(field).hidden = !visible; $(input).disabled = !visible; $(input).required = visible && required;
 }
}
function sshProfile() {
 if (!$('ssh').checked) return null;
 const mode = $('sshAuth').value;
 const target = {host:$('sshHost').value,port:Number($('sshPort').value),user:$('sshUser').value,knownHostsPath:$('knownHostsPath').value};
 if (mode === 'selected-agent') target.agent = {endpoint:$('sshAgentEndpoint').value,publicKeyPath:$('sshAgentPublicKeyPath').value};
 if (mode === 'key-file') target.privateKeyPath = $('privateKeyPath').value;
 return target;
}
function syncTransport(){
 const kind=$('transport').value, local=kind!=='tcp';
 for(const id of ['tcpAddress','tlsSettings','sshSettings']){$(id).hidden=local;$(id).disabled=local;}
 $('localAddress').hidden=!local;$('transportPath').disabled=!local;
 $('localAddressLabel').textContent=kind==='named-pipe'?'Local pipe name':'Absolute socket path';
 $('transportPath').placeholder=kind==='named-pipe'?'MySQL':'/var/run/mysqld/mysqld.sock';
 const iam=!local&&$('authKind').value==='aws-rds-iam';
 const named=iam&&$('awsSource').value==='profile';
 $('authentication-field').hidden=local;
 $('authKind').disabled=local;
 $('iamSettings').hidden=!iam;
 $('iamSettings').disabled=!iam;
 $('awsRegion').required=iam;
 $('awsSource').required=iam;
 $('aws-profile-field').hidden=!named;
 $('awsProfile').required=named;
 $('awsProfile').disabled=!named;
 for(const [field,input] of [['password-field','password'],['remember-field','remember']]){
  $(field).hidden=iam;
  $(input).disabled=iam;
 }
 $('tls').disabled=iam;
 $('serverName').readOnly=iam;
 $('caPath').required=iam;
 if(iam){
  $('tls').value='verify';$('serverName').value=$('host').value;
  $('sshSettings').hidden=true;$('sshSettings').disabled=true;$('ssh').checked=false;
  $('password').value='';$('remember').checked=false;
 }
 syncServerTrust(local,iam);
 syncClientIdentity(local,iam);
 syncSsh(local,iam);
}
for(const id of ['transport','authKind','awsSource','tls','clientIdentity','serverTrust','ssh','sshAuth'])$(id).addEventListener('change',syncTransport);
$('host').addEventListener('input',()=>{if($('authKind').value==='aws-rds-iam')$('serverName').value=$('host').value;});
syncTransport();
function profile(){
 const tables=$('protectedTables').value.split(/\\r?\\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
  const dot=line.indexOf('.');
  if(dot<1||dot===line.length-1)throw Error('Enter each protected table as schema.table.');
  return{schema:line.slice(0,dot),name:line.slice(dot+1)};
 });
 const writeProtection={connectionReadOnly:$('connectionReadOnly').checked,tables};
 const sessionLifecycle={initialSql:$('initialSql').value,keepAliveSeconds:Number($('keepAliveSeconds').value),idleSeconds:Number($('idleSeconds').value)};
 const kind=$('transport').value;
 const common={name:$('name').value,group:$('group').value,color:$('color').value,user:$('user').value,database:$('database').value,writeProtection,...((sessionLifecycle.initialSql.trim()||sessionLifecycle.keepAliveSeconds||sessionLifecycle.idleSeconds)&&{sessionLifecycle})};
 if(kind!=='tcp')return{...common,transport:{kind,address:$('transportPath').value}};
 if($('authKind').value==='aws-rds-iam'){
  const host=$('host').value,source=$('awsSource').value;
  return{...common,host,port:Number($('port').value),tls:{mode:'verify',serverName:host,caPath:$('caPath').value},ssh:null,
   auth:{kind:'aws-rds-iam',region:$('awsRegion').value,source,...(source==='profile'?{profile:$('awsProfile').value}:{})}};
 }
 return{...common,host:$('host').value,port:Number($('port').value),tls:tlsProfile(),ssh:sshProfile()};}
for(const b of document.querySelectorAll('[data-action]'))b.addEventListener('click',()=>{if(busy||!$('form').reportValidity())return;let draft;try{draft=profile();}catch(error){$('status').textContent=error.message;return;}busy=true;for(const x of document.querySelectorAll('button'))x.disabled=true;vscode.postMessage({editorId,type:b.dataset.action,profile:draft,password:$('password').value||undefined,clientIdentityPassphrase:$('clientPassphrase').value||undefined,trustStorePassphrase:$('trustStorePassphrase').value||undefined,rememberPassword:$('remember').checked});$('password').value='';$('clientPassphrase').value='';$('trustStorePassphrase').value='';$('status').textContent='Verifying connection…';});
window.addEventListener('message',({data:m})=>{if(m.type==='model'){editorId=m.editorId;const p=m.profile;$('initialSql').value=p.sessionLifecycle?.initialSql||'';$('keepAliveSeconds').value=p.sessionLifecycle?.keepAliveSeconds||0;$('idleSeconds').value=p.sessionLifecycle?.idleSeconds||0;$('connectionReadOnly').checked=p.writeProtection?.connectionReadOnly===true;$('protectedTables').value=(p.writeProtection?.tables||[]).map(table=>table.schema+'.'+table.name).join('\\n');$('transport').value=p.transport?.kind||'tcp';$('transportPath').value=p.transport?.address||'';for(const id of ['name','group','color','host','port','user','database'])$(id).value=p[id]??(id==='port'?3306:'');$('tls').value=p.tls?.mode||'disabled';for(const id of ['serverName','caPath','trustStorePath','certPath','keyPath','pfxPath'])$(id).value=p.tls?.[id]||'';$('serverTrust').value=p.tls?.serverTrust||'pem';$('trustStorePassphrase').value='';$('clientIdentity').value=p.tls?.clientIdentity||(p.tls?.certPath?'pem':'none');$('clientPassphrase').value='';$('ssh').checked=!!p.ssh;$('sshAuth').value=p.ssh?.agent?'selected-agent':p.ssh?.privateKeyPath?'key-file':'default-agent';$('sshAgentEndpoint').value=p.ssh?.agent?.endpoint||'';$('sshAgentPublicKeyPath').value=p.ssh?.agent?.publicKeyPath||'';for(const [id,k]of [['sshHost','host'],['sshPort','port'],['sshUser','user'],['knownHostsPath','knownHostsPath'],['privateKeyPath','privateKeyPath']])$(id).value=p.ssh?.[k]||(id==='sshPort'?22:'');$('remember').checked=m.hasSavedPassword===true;$('authKind').value=p.auth?.kind||'password';$('awsRegion').value=p.auth?.region||'';$('awsSource').value=p.auth?.source||'';$('awsProfile').value=p.auth?.profile||'';syncTransport();}if(m.type==='result'){$('status').textContent=m.error||(m.result.profile?(m.result.connected?'Connected to ':'Verified and saved ')+m.result.profile.name+' · '+m.result.profile.database+(m.result.hasSavedPassword?' · password saved securely':''):'Verified '+m.result.database+' · '+m.result.serverVersion+(m.result.tls?' · TLS':'')+(m.result.serverTrust==='jks'?' · JKS CA trust':'')+(m.result.ssh?' · SSH':'')+(m.result.sshAgentFingerprint?' · '+m.result.sshAgentFingerprint:'')+(m.result.transport?' · '+localNames[m.result.transport.kind]:''));busy=false;for(const x of document.querySelectorAll('button'))x.disabled=false;}});vscode.postMessage({type:'ready'});
</script></body></html>`;}
async function promptProfileCredentials(vscode, record) {
 const profile = record.profile;
 if (profile.transport && !profile.transport.address) throw Error('Edit the connection and enter its local socket path or pipe name.');
 const jks = profileUsesJksTrust(profile);
 if (jks && !profile.tls.trustStorePath) throw Error('Select the local JKS truststore in the profile editor first.');
 const encrypted = profileRequiresClientPassphrase(profile);
 if (encrypted && !(profile.tls.pfxPath || profile.tls.keyPath)) throw Error('Select the local client identity files in the profile editor first.');
 const credentials = {};
 if (profile.auth) credentials.password = '';
 else if (!record.hasSavedPassword) {
  credentials.password = await vscode.window.showInputBox({title:profile.name,
   prompt:'Database password · not saved by Connect',password:true,ignoreFocusOut:true});
  if (credentials.password === undefined) return null;
 }
 if (jks) {
  credentials.trustStorePassphrase = await vscode.window.showInputBox({title:profile.name,
   prompt:'JKS truststore passphrase · this attempt only',password:true,ignoreFocusOut:true,
   validateInput:value=>value ? undefined : 'Enter the JKS truststore passphrase.'});
  if (credentials.trustStorePassphrase === undefined) return null;
 }
 if (encrypted) {
  credentials.clientIdentityPassphrase = await vscode.window.showInputBox({title:profile.name,
   prompt:'Client identity passphrase · this attempt only',password:true,ignoreFocusOut:true,
   validateInput:value=>value ? undefined : 'Enter the client identity passphrase.'});
  if (credentials.clientIdentityPassphrase === undefined) return null;
 }
 return credentials;
}
function registerConnectionProfiles(context,vscode,{database}){
 const manager=createConnectionProfiles({state:context.workspaceState,secrets:context.secrets,connect:database.connectMysql,disconnect:database.disconnectMysql,getActiveProfile:database.activeConnectionProfile,isTrusted:()=>vscode.workspace.isTrusted,createService:config=>new MysqlService(config,{reportActivity:database.activityLog?.createReporter()}),openProfileConsole:database.openProfileConsole,hasProfileConsole:database.hasProfileConsole,getJavaHome:()=>vscode.workspace.getConfiguration?.('rocketbrain.java')?.get('javaHome')}),editors=new Map(),subscriptions=[];let closed=false;
 const events=new vscode.EventEmitter();
 database.setDatasetProfileSource?.(manager.datasetProfileSource);
 const listSessions = database.profileSessionList || (() => []);
 const tree = createProfileTree(vscode, { changes: events.event, listProfiles: manager.list,
  activeProfile: database.activeConnectionProfile, listSessions });
 let showCatalog;
 async function chooseSession(value) {
  if (value?.profileId && value?.sessionId) return { profileId: value.profileId, sessionId: value.sessionId };
  const byId = new Map(manager.list().map(row => [row.id, row.profile]));
  const choices = listSessions().filter(session => byId.has(session.profileId)).map(session => ({
   label: byId.get(session.profileId).name + ' · SQL console ' + session.id.split('-').at(-1),
   description: sessionDescription(session), target: { profileId: session.profileId, sessionId: session.id }
  }));
  if (!choices.length) throw Error('Open a dedicated SQL console from a saved connection first.');
  return (await vscode.window.showQuickPick(choices, { title: 'Database Profile Sessions' }))?.target;
 }
 const choose=async value=>{const id=typeof value==='string'?value:value?.profileId;if(id)return manager.list().find(r=>r.id===id);return(await vscode.window.showQuickPick(manager.list().map(r=>({label:r.profile.name,description:r.profile.database+' @ '+(transportLabel(r.profile.transport)||r.profile.host),value:r})),{title:'Database connection'}))?.value;};
 const pass=record=>promptProfileCredentials(vscode,record);
 function trusted(){if(closed||!vscode.workspace.isTrusted)throw Error('Trust this open workspace before managing connections.');}
 async function handle(id,message){trusted();const record=editors.get(id);if(!record||record.busy)throw Error('This connection editor is closed or busy.');if(message.type==='ready'){record.panel.webview.postMessage({type:'model',editorId:id,profile:record.profile,hasSavedPassword:record.hasSavedPassword});return;}
  if(message.editorId!==id||!['test','save','connect'].includes(message.type))throw Error('Invalid connection editor action.');record.busy=true;
  try{if(!message.profile||typeof message.profile!=='object'||Object.hasOwn(message.profile,'id'))throw Error('Reopen the connection editor.');const profile={...structuredClone(message.profile),id:record.profile.id};let result;if(message.type==='test')result=await manager.test({profile,password:message.password,clientIdentityPassphrase:message.clientIdentityPassphrase,trustStorePassphrase:message.trustStorePassphrase});else{result=await manager.save({profile,password:message.password,clientIdentityPassphrase:message.clientIdentityPassphrase,trustStorePassphrase:message.trustStorePassphrase,rememberPassword:message.rememberPassword===true,expectedRevision:record.revision,connectAfterSave:message.type==='connect' });record.profile=result.profile;record.revision=result.revision;record.hasSavedPassword=result.hasSavedPassword;}await record.panel.webview.postMessage({type:'result',result});return result;}catch(error){const persisted=persistedProfileOnFailure(error),saved=persisted&&persisted.id===record.profile.id?manager.list().find(row=>row.id===persisted.id&&row.revision===persisted.revision):null,changed=Boolean(saved);if(saved){record.profile=saved.profile;record.revision=saved.revision;record.hasSavedPassword=saved.hasSavedPassword;}await record.panel.webview.postMessage({type:'result',error:(changed?'Profile saved. Connection setup did not finish: ':'')+error.message});throw error;}finally{record.busy=false;}}
 async function openEditor(value){trusted();const saved=value?await choose(value):null;if(value&&!saved)throw Error('This connection profile no longer exists.');const id=randomUUID(),profile=saved?.profile||{id:randomUUID(),name:'My database',group:'',color:'none',host:'127.0.0.1',port:3306,user:'',database:'',tls:{mode:'disabled'},ssh:null},panel=vscode.window.createWebviewPanel('rocketbrain.connectionEditor',saved?'Edit '+profile.name:'New database connection',vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[]});panel.webview.html=connectionHtml(randomBytes(24).toString('hex'));editors.set(id,{panel,profile,revision:saved?.revision,hasSavedPassword:saved?.hasSavedPassword,busy:false});subscriptions.push(panel.onDidDispose(()=>editors.delete(id)),panel.webview.onDidReceiveMessage(message=>handle(id,message).catch(()=>{})));return{editorId:id,profile:structuredClone(profile)};}
 const command=(id,action)=>subscriptions.push(vscode.commands.registerCommand(id,async(...args)=>{try{return await action(...args);}catch(error){await vscode.window.showErrorMessage('Rocketbrain: '+error.message);}}));
 command('rocketbrain.connections.add',()=>openEditor());command('rocketbrain.connections.edit',value=>openEditor(value));command('rocketbrain.connections.refresh',()=>events.fire());
 command('rocketbrain.connections.duplicate',async value=>{
  trusted();
  const selected=await choose(value);
  if(!selected)return;
  const copy=await manager.duplicate({id:selected.id,revision:selected.revision});
  return openEditor(copy.id);
 });
 command('rocketbrain.connections.connect',async value=>{trusted();const r=await choose(value);if(!r)return;const credentials=await pass(r);if(!credentials)return;return manager.connect({id:r.id,...credentials});});
 command('rocketbrain.connections.openDedicatedConsole',async value=>{
  trusted();
  const selected=await choose(value);
  if(!selected)return;
  const credentials=await pass(selected);
  if(!credentials)return;
  return manager.openDedicatedConsole({id:selected.id,revision:selected.revision,...credentials});
 });
 command('rocketbrain.connections.revealSession',async value=>{
  trusted();
  const target=await chooseSession(value);
  if(target)return database.revealProfileSession(target);
 });
 command('rocketbrain.connections.inspectSessionCatalog',async value=>{
  trusted();
  const target=await chooseSession(value);
  if(!target)return;
  const details=await database.inspectProfileSessionCatalog(target);
  trusted();
  showCatalog ||= registerProfileCatalogViewer(vscode,subscriptions);
  return showCatalog(details);
 });
 command('rocketbrain.connections.closeSession',async value=>{
  trusted();
  const target=await chooseSession(value);
  if(!target)return;
  return database.closeProfileSession(target,async risk=>{
   const impact=[];
   if(risk.inTransaction)impact.push('Uncommitted work will be rolled back.');
   if(risk.outcomeUnknown)impact.push('An interrupted write may already have committed. Closing cannot resolve its outcome.');
   if(risk.editorCount>1)impact.push('All '+risk.editorCount+' linked editors will lose this session.');
   const result=await vscode.window.showWarningMessage(impact.join(' '),{modal:true},'Close Profile Session');
   return result==='Close Profile Session';
  });
 });
 command('rocketbrain.connections.test',async value=>{trusted();const r=await choose(value);if(!r)return;const credentials=await pass(r);if(!credentials)return;const result=await manager.test({profile:r.profile,...credentials});await vscode.window.showInformationMessage('Verified '+result.database+' · '+result.serverVersion+(result.tls?' · TLS':'')+(result.transport?' · '+transportLabel(result.transport):''));return result;});
 command('rocketbrain.connections.disconnect',()=>manager.disconnect());
 command('rocketbrain.connections.selectSchema',async value=>{trusted();const r=await choose(value);if(!r)return;const credentials=await pass(r);if(!credentials)return;const schemas=await manager.schemas({id:r.id,...credentials}),database=await vscode.window.showQuickPick(schemas,{title:'Select schema for this connection'});if(database)return manager.connect({id:r.id,...credentials,database});});
 command('rocketbrain.connections.remove',async value=>{trusted();const r=await choose(value);if(!r)return;if(await vscode.window.showWarningMessage('Remove '+r.profile.name+' and its saved password? An active connection will be disconnected.',{modal:true},'Remove connection')!=='Remove connection')return;return manager.remove({id:r.id,expectedRevision:r.revision,disconnect:true});});
 command('rocketbrain.connections.export',async()=>{trusted();const content=manager.exportProfiles(),uri=await vscode.window.showSaveDialog({title:'Export credential-free profiles',filters:{JSON:['json']}});if(uri)await vscode.workspace.fs.writeFile(uri,Buffer.from(JSON.stringify(content,null,2)+'\n'));return{profiles:content.profiles.length,credentialsIncluded:false};});
 command('rocketbrain.connections.import',async()=>{
  trusted();
  const uris=await vscode.window.showOpenDialog({title:'Import credential-free profiles',canSelectMany:false,filters:{JSON:['json']}});
  if(!uris?.length)return;
  const buffer=await vscode.workspace.fs.readFile(uris[0]);
  if(buffer.byteLength>256*1024)throw Error('The profile file exceeds 256 KiB.');
  const content=JSON.parse(Buffer.from(buffer).toString('utf8')), review=manager.reviewProfileImport(content);
  let strategy='rename';
  if(review.conflicts){
   const names=review.rows.filter(item=>item.conflicts).slice(0,8).map(item=>item.name).join(', ');
   const chosen=await vscode.window.showQuickPick([
    { label:'Import as copies', description:'Give each conflicting profile a unique name', strategy:'rename' },
    { label:'Skip conflicting names', description:'Import the profiles with available names', strategy:'skip' }
   ],{title:review.conflicts+' conflicting profile names',placeHolder:names});
   if(!chosen)return;
   strategy=chosen.strategy;
  }
  const result=await manager.importProfiles(content,{review,strategy});
  void vscode.window.showInformationMessage(`${result.imported} imported · ${result.renamed} renamed · ${result.skipped} skipped`);
  return result;
 });
 if(database.onDidChangeProfileSessions)subscriptions.push(database.onDidChangeProfileSessions(()=>events.fire()));
 subscriptions.push(manager.onDidChange(()=>events.fire()),database.onDidChangeDatabase(()=>events.fire()),vscode.window.registerTreeDataProvider('rocketbrain.connections',tree));
 const api={...manager,openEditor,handle,closeEditor(id){editors.get(id)?.panel.dispose();},editors:()=>[...editors.keys()],tree,async dispose(){if(closed)return;closed=true;for(const {panel}of editors.values())panel.dispose();editors.clear();await manager.dispose();for(const s of subscriptions)s.dispose();events.dispose();}};context.subscriptions.push(api);return api;
}
module.exports={connectionHtml,registerConnectionProfiles,promptProfileCredentials};
