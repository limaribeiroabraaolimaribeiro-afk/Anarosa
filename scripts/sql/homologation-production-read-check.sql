-- Aggregate SELECT only. No customer rows, credentials or mutation RPCs.
select jsonb_build_object(
  'checked_at', now(),
  'migrations', (select count(*) from supabase_migrations.schema_migrations),
  'pending_versions_present', (select count(*) from supabase_migrations.schema_migrations where version in ('20261017023020','20261018010144')),
  'new_settings_table_present', to_regclass('public.store_settings') is not null,
  'orders', (select count(*) from public.store_orders),
  'paid', (select count(*) from public.store_orders where payment_status='paid'),
  'payment_webhooks', (select count(*) from public.payment_webhook_events),
  'pg_net_schema', (select n.nspname from pg_extension e join pg_namespace n on n.oid=e.extnamespace where e.extname='pg_net'),
  'unsafe_helper_executable', has_function_privilege('anon','public.rls_auto_enable()','execute')
) as checks;
