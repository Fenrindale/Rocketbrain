'use strict';

const { runTableTransferVerificationChecks } = require('./table-transfer-verification-host');

function runTableTransferHistoryChecks(api, vscode, checks) {
  return runTableTransferVerificationChecks(api, vscode, checks, { expanded: true });
}

module.exports = { runTableTransferHistoryChecks };
