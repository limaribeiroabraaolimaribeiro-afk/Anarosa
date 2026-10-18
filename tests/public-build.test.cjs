const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
test('public frontend uses only the existing production interfaces',()=>{
 const source=files.filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(f,'utf8')).join('\n');
 for(const missing of ['storefront-settings','admin-settings','admin-product-detail','admin-order-action','admin-stock-history','bling-order-sync-process'])assert(!source.includes(missing),missing);
 const checkout=fs.readFileSync(path.join(root,'js/checkout.js'),'utf8');
 assert(checkout.includes('JSON.stringify({ orderId: json.orderId })'));
 assert(checkout.includes('storefront-checkout'));assert(checkout.includes('infinitepay-create-payment'));
 assert(fs.readFileSync(path.join(root,'gestao/js/gestao-auth.js'),'utf8').includes('signInWithPassword'));
 assert(!fs.readFileSync(path.join(root,'js/products.js'),'utf8').includes("price:"));
});
