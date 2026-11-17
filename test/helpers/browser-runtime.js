'use strict';
const fs = require('node:fs');
const path = require('node:path');
function browserRuntime() {
  for (const candidate of [process.env.ROCKETBRAIN_PLAYWRIGHT_PATH, 'playwright', process.env.USERPROFILE && path.join(process.env.USERPROFILE, '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')].filter(Boolean)) {
    try {
      const chromium = require(candidate).chromium;
      const executablePath = [process.env.ROCKETBRAIN_BROWSER_PATH, chromium.executablePath(), process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')].find(value => value && fs.existsSync(value));
      if (executablePath) return { chromium, executablePath };
    } catch { /* Try an available local test runtime. */ }
  }
  return { skip: 'A local Playwright/Chromium runtime is required for the browser integration test.' };
}
module.exports = { browserRuntime };
