const {test,expect}=require('./isolated-test.cjs');
const product={id:'real-fixture',blingId:'100',sku:'REAL-M',slug:'peca-real',name:'Peça do catálogo',price:110,available:true,stock:3,variants:[],images:[{url:'/assets/products/placeholder.svg'}],description:'<p>Algodão &amp; conforto.</p><p>Medidas do fornecedor.<br>Cuidados.</p><script>window.UNSAFE=true</script><img src="https://untrusted.invalid/never-send" onerror="window.UNSAFE=true">'};
test.beforeEach(async({page})=>{
 await page.route('**/functions/v1/**',r=>{
  const name=new URL(r.request().url()).pathname.split('/').pop();
  const json=name==='storefront-products'?{ok:true,items:[product],total:1}:name==='storefront-product'?{ok:true,product}:{ok:false};
  return r.fulfill({json});
 });
});
test('supplier descriptions show plain text without literal HTML or active content',async({page})=>{
 const unexpected=[];page.on('request',r=>{if(r.url().includes('untrusted.invalid'))unexpected.push(r.url());});
 await page.goto('/');await page.locator('[data-product-detail]').first().click();
 const description=page.locator('.product-description p');
 await expect(description).toContainText('Algodão & conforto.');
 await expect(description).toContainText('Medidas do fornecedor.');
 expect(await description.innerText()).not.toMatch(/<p>|<span|window.UNSAFE/);
 expect(await page.evaluate(()=>window.UNSAFE)).toBeUndefined();expect(unexpected).toEqual([]);
});
test('only confirmed test IDs are excluded, including links and an existing local cart',async({page})=>{
 const testItem={...product,id:'a93ccd7c-7bd9-4f15-9f3f-090fc91c7f74',slug:'teste',name:'teste'};
 const otherTest={...product,id:'b37ce022-22df-4a7a-8267-e3e3e775a765',slug:'teste-gestao',name:'TESTE GESTÃO ANAROSA'};
 await page.route('**/storefront-products?*',r=>r.fulfill({json:{ok:true,items:[product,testItem,otherTest],total:3}}));
 await page.route('**/storefront-product?*',r=>r.fulfill({json:{ok:true,product:testItem}}));
 await page.goto('/');await expect(page.locator('[data-product-id]')).toHaveCount(1);
 await page.locator('[data-search-input]').fill('teste');await expect(page.locator('[data-suggestion]')).toHaveCount(0);
 const kept=await page.evaluate(({product,testItem})=>{
  localStorage.setItem('anarosa_cart_v2',JSON.stringify([{key:'test',productId:testItem.id,quantity:1},{key:'real',productId:product.id,sku:product.sku,quantity:1,unitPrice:110}]));
  const c=AnarosaCart.createCartService();c.addItem(testItem,null,1);return c.getItems();
 },{product,testItem});
 expect(kept).toHaveLength(1);expect(kept[0].sku).toBe('REAL-M');
 await page.goto('/?produto=teste');await expect(page.getByRole('dialog')).toBeHidden();
});
test('ERP variant SKU search and explicit description gender survive product grouping',async({page})=>{
 const parent={...product,name:'Bermuda da coleção',description:'<p>Gênero: Masculino</p>',variants:[{id:'size-m',blingId:'200',sku:'ERP-M-987',name:'Tamanho:M',size:'M',price:110,stock:3,available:true}]};
 await page.route('**/storefront-products?*',r=>r.fulfill({json:{ok:true,items:[parent],total:1}}));
 await page.goto('/');await page.locator('[data-search-input]').fill('ERP-M-987');
 await expect(page.locator('[data-suggestion]')).toHaveCount(1);await page.locator('[data-search-input]').press('Enter');
 await expect(page.locator('[data-product-id]')).toHaveCount(1);await page.locator('[data-filter-category]').selectOption('universe:masculino');
 await expect(page.locator('[data-product-id]')).toHaveCount(1);
});
for(const method of ['pix','card_on_pickup','whatsapp'])test(`published checkout contract: ${method}, fully intercepted`,async({page})=>{
 const calls=[];
 await page.route('**/storefront-checkout',r=>{calls.push(r.request().postDataJSON());return r.fulfill({json:{ok:true,orderId:'mock-only-order',publicToken:'b'.repeat(40),total:110}});});
 let payment;
 await page.route('**/infinitepay-create-payment',r=>{payment=r.request().postDataJSON();return r.fulfill({json:{ok:true,paymentUrl:'https://payment.example.invalid/intercepted'}});});
 await page.route('https://payment.example.invalid/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Intercepted payment navigation</h1>'}));
 await page.goto('/');await page.evaluate(p=>AnarosaCart.createCartService().addItem({...p,image:p.images[0].url},null,1),product);
 await page.goto('/checkout.html');await page.locator('[data-next="cart"]').click();
 await page.locator('[name="name"]').fill('Cliente isolado');await page.locator('[name="phone"]').fill('47999990000');await page.locator('[data-next="customer"]').click();
 await page.locator('[data-next="delivery"]').click();await page.locator(`[name="paymentMethod"][value="${method}"]`).check();await page.locator('[data-next="payment"]').click();
 await expect(page.locator('[data-review-total]')).toContainText('110,00');await page.locator('[data-confirm-order]').click();
 await expect.poll(()=>calls.length).toBe(1);expect(calls[0].items).toEqual([{slug:'peca-real',variantBlingId:null,quantity:1}]);
 expect(calls[0].payment.method).toBe(method);expect(calls[0].shipping.method).toBe('pickup');expect(calls[0].items[0].price).toBeUndefined();
 if(method==='pix'){await expect(page).toHaveURL('https://payment.example.invalid/intercepted');expect(payment).toEqual({orderId:'mock-only-order'});}
 else{await expect(page.locator('[data-panel="confirmation"]')).toBeVisible();expect(payment).toBeUndefined();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('anarosa_cart_v2')))).toEqual([]);}
});
for(const allowed of [true,false])test(`existing admin Auth adapter and allowlist: ${allowed?'allowed':'denied'}`,async({page})=>{
 await page.route('https://cdn.jsdelivr.net/**',r=>r.fulfill({contentType:'text/javascript',body:`window.supabase={createClient:()=>{let session=null;return{auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>{session=null},signInWithPassword:async input=>{window.AUTH_INPUT=input;session={access_token:'isolated-session',user:{id:'isolated',email:input.email}};return {data:{session}}}}}}};`}));
 const calls=[];
 await page.route('**/functions/v1/admin-*',r=>{
  calls.push({url:r.request().url(),authorization:r.request().headers().authorization});
  return r.fulfill({status:allowed?200:401,json:allowed?{ok:true,summary:{newOrders:0,ordersToday:0,revenueToday:0,revenueMonth:0,customers:0,dailyRevenue:[]}}:{ok:false}});
 });
 await page.goto('/gestao/');await expect(page.locator('[data-view="login"]')).toBeVisible();
 await page.locator('[name="email"]').fill('isolated@example.invalid');await page.locator('[name="password"]').fill('only-a-local-fixture');await page.locator('[data-login-submit]').click();
 if(allowed){await expect(page.locator('[data-view="app"]')).toBeVisible();await expect(page.locator('[data-current-user-email]')).toHaveText('isolated@example.invalid');}
 else{await expect(page.locator('[data-login-error]')).toContainText('não autorizado');await expect(page.locator('[data-view="app"]')).toBeHidden();}
 expect(calls.length).toBeGreaterThan(0);expect(calls.every(c=>c.authorization==='Bearer isolated-session')).toBe(true);
 expect(await page.evaluate(()=>window.AUTH_INPUT.email)).toBe('isolated@example.invalid');
});
test('desktop, tablet and mobile assets decode and navigation has no overflow',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 for(const width of [360,390,768,1024,1440]){
  await page.setViewportSize({width,height:1000});await page.goto('/');await expect(page.locator('[data-product-id]')).toHaveCount(1);
  await page.locator('footer').scrollIntoViewIfNeeded();await page.evaluate(()=>Promise.all([...document.images].map(async i=>{if(i.loading==='lazy')i.loading='eager';try{await i.decode()}catch{}})));
  expect(await page.evaluate(()=>[...document.images].filter(i=>!i.complete||!i.naturalWidth).map(i=>i.getAttribute('src')))).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:`tmp/release-${width}.png`,fullPage:true});
 }
 expect(errors).toEqual([]);
});
