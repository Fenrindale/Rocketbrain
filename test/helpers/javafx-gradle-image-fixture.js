'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { execFileSync } = require('node:child_process');

function populate(root) {
  const fixtures = path.join(__dirname, '../fixtures');
  fs.cpSync(path.join(fixtures, 'javafx-gradle-app'), root, { recursive: true });
  fs.cpSync(path.join(fixtures, 'javafx-app/src'), path.join(root, 'src'), { recursive: true });
}

function checkLauncher(root, result) {
  assert.equal(result.code, 0);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.task, ':jlink');
  assert.equal(result.image.module, 'dev.rocketbrain.fxml');
  assert.ok(result.image.modulePayloadBytes > 1024 * 1024);
  const imageDirectory = fileURLToPath(result.image.directoryUri);
  const java = fileURLToPath(result.image.javaUri);
  const launcher = fileURLToPath(result.image.launcherUri);
  assert.equal(path.relative(root, imageDirectory), path.join('build', 'rocketbrain-gradle-fxml'));
  const options = { encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: path.dirname(launcher) };
  const modules = execFileSync(java, ['--list-modules'], options);
  assert.match(modules, /^dev\.rocketbrain\.fxml(?:@[^\r\n]*)?\r?$/mu);
  assert.match(modules, /^javafx\.fxml(?:@[^\r\n]*)?\r?$/mu);
  const expected = 'fxml-gradle' + (process.platform === 'win32' ? '.bat' : '');
  assert.equal(path.basename(launcher), expected);
  const output = process.platform === 'win32' ?
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'fxml-gradle.bat'], options) :
    execFileSync(launcher, [], options);
  assert.match(output, /ROCKETBRAIN_FXML_OK:detail:extra:1/u);
  return { launcher: expected, module: result.image.module, imagePayloadBytes: result.image.modulePayloadBytes, output: output.trim() };
}

module.exports = { populate, checkLauncher };
