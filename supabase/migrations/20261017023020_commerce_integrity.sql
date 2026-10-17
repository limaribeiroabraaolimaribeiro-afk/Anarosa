-- Additive migration. No production data deletion, no automatic ERP activation.
create table public.store_settings (
  id boolean primary key default true check (id),
  value jsonb not null default '{}'::jsonb,
  revision integer not null default 1,
  updated_at timestamptz not null default now()
);
insert into public.store_settings(value) values ('{"name":"Anarosa","whatsapp":"554730911041","pickupAddress":"","instagram":"https://www.instagram.com/anarosatextil/","serviceMessage":"Olá! Gostaria de falar com a Anarosa.","deliveryMethods":["pickup","delivery"],"paymentMethods":["pix","card_on_pickup","whatsapp"],"deliveryPricing":"quote","deliveryPrice":0,"pixDiscountPercent":0}');
alter table public.store_settings enable row level security;
revoke all on public.store_settings from public, anon, authenticated;
grant select, update on public.store_settings to service_role;

create table public.store_order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.store_orders(id),
  actor_id uuid,
  kind text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.store_order_events enable row level security;
revoke all on public.store_order_events from public, anon, authenticated;
grant select, insert on public.store_order_events to service_role;
create index on public.store_order_events(order_id, created_at);

alter table public.store_orders
  add column checkout_fingerprint text,
  add column reservation_released_at timestamptz,
  add column bling_claim_token uuid,
  add column bling_claim_until timestamptz,
  add column bling_next_attempt_at timestamptz,
  add column bling_submission_started_at timestamptz;
alter table public.store_orders drop constraint store_orders_bling_sync_status_check;
alter table public.store_orders add constraint store_orders_bling_sync_status_check
  check (bling_sync_status in ('disabled','pending','processing','synced','failed','review'));

-- One transaction for order + lines + local reservation. Advisory locks in sorted
-- SKU order also serialize purchases when stock has no __total__ row.
create function public.checkout_create(p_request jsonb) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_order public.store_orders; v_product public.store_products; v_variant public.store_product_variants;
  v_item jsonb; v_settings jsonb; v_items jsonb := '[]'; v_id text; v_name text; v_sku text;
  v_price numeric; v_stock numeric; v_reserved numeric; v_qty integer; v_subtotal numeric := 0;
  v_shipping numeric := 0; v_shipping_data jsonb; v_total numeric; v_duplicate boolean := false;
