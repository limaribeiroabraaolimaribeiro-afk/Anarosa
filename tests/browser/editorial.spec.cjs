const { test, expect } = require('./isolated-test.cjs');
const settings = { name:'Anarosa', whatsapp:'554730911041', pickupAddress:'Endereço exclusivamente de teste', deliveryMethods:['pickup','delivery'], paymentMethods:['pix','whatsapp'], deliveryPricing:'quote', deliveryPrice:0, pixDiscountPercent:0 };
const image = { url:'/assets/products/placeholder.svg' };
const female = { id:'editorial-1', blingId:'501', slug:'vestido-feminino-teste', name:'Vestido feminino de teste', price:120, promotionalPrice:100, category:{slug:'feminino',name:'Feminino'}, images:[image,{url:'/assets/products/conjunto-alfaiataria.svg'}], available:true, stock:2, updatedAt:'2026-10-18T12:00:00Z', variants:[{id:'size-p',blingId:'502',name:'Tamanho:P',size:'P',stock:0,available:false,price:100},{id:'size-m',blingId:'503',name:'Tamanho:M',size:'M',stock:2,available:true,price:130}] };
const products = [female,
  {id:'editorial-2',blingId:'601',slug:'camiseta-masculina-teste',name:'Camiseta masculina de teste',price:60,category:{slug:'masculino',name:'Masculino'},images:[image],available:true,stock:2,variants:[]},
  {id:'editorial-3',blingId:'701',slug:'camiseta-infantil-teste',name:'Camiseta infantil de teste',price:80,category:{slug:'infantil',name:'Infantil'},images:[image],available:true,stock:1,variants:[]},
  {id:'editorial-4',blingId:'801',slug:'vestido-plus-size-teste',name:'Vestido plus size de teste',price:200,category:{slug:'plus-size',name:'Plus Size'},images:[image],available:false,stock:0,variants:[]},
  {...female,id:'editorial-child',blingId:'503',slug:'vestido-feminino-m-teste',name:'Vestido feminino Tamanho:M',variants:[],price:130},
];
test.beforeEach(async ({ page }) => {
  await page.route('**/functions/v1/**', (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop();
    const body = name === 'storefront-settings' ? {ok:true,settings}
      : name === 'storefront-products' ? {ok:true,items:products,total:products.length}
      : name === 'storefront-product' ? {ok:true,product:female} : {ok:false};
    return route.fulfill({json:body});
  });
});
test('campaign photos stay editorial and actual variant children do not duplicate cards', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-id]')).toHaveCount(4);
  await expect(page.locator('[data-product-id="editorial-child"]')).toHaveCount(0);
  await expect(page.locator('.universe-card img')).toHaveCount(4);
  await expect(page.getByRole('heading',{level:1})).toContainText('Moda que');
  expect(await page.locator('.product-photo img').evaluateAll((imgs) => imgs.every((i) => !i.src.includes('/img/optimized/')))).toBe(true);
  expect(await page.locator('body').innerText()).not.toMatch(/frete gr[aá]tis|sem juros|mais vendidos|cadastre seu e-mail/i);
});

