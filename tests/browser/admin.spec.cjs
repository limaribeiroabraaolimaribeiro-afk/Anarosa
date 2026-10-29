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
        `window.GestaoAuth={isConfigured:()=>true,getSession:async()=>({access_token:'test-session',user:{id:'test-user',email:'test@example.invalid'}}),onAuthStateChange:(callback)=>{if(location.hash.includes('type=recovery'))queueMicrotask(()=>callback('PASSWORD_RECOVERY',{access_token:'test-session'}));return()=>{}},signOut:async()=>{},signIn:async()=>{},requestPasswordReset:async(email)=>{window.__resetEmail=email},changePassword:async(oldPassword,newPassword)=>{window.__changedPassword={oldPassword,newPassword}},finishPasswordRecovery:async(password)=>{window.__recoveredPassword=password}};`,
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

test('native file picker uploads multiple photos selected on separate occasions before saving', async ({ page }) => {
  const uploads = [];
  let saved;
  await page.route('**/admin-product-detail*', (r) => r.fulfill({
    json: { ok: true, product: {}, revision: null, capabilities: { images: true, binaryUpload: true } },
  }));
  await page.route('**/admin-product-image-upload', (r) => {
    expect(r.request().headers()['content-type']).toContain('multipart/form-data');
    uploads.push(r.request().postData());
    return r.fulfill({
      status: 201,
      json: { ok: true, url: `https://images.example.invalid/${uploads.length}.jpg` },
    });
  });
  await page.route('**/admin-product-create', (r) => {
    saved = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, blingId: '901', message: 'Produto salvo.' } });
  });
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-new]').click();
  await fillProduct(page);
  const photo = (name) => ({
    name,
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRt8AAAAASUVORK5CYII=', 'base64'),
  });
  const chooser1 = page.waitForEvent('filechooser');
  await page.locator('[data-photo-add]').click();
  await (await chooser1).setFiles(photo('celular.png'));
  await expect(page.locator('[data-pending-photos] figure')).toHaveCount(1);
  const chooser2 = page.waitForEvent('filechooser');
  await page.locator('[data-photo-add]').click();
  await (await chooser2).setFiles(photo('notebook.png'));
  await expect(page.locator('[data-pending-photos] figure')).toHaveCount(2);
  await expect(page.locator('[data-checklist-count]')).toContainText('de 5 completos');
  await page.locator('[data-save-draft]').click();
  await expect.poll(() => uploads.length).toBe(2);
  await expect.poll(() => saved?.images).toEqual([
    'https://images.example.invalid/1.jpg',
    'https://images.example.invalid/2.jpg',
  ]);
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
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

test('admin can request a password recovery email without being logged in', async ({ page }) => {
  await page.route('**/admin-dashboard-summary', (r) => r.fulfill({ status: 401, json: { ok: false } }));
  await page.goto('/gestao/');
  await page.locator('[data-forgot-password]').click();
  await expect(page.locator('[data-recovery-form]')).toBeVisible();
  await page.locator('[data-recovery-form] input[name="email"]').fill('conta@exemplo.invalid');
  await page.locator('[data-recovery-submit]').click();
  await expect(page.locator('[data-recovery-message]')).toContainText('Se este e-mail estiver cadastrado');
  expect(await page.evaluate(() => window.__resetEmail)).toBe('conta@exemplo.invalid');
});

test('account settings confirm current password and prevent mismatched new passwords', async ({ page }) => {
  await page.goto('/gestao/#/configuracoes');
  const form = page.locator('[data-password-change-form]');
  await expect(form).toBeVisible();
  await form.locator('[name="currentPassword"]').fill('senha-atual-exemplo');
  await form.locator('[name="newPassword"]').fill('senha-nova-segura-2026');
  await form.locator('[name="confirmPassword"]').fill('senhas-nao-coincidem');
  await form.locator('[data-password-change-submit]').click();
  await expect(form.locator('[data-password-feedback]')).toContainText('não coincidem');
  expect(await page.evaluate(() => window.__changedPassword)).toBeUndefined();
  await form.locator('[name="confirmPassword"]').fill('senha-nova-segura-2026');
  await form.locator('[data-password-change-submit]').click();
  await expect(form.locator('[data-password-feedback]')).toContainText('alterada com sucesso');
  expect(await page.evaluate(() => window.__changedPassword)).toEqual({
    oldPassword: 'senha-atual-exemplo',
    newPassword: 'senha-nova-segura-2026',
  });
});