begin
  if length(coalesce(p_request->>'idempotencyKey','')) < 32 then raise exception 'invalid_checkout_key'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_request->>'idempotencyKey',0));
  select * into v_order from public.store_orders where idempotency_key = p_request->>'idempotencyKey';
  if found then
    if v_order.checkout_fingerprint is distinct from p_request->>'fingerprint' then raise exception 'checkout_key_conflict'; end if;
    return jsonb_build_object('orderId',v_order.id,'publicToken',v_order.public_token,'total',v_order.total,'status',v_order.status,'duplicate',true,'shipping',v_order.shipping_data);
  end if;
  select value into strict v_settings from public.store_settings where id;
  if not (v_settings->'deliveryMethods' ? (p_request->'shipping'->>'method')) or
     not (v_settings->'paymentMethods' ? (p_request->'payment'->>'method')) then raise exception 'method_disabled'; end if;
  v_shipping_data := p_request->'shipping';
  if v_shipping_data->>'method' = 'delivery' then
    if v_settings->>'deliveryPricing' = 'fixed' then
      v_shipping := (v_settings->>'deliveryPrice')::numeric;
      v_shipping_data := v_shipping_data || jsonb_build_object('pricing','fixed','cost',v_shipping);
    else
      v_shipping_data := v_shipping_data || '{"pricing":"quote","cost":null}'::jsonb;
      if p_request->'payment'->>'method' = 'pix' then raise exception 'shipping_quote_required'; end if;
    end if;
  else v_shipping_data := v_shipping_data || '{"pricing":"fixed","cost":0}'::jsonb;
  end if;
  if jsonb_array_length(p_request->'items') not between 1 and 50 then raise exception 'invalid_items'; end if;
  for v_item in select value from jsonb_array_elements(p_request->'items') order by value->>'slug',value->>'variantBlingId' loop
    v_qty := (v_item->>'quantity')::integer;
    if v_qty not between 1 and 20 then raise exception 'invalid_quantity'; end if;
    select * into v_product from public.store_products where slug=v_item->>'slug' and active and parent_bling_id is null;
    if not found then raise exception 'product_unavailable'; end if;
    v_id := v_product.bling_id; v_name := v_product.name; v_sku := v_product.sku;
    v_price := coalesce(v_product.promotional_price,v_product.price);
    if coalesce(v_item->>'variantBlingId','') <> '' then
      select * into v_variant from public.store_product_variants where product_id=v_product.id and bling_id=v_item->>'variantBlingId' and active;
      if not found then raise exception 'variant_unavailable'; end if;
      v_id:=v_variant.bling_id; v_sku:=v_variant.sku; v_name:=v_product.name || ' — ' || v_variant.name;
      v_price:=coalesce(v_variant.promotional_price,v_variant.price,v_price);
    elsif exists(select 1 from public.store_product_variants where product_id=v_product.id) then raise exception 'variant_required';
    end if;
    if v_price is null or v_price <= 0 then raise exception 'price_unavailable'; end if;
    perform pg_advisory_xact_lock(hashtextextended('sku:' || v_id,0));
    select coalesce(virtual_stock,physical_stock) into v_stock from public.store_inventory where bling_product_id=v_id and deposit_id='__total__';
    if not found then select sum(available_stock) into v_stock from public.store_inventory where bling_product_id=v_id and deposit_id <> '__total__'; end if;
    select coalesce(sum(i.quantity),0) into v_reserved from public.store_order_items i join public.store_orders o on o.id=i.order_id
      where i.bling_product_id=v_id and o.checkout_fingerprint is not null and o.reservation_released_at is null and o.status <> 'cancelled';
    select v_reserved + coalesce(sum((x->>'quantity')::numeric),0) into v_reserved from jsonb_array_elements(v_items) x where x->>'bling_product_id'=v_id;
    if v_stock is null or v_stock-v_reserved < v_qty then raise exception 'insufficient_stock'; end if;
    v_items := v_items || jsonb_build_array(jsonb_build_object('bling_product_id',v_id,'sku',v_sku,'name',v_name,'quantity',v_qty,'unit_price',v_price,'total',round(v_qty*v_price,2)));
    v_subtotal:=v_subtotal+round(v_qty*v_price,2);
  end loop;
  -- InfinitePay link accepts both Pix and card. Never discount based solely on
  -- a browser preference before the actual capture method is known.
  v_total := v_subtotal+v_shipping;
  insert into public.store_orders(idempotency_key,checkout_fingerprint,status,customer_data,shipping_data,payment_data,subtotal,shipping,total,metadata)
    values(p_request->>'idempotencyKey',p_request->>'fingerprint','pending',p_request->'customer',v_shipping_data,p_request->'payment',v_subtotal,v_shipping,v_total,'{"source":"storefront-checkout"}') returning * into v_order;
  insert into public.store_order_items(order_id,bling_product_id,sku,name,quantity,unit_price,total)
    select v_order.id,x->>'bling_product_id',x->>'sku',x->>'name',(x->>'quantity')::numeric,(x->>'unit_price')::numeric,(x->>'total')::numeric from jsonb_array_elements(v_items) x;
  insert into public.store_order_events(order_id,kind) values(v_order.id,'checkout.created');
  return jsonb_build_object('orderId',v_order.id,'publicToken',v_order.public_token,'total',v_order.total,'status',v_order.status,'duplicate',false,'shipping',v_shipping_data);
end $$;
revoke all on function public.checkout_create(jsonb) from public, anon, authenticated;
grant execute on function public.checkout_create(jsonb) to service_role;

