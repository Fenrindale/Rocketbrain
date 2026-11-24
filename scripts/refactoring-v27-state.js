'use strict';

const { buildStateFixture, runStateFixture } = require('./refactoring-v25-state');

if (require.main === module) runStateFixture(27).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});

module.exports = { buildStateV27: java => buildStateFixture(java, 27) };
