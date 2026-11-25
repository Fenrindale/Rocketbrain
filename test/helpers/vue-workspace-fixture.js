'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const template = path.resolve(__dirname, '../fixtures/vue-workbench');
const names = ['index.html', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'vite.config.mjs',
  'src/main.ts', 'src/App.vue', 'src/CountBadge.vue'];
const kind = 'RocketbrainOwnedVueFixture-v1';

async function stageVueFixture(parent) {
  const boundary = await fs.realpath(parent);
  const root = await fs.mkdtemp(path.join(boundary, 'rocketbrain-vue-'));
  await fs.mkdir(path.join(root, 'src'));
  for (const name of names) await fs.copyFile(path.join(template, name), path.join(root, name));
  await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ kind, id: path.basename(root) }), { flag: 'wx' });
  return root;
}

async function ownedVueFixture(candidate) {
  const root = await fs.realpath(candidate);
  const owner = JSON.parse(await fs.readFile(path.join(root, 'owner.json'), 'utf8'));
  if (owner?.kind !== kind || owner.id !== path.basename(root) || !/^rocketbrain-vue-[A-Za-z0-9]{6}$/.test(owner.id)) {
    throw Error('Use a disposable Vue fixture staged by Rocketbrain.');
  }
  return root;
}

if (require.main === module) stageVueFixture(process.argv[2]).then(root => console.log(root))
  .catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { stageVueFixture, ownedVueFixture };