test('missing ERP identifiers never hide unrelated catalog products', async ({ page }) => {
  const parent={...female,blingId:null,variants:female.variants.map(v=>({...v,blingId:null}))};
  const standalone={...products[1],blingId:null};
  await page.route('**/storefront-products?*',r=>r.fulfill({json:{ok:true,items:[parent,standalone],total:2}}));
  await page.goto('/');
  await expect(page.locator('[data-product-id]')).toHaveCount(2);
  await expect(page.locator('[data-product-id="editorial-2"]')).toBeVisible();
});
test('search suggestions support keyboard selection and product links', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('[data-product-id]')).toHaveCount(4);
  const input = page.locator('[data-search-input]');
  await input.fill('camiseta');
  await expect(page.locator('[data-suggestion]')).toHaveCount(2);
  await input.press('ArrowDown');
  await expect(input).toHaveAttribute('aria-activedescendant','suggestion-0');
  await input.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/produto=camiseta-masculina-teste/);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(input).toBeFocused();
});
test('category, query, availability and sorting remain combined until cleared', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-filter-category]').selectOption('universe:masculino');
  await page.locator('[data-search-input]').fill('camiseta');
  await page.locator('[data-search-input]').press('Enter');
  await page.locator('[data-filter-available]').check();
  await page.locator('[data-filter-sort]').selectOption('price-desc');
  await expect(page.locator('[data-product-id]')).toHaveCount(1);
  await expect(page.locator('[data-product-id]')).toHaveAttribute('data-product-id','editorial-2');
  await page.locator('[data-filter-category]').selectOption('universe:plus-size');
  await expect(page.locator('[data-product-id]')).toHaveCount(0);
  await page.locator('[data-active-filters] [data-clear-filters]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(4);
  await expect(page.locator('[data-search-input]')).toHaveValue('');
});
test('favorites persist across reload and can be removed from their collection', async ({ page }) => {
  await page.goto('/');
  await page.locator('[data-product-id="editorial-1"] [data-favorite]').click();
  await page.reload();
  await expect(page.locator('[data-favorites-count]')).toHaveText('1');
  await page.locator('[data-favorites-toggle]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(1);
  await page.locator('[data-product-id="editorial-1"] [data-favorite]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(0);
  await expect(page.getByText('Suas favoritas moram aqui.')).toBeVisible();
});
test('card variant choice uses its price, cart updates instantly and respects stock', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('[data-product-id="editorial-1"]');
  await expect(card.locator('[data-card-variant="size-p"]')).toBeDisabled();
  await card.locator('[data-card-variant="size-m"]').click();
  await expect(card.locator('.price-now')).toHaveText(/130,00/);
  await card.locator('[data-add-to-cart]').click();
  await page.locator('[data-cart-toggle]').click();
  await expect(page.locator('[data-cart-drawer]')).toBeVisible();
  await expect(page.locator('[data-toast]')).not.toHaveClass(/is-visible/);
  await page.locator('[data-cart-increment]').click();
  await page.locator('[data-cart-increment]').click();
  await expect(page.locator('[data-cart-badge]')).toHaveText('2');
  await expect(page.locator('[data-cart-subtotal]')).toContainText('260,00');
  await page.locator('[data-cart-remove]').click();
  await expect(page.locator('[data-cart-checkout-link]')).toBeHidden();
  await expect(page.locator('[data-cart-empty-close]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-cart-toggle]')).toBeFocused();
});
test('mobile menu traps focus and returns it to its trigger', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.locator('[data-hamburger]').click();
  await expect(page.locator('[data-drawer]')).toBeVisible();
  await expect(page.locator('[data-drawer-close]')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('[data-drawer] a[href="informacoes.html"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-drawer]')).toBeHidden();
  await expect(page.locator('[data-hamburger]')).toBeFocused();
});
test('shared product link opens the real gallery and clears cleanly on close', async ({ page }) => {
  await page.goto('/?produto=vestido-feminino-teste');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.locator('[data-image-index="1"]').click();
  await expect(page.locator('[data-detail-image]')).toHaveAttribute('src',/conjunto-alfaiataria\.svg$/);
  await page.locator('[data-variant-modal-close]').click();
  await expect(page).not.toHaveURL(/produto=/);
});
test('catalog retry recovers without replacing the campaign or adding demo products', async ({ page }) => {
  let attempts=0;
  await page.route('**/storefront-products?*', (r) => ++attempts===1 ? r.fulfill({status:503,json:{ok:false}}) : r.fulfill({json:{ok:true,items:products,total:products.length}}));
  await page.goto('/');
  await expect(page.locator('[data-retry-catalog]')).toBeVisible();
  await expect(page.locator('.universe-card')).toHaveCount(4);
  await page.locator('[data-retry-catalog]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(4);
});
test('information links resolve to content and reduced motion is respected', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.goto('/');
  const duration=await page.locator('.universe-card img').first().evaluate((e)=>parseFloat(getComputedStyle(e).transitionDuration));
  expect(duration).toBeLessThan(.001);
  await page.goto('/informacoes.html#entrega');
  await expect(page.locator('#entrega')).toBeVisible();
  await expect(page.locator('[data-pickup-address]')).toContainText('Consulte o endereço');
  expect(await page.locator('.information-nav a').evaluateAll(links=>links.every(a=>document.querySelector(a.hash)))).toBe(true);
});

test('show more reveals every catalog item without changing filters', async ({ page }) => {
  const items = Array.from({length:14}, (_,i) => ({...products[1],id:'page-'+i,blingId:String(900+i),slug:'camiseta-'+i}));
  await page.route('**/storefront-products?*', r => r.fulfill({json:{ok:true,items,total:items.length}}));
  await page.goto('/');
  await page.locator('[data-filter-category]').selectOption('universe:masculino');
  await expect(page.locator('[data-product-id]')).toHaveCount(6);
  await page.locator('[data-load-more]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(12);
  await page.locator('[data-load-more]').click();
  await expect(page.locator('[data-product-id]')).toHaveCount(14);
  await expect(page.locator('[data-load-more]')).toBeHidden();
  await expect(page.locator('[data-filter-category]')).toHaveValue('universe:masculino');
});