test('recovery link requires a session and sets a new password only after confirmation', async ({ page }) => {
  await page.goto('/gestao/redefinir-senha.html');
  await expect(page.locator('[data-reset-password-form]')).toBeHidden();
  await page.goto('/gestao/redefinir-senha.html#access_token=test-recovery&type=recovery');
  const form = page.locator('[data-reset-password-form]');
  await expect(form).toBeVisible();
  await form.locator('[name="password"]').fill('nova-senha-segura-2026');
  await form.locator('[name="confirmation"]').fill('nova-senha-segura-2025');
  await form.locator('[data-reset-submit]').click();
  await expect(page.locator('[data-reset-status]')).toContainText('não coincidem');
  await form.locator('[name="confirmation"]').fill('nova-senha-segura-2026');
  await form.locator('[data-reset-submit]').click();
  await expect(page.locator('[data-reset-status]')).toContainText('redefinida com sucesso');
  expect(await page.evaluate(() => window.__recoveredPassword)).toBe('nova-senha-segura-2026');
});

test('login distinguishes dashboard errors from incorrect credentials', async ({ page }) => {
  await page.route('**/gestao-auth.js*', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `window.GestaoAuth={
      isConfigured:()=>true,
      getSession:async()=>window.__hasSession?{access_token:'fake-session',user:{id:'test-user',email:'conta@exemplo.invalid'}}:null,
      onAuthStateChange:()=>()=>{},
      signIn:async()=>{window.__hasSession=true;return {access_token:'fake-session'}},
      signOut:async()=>{window.__hasSession=false}
    };`,
  }));
  await page.route('**/functions/v1/admin-dashboard-summary', (r) =>
    r.fulfill({ status: 503, json: { message: 'backend temporariamente indisponível' } }));
  await page.goto('/gestao/');
  await page.locator('[data-login-form] input[name="email"]').fill('conta@exemplo.invalid');
  await page.locator('[data-login-form] input[name="password"]').fill('senha-exemplo');
  await page.locator('[data-login-submit]').click();
  await expect(page.locator('[data-login-error]')).toContainText('Senha aceita, mas não foi possível abrir o painel');
  await expect(page.locator('[data-login-error]')).not.toContainText('senha inválidos');
});

test('login shows invalid credentials only when Supabase rejects the password', async ({ page }) => {
  await page.route('**/gestao-auth.js*', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `window.GestaoAuth={
      isConfigured:()=>true,getSession:async()=>null,onAuthStateChange:()=>()=>{},
      signIn:async()=>{throw Object.assign(new Error('Invalid login credentials'),{status:400,code:'invalid_credentials'})},
      signOut:async()=>{}
    };`,
  }));
  await page.goto('/gestao/');
  await page.locator('[data-login-form] input[name="email"]').fill('conta@exemplo.invalid');
  await page.locator('[data-login-form] input[name="password"]').fill('senha-incorreta');
  await page.locator('[data-login-submit]').click();
  await expect(page.locator('[data-login-error]')).toHaveText('E-mail ou senha inválidos.');
});

test('valid login opens the dashboard instead of returning to the login form', async ({ page }) => {
  await page.route('**/gestao-auth.js*', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `window.GestaoAuth={
      isConfigured:()=>true,
      getSession:async()=>window.__signedIn?{access_token:'test-session',user:{id:'test-user',email:'conta@exemplo.invalid'}}:null,
      onAuthStateChange:()=>()=>{},
      signIn:async()=>{window.__signedIn=true;return {access_token:'test-session'}},
      signOut:async()=>{window.__signedIn=false}
    };`,
  }));
  await page.goto('/gestao/');
  await expect(page.locator('[data-view="login"]')).toBeVisible();
  await page.locator('[data-login-form] input[name="email"]').fill('conta@exemplo.invalid');
  await page.locator('[data-login-form] input[name="password"]').fill('senha-ficticia');
  await page.locator('[data-login-submit]').click();
  await expect(page.locator('[data-view="app"]')).toBeVisible();
  await expect(page.locator('[data-view="login"]')).toBeHidden();
  await expect(page.locator('[data-page="dashboard"]')).toBeVisible();
  await expect(page.locator('[data-page="pedidos"]')).toBeHidden();
  await page.evaluate(() => { location.hash = '#/pedidos'; });
  await expect(page.locator('[data-page="pedidos"]')).toBeVisible();
  await expect(page.locator('[data-page="dashboard"]')).toBeHidden();
});

