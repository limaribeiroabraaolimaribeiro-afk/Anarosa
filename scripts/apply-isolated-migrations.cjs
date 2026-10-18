const fs = require('node:fs');
const path = require('node:path');
const { guard, sql, hash, root, evidence, container, persistFailure } = require('./verify-isolated-restore.cjs');
const files = [
  '20261017023020_commerce_integrity.sql',
  '20261018010144_pre_publication_security.sql',
];
const addedOrderColumns = ['checkout_fingerprint', 'reservation_released_at', 'bling_claim_token',
  'bling_claim_until', 'bling_next_attempt_at', 'bling_submission_started_at'];
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
function financialSnapshot() {
  // Ignore only the six additive columns so all original fields, including
  // payment links, proofs, statuses, amounts and identifiers, remain comparable.
  return JSON.parse(sql(`select jsonb_build_object(
    'orders', (select md5(coalesce(string_agg((to_jsonb(o)-array[${addedOrderColumns.map(quote).join(',')}])::text,E'\\n' order by id),'')) from public.store_orders o),
    'items', (select md5(coalesce(string_agg(to_jsonb(i)::text,E'\\n' order by id),'')) from public.store_order_items i),
    'orders_count',(select count(*) from public.store_orders),
    'paid_count',(select count(*) from public.store_orders where payment_status='paid'),
    'payment_events',(select count(*) from public.payment_webhook_events)
  );`));
}
try {
  const c = guard();
  const integrity = JSON.parse(fs.readFileSync(path.join(evidence, 'restore-integrity.json')));
  if (!integrity.passed || integrity.container_id !== c.Id || !Object.values(integrity.checks).every(Boolean)) throw Error('Integrity approval missing');
  const manifestPath = path.join(evidence, 'local-migrations.json');
  if (fs.existsSync(manifestPath)) throw Error('Migration evidence already exists');
  const current = JSON.parse(sql('select json_agg(version order by version) from supabase_migrations.schema_migrations;'));
  if (current.length !== 8 || current.some((v) => v >= '20261017023020')) throw Error('Unexpected migration baseline');
  const before = financialSnapshot();
  const migrations = files.map((file) => ({ file, source: fs.readFileSync(path.join(root, 'supabase/migrations', file), 'utf8') }));
  let transaction = 'begin; set local role postgres;\n';
  for (const m of migrations) {
    const version = m.file.slice(0, 14), name = m.file.slice(15, -4);
    transaction += m.source + `\ninsert into supabase_migrations.schema_migrations(version,name,statements) values (${quote(version)},${quote(name)},array[${quote(m.source)}]);\n`;
  }
  transaction += 'commit;';
  sql(transaction);
  const after = financialSnapshot();
  const preserved = JSON.stringify(before) === JSON.stringify(after);
  const versions = JSON.parse(sql('select json_agg(version order by version) from supabase_migrations.schema_migrations;'));
  const security = JSON.parse(sql(`select jsonb_build_object(
    'helpers_restricted',not has_function_privilege('anon','public.rls_auto_enable()','execute') and not has_function_privilege('authenticated','public.rls_auto_enable()','execute') and not has_function_privilege('anon','public.set_updated_at()','execute') and not has_function_privilege('authenticated','public.set_updated_at()','execute'),
    'search_paths_fixed',(select bool_and('search_path=pg_catalog, public, pg_temp'=any(proconfig)) from pg_proc where oid in ('public.set_updated_at()'::regprocedure,'public.store_available_stock(numeric,numeric)'::regprocedure)),
    'new_tables_rls',(select count(*)=3 and bool_and(relrowsecurity) from pg_class where oid in ('public.store_settings'::regclass,'public.store_order_events'::regclass,'public.store_admin_operations'::regclass)),
    'checkout_private',not has_function_privilege('anon','public.checkout_create(jsonb)','execute') and not has_function_privilege('authenticated','public.checkout_create(jsonb)','execute'),
    'cron_still_disabled',current_setting('cron.launch_active_jobs')='off',
    'no_order_events',(select count(*)=0 from public.store_order_events)
  );`));
  const result = { applied_utc: new Date().toISOString(), container, container_id: c.Id,
    execution_role: 'postgres', local_only: true, single_transaction: true,
    source_files: migrations.map(({ file, source }) => ({ file, sha256: hash(source) })),
    versions, original_financial_data_preserved: preserved, before, after, security,
    passed: preserved && versions.length === 10 && Object.values(security).every(Boolean) };
  fs.writeFileSync(manifestPath, JSON.stringify(result, null, 2));
  const restorePath = path.join(evidence, 'restore-completed.json');
  const restore = JSON.parse(fs.readFileSync(restorePath));
  restore.integrity_validated = true;
  restore.migrations_applied = true;
  fs.writeFileSync(restorePath, JSON.stringify(restore, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  persistFailure(error, 'migration-error');
  console.error('Local migration step failed. No remote command was used; review private evidence before retrying.');
  process.exitCode = 1;
}
