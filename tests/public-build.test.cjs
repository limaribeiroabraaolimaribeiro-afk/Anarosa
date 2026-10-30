const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..','_site');
function walk(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):[path.join(dir,e.name)]);}
const files=walk(root);
test('public artifact excludes internal files, credentials and backend',()=>{
 for(const file of files){
  const relative=path.relative(root,file).replace(/\\/g,'/');
  assert(!/(?:^|\/)(?:\.git|\.env[^/]*|\.backups|tmp|docs|scripts|supabase|tests|node_modules)(?:\/|$)/i.test(relative),relative);
  assert(!/\.(?:sql|json|md|dump|bak|gz|zip|env|ts|cjs)$/i.test(relative),relative);
  if(/\.(?:html|css|js)$/.test(file))assert(!/(?:sb_secret_[A-Za-z0-9_-]{12,}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/.test(fs.readFileSync(file,'utf8')),relative);
 }
 assert.equal(fs.readFileSync(path.join(root,'CNAME'),'utf8').trim(),'www.lojaanarosa.com.br');
});
test('all local HTML, CSS and editorial image references exist in the artifact',()=>{
 function check(from,value){
  if(!value||value.startsWith('#')||/^(?:https?:|data:|mailto:|tel:)/.test(value))return;
  const target=path.resolve(path.dirname(from),decodeURIComponent(value.split(/[?#]/)[0]));
  assert(target.startsWith(root+path.sep),'Reference escapes artifact');assert(fs.existsSync(target),`${path.relative(root,from)} -> ${value}`);
 }
 for(const file of files.filter(f=>/\.(html|css)$/.test(f))){
  const text=fs.readFileSync(file,'utf8');
  if(file.endsWith('.html')){
   for(const m of text.matchAll(/(?:src|href)=["']([^"']+)["']/g))check(file,m[1]);
   for(const m of text.matchAll(/(?:srcset|imagesrcset)=["']([^"']+)["']/g))for(const candidate of m[1].split(','))check(file,candidate.trim().split(/\s+/)[0]);
  }else for(const m of text.matchAll(/url\(['"]?([^)'"\s]+)['"]?\)/g))check(file,m[1]);
 }
 for(const slug of ['feminino-campanha','infantil-campanha','masculino-campanha','plus-size-campanha'])for(const size of [480,960])assert(fs.existsSync(path.join(root,`assets/img/optimized/${slug}-${size}.webp`)));
 for(const slug of ['bebe-editorial','infantil-editorial','masculino-editorial','feminino-editorial','juvenil-editorial','plus-size-editorial'])assert(fs.existsSync(path.join(root,`assets/img/optimized/${slug}-480.webp`)));
 assert.equal(files.filter(f=>f.endsWith('.webp')).length,22);assert.equal(files.filter(f=>f.endsWith('.woff2')).length,6);
});
test('public checkout contract is preserved and new APIs are limited to product administration',()=>{
 const source=files.filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
 for(const missing of ['storefront-settings','admin-settings','admin-order-action','bling-order-sync-process'])assert(!source.includes(missing),missing);
 for(const added of ['admin-product-detail','admin-stock-history'])assert(source.includes(added),added);
 const checkout=fs.readFileSync(path.join(root,'js/checkout.js'),'utf8');
 assert(checkout.includes('JSON.stringify({ orderId: json.orderId })'));
 assert(checkout.includes('storefront-checkout'));assert(checkout.includes('infinitepay-create-payment'));
 assert(fs.readFileSync(path.join(root,'gestao/js/gestao-auth.js'),'utf8').includes('signInWithPassword'));
 assert(!fs.readFileSync(path.join(root,'js/products.js'),'utf8').includes("price:"));
});
test('each local script and stylesheet has a content-specific cache version',()=>{
 for(const file of files.filter(f=>f.endsWith('.html'))){
  const html=fs.readFileSync(file,'utf8');
  for(const match of html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css))([^"']*)["']/g)){
   if(/^https?:/.test(match[1]))continue;
   const dependency=path.resolve(path.dirname(file),match[1]);
   const version=crypto.createHash('sha256').update(fs.readFileSync(dependency)).digest('hex').slice(0,12);
   assert.equal(match[2],`?v=${version}`,`${path.relative(root,file)} -> ${match[1]}`);
  }
 }
});


test('Gestão keeps navigation fixed while the products grid scrolls separately', () => {
 const html=fs.readFileSync(path.join(root,'gestao/index.html'),'utf8');
 const css=fs.readFileSync(path.join(root,'gestao/css/gestao.css'),'utf8');
 const js=fs.readFileSync(path.join(root,'gestao/js/gestao.js'),'utf8');
 assert.match(html, /class="gestao-products-scroll" data-products-scroll/);
 assert.match(html, /data-products-grid hidden/);
 assert.match(css, /\.gestao-app\s*\{[^}]*height:\s*100dvh;[^}]*overflow:\s*hidden;/);
 assert.match(css, /\.gestao-main\s*\{[^}]*flex-direction:\s*column;[^}]*overflow-y:\s*auto;/);
 assert.match(css, /\.gestao-products-scroll\s*\{[^}]*overflow-y:\s*auto;/);
 assert.match(css, /\.gestao-app\.is-products-route \.gestao-main\s*\{\s*overflow-y:\s*hidden;/);
 assert.match(js, /classList\.toggle\('is-products-route', page === 'produtos'\)/);
 assert(js.includes("$('[data-products-scroll]')"));
});

test('admin route updates every page using querySelectorAll, not a single Element', () => {
 const js=fs.readFileSync(path.join(root,'gestao/js/gestao.js'),'utf8');
 assert(js.includes("$$('[data-page]').forEach("));
 assert(!/(?<!\$)\$\('\[data-page\]'\)\.forEach\(/.test(js));
});

test('Gestão contains marketplace announcements route and explicit publication safeguards', () => {
 const html=fs.readFileSync(path.join(root,'gestao/index.html'),'utf8');
 const js=fs.readFileSync(path.join(root,'gestao/js/gestao.js'),'utf8');
 const client=fs.readFileSync(path.join(root,'gestao/js/marketplace-listings.js'),'utf8');
 const editor=fs.readFileSync(path.join(root,'gestao/js/product-editor.js'),'utf8');
 assert.match(html,/data-nav="anuncios"/);
 assert.match(html,/data-page="anuncios"/);
 assert.match(html,/js\/marketplace-listings\.js/);
 assert.match(js,/anuncios: \(\) => window\.MarketplaceListings/);
 assert.match(client,/listMarketplaceListings/);
 assert.match(client,/saveMarketplaceListing/);
 assert.match(client,/inspectMarketplaceChannels/);
 assert.match(client,/data-listing-variant-photo/);
 assert.match(editor,/data-generate-matrix/);
 assert.match(editor,/data-matrix-colors/);
 assert.match(editor,/data-matrix-sizes/);
});

test('marketplace database grants backend only, never direct visitors or login users', () => {
 const sql=fs.readFileSync(path.join(__dirname,'..','supabase/migrations/20261029211000_fix_marketplace_service_role_permissions.sql'),'utf8');
 assert.match(sql,/GRANT SELECT, INSERT, UPDATE ON TABLE public\.store_marketplace_listings TO service_role;/);
 assert.match(sql,/GRANT SELECT ON TABLE public\.store_marketplace_connections TO service_role;/);
 assert.match(sql,/REVOKE ALL ON TABLE public\.store_marketplace_listings FROM anon, authenticated;/);
 assert.match(sql,/REVOKE ALL ON TABLE public\.store_marketplace_connections FROM anon, authenticated;/);
});

test('ANAROSA MCP is restricted to commercial tools and private authentication', () => {
 const mcp=fs.readFileSync(path.join(__dirname,'..','supabase/functions/anarosa-mcp/index.ts'),'utf8');
 const oauth=fs.readFileSync(path.join(root,'oauth/consent/index.html'),'utf8');
 const js=fs.readFileSync(path.join(root,'oauth/consent/consent.js'),'utf8');
 const panel=fs.readFileSync(path.join(root,'gestao/index.html'),'utf8');
 assert.match(mcp,/requireAdminUser/);
 assert.match(mcp,/oauth-protected-resource/);
 assert.match(mcp,/WWW-Authenticate/);
 assert.match(mcp,/tools\/list/);
 assert.match(mcp,/confirmar=true/);
 assert.match(mcp,/cadastrar_produto/);
 assert.match(mcp,/salvar_anuncio/);
 assert.match(mcp,/gerar_imagem_comercial/);
 assert.doesNotMatch(mcp,/exec_shell|execute_sql|run_command|github\.com\/repos\/|service_role\s*[:=]/i);
 assert.match(oauth,/Autorizar ChatGPT/);
 assert.match(oauth,/consent\.js/);
 assert.match(js,/getAuthorizationDetails/);
 assert.match(js,/approveAuthorization/);
 assert.match(js,/denyAuthorization/);
 assert.match(js,/checkAdmin/);
 assert.match(panel,/data-copy-mcp-url/);
 assert.doesNotMatch(oauth,/service_role|BLING_CLIENT_SECRET|OPENAI_API_KEY/);
});


test('product share pages expose bot-readable product metadata with permanent image URLs', () => {
  const previews = path.join(root, 'p');
  assert(fs.existsSync(previews), 'Missing individual Open Graph preview pages');
  const htmlFiles = fs.readdirSync(previews).filter((name) => name.endsWith('.html'));
  assert(htmlFiles.length > 0, 'Public catalog generated no product previews');
  for (const name of htmlFiles) {
    assert(/^[a-z0-9-]+\.html$/.test(name), 'Unsafe preview path: ' + name);
    const html = fs.readFileSync(path.join(previews, name), 'utf8');
    assert.match(html, /<meta property="og:type" content="product">/, name);
    assert.match(html, /<meta property="og:title" content="[^"]+">/, name);
    assert.match(html, /<meta property="og:image" content="https:\/\/[^"]+">/, name);
    assert.match(html, /<meta property="og:url" content="https:\/\/www\.lojaanarosa\.com\.br\/p\//, name);
    assert(!html.includes('orgbling.s3.amazonaws.com'), 'Expired Bling image must not be published: ' + name);
    assert(!html.includes('AWSAccessKeyId='), 'Signed URLs must never be used for social previews: ' + name);
    assert.match(html, /window\.location\.replace\(/, 'Visitors must reach the product page: ' + name);
  }
});

test('existing Mercado Livre links require product, SKU, MLB and confirmation', () => {
 const html=fs.readFileSync(path.join(root,'gestao/index.html'),'utf8');
 const client=fs.readFileSync(path.join(root,'gestao/js/marketplace-listings.js'),'utf8');
 const api=fs.readFileSync(path.join(root,'gestao/js/gestao-api.js'),'utf8');
 const backend=fs.readFileSync(path.join(__dirname,'..','supabase/functions/admin-marketplace-listings/index.ts'),'utf8');
 assert.match(html, /data-listing-link-form/);
 assert.match(html, /name="link-sku"/);
 assert.match(html, /name="link-mlb"/);
 assert.match(client, /window\.confirm\(/);
 assert.match(client, /GestaoApi\.linkMarketplaceListing/);
 assert.match(api, /linkMarketplaceListing/);
 assert.match(backend, /body\.confirmar !== true/);
 assert.match(backend, /\^MLB\[0-9\]\{8,16\}\$/);
 assert.match(backend, /marketplace_link_lookup_failed/);
 assert.match(backend, /status:'ready'/);
 assert.match(backend, /Vínculo manual pendente de confirmação remota/);
 const index=fs.readFileSync(path.join(__dirname,'..','supabase/migrations/20261029233000_unique_marketplace_external_listing_reference.sql'),'utf8');
 assert.match(index,/CREATE UNIQUE INDEX IF NOT EXISTS/);
 assert.match(index,/WHERE external_listing_id IS NOT NULL/);
});
