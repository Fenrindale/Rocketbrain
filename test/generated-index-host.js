'use strict';

const { runGeneratedColumnChecks, verifyGeneratedColumns } = require('./generated-columns-host');
const { MysqlService } = require('../src/db/mysql');
const fs = require('node:fs/promises');

const options = { indexCoverage: true };
const approvals = { allowImplicitCommit: true, allowDestructive: true, allowDependencyChanges: true,
  allowUnverifiedDependencies: true, autoRecover: true };

function runGeneratedIndexChecks(api, vscode, checks) {
  return runGeneratedColumnChecks(api, vscode, checks, options);
}

async function verifyGeneratedIndexBackend() {
  const runtime = JSON.parse(await fs.readFile(process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG, 'utf8'));
  let db;
  return verifyGeneratedColumns(runtime, {
    async connect(config) { db = new MysqlService(config); },
    disconnect: () => db?.dispose(),
    open: table => db.openTableDesigner(table ? { table } : {}),
    review: (modelId, draft) => db.previewTableDesign({ modelId, draft }),
    apply: (_modelId, reviewed) => db.applyTableDesign({ reviewId: reviewed.reviewId, ...approvals }),
    recover: (_modelId, reviewed) => db.recoverSchemaRebuild({ operationId: reviewed.plan.id, ...approvals })
  }, options);
}

module.exports = { runGeneratedIndexChecks, verifyGeneratedIndexBackend };
if (require.main === module) verifyGeneratedIndexBackend().then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.stack); process.exitCode = 1; });
