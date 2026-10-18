const { test, expect } = require('./isolated-test.cjs');
const settings = {
  name: 'Anarosa',
  whatsapp: '554730911041',
  pickupAddress: 'Endereço de teste isolado',
  instagram: 'https://www.instagram.com/anarosatextil/',
  deliveryMethods: ['pickup', 'delivery'],
  paymentMethods: ['pix', 'whatsapp', 'card_on_pickup'],
  deliveryPricing: 'quote',
  deliveryPrice: 0,
  pixDiscountPercent: 0,
};
const product = {
  id: 'p1',
  blingId: '101',
  name: 'Bermuda de teste',
  slug: 'bermuda-teste',
  price: 100,
  images: [{ url: '/assets/products/placeholder.svg' }],
  description: 'Composição e medidas informadas pelo fornecedor.',
  category: { slug: 'bermudas', name: 'Bermudas' },
  stock: 2,
  available: true,
  variants: [{
    id: 'v1',
    blingId: '201',
    sku: 'TEST-P',
    name: 'Tamanho:P',
    size: 'P',
    price: 100,
    stock: 0,
    available: false,
  }, {
    id: 'v2',
    blingId: '202',
    sku: 'TEST-M',
    name: 'Tamanho:M',
    size: 'M',
    price: 110,
    stock: 2,
    available: true,
  }],
};
test.beforeEach(async ({ page }) => {
  await page.route('**/fonts.googleapis.com/**', (r) => r.abort());
  await page.route('**/fonts.gstatic.com/**', (r) => r.abort());
  await page.route('**/functions/v1/**', (r) => {
    const path = new URL(r.request().url()).pathname.split('/').pop();
    const data = path === 'storefront-settings'
      ? { ok: true, settings }
      : path === 'storefront-products'
      ? { ok: true, items: [product], total: 1 }
      : path === 'storefront-product'
      ? { ok: true, product }
      : path === 'storefront-order-status'
      ? { ok: true, uiStatus: 'ainda_nao_confirmado', total: 110, payment: {}, deliveryMethod: 'pickup' }
      : { ok: false };
    return r.fulfill({ json: data });
  });
});
test('variation: sold-out P does not block M; keyboard modal and persistent cart', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-product-detail]:visible').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('[data-variant-option="v1"]')).toBeDisabled();
  await expect(page.locator('[data-detail-add]')).toBeDisabled();
  await page.locator('[data-variant-option="v2"]').click();
  await expect(page.locator('[data-detail-price]')).toContainText('110,00');
  await page.locator('[data-detail-add]').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('anarosa_cart_v2'))[0].variantBlingId))
    .toBe('202');
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('anarosa_cart_v2'))[0].quantity)).toBe(1);
  await page.locator('[data-product-detail]:visible').first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `tmp/store-${test.info().project.name}.png`, fullPage: false });
});
test('catalog failure shows an error and no demo product', async ({ page }) => {
  await page.route('**/storefront-products?*', (r) => r.fulfill({ status: 503, json: { ok: false } }));
  await page.goto('/');
  await expect(page.locator('[data-product-id]')).toHaveCount(0);
  await expect(page.getByText(/Não conseguimos carregar os produtos/).filter({ visible: true }).first())
    .toBeVisible();
});
test('confirmation never trusts paid query parameters', async ({ page }) => {
  await page.goto('/pedido-confirmado.html?token=' + 'a'.repeat(40) + '&paid=true');
  await expect(page.locator('[data-order-title]')).toHaveText('Pagamento ainda não confirmado');
});
test('cart requires a valid variation and cannot add zero-stock items', async ({ page }) => {
  await page.goto('/');
  const value = await page.evaluate((p) => {
    const c = AnarosaCart.createCartService();
    c.clear();
    const normalized = { ...p, variants: { items: p.variants } };
    c.addItem(normalized, null, 1);
    c.addItem(normalized, p.variants[0], 1);
    return c.getCount();
  }, product);
  expect(value).toBe(0);
});
