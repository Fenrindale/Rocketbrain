'use strict';

const { buildStateFixture, runStateFixture } = require('./refactoring-v25-state');

if (require.main === module) runStateFixture(26).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { buildStateV26: java => buildStateFixture(java, 26) };
