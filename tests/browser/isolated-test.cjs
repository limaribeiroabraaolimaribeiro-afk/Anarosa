const { test: base, expect } = require('@playwright/test');

// Every test starts with outbound access denied. Individual fixtures may fulfill
// a provider request, but an unhandled request can only reach the local server.
const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === 'http://127.0.0.1:5500'
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    await use(context);
  },
});

module.exports = { test, expect };
