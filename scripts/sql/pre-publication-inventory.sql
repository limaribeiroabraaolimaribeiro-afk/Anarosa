-- Read-only metadata only: no customer rows, keys or token values.
select jsonb_build_object(
  'checked_at', now(),
  'server_version', current_setting('server_version'),
  'database_bytes', pg_database_size(current_database()),
  'migrations', (select jsonb_agg(jsonb_build_object('version',version,'name',name,'statements',cardinality(statements),'content_md5',md5(array_to_string(statements,E'\n'))) order by version) from supabase_migrations.schema_migrations),
  'extensions', (select jsonb_agg(jsonb_build_object('name',extname,'version',extversion)) from pg_extension),
  'tables', (select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'rls',c.relrowsecurity,'estimated_rows',c.reltuples::bigint,'anon_select',has_table_privilege('anon',c.oid,'select'),'authenticated_select',has_table_privilege('authenticated',c.oid,'select')) order by n.nspname,c.relname) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and n.nspname in ('public','private','auth','storage')),
  'columns', (select jsonb_agg(jsonb_build_object('schema',table_schema,'table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable) order by table_schema,table_name,ordinal_position) from information_schema.columns where table_schema in ('public','private')),
  'routines', (select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,'signature',pg_get_function_identity_arguments(p.oid),'security_definer',p.prosecdef,'config',p.proconfig,'definition_md5',md5(pg_get_functiondef(p.oid)),'anon_execute',has_function_privilege('anon',p.oid,'execute'),'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute')) order by n.nspname,p.proname) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'),
  'constraints', (select jsonb_agg(jsonb_build_object('table',c.conrelid::regclass::text,'name',c.conname,'definition',pg_get_constraintdef(c.oid))) from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname in ('public','private')),
  'policies', (select jsonb_agg(jsonb_build_object('schema',schemaname,'table',tablename,'name',policyname,'command',cmd,'roles',roles)) from pg_policies where schemaname in ('public','private','storage')),
  'storage', (select jsonb_build_object('buckets',count(*),'public_buckets',count(*) filter(where public)) from storage.buckets),
  'auth', (select jsonb_build_object('users',count(*),'confirmed',count(*) filter(where email_confirmed_at is not null)) from auth.users)
) as inventory;
