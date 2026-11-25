'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

async function agentProfiles(parent,node,sdk) {
  const root = await fs.realpath(parent);
  for (const binary of [node,sdk]) {
    assert.ok(path.isAbsolute(binary) && (await fs.stat(binary)).isFile(),'Configure the standalone Node and ACP SDK fixture paths.');
  }
  const directory = await fs.mkdtemp(path.join(root,'rb-acp-peers-'));
  const peer = path.resolve(__dirname,'../fixtures/acp-peer.mjs');
  const profile = (label,own,other) => ({ label,executable:node,args:[peer,sdk,label,directory,own,...(other?[other]:[])] });
  const profiles = [profile('First Peer','first','second'),profile('Second Peer','second','first')];
  return { profiles,directory,solo:profile('Cancel Peer','cancel-start'),
    async close() {
      const current = await fs.realpath(directory);
      assert.equal(path.relative(root,path.dirname(current)),'');
      assert.ok(path.basename(current).startsWith('rb-acp-peers-'));
      await fs.rm(current,{recursive:true,maxRetries:6,retryDelay:200});
    }
  };
}

module.exports = { agentProfiles };