create function public.settings_save(p_value jsonb,p_revision integer,p_actor uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_result jsonb;
begin
  update public.store_settings set value=p_value,revision=revision+1,updated_at=now() where id and revision=p_revision
    returning jsonb_build_object('settings',value,'revision',revision) into v_result;
  if not found then raise exception 'settings_conflict'; end if;
  insert into public.store_order_events(actor_id,kind,details) values(p_actor,'settings.updated',jsonb_build_object('revision',p_revision+1));
  return v_result;
end $$;
revoke all on function public.settings_save(jsonb,integer,uuid) from public,anon,authenticated;
grant execute on function public.settings_save(jsonb,integer,uuid) to service_role;

-- Audit financial transitions in the SAME transaction as the update. Preserve
-- payment proof when an operational cancellation arrives from the ERP.
create function public.audit_order_change() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if old.payment_status is distinct from new.payment_status then
    insert into public.store_order_events(order_id,kind,details) values(new.id,'payment.'||new.payment_status,jsonb_build_object('previous',old.payment_status,'provider',new.payment_provider));
  end if;
  if old.status is distinct from new.status then
    insert into public.store_order_events(order_id,kind,details) values(new.id,'order.'||new.status,jsonb_build_object('previous',old.status));
  end if;
  return new;
end $$;
revoke all on function public.audit_order_change() from public,anon,authenticated;
create trigger audit_order_change after update on public.store_orders for each row execute function public.audit_order_change();

-- Claim with fencing token; an expired claim after submission is recovered by
-- reference lookup only. An ambiguous POST is NEVER blindly repeated.
create function public.claim_bling_order(p_id uuid default null) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_order public.store_orders;
begin
  select * into v_order from public.store_orders where payment_status='paid' and status <> 'cancelled' and origin='site' and bling_id is null
    and (p_id is null or id=p_id) and bling_sync_attempts<5
    and (bling_sync_status in ('pending','failed') or (bling_sync_status='processing' and bling_claim_until<now()))
    and (bling_next_attempt_at is null or bling_next_attempt_at<=now())
    order by created_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.store_orders set bling_sync_status='processing',bling_claim_token=gen_random_uuid(),bling_claim_until=now()+interval '2 minutes',bling_sync_attempts=bling_sync_attempts+1,bling_last_attempt_at=now()
    where id=v_order.id returning * into v_order;
  insert into public.store_order_events(order_id,kind,details) values(v_order.id,'bling.claimed',jsonb_build_object('attempt',v_order.bling_sync_attempts));
  return to_jsonb(v_order);
end $$;
revoke all on function public.claim_bling_order(uuid) from public,anon,authenticated;
grant execute on function public.claim_bling_order(uuid) to service_role;

create function public.admin_order_action(p_id uuid,p_action text,p_actor uuid,p_reason text) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.store_orders;
begin
  if length(trim(coalesce(p_reason,'')))<5 then raise exception 'reason_required'; end if;
  select * into strict v from public.store_orders where id=p_id for update;
  if p_action='cancel' then
    if v.payment_status<>'pending' or v.payment_url is not null or v.payment_provider is not null or v.bling_id is not null or v.status not in ('draft','pending') then raise exception 'unsafe_cancellation'; end if;
    update public.store_orders set status='cancelled',payment_status='cancelled',reservation_released_at=now() where id=p_id;
  elsif p_action='retry' then
    if v.payment_status<>'paid' or v.status='cancelled' or v.bling_sync_status not in ('failed','review') or v.bling_id is not null then raise exception 'invalid_retry'; end if;
    -- Preserve ambiguous-submission marker. Retry will only look up the ERP.
    update public.store_orders set bling_sync_status='pending',bling_next_attempt_at=now(),bling_sync_attempts=0 where id=p_id;
  elsif p_action='release_reservation' then
    if v.bling_id is null or v.bling_sync_status<>'synced' then raise exception 'erp_confirmation_required'; end if;
    update public.store_orders set reservation_released_at=now() where id=p_id;
  else raise exception 'invalid_action'; end if;
  insert into public.store_order_events(order_id,actor_id,kind,details) values(p_id,p_actor,'admin.'||p_action,jsonb_build_object('reason',left(p_reason,500)));
end $$;
revoke all on function public.admin_order_action(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.admin_order_action(uuid,text,uuid,text) to service_role;

-- Revenue means reconciled payment, not order intent.
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
    where (payment_paid_at at time zone 'America/Sao_Paulo')::date = v_today
      and payment_status = 'paid'
  ),
  orders_month as (
    select coalesce(sum(total), 0) as revenue
    from public.store_orders
    where (payment_paid_at at time zone 'America/Sao_Paulo')::date >= v_month_start
      and payment_status = 'paid'
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
    'ordersToday', (select count(*) from public.store_orders where (created_at at time zone 'America/Sao_Paulo')::date=v_today),
    'processingOrders', (select count(*) from public.store_orders where status in ('confirmed','paid','shipped') or (payment_status='paid' and status='pending')),
    'failedPayments', (select count(*) from public.store_orders where payment_status='failed'),
    'revenueWeek', (select coalesce(sum(total),0) from public.store_orders where payment_status='paid' and payment_paid_at >= (date_trunc('week',now() at time zone 'America/Sao_Paulo') at time zone 'America/Sao_Paulo')),
    'dailyRevenue', (select jsonb_agg(jsonb_build_object('day',d.revenue_date,'total',coalesce(r.total,0)) order by d.revenue_date) from (select generate_series(v_today-6,v_today,'1 day'::interval)::date as revenue_date) d left join (select (payment_paid_at at time zone 'America/Sao_Paulo')::date as revenue_date,sum(total) total from public.store_orders where payment_status='paid' group by 1) r using(revenue_date)),
    'origins', (select coalesce(jsonb_agg(x),'[]'::jsonb) from (select origin,count(*) count from public.store_orders group by origin) x),
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
    coalesce(sum(total) filter (where payment_status = 'paid'), 0) as total_spent,
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

create function public.finish_bling_order(p_id uuid,p_claim uuid,p_status text,p_bling_id text,p_error text) returns boolean
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.store_orders;
begin
  update public.store_orders set bling_sync_status=p_status,bling_id=coalesce(p_bling_id,bling_id),bling_sync_error=p_error,bling_claim_until=null,
    bling_next_attempt_at=now()+make_interval(secs=>least(3600,30*power(2,bling_sync_attempts)::integer)),
    synced_at=case when p_bling_id is not null then now() else synced_at end
    where id=p_id and bling_claim_token=p_claim and bling_sync_status='processing' returning * into v;
  if not found then return false; end if;
  insert into public.store_order_events(order_id,kind,details) values(p_id,'bling.'||p_status,jsonb_build_object('attempt',v.bling_sync_attempts,'errorCode',p_error));
  return true;
end $$;
revoke all on function public.finish_bling_order(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.finish_bling_order(uuid,uuid,text,text,text) to service_role;

create function public.import_bling_order(p_order jsonb) returns uuid
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_id uuid; v_origin text; v_item jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('bling-order:'||(p_order->>'blingId'),0));
  select id,origin into v_id,v_origin from public.store_orders where bling_id=p_order->>'blingId';
  if not found and (p_order->>'reference') ~ '^anarosa-[0-9a-f-]{36}$' then
    select id,origin into v_id,v_origin from public.store_orders where id=substring(p_order->>'reference' from 9)::uuid;
  end if;
  if v_id is not null then
    update public.store_orders set bling_id=p_order->>'blingId',synced_at=now(),
      status=case when p_order->>'status'='cancelled' then 'cancelled' when status='cancelled' then status when v_origin='site' and p_order->>'status' in ('draft','pending') then status else coalesce(p_order->>'status',status) end
      where id=v_id;
    -- Local paid order remains owned by the worker; webhook must not replace
    -- its immutable prices/payment or clear its fencing token.
    if v_origin='site' then return v_id; end if;
  else
    insert into public.store_orders(idempotency_key,bling_id,origin,external_order_id,status,customer_data,shipping_data,subtotal,total,bling_sync_status)
    values('bling-'||(p_order->>'blingId'),p_order->>'blingId',p_order->>'origin',p_order->>'reference',p_order->>'status',p_order->'customer',p_order->'shipping',(p_order->>'subtotal')::numeric,(p_order->>'total')::numeric,'synced') returning id into v_id;
  end if;
  update public.store_orders set customer_data=p_order->'customer',shipping_data=p_order->'shipping',total=(p_order->>'total')::numeric,subtotal=(p_order->>'subtotal')::numeric,synced_at=now() where id=v_id;
  delete from public.store_order_items where order_id=v_id;
  for v_item in select value from jsonb_array_elements(p_order->'items') loop
    insert into public.store_order_items(order_id,bling_product_id,sku,name,quantity,unit_price,total) values(v_id,v_item->>'blingProductId',v_item->>'sku',v_item->>'name',(v_item->>'quantity')::numeric,(v_item->>'unitPrice')::numeric,(v_item->>'total')::numeric);
  end loop;
  insert into public.store_order_events(order_id,kind,details) values(v_id,'bling.imported',jsonb_build_object('origin',p_order->>'origin'));
  return v_id;
end $$;
revoke all on function public.import_bling_order(jsonb) from public,anon,authenticated;
grant execute on function public.import_bling_order(jsonb) to service_role;

create function private.bling_process_order_queue() returns void
language plpgsql security definer set search_path=private,net,pg_temp as $$
declare v_url text; v_secret text;
begin
  if not private.try_acquire_cron_lock('bling-order-sync-process',55) then return; end if;
  select value into v_url from private.integration_settings where key='bling_order_process_url';
  select value into v_secret from private.integration_settings where key='bling_webhook_process_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url:=v_url,headers:=jsonb_build_object('Content-Type','application/json','x-integration-admin-secret',v_secret),body:='{}'::jsonb,timeout_milliseconds:=20000);
end $$;
revoke all on function private.bling_process_order_queue() from public,anon,authenticated;
select cron.schedule('bling-order-process-tick','* * * * *','select private.bling_process_order_queue();');

create table public.store_admin_operations(
  operation_key uuid primary key,
  resource text not null,
  actor_id uuid,
  fingerprint text not null,
  status text not null check(status in ('processing','completed','failed','review')),
  submitted_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.store_admin_operations enable row level security;
revoke all on public.store_admin_operations from public,anon,authenticated;
grant select,insert,update on public.store_admin_operations to service_role;
create unique index store_admin_resource_lock on public.store_admin_operations(resource) where status in ('processing','review');
create function public.claim_admin_operation(p_key uuid,p_resource text,p_actor uuid,p_fingerprint text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.store_admin_operations;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin:'||p_resource,0));
  select * into v from public.store_admin_operations where operation_key=p_key for update;
  if found then
    if v.actor_id is distinct from p_actor or v.resource<>p_resource or v.fingerprint<>p_fingerprint then raise exception 'operation_key_conflict'; end if;
    if v.status<>'failed' then return jsonb_build_object('state',v.status,'result',v.result); end if;
    update public.store_admin_operations set status='processing',submitted_at=null,updated_at=now() where operation_key=p_key;
  else
    insert into public.store_admin_operations(operation_key,resource,actor_id,fingerprint,status) values(p_key,p_resource,p_actor,p_fingerprint,'processing');
  end if;
  return '{"state":"claimed"}'::jsonb;
end $$;
revoke all on function public.claim_admin_operation(uuid,text,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_admin_operation(uuid,text,uuid,text) to service_role;
create function public.finish_admin_operation(p_key uuid,p_status text,p_result jsonb) returns void
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v public.store_admin_operations;
begin
  update public.store_admin_operations set status=p_status,result=p_result,updated_at=now() where operation_key=p_key and status='processing' returning * into v;
  if not found then raise exception 'operation_claim_lost'; end if;
  insert into public.store_order_events(actor_id,kind,details) values(v.actor_id,'admin.operation.'||p_status,jsonb_build_object('resource',v.resource,'operationKey',p_key,'result',p_result));
end $$;
revoke all on function public.finish_admin_operation(uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.finish_admin_operation(uuid,text,jsonb) to service_role;

-- A reconciled payment advances the local order atomically. This function is
-- service-only; only payment_check results may be passed by the Edge Function.
create or replace function public.mark_order_paid(
  p_order_id uuid,p_payment_provider text,p_transaction_nsu text,p_invoice_slug text,
  p_capture_method text,p_paid_amount integer,p_installments integer,p_receipt_url text,p_raw jsonb
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_rows integer;
begin
  if p_payment_provider<>'infinitepay' or nullif(trim(p_transaction_nsu),'') is null or
     nullif(trim(p_invoice_slug),'') is null or jsonb_typeof(p_raw->'amount') is distinct from 'number'
     then raise exception 'invalid_payment_proof'; end if;
  update public.store_orders set
    payment_status='paid',status=case when status in ('draft','pending') then 'paid' else status end,
    payment_provider=p_payment_provider,payment_transaction_nsu=p_transaction_nsu,payment_invoice_slug=p_invoice_slug,
    payment_capture_method=p_capture_method,payment_paid_amount=p_paid_amount,payment_installments=p_installments,
    payment_receipt_url=p_receipt_url,payment_raw_status=p_raw,payment_paid_at=now(),payment_checked_at=now(),
    bling_sync_status=case when bling_sync_status='disabled' then 'pending' else bling_sync_status end
    where id=p_order_id and payment_status='pending' and status<>'cancelled'
      and round(total*100)=(p_raw->>'amount')::numeric
      and coalesce(shipping_data->>'pricing','fixed')<>'quote';
  get diagnostics v_rows=row_count;
  return v_rows=1;
end $$;
revoke all on function public.mark_order_paid(uuid,text,text,text,text,integer,integer,text,jsonb) from public,anon,authenticated;
grant execute on function public.mark_order_paid(uuid,text,text,text,text,integer,integer,text,jsonb) to service_role;
