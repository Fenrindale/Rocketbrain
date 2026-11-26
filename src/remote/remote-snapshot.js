'use strict';

const path = require('node:path');
const sftp = require('./sftp-channel');
const ftps = require('./ftps-channel');
const { captureDirectory, directoryPath } = require('./directory-snapshot');

async function captureRemoteDirectory(input, signal, webdav) {
  const directory = directoryPath(input.directory), credential = input.credential;
  const limit = AbortSignal.any([AbortSignal.timeout(25000), ...(signal ? [signal] : [])]);
  const descendant = (base, name) => base ? path.posix.join(base, name) : name;
  const { protocol } = input;
  if (protocol === 'webdav') {
    if (!webdav?.snapshot) throw Error('The WebDAV connection is unavailable in this workspace.');
    const configured = input.profile;
    const remoteDirectory = [configured.remoteDirectory, directory].filter(Boolean).join('/');
    return webdav.snapshot({ ...configured, remoteDirectory, password: credential }, { signal: limit });
  }
  if (protocol === 'sftp') {
    const profile = sftp.profileFor(input.profile);
    return sftp.withSftp(profile, credential, limit, async peer => {
      const data = await captureDirectory(() => peer.list(directory, true),
        row => peer.read(descendant(directory, row.name)), { signal: limit });
      return { ...data, identity: ['sftp', profile, directory] };
    });
  }
  if (protocol === 'ftps') {
    const profile = ftps.profileFor(input.profile);
    return ftps.withFtps(profile, credential, limit, async peer => {
      const data = await captureDirectory(async () => (await peer.list(directory)).map(row => ({
        ...row, tag: [row.unique, row.modified],
      })), row => peer.file(descendant(directory, row.name)), { signal: limit });
      return { ...data, identity: ['ftps', profile, directory, peer.trust] };
    });
  }
  throw Error('Choose an SFTP, FTPS, or WebDAV route for change review.');
}

module.exports = { captureRemoteDirectory };
