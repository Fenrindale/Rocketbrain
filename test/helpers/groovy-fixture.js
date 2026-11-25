'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const SOURCE = path.resolve(__dirname,'../fixtures/java/groovy-spock');
const scripts = Object.freeze({
  source:'src/main/groovy/groovyfixture/GroovyBadge.groovy',
  script:'scripts/score.groovy',
  tests:'build/test-results/test/TEST-groovyfixture.BadgeSpec.xml'
});

async function createGroovyFixture(workspace) {
  const target = await fs.mkdtemp(path.join(workspace,'rb-groovy-fixture-'));
  await fs.cp(SOURCE,target,{recursive:true});
  return target;
}

module.exports = { createGroovyFixture,scripts };
