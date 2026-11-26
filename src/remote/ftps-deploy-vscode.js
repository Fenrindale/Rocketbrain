'use strict';

const { createFtpsDeployment } = require('./ftps-deploy');
const { profileFor, relativePath } = require('./ftps-channel');
const { registerRemoteDeployment } = require('./remote-deployment-vscode');

function registerFtpsDeployment(vscode) {
  return registerRemoteDeployment(vscode, {
    protocol: 'FTPS', suffix: 'Ftps', createCore: createFtpsDeployment, profileFor, relativePath,
    identity: profile => 'TLS ' + profile.tlsServerName + (profile.certificateSha256 ? ' · SHA-256 ' + profile.certificateSha256 : ''),
    credentialTitle: () => 'FTPS Password',
    uploadChoice: 'Review a local file for unique upload',
  });
}

module.exports = { registerFtpsDeployment };
