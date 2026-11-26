'use strict';

const { execFile } = require('node:child_process');

const loopback = '127.0.0.1';
const validPort = value => Number.isInteger(value) && value > 0 && value <= 65535;
const trustedPid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;

function parseDarwinTcpListeners(text) {
  const sockets = new Map();
  if (!/^Proto\s+Recv-Q\s+Send-Q\s+Local Address\s+Foreign Address/mu.test(text)) {
    throw Error('macOS returned an unrecognized TCP socket table.');
  }
  for (const line of String(text).split(/\r?\n/u)) {
    const [protocol, received, queued, address, remote, state] = line.trim().split(/\s+/u);
    if (!/^tcp(?:4|6|46)?$/u.test(protocol)) continue;
    if (!/^\d+$/u.test(received) || !/^\d+$/u.test(queued) || !address || !remote || !state) {
      throw Error('macOS returned a malformed TCP socket record.');
    }
    if (state !== 'LISTEN') continue;
    const match = /^(\S+)\.(\d{1,5})$/u.exec(address), port = Number(match?.[2]);
    if (!validPort(port)) throw Error('macOS returned an invalid TCP listener port.');
    const exact = protocol === 'tcp4' && match[1] === loopback && remote === '*.*';
    sockets.set(port,{exact:exact && !sockets.has(port)});
  }
  return sockets;
}

function parseDarwinSocketOwners(text, uid) {
  const owners = new Map();
  let owner;
  if (!Number.isInteger(uid) || uid < 0) throw Error('macOS did not report the debugger user ID.');
  for (const line of String(text).split('\n')) {
    if (!line) continue;
    if (!line.endsWith('\0')) throw Error('macOS returned an incomplete listener ownership record.');
    const fields = line.slice(0,-1).split('\0');
    if (fields[0].startsWith('p')) {
      const pid = Number(/^p([1-9]\d{0,9})$/u.exec(fields[0])?.[1]);
      if (!trustedPid(pid)) throw Error('macOS returned an invalid listener process ID.');
      const user = fields.filter(value=>value.startsWith('u'));
      owner = {pid,own:user.length===1 && user[0]==='u'+uid};
      continue;
    }
    if (!owner || !/^f\d+$/u.test(fields[0])) throw Error('macOS returned an unordered listener ownership record.');
    const addr = fields.filter(value=>value.startsWith('n'));
    const types = fields.filter(value=>value.startsWith('t'));
    if (addr.length!==1 || types.length!==1) throw Error('macOS returned an ambiguous listener ownership record.');
    const match = /^n(.+):(\d{1,5})$/u.exec(addr[0]), port = Number(match?.[2]);
    if (!validPort(port)) throw Error('macOS returned an invalid owned listener port.');
    const exact = owner.own && types[0]==='tIPv4' && match[1]===loopback;
    owners.set(port,{pid:exact && !owners.has(port) ? owner.pid : null});
  }
  return owners;
}

function correlateDarwinListeners(sockets, owners) {
  return new Map([...sockets].map(([port,{exact}])=>[port,{pid:exact ? owners.get(port)?.pid || null : null}]));
}

function observe(file,args,signal,empty=false) {
  return new Promise((resolve,reject)=>{
    const child = execFile(file,args,{encoding:'utf8',timeout:3500,maxBuffer:512*1024,signal,
      env:{...process.env,LC_ALL:'C'}},(error,stdout,stderr)=>{
      if (!error || empty && error.code===1 && !stdout && !stderr) resolve(stdout);
      else reject(Error('macOS could not verify TCP listener ownership with '+file.split('/').at(-1)+'.',{cause:error}));
    });
    child.stdin.on('error',()=>{});
    child.stdin.end();
  });
}

async function readDarwinListeners({signal,port}={}) {
  if (port!==undefined && !validPort(port)) throw Error('Verify a valid TCP listener port.');
  const [network, owners] = await Promise.all([
    observe('/usr/sbin/netstat',['-an','-p','tcp'],signal),
    observe('/usr/sbin/lsof',['-nP','-a','-iTCP'+(port===undefined?'':':'+port),'-sTCP:LISTEN','-F0pufnt'],signal,true)
  ]);
  return correlateDarwinListeners(parseDarwinTcpListeners(network),parseDarwinSocketOwners(owners,process.getuid?.()));
}

module.exports = {parseDarwinTcpListeners,parseDarwinSocketOwners,correlateDarwinListeners,readDarwinListeners};
