const { test, expect } = require('@playwright/test');
const variants = ['P', 'M', 'G', 'GG', 'XG'].map((size, i) => ({
  id: String(i + 1),
  blingId: String(201 + i),
  name: `Tamanho:${size}`,
  sku: `TEST-${size}`,
  stock: i,
  preco: 100,
}));
const product = {
  blingId: '101',
  name: 'Bermuda de teste',
  sku: 'TEST',
  price: 100,
  active: true,
  availableStock: 10,
  variants,
};
test.beforeEach(async ({ page }) => {
  await page.route('https://fonts.**', (r) => r.abort());
  await page.route('https://cdn.jsdelivr.net/**', (r) => r.abort());
  // UI-only fixture. Backend authorization is exercised separately in Deno.
  await page.route('**/gestao-auth.js', (r) =>
    r.fulfill({
      contentType: 'text/javascript',
      body:
        `window.GestaoAuth={isConfigured:()=>true,getSession:async()=>({access_token:'test-session',user:{id:'test-user',email:'test@example.invalid'}}),onAuthStateChange:()=>{},signOut:async()=>{},signIn:async()=>{}};`,
    }));
  await page.route('**/functions/v1/**', (r) => {
    const name = new URL(r.request().url()).pathname.split('/').pop();
    const data = name === 'admin-dashboard-summary'
      ? {
        ok: true,
        summary: { revenueToday: 0, revenueMonth: 0, newOrders: 1, ordersToday: 1, dailyRevenue: [] },
      }
      : name === 'admin-products'
      ? { ok: true, items: [product], total: 1 }
      : name === 'admin-product-detail'
      ? {
        ok: true,
        revision: 'rev-test',
        product: {
          nome: product.name,
          sku: 'TEST',
          preco: 100,
          ativo: true,
          variacoes: variants.map((v) => ({ ...v, nome: v.name, ativo: true })),
        },
        capabilities: { images: false },
      }
      : name === 'admin-categories'
      ? { ok: true, items: [] }
      : name === 'admin-deposits'
      ? { ok: true, items: [{ id: '1', descricao: 'Geral', padrao: true }], defaultDepositId: '1' }
      : name === 'admin-stock-history'
      ? { ok: true, balances: [], operations: [] }
      : { ok: true, items: [], total: 0 };
    return r.fulfill({ json: data });
  });
});
test('unauthorized session is returned to login by backend rejection', async ({ page }) => {
  await page.route('**/admin-dashboard-summary', (r) => r.fulfill({ status: 401, json: { ok: false } }));
  await page.goto('/gestao/');
  await expect(page.locator('[data-view="login"]')).toBeVisible();
  await expect(page.locator('[data-view="app"]')).toBeHidden();
});
test('variant editor preserves existing IDs and submits updated price', async ({ page }) => {
  let saved;
  await page.route('**/admin-product-update', (r) => {
    saved = r.request().postDataJSON();
    expect(r.request().headers().authorization).toBe('Bearer test-session');
    return r.fulfill({ json: { ok: true, message: 'Produto salvo.' } });
  });
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-edit]').click();
  await expect(page.locator('.variant-edit-row')).toHaveCount(5);
  await expect(page.locator('[data-product-form-submit]')).toBeEnabled();
  await page.locator('[data-v-price]').nth(1).fill('120');
  await page.locator('[data-product-form-submit]').click();
  await expect.poll(() => saved?.variacoes?.[1]?.preco).toBe(120);
  expect(saved.variacoes[1].id).toBe('2');
  expect(saved.operationKey).toMatch(/^[a-f0-9-]{36}$/);
  expect(saved.revision).toBe('rev-test');
  expect(saved.images).toBeUndefined();
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
});
test('stock balance targets selected size, allows zero, and retries with same command', async ({ page }) => {
  const calls = [];
  await page.route('**/admin-stock-adjust', (r) => {
    calls.push(r.request().postDataJSON());
    return r.fulfill({
      status: calls.length === 1 ? 503 : 200,
      json: calls.length === 1 ? { ok: false } : { ok: true, message: 'Saldo sincronizado.' },
    });
  });
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-stock]').click();
  await page.locator('[data-stock-sku]').selectOption('202');
  await page.locator('[data-stock-deposit-select]').selectOption('1');
  await page.locator('[data-stock-form] input[name="quantidade"]').fill('0');
  await page.locator('[data-stock-form-submit]').click();
  await expect(page.locator('[data-stock-form-error]')).toBeVisible();
  await page.locator('[data-stock-form-submit]').click();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls[0].blingProductId).toBe('202');
  expect(calls[0].quantidade).toBe(0);
  expect(calls[0].operacao).toBe('balanco');
  expect(calls[0].operationKey).toBe(calls[1].operationKey);
  await expect(page.locator('[data-stock-drawer]')).toBeHidden();
});
