const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { guard, sql, docker, evidence, container, owner, persistFailure } = require('./verify-isolated-restore.cjs');
const database = 'anarosa_synthetic';
const psql = ['exec', '-i', container, 'psql', '-X', '-h', '/tmp', '-U', owner, '-d', database, '-qAt', '--set', 'ON_ERROR_STOP=1'];
function localSql(text) {
  guard();
  return docker(psql, 'set search_path=public;\n' + text).toString('utf8').trim();
}
const quote = (text) => "'" + text.replaceAll("'", "''") + "'";
const request = (key) => ({ idempotencyKey: key.repeat(32), fingerprint: key,
  customer: { name: 'Cliente sintético', phone: '47999990000' },
  shipping: { method: 'pickup' }, payment: { method: 'pix' },
  items: [{ slug: 'homologacao-local-exclusiva', quantity: 2 }] });
async function checkout(key) {
  guard();
  const query = 'set search_path=public; select checkout_create(' + quote(JSON.stringify(request(key))) + '::jsonb);';
  const child = execFile('docker.exe', ['--context', 'desktop-linux', ...psql], { timeout: 30000, windowsHide: true, maxBuffer: 1024 * 1024 });
  const result = new Promise((resolve, reject) => {
    let out = '', err = '';
    child.stdout.on('data', (data) => out += data);
    child.stderr.on('data', (data) => err += data);
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve(JSON.parse(out.trim())) : reject(new Error(err)));
  });
  child.stdin.end(query);
  return result;
}
async function main() {
  guard();
  const migrations = JSON.parse(fs.readFileSync(path.join(evidence, 'local-migrations.json')));
  if (!migrations.passed) throw Error('Validated local migrations required');
  if (sql(`select count(*) from pg_database where datname='${database}';`) === '0') {
    sql(`create database ${database} owner postgres template template0;`);
  } else if (localSql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_' and c.relkind in ('r','p','v','m','S');") !== '0') {
    throw Error('Synthetic database already has objects; never overwrite data');
  }
  // Schema only: never copy customers, sessions, provider credentials, orders or stock.
  const schema = docker(['exec', container, 'pg_dump', '-h', '/tmp', '-U', owner, '-d', 'anarosa_restore', '--schema-only', '--schema=public', '--schema=private', '--schema=auth', '--schema=extensions']).toString('utf8');
  const extensionSetup = 'drop schema public; create schema extensions; create extension pgcrypto with schema extensions; create extension "uuid-ossp" with schema extensions; create extension pg_stat_statements with schema extensions;\n';
  docker([...psql, '--single-transaction'], extensionSetup + schema.replace(/^CREATE SCHEMA extensions;\r?$/m, ''));
  const checks = {
    no_copied_users: localSql('select count(*) from auth.users;') === '0',
    no_copied_orders: localSql('select count(*) from public.store_orders;') === '0',
    no_provider_connections: localSql('select count(*) from public.bling_connections;') === '0',
    no_provider_settings: localSql('select count(*) from private.integration_settings;') === '0',
  };
  assert.ok(Object.values(checks).every(Boolean));
  localSql(`insert into store_settings(value) values ('{"deliveryMethods":["pickup"],"paymentMethods":["pix"],"deliveryPricing":"quote","pixDiscountPercent":0}');
    insert into store_products(bling_id,name,slug,price,active) values('999999999900001','Produto exclusivamente sintético','homologacao-local-exclusiva',12.34,true);
    insert into store_inventory(bling_product_id,deposit_id,physical_stock,virtual_stock) values('999999999900001','__total__',2,2);`);
  const competing = await Promise.allSettled([checkout('x'), checkout('y')]);
  const successes = competing.filter((r) => r.status === 'fulfilled');
  const failures = competing.filter((r) => r.status === 'rejected');
  assert.equal(successes.length, 1); assert.equal(failures.length, 1);
  assert.match(failures[0].reason.message, /insufficient_stock/);
  checks.two_real_sessions_prevent_overselling = true;
  const winner = competing[0].status === 'fulfilled' ? 'x' : 'y';
  const order = successes[0].value;
  assert.equal(Number(order.total), 24.68);
  const replay = await checkout(winner);
  assert.equal(replay.orderId, order.orderId); assert.equal(replay.duplicate, true);
  checks.idempotency_and_server_price = true;
  const pay = (amount) => localSql(`select mark_order_paid(${quote(order.orderId)},'infinitepay','synthetic-transaction','synthetic-invoice','pix',2468,1,null,'{"amount":${amount}}');`);
  assert.equal(pay(2467), 'f'); assert.equal(pay(2468), 't'); assert.equal(pay(2468), 'f');
  checks.amount_check_and_duplicate_payment_proof = true;
  try { localSql(`select admin_order_action(${quote(order.orderId)},'cancel',null,'Teste sintético local');`); throw Error('Cancellation unexpectedly allowed'); }
  catch (error) { assert.match(error.stderr?.toString() || error.message, /unsafe_cancellation/); }
  checks.paid_proof_survives_cancellation_attempt = true;
  for (const role of ['anon', 'authenticated']) {
    try { localSql(`set role ${role}; select * from store_orders;`); throw Error('Private rows exposed'); }
    catch (error) { assert.match(error.stderr?.toString() || error.message, /permission denied/); }
  }
  checks.real_postgres_role_denials = true;
  const amount = JSON.parse(localSql('select admin_dashboard_summary();'));
  assert.equal(amount.revenueToday, 24.68);
  checks.paid_revenue_only = true;
  const added = ['checkout_fingerprint','reservation_released_at','bling_claim_token','bling_claim_until','bling_next_attempt_at','bling_submission_started_at'];
  const original = JSON.parse(sql(`select jsonb_build_object(
    'orders',(select md5(coalesce(string_agg((to_jsonb(o)-array[${added.map(quote).join(',')}])::text,E'\\n' order by id),'')) from store_orders o),
    'items',(select md5(coalesce(string_agg(to_jsonb(i)::text,E'\\n' order by id),'')) from store_order_items i));`));
  assert.equal(original.orders, migrations.after.orders); assert.equal(original.items, migrations.after.items);
  checks.restored_orders_untouched_by_synthetic_tests = true;
  const result = { checked_utc: new Date().toISOString(), container, database,
    schema_source: 'migrated local restore; schema only', network: 'none', real_provider_calls: 0,
    checks, passed: Object.values(checks).every(Boolean) };
  fs.writeFileSync(path.join(evidence, 'postgres-integration.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  persistFailure(error, 'postgres-integration-error');
  console.error('Synthetic PostgreSQL integration failed; details encrypted locally.');
  process.exitCode = 1;
});
