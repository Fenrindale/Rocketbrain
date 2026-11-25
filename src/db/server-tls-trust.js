'use strict';

const tls=require('node:tls');
const {createHash,X509Certificate}=require('node:crypto');
const expectedByConfig=new WeakMap();
const hash=value=>createHash('sha256').update(value).digest('hex');

function caFingerprint(ssl) {
  return typeof ssl?.ca==='string' ? hash(ssl.ca) : null;
}

function issuingFingerprint(leaf,ssl) {
  if(leaf.issuerCertificate?.raw)return hash(leaf.issuerCertificate.raw);
  const blocks=ssl.ca?.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
  if(blocks.length>256)return null;
  const issuers=new Set();
  for(const pem of blocks) {
    try {
      const certificate=new X509Certificate(pem);
      if(leaf.checkIssued(certificate)&&leaf.verify(certificate.publicKey))issuers.add(hash(certificate.raw));
    } catch { /* The strict handshake already validated the chosen certificate chain. */ }
  }
  return issuers.size===1?issuers.values().next().value:null;
}

function observeServerTls(socket,options) {
  if(options?.ssl?.rejectUnauthorized!==true||options.ssl.verifyIdentity!==true||
     !(socket instanceof tls.TLSSocket)||!socket.encrypted||!socket.authorized||socket.destroyed)return null;
  try {
    const leaf=socket.getPeerX509Certificate(),hostname=options.host;
    if(!leaf?.raw||!leaf.checkHost(hostname))return null;
    const notBefore=new Date(leaf.validFrom).toISOString(),notAfter=new Date(leaf.validTo).toISOString();
    if(Date.now()<Date.parse(notBefore)||Date.now()>=Date.parse(notAfter))return null;
    const protocol=socket.getProtocol();
    if(!protocol)return null;
    return {hostname,leafSha256:hash(leaf.raw),issuerSha256:issuingFingerprint(leaf,options.ssl),
      caMaterialSha256:caFingerprint(options.ssl),notBefore,notAfter,protocol};
  } catch {return null;}
}

function sameReviewedPeer(current,reviewed) {
  return Boolean(current&&reviewed&&current.hostname===reviewed.hostname&&current.leafSha256===reviewed.leafSha256&&
    current.issuerSha256===reviewed.issuerSha256&&current.caMaterialSha256===reviewed.caMaterialSha256);
}

function expectReviewedTls(config,reviewed) {
  expectedByConfig.set(config,Object.freeze({...reviewed}));
}

const reviewedTls=config=>expectedByConfig.get(config);
const changedPeer=()=>Object.assign(Error('The server TLS certificate or trust material changed after review.'),
  {code:'ROCKETBRAIN_TLS_REVIEW_CHANGED'});

function guardBeforeAuthentication(connection,options,expected) {
  const upgrade=connection.startTLS;
  if(typeof upgrade!=='function')throw changedPeer();
  const result={evidence:null,error:null};
  connection.startTLS=function(onSecure) {
    return upgrade.call(this,error=>{
      if(error)return onSecure(error);
      result.evidence=observeServerTls(this.stream,options);
      if(sameReviewedPeer(result.evidence,expected))return onSecure();
      result.error=changedPeer();
      // mysql2 annotates the callback error. Retain our own bounded error for the caller.
      return onSecure(Error(result.error.message));
    });
  };
  return result;
}

module.exports={caFingerprint,observeServerTls,sameReviewedPeer,expectReviewedTls,reviewedTls,guardBeforeAuthentication,changedPeer};
