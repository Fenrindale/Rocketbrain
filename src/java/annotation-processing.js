'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const LOMBOK_VERSION = '1.18.48';
const LOMBOK_SHA256 = '85477a4655ebb2c074a9099cfb749be454449fee564d4282610df1b85f7c508b';
const LOMBOK_SIZE = 2055065;
const LOMBOK_FILE = 'lombok-'+LOMBOK_VERSION+'.jar';
const LOMBOK_URL = 'https://repo.maven.apache.org/maven2/org/projectlombok/lombok/'+LOMBOK_VERSION+'/'+LOMBOK_FILE;

function verifyLombok(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== LOMBOK_SIZE) {
    throw Error('Select the official regular Lombok '+LOMBOK_VERSION+' JAR.');
  }
  const bytes = fs.readFileSync(file);
  if (bytes.length !== LOMBOK_SIZE || crypto.createHash('sha256').update(bytes).digest('hex') !== LOMBOK_SHA256) {
    throw Error('Lombok '+LOMBOK_VERSION+' editor agent checksum does not match the official release.');
  }
  return bytes;
}

function stageLombokAgent(configured,storagePath) {
  if (configured === undefined || configured === '') return null;
  if (typeof configured !== 'string' || !path.isAbsolute(configured) || !/\.jar$/i.test(configured)) {
    throw Error('Use an absolute local JAR path for rocketbrain.java.annotationProcessing.lombokJar.');
  }
  if (!fs.existsSync(configured)) throw Error('The configured Lombok editor JAR could not be found.');
  const bytes = verifyLombok(configured);
  const directory = path.join(storagePath,'verified-java-agents');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Use physical extension storage for the Lombok editor agent.');
  const file = path.join(fs.realpathSync(directory),LOMBOK_FILE);
  if (/[=\r\n]/.test(file)) throw Error('The Java agent storage path contains unsupported characters.');
  if (!fs.existsSync(file)) {
    const temporary = path.join(path.dirname(file),'.lombok-'+crypto.randomUUID()+'.jar');
    try {
      fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});
      try { fs.renameSync(temporary,file); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally {
      fs.rmSync(temporary,{force:true});
    }
  }
  verifyLombok(file);
  return {file,version:LOMBOK_VERSION,sha256:LOMBOK_SHA256};
}

module.exports = { LOMBOK_VERSION,LOMBOK_SHA256,LOMBOK_URL,stageLombokAgent };
