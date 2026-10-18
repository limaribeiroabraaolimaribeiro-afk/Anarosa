-- Aggregate health only. No PII, payment URLs, document numbers or tokens.
select jsonb_build_object(
  'checked_at',now(),
  'products',(select jsonb_build_object('total',count(*),'active',count(*) filter(where active),'unknown_price',count(*) filter(where price is null or price<=0)) from public.store_products),
  'variants',(select jsonb_build_object('total',count(*),'active',count(*) filter(where active)) from public.store_product_variants),
  'categories',(select count(*) from public.store_categories),
  'inventory',(select jsonb_build_object('rows',count(*),'skus',count(distinct bling_product_id),'last_updated',max(updated_at)) from public.store_inventory),
  'orders',(select jsonb_build_object('total',count(*),'paid',count(*) filter(where payment_status='paid'),'pending',count(*) filter(where payment_status='pending'),'has_payment_link',count(*) filter(where payment_url is not null),'orphan_link_claim',count(*) filter(where payment_provider='infinitepay' and payment_url is null),'already_exported',count(*) filter(where bling_id is not null),'waiting_for_bling',count(*) filter(where payment_status='paid' and bling_id is null),'unknown_freight',count(*) filter(where shipping_data->>'method'='delivery' and coalesce(shipping_data->>'pricing','')<>'fixed')) from public.store_orders),
  'orders_by_state',(select jsonb_agg(x) from (select origin,status,payment_status,bling_sync_status,count(*) as orders from public.store_orders group by 1,2,3,4) x),
  'admins',(select jsonb_build_object('total',count(*),'active',count(*) filter(where active)) from public.store_admins),
  'bling_connection',(select jsonb_agg(jsonb_build_object('status',status,'has_access_token',access_token is not null,'has_refresh_token',refresh_token is not null,'expires_at',expires_at,'scope',scope,'last_sync_at',last_sync_at,'last_refresh_at',last_refresh_at)) from public.bling_connections),
  'bling_webhooks',(select jsonb_agg(x) from (select status,count(*) as events,max(received_at) as last_received from public.bling_webhook_events group by status) x),
  'payment_webhooks',(select jsonb_agg(x) from (select status,count(*) as events,max(received_at) as last_received from public.payment_webhook_events group by status) x),
  'cron',(select jsonb_agg(jsonb_build_object('name',jobname,'schedule',schedule,'active',active,'command_md5',md5(command))) from cron.job),
  'private_setting_keys',(select jsonb_agg(jsonb_build_object('key',key,'configured',length(coalesce(value,''))>0)) from private.integration_settings),
  'public_views',(select jsonb_agg(jsonb_build_object('name',c.relname,'options',c.reloptions,'anon_select',has_table_privilege('anon',c.oid,'select'),'authenticated_select',has_table_privilege('authenticated',c.oid,'select'))) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='v'),
  'event_triggers',(select jsonb_agg(jsonb_build_object('name',evtname,'function',evtfoid::regprocedure::text,'enabled',evtenabled)) from pg_event_trigger)
) as operations;
