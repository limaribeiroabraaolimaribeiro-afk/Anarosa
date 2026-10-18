const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: 'tests/browser',
  timeout: 30000,
  reporter: [['line'], ['json', { outputFile: 'tmp/browser-results.json' }]],
  use: { baseURL: 'http://127.0.0.1:5500', headless: true },
  projects: [{ name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } }, {
    name: 'mobile',
    use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  }],
});
