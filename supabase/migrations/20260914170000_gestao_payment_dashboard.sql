-- =====================================================================
-- ANAROSA — Gestão: dashboard e listagem de pedidos passam a mostrar
-- pagamento (InfinitePay) e origem do pedido.
-- ---------------------------------------------------------------------
-- NÃO edita a migration 20260911150000 (já aplicada). Substitui a
-- função admin_dashboard_summary por CREATE OR REPLACE com a mesma
-- assinatura, só adicionando os novos campos:
--   pendingPayments  → pedidos com payment_status='pending' (exclui
--                      cancelados — não é uma pendência real de cobrar)
--   paidToday        → pedidos com payment_status='paid' cujo
--                      payment_paid_at cai no dia de hoje (America/Sao_Paulo)
--   blingSyncFailed  → pedidos com bling_sync_status='failed'
-- =====================================================================
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
  ),
  payments as (
    select
      count(*) filter (where payment_status = 'pending' and status <> 'cancelled') as pending_payments,
      count(*) filter (
        where payment_status = 'paid'
        and (payment_paid_at at time zone 'America/Sao_Paulo')::date = v_today
      ) as paid_today,
      count(*) filter (where bling_sync_status = 'failed') as bling_sync_failed
    from public.store_orders
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
    ),
    'pendingPayments', (select pending_payments from payments),
    'paidToday', (select paid_today from payments),
    'blingSyncFailed', (select bling_sync_failed from payments)
  ) into v_result;

  return coalesce(v_result, jsonb_build_object(
    'newOrders', 0, 'ordersToday', 0, 'revenueToday', 0, 'revenueMonth', 0,
    'activeProducts', 0, 'lowStockProducts', 0, 'outOfStockProducts', 0,
    'customers', 0, 'lastWebhookAt', null, 'lastSyncAt', null,
    'blingStatus', 'disconnected', 'blingConnected', false,
    'pendingPayments', 0, 'paidToday', 0, 'blingSyncFailed', 0
  ));
end;
$$;

revoke execute on function public.admin_dashboard_summary(integer) from public, anon, authenticated;
grant execute on function public.admin_dashboard_summary(integer) to service_role;
