const {before,after,test}=require('node:test');
const assert=require('node:assert/strict');
const {fork}=require('node:child_process');
const path=require('node:path');
let server;const origin='http://127.0.0.1:5519';
before(async()=>{
  server=fork(path.resolve('scripts/serve-preview.cjs'),[],{env:{...process.env,ANAROSA_PREVIEW_PORT:'5519'},stdio:['ignore','ignore','inherit','ipc']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Preview timeout')),10000);server.once('message',()=>{clearTimeout(timer);resolve()});server.once('exit',()=>reject(Error('Preview unavailable')))});
});
after(async()=>{if(server&&!server.killed){await new Promise(resolve=>{server.once('exit',resolve);server.send('shutdown')})}});
test('local preview rejects financial and integration mutations',async()=>{
  for(const endpoint of ['storefront-checkout','infinitepay-create-payment','bling-create-order','admin-stock-adjust']){
    const r=await fetch(origin+'/functions/v1/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(r.status,405);assert.match((await r.json()).message,/desativados/);
  }
});
test('local preview overrides the API destination and blocks external connections',async()=>{
  const config=await(await fetch(origin+'/js/config.js')).text();
  assert.ok(config.includes('window.ANAROSA_CONFIG.functionsBaseUrl="'+origin+'/functions/v1"'));
  const r=await fetch(origin+'/');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/connect-src 'self'/);
  assert.match(await r.text(),/Prévia local · pedidos e pagamentos desativados/);
});
test('private backups and source campaign originals are not exposed',async()=>{
  for(const file of ['.backups/gpmbkptimjipqsayrvce/20261018T005827Z/database-full.dump.dpapi','assets/img/campaign-manifest.json','assets/img/banners/Moda que Veste Momentos em Família.png']){
    const r=await fetch(origin+'/'+encodeURI(file));assert.equal(r.status,404);
  }
});
