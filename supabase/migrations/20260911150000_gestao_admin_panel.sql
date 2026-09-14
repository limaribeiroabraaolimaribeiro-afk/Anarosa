-- =====================================================================
-- ANAROSA — Gestão Anarosa (painel administrativo em /gestao/)
-- ---------------------------------------------------------------------
-- Cria:
--   * store_admins            allowlist de usuários (Supabase Auth) com
--                              acesso ao painel — SECRETA, só service_role
--   * admin_dashboard_summary()  RPC única para o Dashboard (evita N+1)
--   * admin_customers_summary()  RPC de clientes agregados de store_orders
--
-- Nenhuma tabela existente é alterada. Nenhuma policy nova para
-- anon/authenticated. O navegador nunca lê estas tabelas/funções
-- diretamente — só as Edge Functions admin-* (service_role), depois de
-- verificarem a sessão do usuário via Supabase Auth.
-- =====================================================================

-- ---------------------------------------------------------------------
-- store_admins — allowlist real de admins da loja.
-- Um login válido no Supabase Auth NÃO basta: o user_id também precisa
-- estar aqui, com active=true. É a "role administrativa" do painel.
-- ---------------------------------------------------------------------
create table if not exists public.store_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.store_admins is
  'Allowlist de usuarios (Supabase Auth) autorizados a usar /gestao/. '
  'SECRETA: sem policy para anon/authenticated. Só service_role le, '
  'dentro das Edge Functions admin-* (ver _shared/admin-user-auth.ts).';

create trigger trg_store_admins_updated_at
  before update on public.store_admins
  for each row execute function public.set_updated_at();

alter table public.store_admins enable row level security;
revoke all on table public.store_admins from anon, authenticated;
grant select, insert, update on table public.store_admins to service_role;

-- ---------------------------------------------------------------------
-- admin_dashboard_summary() — um round-trip só para o Dashboard.
-- Horário de referência: America/Sao_Paulo (loja em Luiz Alves - SC),
-- para "hoje"/"mês" não desalinharem por causa do UTC.
--
-- Regra de estoque baixo/esgotado: soma o available_stock de todas as
-- linhas de store_inventory do produto (produto simples: linha própria;
-- produto com variacoes: soma das variacoes) — mesma função central
-- store_available_stock já usada em toda a integração.
-- ---------------------------------------------------------------------
create or replace function public.admin_dashboard_summary(
  p_low_stock_threshold integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'America/Sao_Paulo')::date;
  v_month_start date := date_trunc('month', now() at time zone 'America/Sao_Paulo')::date;
  v_result jsonb;
begin
  with product_stock as (
    -- estoque agregado por produto TOP-LEVEL (soma variações quando existirem)
    select
      p.id as product_id,
      p.active,
      coalesce(sum(i.available_stock), 0) as available_stock
    from public.store_products p
    left join public.store_product_variants v on v.product_id = p.id and v.active
    left join public.store_inventory i
      on i.deposit_id = '__total__'
     and i.bling_product_id = coalesce(v.bling_id, p.bling_id)
    where p.parent_bling_id is null
    group by p.id, p.active
  ),
  orders_today as (
    select count(*) as cnt, coalesce(sum(total), 0) as revenue
    from public.store_orders
    where (created_at at time zone 'America/Sao_Paulo')::date = v_today
      and status <> 'cancelled'
  ),
  orders_month as (
    select coalesce(sum(total), 0) as revenue
    from public.store_orders
    where (created_at at time zone 'America/Sao_Paulo')::date >= v_month_start
      and status <> 'cancelled'
  ),
  new_orders as (
    select count(*) as cnt from public.store_orders where status = 'pending'
  ),
  customers as (
    select count(distinct (customer_data->>'phone')) as cnt
    from public.store_orders
    where coalesce(customer_data->>'phone', '') <> ''
  )
  select jsonb_build_object(
    'newOrders', (select cnt from new_orders),
    'ordersToday', (select cnt from orders_today),
    'revenueToday', (select revenue from orders_today),
    'revenueMonth', (select revenue from orders_month),
    'activeProducts', (select count(*) from product_stock where active),
    'lowStockProducts', (
      select count(*) from product_stock
      where active and available_stock > 0 and available_stock <= p_low_stock_threshold
    ),
    'outOfStockProducts', (
      select count(*) from product_stock where active and available_stock <= 0
    ),
    'customers', (select cnt from customers),
    'lastWebhookAt', (select max(received_at) from public.bling_webhook_events),
    'lastSyncAt', (select max(last_sync_at) from public.bling_connections),
    'blingStatus', (select status from public.bling_connections order by created_at asc limit 1),
    'blingConnected', (
      select (status = 'connected' and access_token is not null)
      from public.bling_connections order by created_at asc limit 1
    )
  ) into v_result;

  return coalesce(v_result, jsonb_build_object(
    'newOrders', 0, 'ordersToday', 0, 'revenueToday', 0, 'revenueMonth', 0,
    'activeProducts', 0, 'lowStockProducts', 0, 'outOfStockProducts', 0,
    'customers', 0, 'lastWebhookAt', null, 'lastSyncAt', null,
    'blingStatus', 'disconnected', 'blingConnected', false
  ));
end;
$$;

revoke execute on function public.admin_dashboard_summary(integer) from public, anon, authenticated;
grant execute on function public.admin_dashboard_summary(integer) to service_role;

-- ---------------------------------------------------------------------
-- admin_customers_summary() — agrega store_orders por cliente
-- (telefone como chave: é obrigatório no checkout; e-mail não é).
-- Não cria tabela de clientes: deriva sempre da fonte (pedidos).
-- ---------------------------------------------------------------------
create or replace function public.admin_customers_summary(
  p_search text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  phone text,
  name text,
  email text,
  order_count bigint,
  total_spent numeric,
  last_order_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    customer_data->>'phone' as phone,
    max(customer_data->>'name') as name,
    max(customer_data->>'email') as email,
    count(*) as order_count,
    coalesce(sum(total) filter (where status <> 'cancelled'), 0) as total_spent,
    max(created_at) as last_order_at
  from public.store_orders
  where coalesce(customer_data->>'phone', '') <> ''
    and (
      p_search is null or p_search = ''
      or customer_data->>'name' ilike '%' || p_search || '%'
      or customer_data->>'phone' ilike '%' || p_search || '%'
    )
  group by customer_data->>'phone'
  order by max(created_at) desc
  limit greatest(p_limit, 1)
  offset greatest(p_offset, 0);
$$;

revoke execute on function public.admin_customers_summary(text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_customers_summary(text, integer, integer) to service_role;