test('editor saves commercial tags and promotional price linked to a Bling product', async ({ page }) => {
  let saved;
  await page.route('**/admin-product-create', (r) => {
    saved = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, blingId: '908', message: 'Cadastro confirmado.' } });
  });
  await newProduct(page);
  await fillProduct(page);
  await page.locator('[name="colecao"]').fill('Primavera 2027');
  await page.locator('[name="segmento"]').fill('Infantil');
  await page.locator('[name="precoPromocional"]').fill('109.90');
  await page.locator('[name="storeTag"][value="novo"]').check();
  await page.locator('[name="storeTag"][value="destaque"]').check();
  await page.locator('[data-product-form-submit]').click();
  await expect.poll(() => saved?.merchandising?.tags?.length).toBe(2);
  expect(saved.merchandising).toEqual({
    tags: ['novo', 'destaque'],
    colecao: 'Primavera 2027',
    segmento: 'Infantil',
    precoPromocional: 109.9,
  });
  expect(saved.preco).toBe(149.9);
  await expect(page.locator('[data-product-drawer]')).toBeHidden();
});

test('editor prevents a promotional price higher than the base price', async ({ page }) => {
  let calls = 0;
  await page.route('**/admin-product-create', (r) => {
    calls++;
    return r.fulfill({ json: { ok: true } });
  });
  await newProduct(page);
  await fillProduct(page);
  await page.locator('[name="precoPromocional"]').fill('199.99');
  // Backend blocks invalid promotions even when a browser has permissive
  // validation; UI feedback should not silently save them.
  await page.locator('[data-product-form-submit]').click();
  expect(calls).toBe(0);
  await expect(page.locator('[data-product-form-error]')).toContainText('preço promocional');
});

test('existing product saves storefront tags without PATCHing its Bling product', async ({ page }) => {
  let merchandising;
  let productUpdateCalls = 0;
  await page.route('**/admin-product-update', (r) => {
    productUpdateCalls++;
    return r.fulfill({ json: { ok: true } });
  });
  await page.route('**/admin-product-merchandising', (r) => {
    merchandising = r.request().postDataJSON();
    return r.fulfill({ json: { ok: true, message: 'Tags e informações da loja atualizadas.' } });
  });
  await page.goto('/gestao/#/produtos');
  await page.locator('[data-product-edit]').click();
  await expect(page.locator('[data-save-merchandising]')).toBeVisible();
  await page.locator('[name="storeTag"][value="destaque"]').check();
  await page.locator('[name="colecao"]').fill('Coleção teste');
  await page.locator('[name="precoPromocional"]').fill('89.90');
  await page.locator('[data-save-merchandising]').click();
  await expect.poll(() => merchandising?.blingId).toBe('101');
  expect(merchandising.merchandising.tags).toEqual(['destaque']);
  expect(merchandising.merchandising.precoPromocional).toBe(89.9);
  expect(productUpdateCalls).toBe(0);
});

test('manual category refresh calls the Bling sync endpoint and retains current selection', async ({ page }) => {
  const requests = [];
  await page.route('**/admin-categories**', (r) => {
    requests.push(new URL(r.request().url()).searchParams.get('refresh'));
    return r.fulfill({
      json: { ok: true, items: [{ blingId: '1', name: 'Feminino' }, { blingId: '2', name: 'Infantil' }] },
    });
  });
  await newProduct(page);
  await page.locator('[name="categoriaId"]').selectOption('1');
  await page.locator('[data-refresh-categories]').click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual([null, '1']);
  await expect(page.locator('[name="categoriaId"]')).toHaveValue('1');
});

test('integration audit identifies catalog problems and never writes to Bling', async ({ page }) => {
  const audit = {
    ok: true,
    generatedAt: '2026-10-29T17:00:00Z',
    stats: {
      activeRecords: 20, storefrontProducts: 9, activeCategories: 1,
      duplicateVariationCards: 0, productsWithIssues: 1,
      missingCategory: 1, missingImages: 1, expiringImages: 0,
    },
    issues: [{ blingId: '123', name: 'Produto sem foto', sku: 'ABC', issues: ['Categoria não vinculada', 'Sem fotos'] }],
  };
  let calls = 0;
  await page.route('**/admin-catalog-audit', (r) => { calls++; return r.fulfill({ json: audit }); });
  await page.goto('/gestao/#/integracao');
  await page.locator('[data-run-catalog-audit]').click();
  await expect(page.locator('[data-catalog-audit-results]')).toBeVisible();
  await expect(page.locator('[data-catalog-audit-stats]')).toContainText('Variações duplicadas na vitrine');
  await expect(page.locator('[data-catalog-audit-issues]')).toContainText('Categoria não vinculada');
  await expect(page.locator('[data-catalog-audit-issues]')).toContainText('Produto sem foto');
  expect(calls).toBe(1);
});
