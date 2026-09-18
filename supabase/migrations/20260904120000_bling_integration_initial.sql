-- =====================================================================
-- ANAROSA × BLING — migration inicial da integração
-- ---------------------------------------------------------------------
-- Cria:
--   * tabelas SECRETAS (somente service role): bling_connections,
--     bling_oauth_states, bling_webhook_events, integration_logs
--   * cache da vitrine: store_categories, store_products,
--     store_product_variants, store_inventory
--   * estrutura futura de pedidos: store_orders, store_order_items
--   * funções auxiliares (RPC) usadas pelas Edge Functions
--
-- Segurança:
--   * RLS habilitado em TODAS as tabelas.
--   * Nenhuma policy para anon/authenticated: o navegador não lê nada
--     diretamente; o acesso público acontece via Edge Functions
--     (storefront-*), que devolvem apenas campos sanitizados.
--   * Privilégios revogados de anon/authenticated como segunda camada.
--   * Tokens armazenados como TEXT (JWT do Bling tem ~1.500 a 3.000 chars).
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Utilitários
-- ---------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Regra central de estoque disponível (fonte: Bling).
-- Regra padrão (documentada em docs/BLING_DATA_FLOW.md):
--   disponível = saldo VIRTUAL quando informado (já desconta reservas
--   de pedidos em aberto no Bling); caso contrário saldo FÍSICO;
--   nunca negativo.
create or replace function public.store_available_stock(
  p_physical numeric,
  p_virtual numeric
)
returns numeric
language sql
immutable
as $$
  select greatest(coalesce(p_virtual, p_physical, 0), 0);
$$;

-- =====================================================================
-- 1. bling_connections (SECRETA)
-- =====================================================================
create table if not exists public.bling_connections (
  id                  uuid primary key default gen_random_uuid(),
  company_id          text,
  access_token        text,
  refresh_token       text,
  token_type          text default 'Bearer',
  expires_at          timestamptz,
  scope               text,
  status              text not null default 'disconnected'
                      check (status in ('disconnected', 'connected', 'refresh_failed', 'revoked')),
  connected_at        timestamptz,
  last_refresh_at     timestamptz,
  refresh_lock_until  timestamptz,
  last_sync_at        timestamptz,
  last_error          text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

comment on table public.bling_connections is
  'Conexao OAuth com o Bling. NUNCA expor ao frontend. Somente service role.';

create trigger trg_bling_connections_updated_at
  before update on public.bling_connections
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 2. bling_oauth_states (SECRETA) - protecao CSRF do OAuth
-- =====================================================================
create table if not exists public.bling_oauth_states (
  id          uuid primary key default gen_random_uuid(),
  state_hash  text not null unique,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz,
  metadata    jsonb not null default '{}'::jsonb
);

comment on table public.bling_oauth_states is
  'Armazena apenas o SHA-256 do state OAuth. Uso unico, expiracao curta.';

create index if not exists idx_bling_oauth_states_expires_at
  on public.bling_oauth_states (expires_at);

-- =====================================================================
-- 3. bling_webhook_events (SECRETA) - idempotencia de webhooks
-- =====================================================================
create table if not exists public.bling_webhook_events (
  event_id        text primary key,
  event_type      text not null,
  company_id      text,
  event_date      timestamptz,
  payload         jsonb not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'processing', 'processed', 'failed', 'ignored')),
  received_at     timestamptz not null default now(),
  processed_at    timestamptz,
  error_message   text,
  retry_count     integer not null default 0,
  next_retry_at   timestamptz
);

comment on table public.bling_webhook_events is
  'Eventos recebidos do Bling. event_id garante processamento unico.';

create index if not exists idx_bling_webhook_events_status
  on public.bling_webhook_events (status, next_retry_at);
create index if not exists idx_bling_webhook_events_received_at
  on public.bling_webhook_events (received_at desc);

