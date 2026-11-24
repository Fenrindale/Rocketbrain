'use strict';

const { buildConditionFixture, runConditionFixture } = require('./refactoring-spring-condition-fixture');

if (require.main === module) runConditionFixture(25).catch(error => {
  console.error(error.stack);
  process.exitCode = 1;
});
module.exports = { buildSpringV25: java => buildConditionFixture(java, 25) };
