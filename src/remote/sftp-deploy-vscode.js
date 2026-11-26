'use strict';

const { createSftpDeployment } = require('./sftp-deploy');
const { profileFor, relativePath } = require('./sftp-channel');
const { registerRemoteDeployment } = require('./remote-deployment-vscode');

function registerSftpDeployment(_context, vscode) {
  return registerRemoteDeployment(vscode, {
    protocol: 'SFTP', suffix: 'Sftp', createCore: createSftpDeployment, profileFor, relativePath,
    identity: profile => profile.hostFingerprint,
    credentialTitle: profile => profile.authentication === 'password' ? 'SFTP Password' : 'SFTP Key Passphrase',
    uploadChoice: 'Review a local file for upload',
  });
}

module.exports = { registerSftpDeployment };
