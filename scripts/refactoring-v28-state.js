'use strict';

const { buildStateFixture, runStateFixture } = require('./refactoring-v25-state');

if (require.main === module) {
  runStateFixture(28).catch(error => {
    console.error(error.stack);
    process.exitCode = 1;
  });
}

module.exports = { buildStateV28: java => buildStateFixture(java, 28) };
