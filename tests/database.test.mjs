import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const db = new PGlite({ extensions: { pgcrypto } });
before(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema extensions; create schema cron; create schema net;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create table cron.job(jobid bigint,jobname text);
    create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';
    create function cron.unschedule(bigint) returns boolean language sql as 'select true';
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as 'select 1::bigint';
    create extension pgcrypto with schema extensions;`);
  for (const file of readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()) {
    const sql = readFileSync(`supabase/migrations/${file}`, 'utf8').replace(
      /create extension if not exists pg_(cron|net);/gi,
      '',
    );
    try {
      await db.exec(sql);
    } catch (e) {
      throw new Error(`${file}: ${e.message}`, { cause: e });
    }
  }
  await db.exec(
    `insert into store_products(bling_id,name,slug,price,active) values('101','Produto de teste isolado','teste',100,true);
    insert into store_inventory(bling_product_id,deposit_id,physical_stock,virtual_stock) values('101','__total__',3,3);`,
  );
});
after(() => db.close());
const request = (key, quantity = 1) => ({
  idempotencyKey: key.repeat(32),
  fingerprint: key,
  customer: { name: 'Cliente teste', phone: '47999990000' },
  shipping: { method: 'pickup' },
  payment: { method: 'pix' },
  items: [{ slug: 'teste', quantity }],
});
const checkout = async (r) => (await db.query('select checkout_create($1) as result', [r])).rows[0].result;

test('transaction: same checkout returns same order, changed body is rejected', async () => {
  const a = await checkout(request('a'));
  const b = await checkout(request('a'));
  assert.equal(a.orderId, b.orderId);
  assert.equal(b.duplicate, true);
  await assert.rejects(checkout({ ...request('a'), fingerprint: 'changed' }), /checkout_key_conflict/);
  assert.equal(
    (await db.query('select count(*)::int n from store_order_items where order_id=$1', [a.orderId])).rows[0]
      .n,
    1,
  );
});
test('transaction: reservations prevent concurrent orders from selling the same units', async () => {
  const r = await Promise.allSettled([checkout(request('b', 2)), checkout(request('c', 2))]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(r.filter((x) => x.status === 'rejected').length, 1);
});
test('transaction: duplicate lines cannot bypass stock; failure rolls back the entire order', async () => {
  const r = request('d', 2);
  r.items.push({ slug: 'teste', quantity: 2 });
  await assert.rejects(checkout(r), /insufficient_stock/);
  assert.equal(
    (await db.query('select count(*)::int n from store_orders where idempotency_key=$1', [r.idempotencyKey]))
      .rows[0].n,
    0,
  );
});
test('transaction: shipping price is server controlled, unknown freight blocks online payment', async () => {
  await assert.rejects(
    checkout({ ...request('e'), shipping: { method: 'delivery', cost: 0 } }),
    /shipping_quote_required/,
  );
});
test('authorization: public roles cannot call checkout or read private orders/settings', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query('select checkout_create($1)', [request('z')]), /permission denied/);
    await assert.rejects(db.query('select * from store_orders'), /permission denied/);
    await assert.rejects(db.query('select * from store_settings'), /permission denied/);
    await db.exec('reset role');
  }
});
test('payment: duplicate proof is idempotent, revenue excludes unpaid orders', async () => {
  const a = await checkout(request('a'));
  const pay = () =>
    db.query(
      "select mark_order_paid($1,'infinitepay','txn-test','slug-test','pix',10000,1,null,'{\"amount\":10000}') paid",
      [a.orderId],
    );
  assert.equal((await pay()).rows[0].paid, true);
  assert.equal((await pay()).rows[0].paid, false);
  assert.equal(
    (await db.query('select status from store_orders where id=$1', [a.orderId])).rows[0].status,
    'paid',
  );
  const d = (await db.query('select admin_dashboard_summary() s')).rows[0].s;
  assert.equal(d.revenueToday, 100);
  assert.equal(d.revenueMonth, 100);
  const c = (await db.query('select * from admin_customers_summary()')).rows[0];
  assert.equal(Number(c.total_spent), 100);
  const claim = (await db.query('select claim_bling_order($1) c', [a.orderId])).rows[0].c;
  assert.equal(claim.id, a.orderId);
  assert.equal((await db.query('select claim_bling_order($1) c', [a.orderId])).rows[0].c, null);
});
test('administration: cancellation cannot erase paid proof', async () => {
  const a = await checkout(request('a'));
  await assert.rejects(
    db.query("select admin_order_action($1,'cancel',null,'teste controlado')", [a.orderId]),
    /unsafe_cancellation/,
  );
  await assert.rejects(
    db.query("select admin_order_action($1,'paid',null,'teste controlado')", [a.orderId]),
    /invalid_action/,
  );
});

test('administration: durable commands exclude concurrent keys and replay completed results', async () => {
  const actor = '00000000-0000-4000-8000-000000000001',
    key = '00000000-0000-4000-8000-000000000002',
    other = '00000000-0000-4000-8000-000000000003';
  const claim = async (k, hash = 'hash') =>
    (await db.query("select claim_admin_operation($1,'stock:101:1',$2,$3) c", [k, actor, hash])).rows[0].c;
  assert.equal((await claim(key)).state, 'claimed');
  assert.equal((await claim(key)).state, 'processing');
  await assert.rejects(claim(other), /duplicate key/);
  await assert.rejects(claim(key, 'changed'), /operation_key_conflict/);
  await db.query("select finish_admin_operation($1,'completed','{\"ok\":true}')", [key]);
  assert.deepEqual((await claim(key)).result, { ok: true });
  assert.equal((await claim(other)).state, 'claimed');
  await db.query("select finish_admin_operation($1,'review','{}')", [other]);
  await assert.rejects(claim('00000000-0000-4000-8000-000000000004'), /duplicate key/);
});
test('marketplace: repeated import is atomic and does not mark revenue paid', async () => {
  const order = {
    blingId: '999',
    reference: 'ML-TEST',
    origin: 'mercado_livre',
    status: 'pending',
    customer: { name: 'Teste' },
    shipping: { method: 'external' },
    subtotal: 20,
    total: 20,
    items: [{ blingProductId: '101', sku: 'T', name: 'Teste', quantity: 2, unitPrice: 10, total: 20 }],
  };
  const run = async (value) => (await db.query('select import_bling_order($1) id', [value])).rows[0].id;
  const id = await run(order);
  assert.equal(await run(order), id);
  assert.equal(
    (await db.query('select count(*)::int n from store_order_items where order_id=$1', [id])).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query('select payment_status from store_orders where id=$1', [id])).rows[0].payment_status,
    'pending',
  );
  await assert.rejects(run({ ...order, items: [{ ...order.items[0], quantity: -1 }] }));
  assert.equal(
    (await db.query('select quantity from store_order_items where order_id=$1', [id])).rows[0].quantity,
    '2.000',
  );
});
test('settings: stale editor cannot overwrite another change', async () => {
  const row = (await db.query('select value,revision from store_settings')).rows[0];
  await db.query('select settings_save($1,$2,null)', [row.value, row.revision]);
  await assert.rejects(
    db.query('select settings_save($1,$2,null)', [row.value, row.revision]),
    /settings_conflict/,
  );
});
test('variants: choosing a size is mandatory, zero size does not block other sizes', async () => {
  await db.exec(
    `insert into store_products(bling_id,name,slug,price,active) values('301','Bermuda teste','teste-grade',100,true);
    insert into store_product_variants(product_id,bling_id,name,sku,price,active) select id,'302','Tamanho:P','TEST-P',100,true from store_products where bling_id='301';
    insert into store_product_variants(product_id,bling_id,name,sku,price,active) select id,'303','Tamanho:M','TEST-M',120,true from store_products where bling_id='301';
    insert into store_inventory(bling_product_id,deposit_id,physical_stock,virtual_stock) values('302','__total__',0,0),('303','__total__',2,2);`,
  );
  const base = { ...request('v'), items: [{ slug: 'teste-grade', quantity: 1 }] };
  await assert.rejects(checkout(base), /variant_required/);
  await assert.rejects(
    checkout({ ...base, items: [{ slug: 'teste-grade', variantBlingId: '302', quantity: 1 }] }),
    /insufficient_stock/,
  );
  const order = await checkout({
    ...base,
    items: [{ slug: 'teste-grade', variantBlingId: '303', quantity: 1 }],
  });
  assert.equal(Number(order.total), 120);
});
