'use strict';
const fs = require('node:fs');
const vscode = require('vscode');
const { runJavaDebugChecks } = require('./java-debug-host');
const { runJavaAdvancedDebugChecks } = require('./java-debug-advanced-host');
const { runSpringProjectDebugChecks } = require('./java-debug-spring-host');
async function run() {
  const extension = vscode.extensions.getExtension('rocketbrain-local.rocketbrain-java-debug-test');
  const api = await extension.activate(), checks = [];
  try {
    const result = process.env.ROCKETBRAIN_SPRING_PROJECT_CONFIG ? await runSpringProjectDebugChecks(api, vscode, checks) : process.env.ROCKETBRAIN_JAVA_ADVANCED_DEBUG_TEST ? await runJavaAdvancedDebugChecks(api, vscode, checks) : await runJavaDebugChecks(api, vscode, checks);
    const report = { vscode: vscode.version, ownProvider: true, isolatedProfile: true, independentRuntime: api.java.getState(), checks, result };
    fs.writeFileSync(process.env.ROCKETBRAIN_DEBUG_HOST_OUTPUT, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error.stack || error);
    fs.writeFileSync(process.env.ROCKETBRAIN_DEBUG_HOST_OUTPUT + '.failure.json', JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
    throw error;
  } finally { await api.java.stop(); }
}
module.exports = { run };
