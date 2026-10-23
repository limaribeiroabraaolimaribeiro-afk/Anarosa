-- Additive dependency of the product editor only. No order/payment changes.
create table public.gestao_admin_operations (
  operation_key uuid primary key,
  resource text not null,
  actor_id uuid,
  fingerprint text not null,
  status text not null check (status in ('processing', 'completed', 'failed', 'review')),
  submitted_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gestao_admin_operations enable row level security;
revoke all on public.gestao_admin_operations from public, anon, authenticated;
grant select, insert, update on public.gestao_admin_operations to service_role;
create unique index gestao_admin_resource_lock
  on public.gestao_admin_operations(resource) where status in ('processing', 'review');

create function public.gestao_claim_operation(
  p_key uuid, p_resource text, p_actor uuid, p_fingerprint text
) returns jsonb
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
declare v public.gestao_admin_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended('gestao:' || p_resource, 0));
  select * into v from public.gestao_admin_operations where operation_key = p_key for update;
  if found then
    if v.actor_id is distinct from p_actor or v.resource <> p_resource or v.fingerprint <> p_fingerprint then
      raise exception 'operation_key_conflict';
    end if;
    if v.status <> 'failed' then
      return jsonb_build_object('state', v.status, 'result', v.result);
    end if;
    update public.gestao_admin_operations
      set status = 'processing', submitted_at = null, updated_at = now() where operation_key = p_key;
  else
    insert into public.gestao_admin_operations(operation_key, resource, actor_id, fingerprint, status)
      values (p_key, p_resource, p_actor, p_fingerprint, 'processing');
  end if;
  return '{"state":"claimed"}'::jsonb;
end $$;
revoke all on function public.gestao_claim_operation(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.gestao_claim_operation(uuid, text, uuid, text) to service_role;

create function public.gestao_finish_operation(p_key uuid, p_status text, p_result jsonb) returns void
language plpgsql security invoker set search_path = pg_catalog, public, pg_temp as $$
begin
  if p_status not in ('completed', 'failed', 'review') then raise exception 'invalid_operation_status'; end if;
  update public.gestao_admin_operations set status = p_status, result = p_result, updated_at = now()
    where operation_key = p_key and status = 'processing';
  if not found then raise exception 'operation_claim_lost'; end if;
end $$;
revoke all on function public.gestao_finish_operation(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.gestao_finish_operation(uuid, text, jsonb) to service_role;
