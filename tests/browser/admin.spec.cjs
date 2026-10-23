const { test, expect } = require('./isolated-test.cjs');
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
  await page.route('**/gestao-auth.js*', (r) =>
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

async function newProduct(page, images = false) {
  await page.route('**/admin-product-detail*', (r) => r.fulfill({
    json: { ok: true, product: {}, revision: null, capabilities: { images, binaryUpload: false } },
  }));
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-new]').click();
  await expect(page.locator('[data-product-form-submit]')).toBeEnabled();
}
async function fillProduct(page) {
  await page.locator('[name="nome"]').fill('Conjunto feminino — produto de teste');
  await page.locator('[name="sku"]').fill('TEST-NOVO');
  await page.locator('[name="preco"]').fill('149.90');
}
test('draft persists inactive and publish persists active only after confirmation from API', async ({ page }) => {
  const writes = [];
  await page.route('**/admin-product-create', async (r) => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ json: { ok: true, blingId: '901', message: 'Cadastro confirmado no teste.' } });
  });
  await newProduct(page);
  await fillProduct(page);
  await page.locator('[data-save-draft]').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].ativo).toBe(false);
  expect(writes[0].images).toBeUndefined();
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
  await page.locator('[data-product-new]').click();
  await expect(page.locator('[data-product-form-submit]')).toBeEnabled();
  await fillProduct(page);
  await page.locator('[data-product-form-submit]').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].ativo).toBe(true);
  expect(writes[1].preco).toBe(149.9);
});
test('failed save keeps values, displays an error and retries the same operation', async ({ page }) => {
  const writes = [];
  await page.route('**/admin-product-create', (r) => {
    writes.push(r.request().postDataJSON());
    return r.fulfill({ status: 503, json: { ok: false, message: 'Indisponível' } });
  });
  await newProduct(page);
  await fillProduct(page);
  await page.locator('[data-save-draft]').click();
  await expect(page.locator('[data-product-form-error]')).toBeVisible();
  await expect(page.locator('[name="nome"]')).toHaveValue('Conjunto feminino — produto de teste');
  await expect(page.locator('[data-product-status]')).toHaveText('Não salvo');
  await page.locator('[data-save-draft]').click();
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[0].operationKey).toBe(writes[1].operationKey);
});
test('gallery order, main photo and deletion persist without allowing unsafe links', async ({ page }) => {
  let saved;
  await page.route('https://photos.example.invalid/**', (r) => r.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' }));
  await page.route('**/admin-product-create', (r) => {
    saved = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, message: 'Salvo no teste.' } });
  });
  await newProduct(page, true);
  await fillProduct(page);
  await page.locator('[data-photo-add]').click();
  await page.locator('[name="images"]').fill('https://photos.example.invalid/1.jpg\nhttps://photos.example.invalid/2.jpg\nhttps://photos.example.invalid/3.jpg');
  await page.locator('[data-photo-main="2"]').click();
  await expect(page.locator('[data-preview-image]')).toHaveAttribute('src', 'https://photos.example.invalid/3.jpg');
  await page.locator('[data-photo-remove="1"]').click();
  await page.locator('[data-photo-right="0"]').click();
  await page.locator('[data-save-draft]').click();
  await expect.poll(() => saved?.images).toEqual(['https://photos.example.invalid/2.jpg', 'https://photos.example.invalid/3.jpg']);
});
test('validation rejects duplicate combinations and invalid image protocols before writing', async ({ page }) => {
  let writes = 0;
  await page.route('**/admin-product-create', (r) => { writes++; return r.fulfill({ json: { ok: true } }); });
  await newProduct(page, true);
  await fillProduct(page);
  for (let i = 0; i < 2; i++) {
    await page.locator('[data-add-variant]').click();
    await page.locator('[data-v-size]').nth(i).fill('M');
    await page.locator('[data-v-sku]').nth(i).fill('TEST-M-' + i);
  }
  await page.locator('[data-save-draft]').click();
  await expect(page.locator('[data-product-form-error]')).toContainText('combinações repetidas');
  await page.locator('[data-v-size]').nth(1).fill('G');
  await page.locator('[data-photo-add]').click();
  await page.locator('[name="images"]').fill('javascript:alert(1)');
  await page.locator('[data-save-draft]').click();
  await expect(page.locator('[data-product-form-error]')).toContainText('HTTPS');
  expect(writes).toBe(0);
});
test('detail failures lock saving and expired authorization hides the entire editor', async ({ page }) => {
  await page.route('**/admin-product-detail*', (r) => r.fulfill({ status: 503, json: { ok: false } }));
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-new]').click();
  await expect(page.locator('[data-product-form-error]')).toBeVisible();
  await expect(page.locator('[data-save-draft]')).toBeDisabled();
  await expect(page.locator('[data-product-form-submit]')).toBeDisabled();
  await page.locator('[data-product-drawer-close]').first().click();
  await page.route('**/admin-product-detail*', (r) => r.fulfill({ status: 401, json: { ok: false } }));
  await page.locator('[data-product-new]').click();
  await expect(page.locator('[data-view="login"]')).toBeVisible();
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
});
test('product preview, navigation and responsive layout use only the entered data', async ({ page }, testInfo) => {
  const scriptErrors = [];
  page.on('pageerror', (error) => scriptErrors.push(error.message));
  const fs = require('node:fs');
  const path = require('node:path');
  await page.route('https://photos.example.invalid/**', (r) => r.fulfill({
    contentType: 'image/webp', body: fs.readFileSync(path.resolve('assets/img/optimized/feminino-editorial-480.webp')),
  }));
  await newProduct(page, true);
  await fillProduct(page);
  await page.locator('[name="marca"]').fill('Anarosa');
  await page.locator('[name="descricaoCurta"]').fill('Dados demonstrativos exclusivos do teste local.');
  await page.locator('[name="descricaoComplementar"]').fill('Descrição de teste para verificar a prévia e o preenchimento do cadastro.');
  await page.locator('[data-photo-add]').click();
  await page.locator('[name="images"]').fill('https://photos.example.invalid/1.jpg\nhttps://photos.example.invalid/2.jpg\nhttps://photos.example.invalid/3.jpg');
  await page.locator('.image-url-editor summary').click();
  await page.locator('[data-size-grid]').click();
  await expect(page.locator('[data-preview-name]')).toHaveText('Conjunto feminino — produto de teste');
  await expect(page.locator('[data-preview-price]')).toContainText('149,90');
  await expect(page.locator('[data-checklist-count]')).toHaveText('5 de 5 completos');
  await expect(page.locator('[data-product-status]')).toHaveText('Não salvo');
  await expect(page.locator('[data-product-form]')).not.toContainText('avaliações');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.fonts.ready);
  const dir = path.resolve('docs/screenshots/gestao-2026-10-21');
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, testInfo.project.name + '.png'), fullPage: true });
  if (testInfo.project.name === 'desktop') {
    for (const width of [320, 768, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  if (testInfo.project.name === 'mobile') await page.locator('[data-hamburger]').click();
  await page.locator('[data-nav="pedidos"]').click();
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
  await expect(page.locator('[data-page="pedidos"]')).toBeVisible();
  expect(scriptErrors).toEqual([]);
});
