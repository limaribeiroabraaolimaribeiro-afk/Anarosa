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
test('product card opens a dedicated page, variant stock blocks P and cart persists', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('.product-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.product-card-media')).toBeVisible();
  await expect(card.locator('.product-info')).toBeVisible();
  await expect(card.locator('.product-card-link')).toHaveAttribute('href', /produto\.html\?slug=bermuda-teste/);
  await card.locator('[data-product-detail]').click();
  await expect(page).toHaveURL(/produto\.html\?slug=bermuda-teste/);
  await expect(page.locator('[data-title]')).toHaveText('Bermuda de teste');
  await expect(page.locator('[data-product-content]')).toBeVisible();
  await expect(page.locator('[data-variant="v1"]')).toBeDisabled();
  await expect(page.locator('[data-add-cart]')).toBeDisabled();
  await page.locator('[data-variant="v2"]').click();
  await expect(page.locator('[data-price]')).toContainText('110,00');
  await expect(page.locator('[data-availability]')).toContainText('2 unidades disponíveis');
  await page.locator('[data-add-cart]').click();
  await expect(page.locator('[data-cart-drawer]')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('anarosa_cart_v2'))[0].variantBlingId)).toBe('202');
  await page.reload();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('anarosa_cart_v2'))[0].quantity)).toBe(1);
  await page.locator('[data-cart-toggle]').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-cart-drawer]')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('product page exposes all photos, description, share and WhatsApp link', async ({ page }) => {
  await page.goto('/produto.html?slug=bermuda-teste');
  await expect(page.locator('[data-description]')).toContainText('Composição e medidas');
  await expect(page.locator('[data-main-image]')).toBeVisible();
  await expect(page.locator('[data-whatsapp]')).toHaveAttribute('href', /wa\.me\/\d+\?text=/);
  await expect(page.locator('[data-share]')).toBeVisible();
  await page.locator('[data-zoom]').click();
  await expect(page.locator('[data-lightbox]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-lightbox]')).toBeHidden();
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
