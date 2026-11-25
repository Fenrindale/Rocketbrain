'use strict';
const net=require('node:net'),crypto=require('node:crypto');
const resources=new WeakMap(),profiles=new WeakMap(),MAX_PEM=2*1024*1024;
function error(message){return Object.assign(new Error(message),{code:'ROCKETBRAIN_CONNECTION_SECURITY'});}
function pem(value,kind){if(typeof value!=='string'||!value||Buffer.byteLength(value)>MAX_PEM||value.includes('\0'))throw error('Use a bounded PEM '+kind+'.');return value;}
function dnsName(value){return typeof value==='string'&&value.length<=253&&!net.isIP(value)&&/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)&&!value.includes('..');}
function bindConnectionResource(config,{endpoint,dispose,profile}={}){
 if(config?.transport!==undefined)throw error('Use a TCP connection for an SSH tunnel.');
 if(!config||typeof config!=='object'||!endpoint||endpoint.host!=='127.0.0.1'||!Number.isInteger(endpoint.port)||endpoint.port<1||endpoint.port>65535||typeof dispose!=='function')throw error('An owned loopback transport is required.');
 const bound={...config};let closed=false;resources.set(bound,{endpoint:{...endpoint},profile:profile?structuredClone(profile):null,dispose:async()=>{if(closed)return;closed=true;await dispose();},claimed:false});return bound;
}
function identifyConnection(config,profile){const tagged={...config};profiles.set(tagged,structuredClone(profile));return tagged;}
function connectionProfile(config){const value=resources.get(config)?.profile||profiles.get(config);return value?structuredClone(value):null;}
function connectionSecurity(config){
 const resource=resources.get(config);if(resource?.claimed)throw error('This private connection transport was already consumed.');
 const options={};let expected=config.host;
 if(config.ssl){
  const ssl=config.ssl;if(typeof ssl!=='object'||Array.isArray(ssl)||ssl.rejectUnauthorized===false||ssl.verifyIdentity===false)throw error('TLS certificate and hostname verification must remain enabled.');
  if(ssl.serverName!==undefined){if(!dnsName(ssl.serverName))throw error('TLS serverName must be the DNS name on the server certificate.');expected=ssl.serverName;}
  if(!dnsName(expected))throw error('For a numeric database address, provide the certificate DNS name as TLS serverName.');
  const secure={rejectUnauthorized:true,verifyIdentity:true,minVersion:'TLSv1.2'};
  if(ssl.ca!==undefined){secure.ca=pem(ssl.ca,'CA certificate');try{new crypto.X509Certificate(secure.ca);}catch{throw error('The CA certificate is not valid PEM X.509.');}}
  if ((ssl.cert !== undefined) !== (ssl.key !== undefined)) throw error('Client certificate and private key must be supplied together.');
  const encrypted = ssl.passphrase !== undefined;
  if (encrypted && (ssl.key === undefined || typeof ssl.passphrase !== 'string' || !ssl.passphrase ||
      Buffer.byteLength(ssl.passphrase) > 16384 || ssl.passphrase.includes('\0'))) {
   throw error('Enter a client identity passphrase for an encrypted private key.');
  }
  if (ssl.cert !== undefined) {
   secure.cert = pem(ssl.cert, 'client certificate');
   secure.key = pem(ssl.key, 'client private key');
   if (encrypted && !/-{5}BEGIN ENCRYPTED PRIVATE KEY-{5}|^Proc-Type: 4,ENCRYPTED\r?$/m.test(secure.key)) {
    throw error('Select an encrypted PEM private key for this client identity.');
   }
   try {
    const certificate = new crypto.X509Certificate(secure.cert);
    const key = crypto.createPrivateKey({ key: secure.key, passphrase: ssl.passphrase });
    if (!certificate.checkPrivateKey(key)) throw Error('key mismatch');
   } catch {
    throw error(encrypted ? 'Use a matching encrypted client certificate/private-key pair and the correct passphrase.' :
     'Use a matching unencrypted PEM client certificate/private-key pair.');
   }
   if (encrypted) secure.passphrase = ssl.passphrase;
  }
  options.host=expected;options.ssl=secure;
 }
 const endpoint=resource?.endpoint||(expected!==config.host?{host:config.host,port:config.port??3306}:null);
 if(endpoint)options.stream=()=>net.createConnection({host:endpoint.host,port:endpoint.port});
 if(resource)resource.claimed=true;
 return{options,dispose:resource?.dispose||(async()=>{})};
}
module.exports={connectionSecurity,bindConnectionResource,identifyConnection,connectionProfile,dnsName};