-- =====================================================================
-- 4. store_categories
-- =====================================================================
create table if not exists public.store_categories (
  id          uuid primary key default gen_random_uuid(),
  bling_id    text unique,
  name        text not null,
  slug        text not null unique,
  parent_id   uuid references public.store_categories (id) on delete set null,
  active      boolean not null default true,
  sort_order  integer not null default 0,
  synced_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger trg_store_categories_updated_at
  before update on public.store_categories
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 5. store_products
-- =====================================================================
create table if not exists public.store_products (
  id                 uuid primary key default gen_random_uuid(),
  bling_id           text not null unique,
  parent_bling_id    text,
  sku                text,
  name               text not null,
  slug               text not null unique,
  short_description  text,
  description        text,
  category_id        uuid references public.store_categories (id) on delete set null,
  brand              text,
  price              numeric(12,2) not null default 0,
  promotional_price  numeric(12,2),
  format             text,          -- Bling: S=simples, V=com variacoes, E=composicao
  condition          text,
  active             boolean not null default true,
  images             jsonb not null default '[]'::jsonb,
  metadata           jsonb not null default '{}'::jsonb,
  bling_updated_at   timestamptz,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_store_products_active on public.store_products (active);
create index if not exists idx_store_products_category on public.store_products (category_id);
create index if not exists idx_store_products_sku on public.store_products (sku);
create index if not exists idx_store_products_parent on public.store_products (parent_bling_id);

create trigger trg_store_products_updated_at
  before update on public.store_products
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 6. store_product_variants
-- =====================================================================
create table if not exists public.store_product_variants (
  id                 uuid primary key default gen_random_uuid(),
  product_id         uuid not null references public.store_products (id) on delete cascade,
  bling_id           text not null unique,
  sku                text,
  name               text not null,
  color              text,
  size               text,
  price              numeric(12,2),
  promotional_price  numeric(12,2),
  active             boolean not null default true,
  attributes         jsonb not null default '{}'::jsonb,
  metadata           jsonb not null default '{}'::jsonb,
  synced_at          timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists idx_store_product_variants_product
  on public.store_product_variants (product_id);

create trigger trg_store_product_variants_updated_at
  before update on public.store_product_variants
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 7. store_inventory - um registro por (produto Bling, deposito)
-- =====================================================================
create table if not exists public.store_inventory (
  id                uuid primary key default gen_random_uuid(),
  bling_product_id  text not null,
  product_id        uuid references public.store_products (id) on delete cascade,
  variant_id        uuid references public.store_product_variants (id) on delete cascade,
  deposit_id        text not null default '__total__',
  physical_stock    numeric(14,3) not null default 0,
  virtual_stock     numeric(14,3),
  available_stock   numeric(14,3) generated always as
                    (public.store_available_stock(physical_stock, virtual_stock)) stored,
  updated_at        timestamptz not null default now(),
  synced_at         timestamptz,
  unique (bling_product_id, deposit_id)
);

comment on column public.store_inventory.deposit_id is
  'ID do deposito no Bling. "__total__" guarda o saldo consolidado informado pelo Bling.';

create index if not exists idx_store_inventory_product on public.store_inventory (product_id);
create index if not exists idx_store_inventory_variant on public.store_inventory (variant_id);

create trigger trg_store_inventory_updated_at
  before update on public.store_inventory
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 8. integration_logs (SECRETA)
-- =====================================================================
create table if not exists public.integration_logs (
  id           uuid primary key default gen_random_uuid(),
  integration  text not null default 'bling',
  level        text not null check (level in ('debug', 'info', 'warn', 'error')),
  operation    text not null,
  entity_type  text,
  entity_id    text,
  message      text not null,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idx_integration_logs_created_at
  on public.integration_logs (created_at desc);
create index if not exists idx_integration_logs_level
  on public.integration_logs (level, created_at desc);

-- =====================================================================
-- 9. store_orders - estrutura inicial (checkout NAO ativo)
-- =====================================================================
create table if not exists public.store_orders (
  id                 uuid primary key default gen_random_uuid(),
  idempotency_key    text not null unique,
  bling_id           text unique,
  order_number       text,
  status             text not null default 'draft'
                     check (status in ('draft', 'pending', 'confirmed', 'paid', 'shipped', 'delivered', 'cancelled')),
  customer_data      jsonb not null default '{}'::jsonb,
  shipping_data      jsonb not null default '{}'::jsonb,
  payment_data       jsonb not null default '{}'::jsonb,
  subtotal           numeric(12,2) not null default 0,
  discount           numeric(12,2) not null default 0,
  shipping           numeric(12,2) not null default 0,
  total              numeric(12,2) not null default 0,
  bling_sync_status  text not null default 'disabled'
                     check (bling_sync_status in ('disabled', 'pending', 'synced', 'failed')),
  bling_sync_error   text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  synced_at          timestamptz
);

create trigger trg_store_orders_updated_at
  before update on public.store_orders
  for each row execute function public.set_updated_at();

-- =====================================================================
-- 10. store_order_items
-- =====================================================================
create table if not exists public.store_order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references public.store_orders (id) on delete cascade,
  product_id        uuid references public.store_products (id) on delete set null,
  variant_id        uuid references public.store_product_variants (id) on delete set null,
  bling_product_id  text,
  sku               text,
  name              text not null,
  quantity          numeric(12,3) not null check (quantity > 0),
  unit_price        numeric(12,2) not null,
  total             numeric(12,2) not null,
  metadata          jsonb not null default '{}'::jsonb
);

create index if not exists idx_store_order_items_order on public.store_order_items (order_id);

-- =====================================================================
-- RLS + privilegios
-- =====================================================================
alter table public.bling_connections      enable row level security;
alter table public.bling_oauth_states     enable row level security;
alter table public.bling_webhook_events   enable row level security;
alter table public.integration_logs       enable row level security;
alter table public.store_categories       enable row level security;
alter table public.store_products         enable row level security;
alter table public.store_product_variants enable row level security;
alter table public.store_inventory        enable row level security;
alter table public.store_orders           enable row level security;
alter table public.store_order_items      enable row level security;

-- Nenhuma policy e criada: anon/authenticated nao leem nem escrevem.
-- Service role (Edge Functions) ignora RLS por definicao.
revoke all on table
  public.bling_connections,
  public.bling_oauth_states,
  public.bling_webhook_events,
  public.integration_logs,
  public.store_categories,
  public.store_products,
  public.store_product_variants,
  public.store_inventory,
  public.store_orders,
  public.store_order_items
from anon, authenticated;

-- =====================================================================
-- RPCs (somente service role)
-- =====================================================================

-- Consome um state OAuth de forma atomica.
-- Retorna true somente se existir, nao tiver expirado e nao tiver sido usado.
create or replace function public.bling_consume_oauth_state(p_state_hash text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.bling_oauth_states
     set used_at = now()
   where state_hash = p_state_hash
     and used_at is null
     and expires_at > now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Registra evento de webhook. Retorna true se for NOVO (deve ser processado),
-- false se o event_id ja existia (duplicado -> apenas responder 2xx).
create or replace function public.bling_register_webhook_event(
  p_event_id   text,
  p_event_type text,
  p_company_id text,
  p_event_date timestamptz,
  p_payload    jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  insert into public.bling_webhook_events
    (event_id, event_type, company_id, event_date, payload, status)
  values
    (p_event_id, p_event_type, p_company_id, p_event_date, p_payload, 'pending')
  on conflict (event_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Lock leve para refresh de token (evita duas funcoes renovando ao mesmo tempo).
-- Retorna true se o chamador obteve o lock. O lock expira sozinho apos p_ttl_seconds.
create or replace function public.bling_try_acquire_refresh_lock(
  p_connection_id uuid,
  p_ttl_seconds   integer default 30
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.bling_connections
     set refresh_lock_until = now() + make_interval(secs => p_ttl_seconds)
   where id = p_connection_id
     and (refresh_lock_until is null or refresh_lock_until < now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Persiste novos tokens e libera o lock em uma unica operacao atomica.
create or replace function public.bling_complete_token_refresh(
  p_connection_id uuid,
  p_access_token  text,
  p_refresh_token text,
  p_token_type    text,
  p_expires_at    timestamptz,
  p_scope         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bling_connections
     set access_token       = p_access_token,
         refresh_token      = coalesce(p_refresh_token, refresh_token),
         token_type         = coalesce(p_token_type, token_type),
         expires_at         = p_expires_at,
         scope              = coalesce(p_scope, scope),
         status             = 'connected',
         last_refresh_at    = now(),
         last_error         = null,
         refresh_lock_until = null
   where id = p_connection_id;
end;
$$;

-- Marca falha de refresh e libera o lock.
create or replace function public.bling_fail_token_refresh(
  p_connection_id uuid,
  p_error         text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.bling_connections
     set status             = 'refresh_failed',
         last_error         = left(coalesce(p_error, 'unknown'), 500),
         refresh_lock_until = null
   where id = p_connection_id;
end;
$$;

-- Reserva um evento de webhook para processamento de forma atomica
-- (evita dois workers pegando o mesmo evento).
create or replace function public.bling_claim_webhook_event(p_event_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.bling_webhook_events
     set status = 'processing'
   where event_id = p_event_id
     and status in ('pending', 'failed')
     and (next_retry_at is null or next_retry_at <= now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

-- Limpeza de states expirados (chamar ocasionalmente).
create or replace function public.bling_cleanup_oauth_states()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  delete from public.bling_oauth_states
   where expires_at < now() - interval '1 day';
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke execute on function public.bling_consume_oauth_state(text)                                          from public, anon, authenticated;
revoke execute on function public.bling_register_webhook_event(text, text, text, timestamptz, jsonb)     from public, anon, authenticated;
revoke execute on function public.bling_try_acquire_refresh_lock(uuid, integer)                            from public, anon, authenticated;
revoke execute on function public.bling_complete_token_refresh(uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.bling_fail_token_refresh(uuid, text)                                     from public, anon, authenticated;
revoke execute on function public.bling_claim_webhook_event(text)                                          from public, anon, authenticated;
revoke execute on function public.bling_cleanup_oauth_states()                                             from public, anon, authenticated;
revoke execute on function public.store_available_stock(numeric, numeric)                                  from public, anon, authenticated;

-- =====================================================================
-- View interna de estoque consolidado por produto/variacao
-- (usada pelas Edge Functions storefront-*; nao exposta a anon)
-- =====================================================================
create or replace view public.store_stock_totals
with (security_invoker = true)
as
select
  bling_product_id,
  product_id,
  variant_id,
  sum(physical_stock)  as physical_stock,
  sum(virtual_stock)   as virtual_stock,
  sum(available_stock) as available_stock,
  max(synced_at)       as synced_at
from public.store_inventory
where deposit_id <> '__total__'
group by bling_product_id, product_id, variant_id;

revoke all on public.store_stock_totals from anon, authenticated;
