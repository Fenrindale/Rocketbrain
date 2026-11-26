'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
const { prepareAgentIdentity } = require('./connection-ssh-agent');
const { openPinnedTunnel, userAuthModes, credentialFor } = require('./connection-ssh-credentials');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=message=>Object.assign(new Error(message),{code:'ROCKETBRAIN_SSH'});
function host(value){if(typeof value!=='string'||value.length>253||!value||value.startsWith('-')||!/^[A-Za-z0-9:.\[\]-]+$/.test(value))throw fail('Use a DNS name or IP address for SSH forwarding.');return value.replace(/^\[|\]$/g,'');}
function sshOptionPath(value){return '"'+value.replaceAll('\\','/')+'"';}
async function regularFile(value,label){if(typeof value!=='string'||!path.isAbsolute(value)||value.includes('\0')||/[\r\n"]/.test(value))throw fail('Choose a local absolute '+label+' file.');const target=await fs.realpath(value),stat=await fs.stat(target);if(!stat.isFile()||stat.size>4*1024*1024)throw fail('The '+label+' must be a regular file under 4 MiB.');return target;}
function validatedTarget(ssh){
 const target=host(ssh.host),port=ssh.port??22;
 if(!Number.isInteger(port)||port<1||port>65535||typeof ssh.user!=='string'||!ssh.user||ssh.user.length>128||/[\r\n\0]/.test(ssh.user))throw fail('Use a valid SSH port and user.');
 return { host: target, port, user: ssh.user };
}
async function secureSshTarget(ssh){
 const { host: target, port } = validatedTarget(ssh);
 const knownHosts=await regularFile(ssh.knownHostsPath,'verified known_hosts');
 const key=ssh.privateKeyPath?await regularFile(ssh.privateKeyPath,'SSH private-key'):null;
 const executable=ssh.executable||(process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32','OpenSSH','ssh.exe'):'ssh');
 const options=['-T','-F','none','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','GlobalKnownHostsFile=none','-o','UserKnownHostsFile='+sshOptionPath(knownHosts),'-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-o','ForwardAgent=no','-o','PermitLocalCommand=no','-p',String(port),'-l',ssh.user];
 if(key)options.push('-o','IdentitiesOnly=yes','-i',key);
 return {executable,options,destination:['--',target]};
}
async function unusedPort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(error=>error?reject(error):resolve(value));});});}
async function accepting(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let done=false;const end=value=>{if(done)return;done=true;socket.destroy();resolve(value);};socket.once('connect',()=>end(true));socket.once('error',()=>end(false));socket.setTimeout(150,()=>end(false));});}
async function openTunnel(ssh,destination,{cancellation,onExit,expectedAgentFingerprint,credential}={}){
 const remote=host(destination.host),remotePort=destination.port??3306;
 if(!Number.isInteger(remotePort)||remotePort<1||remotePort>65535)throw fail('Use a valid database forwarding port.');
 if (ssh.authentication !== undefined) {
  if (!userAuthModes.has(ssh.authentication) || ssh.agent || ssh.knownHostsPath || expectedAgentFingerprint !== undefined ||
      Boolean(ssh.privateKeyPath) !== (ssh.authentication === 'encrypted-key')) throw fail('Choose one SSH authentication method and its matching host verification.');
  return openPinnedTunnel({ ...ssh, ...validatedTarget(ssh) }, { host: remote, port: remotePort }, { credential, cancellation, onExit });
 }
 credentialFor(undefined, credential);
 const sshTarget=await secureSshTarget(ssh);
 if(cancellation?.aborted||cancellation?.isCancellationRequested)throw fail('SSH connection cancelled.');
 if (ssh.agent && ssh.privateKeyPath) throw fail('Choose either a selected SSH agent identity or a private-key file.');
 const identity = ssh.agent ? await prepareAgentIdentity(ssh.agent) : undefined;
 let forward;
 try {
  if (expectedAgentFingerprint !== undefined && identity?.fingerprint !== expectedAgentFingerprint) {
   throw fail('The selected SSH agent public key changed. Review and verify the profile again.');
  }
  forward = await startForward({ sshTarget, remote, remotePort, cancellation, onExit, identity });
 } finally {
  try { await identity?.dispose(); }
  catch (error) { await forward?.dispose(); throw error; }
 }
 return { ...forward, ...(identity && { agentFingerprint: identity.fingerprint }) };
}
async function startForward({ sshTarget, remote, remotePort, cancellation, onExit, identity }) {
 if(cancellation?.aborted||cancellation?.isCancellationRequested)throw fail('SSH connection cancelled.');
 const port=await unusedPort(),remoteAddress=net.isIP(remote)===6?'['+remote+']':remote;
 const args=['-N','-o','ExitOnForwardFailure=yes','-L','127.0.0.1:'+port+':'+remoteAddress+':'+remotePort,...sshTarget.options,...(identity?.options ?? []),...sshTarget.destination];
 const child=spawn(sshTarget.executable,args,{windowsHide:true,shell:false,stdio:['ignore','ignore','pipe'],...identity&&{env:identity.env}});let exited=false,closed=false,failure='',size=0;
 const exit=new Promise(resolve=>{child.once('error',()=>{failure='The configured OpenSSH client could not start.';exited=true;resolve();});child.once('exit',()=>{exited=true;resolve();if(!closed)onExit?.();});});
 child.stderr.on('data',chunk=>{size+=chunk.length;if(size<=65536)failure+=chunk.toString('utf8');});
 async function dispose(){if(closed)return;closed=true;if(!exited)child.kill();await Promise.race([exit,sleep(2000)]);if(!exited)child.kill('SIGKILL');await Promise.race([exit,sleep(2000)]);if(!exited)throw fail('The owned SSH client did not stop; its process is retained for inspection.');}
 try{const deadline=Date.now()+12000;while(Date.now()<deadline){if(cancellation?.aborted||cancellation?.isCancellationRequested)throw fail('SSH connection cancelled.');if(exited)throw fail(/host key|known_hosts|REMOTE HOST IDENTIFICATION/i.test(failure)?'SSH host-key verification failed. Verify the selected known_hosts file.':/Permission denied|authentication/i.test(failure)?'SSH key/agent authentication failed.':'The owned SSH forward could not connect.');if(await accepting(port))return{endpoint:{host:'127.0.0.1',port},pid:child.pid,dispose};await sleep(50);}throw fail('SSH forwarding timed out.');}catch(error){await dispose();throw error;}
}
module.exports={openTunnel,secureSshTarget};
