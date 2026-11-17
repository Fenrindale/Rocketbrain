'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { analyzeSpring } = require('../src/spring/model');
const root = path.join(__dirname, 'fixtures/spring-analysis');
function filesUnder(directory, pattern) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const file = path.join(directory, entry.name); if (entry.isDirectory()) result.push(...filesUnder(file, pattern)); else if (pattern.test(entry.name)) result.push({ uri: pathToFileURL(file).href, text: fs.readFileSync(file, 'utf8') }); }
  return result;
}
function fixtureModel(profile = 'prod', overrides = {}) { return analyzeSpring(filesUnder(path.join(root, 'src'), /\.java$/), filesUnder(path.join(root, 'config'), /\.properties$/), { activeProfiles: [profile], basePackages: ['fixtures.valid'], closedWorld: true, parameterNames: true, ...overrides }); }
module.exports = { fixtureModel, filesUnder, root };
