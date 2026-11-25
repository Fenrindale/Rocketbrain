'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net'),{spawn}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../test-output/'+(process.env.ROCKETBRAIN_TEST_REPORT_PREFIX||'v0.18')+'-security-fixtures'),KIND='RocketbrainConnectionSecurityFixture-v18';
function execute(file,args,options={}){return new Promise((resolve,reject)=>{const child=spawn(file,args,{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],...options});let output='';const timer=setTimeout(()=>{child.kill();reject(Error('Owned fixture command timed out.'));},30000);child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',code=>{clearTimeout(timer);code===0?resolve(output):reject(Error('Owned fixture command failed: '+output.slice(-4000)));});});}
async function certificates({ protectedIdentity = false, ssh = true } = {}) {
  await fs.mkdir(ROOT,{recursive:true});
  const id = crypto.randomUUID(), folder = path.join(ROOT,id);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder,'owner.json'),JSON.stringify({kind:KIND,id}));
  const read = name => fs.readFile(path.join(folder,name),'utf8');
  const remove = async () => {
    const marker = JSON.parse(await read('owner.json'));
    if (marker.kind !== KIND || marker.id !== id || path.dirname(await fs.realpath(folder)) !== await fs.realpath(ROOT)) {
      throw Error('Security fixture ownership mismatch.');
    }
    await fs.rm(folder,{recursive:true});
  };
  try {
    const passphrase = protectedIdentity ? crypto.randomBytes(24).toString('base64url') : '';
    const pwsh = process.env.ROCKETBRAIN_TEST_PWSH || 'pwsh.exe';
    await execute(pwsh,['-NoProfile','-NonInteractive','-File',path.resolve(__dirname,'connection-security-certificates.ps1'),'-Folder',folder],{
      env:{...process.env,ROCKETBRAIN_OWNED_CLIENT_PFX_PASSPHRASE:passphrase}
    });
    if (ssh) {
      const keygen = process.platform === 'win32' ? path.join(process.env.SystemRoot,'System32/OpenSSH/ssh-keygen.exe') : 'ssh-keygen';
      for (const name of ['ssh-host','ssh-client','ssh-wrong']) {
        await execute(keygen,['-t','ed25519','-N','','-f',path.join(folder,name)]);
      }
    }
    const ca = await read('ca.pem'), cert = await read('client.pem'), key = await read('client-key.pem');
    if (protectedIdentity) {
      const opaque = crypto.createPrivateKey(key).export({format:'pem',type:'pkcs8',cipher:'aes-256-cbc',passphrase});
      await fs.writeFile(path.join(folder,'client-key-encrypted.pem'),opaque,{flag:'wx',mode:0o600});
    }
    return { id, folder, ca, wrongCa:await read('wrong-ca.pem'), server:{ca,cert:await read('server.pem'),key:await read('server-key.pem')},
      client:{cert,key}, ...(protectedIdentity && {passphrase}), remove };
  } catch (error) {
    await remove().catch(() => {});
    throw error;
  }
}
async function sshServer(fixture,destination,{stallAuthentication=false}={}){const{Server,utils}=require('ssh2'),key=utils.parseKey(await fs.readFile(path.join(fixture.folder,'ssh-client.pub')));if(key instanceof Error)throw key;const clients=new Set(),sockets=new Set(),destinations=[];const server=new Server({hostKeys:[await fs.readFile(path.join(fixture.folder,'ssh-host'))]},client=>{clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));client.on('authentication',ctx=>{if(stallAuthentication)return;if(ctx.method==='publickey'&&ctx.username==='rb_ssh'&&ctx.key.data.equals(key.getPublicSSH())&&(!ctx.signature||key.verify(ctx.blob,ctx.signature,ctx.hashAlgo)===true))ctx.accept();else ctx.reject();});client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{if(info.destIP!==destination.host||info.destPort!==destination.port){reject();return;}destinations.push({host:info.destIP,port:info.destPort});const socket=net.connect(destination);sockets.add(socket);socket.once('error',()=>reject());socket.once('close',()=>sockets.delete(socket));socket.once('connect',()=>{const stream=accept();if(!stream){socket.destroy();return;}stream.on('error',()=>socket.destroy());stream.on('close',()=>socket.destroy());socket.pipe(stream).pipe(socket);});}));});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port,publicKey=(await fs.readFile(path.join(fixture.folder,'ssh-host.pub'),'utf8')).trim().split(/\s+/).slice(0,2).join(' '),wrongKey=(await fs.readFile(path.join(fixture.folder,'ssh-wrong.pub'),'utf8')).trim().split(/\s+/).slice(0,2).join(' '),knownHostsPath=path.join(fixture.folder,'known-'+port),badKnownHostsPath=path.join(fixture.folder,'bad-known-'+port);await fs.writeFile(knownHostsPath,'[127.0.0.1]:'+port+' '+publicKey+'\n');await fs.writeFile(badKnownHostsPath,'[127.0.0.1]:'+port+' '+wrongKey+'\n');return{port,destinations,ssh:{host:'127.0.0.1',port,user:'rb_ssh',privateKeyPath:path.join(fixture.folder,'ssh-client'),knownHostsPath},badKnownHostsPath,wrongKeyPath:path.join(fixture.folder,'ssh-wrong'),async close(){for(const socket of sockets)socket.destroy();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));}};}
async function listening(port){return new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});}
module.exports={certificates,sshServer,listening,ROOT,KIND};
