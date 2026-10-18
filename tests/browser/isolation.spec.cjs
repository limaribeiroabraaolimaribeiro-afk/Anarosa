const { test, expect } = require('./isolated-test.cjs');

test('unhandled external requests are blocked before network access', async ({ page }) => {
  await page.goto('/assets/products/placeholder.svg');
  const failure = page.waitForEvent('requestfailed', (request) =>
    request.url() === 'https://unmocked-provider.example.invalid/never-send');
  await page.evaluate(() => fetch('https://unmocked-provider.example.invalid/never-send').catch(() => null));
  expect((await failure).failure().errorText).toContain('ERR_BLOCKED_BY_CLIENT');
});
