const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
let db;
const key = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
before(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role;');
  const dir = path.resolve(__dirname, '../supabase/migrations');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('_gestao_product_operations.sql'));
  await db.exec(fs.readFileSync(path.join(dir, file), 'utf8'));
});
after(async () => db?.close());
const claim = (k, resource, fingerprint = 'abc', who = actor) =>
  db.query('select public.gestao_claim_operation($1,$2,$3,$4) as value', [k, resource, who, fingerprint]);
test('administrative commands exclude parallel resources, replay completed results and reject changed intents', async () => {
  assert.equal((await claim(key, 'product:1')).rows[0].value.state, 'claimed');
  await assert.rejects(() => claim(other, 'product:1'));
  await db.query("select public.gestao_finish_operation($1,'completed',$2)", [key, { ok: true }]);
  assert.deepEqual((await claim(key, 'product:1')).rows[0].value, { state: 'completed', result: { ok: true } });
  await assert.rejects(() => claim(key, 'product:1', 'changed'));
  await assert.rejects(() => claim(key, 'product:1', 'abc', other));
});
test('review locks prevent a new key from duplicating uncertain operations; rejected operations can retry', async () => {
  await claim(other, 'product:2');
  await db.query("select public.gestao_finish_operation($1,'review',$2)", [other, { errorCode: 'timeout' }]);
  assert.equal((await claim(other, 'product:2')).rows[0].value.state, 'review');
  await assert.rejects(() => claim('33333333-3333-4333-8333-333333333333', 'product:2'));
  const retry = '44444444-4444-4444-8444-444444444444';
  await claim(retry, 'product:3');
  await db.query("select public.gestao_finish_operation($1,'failed',$2)", [retry, {}]);
  assert.equal((await claim(retry, 'product:3')).rows[0].value.state, 'claimed');
});
test('public browser roles cannot read administrative operations or execute their RPCs', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec('set role ' + role);
    await assert.rejects(() => db.query('select * from public.gestao_admin_operations'));
    await assert.rejects(() => claim(key, 'product:1'));
    await assert.rejects(() => db.query("select public.gestao_finish_operation($1,'completed',$2)", [key, {}]));
    await db.exec('reset role');
  }
  const row = (await db.query("select relrowsecurity from pg_class where oid='public.gestao_admin_operations'::regclass")).rows[0];
  assert.equal(row.relrowsecurity, true);
});
