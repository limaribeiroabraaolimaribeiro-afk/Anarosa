-- Prepared from read-only production advisors; NOT applied remotely.
-- Retain every table, policy, event trigger and integration extension.
alter function public.store_available_stock(numeric,numeric) set search_path=pg_catalog,public,pg_temp;
alter function public.set_updated_at() set search_path=pg_catalog,public,pg_temp;
revoke execute on function public.set_updated_at() from public,anon,authenticated;

-- Supabase creates this event-trigger helper on some hosted projects.
-- It must keep working as an event trigger without being publicly executable.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public,anon,authenticated';
  end if;
end $$;

-- pg_net is non-relocatable on the inspected project. Do not drop/recreate it
-- to satisfy a generic advisor: the existing webhook queues depend on it.
