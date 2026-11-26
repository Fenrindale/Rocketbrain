'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { populate, rebuild, runJdbc, kotlinCaller } = require('./mixed-type-rename-fixture');

const input = path.resolve(__dirname, '../fixtures/java/mixed-nullability');
const javaFile = path.join('src/main/java/mixed/rename/contract/Names.java');
const kotlinFile = path.join('src/main/kotlin/mixed/rename/contract/InteropCalls.kt');
const jspecify = "    implementation 'org.jspecify:jspecify:1.0.1'";
const calls = {
  maybe: ['Names.maybe()?.length', 'Names.maybe().length'],
  demand: ['Names.demand(value ?: "")', 'Names.demand(value)'],
  checked: ['Names.checked<String>(value ?: "")', 'Names.checked<String?>(value)'],
  items: ['Names.items()[0]?.length', 'Names.items()[0].length'],
  ordinary: ['    value?.trim()', '    value.trim()']
};

async function replace(file, before, after) {
  const text = await fs.readFile(file, 'utf8');
  if (text.split(before).length !== 2) throw Error('Unexpected mixed fixture content.');
  await fs.writeFile(file, text.replace(before, after));
}

async function prepareNullabilityFixture(root, tools) {
  await populate(root, tools, async () => {
    for (const [source, target] of [['Names.java', javaFile], ['InteropCalls.kt', kotlinFile]]) {
      const file = path.join(root, target);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.copyFile(path.join(input, source), file, fs.constants.COPYFILE_EXCL);
    }
    await replace(path.join(root, 'build.gradle'), 'dependencies {', 'dependencies {\n' + jspecify);
    await replace(path.join(root, kotlinCaller), '= Invoice(amount)', '= Invoice(mixed.rename.contract.Names.checked(amount))');
  });
}

async function brokenCalls(root, names = Object.keys(calls)) {
  const file = path.join(root, kotlinFile);
  for (const name of names) await replace(file, ...calls[name]);
  return fs.readFile(file, 'utf8');
}

async function restoreCalls(root, tools) {
  await fs.copyFile(path.join(input, 'InteropCalls.kt'), path.join(root, kotlinFile));
  await rebuild(root, tools);
}

module.exports = { javaFile, kotlinFile, prepareNullabilityFixture, brokenCalls, restoreCalls, runJdbc };
