-- =====================================================================
-- ANAROSA — extensão de store_orders para checkout real + pagamento
-- (InfinitePay) + omnichannel (Shopee/Mercado Livre via Bling)
-- ---------------------------------------------------------------------
-- NÃO edita nenhuma migration já aplicada. Só ADICIONA:
--   * colunas novas em store_orders (origem/canal, pagamento, tentativas
--     de sincronização com o Bling, token público de consulta);
--   * tabela payment_webhook_events (idempotência de webhooks de
--     pagamento — mesmo padrão de bling_webhook_events);
--   * tabela privada de contagem para rate limiting (private.rate_limit_hits)
--     + função pública (mas service_role-only) para incrementar/checar;
--   * RPC mark_order_paid — transição atômica e idempotente
--     pending → paid (nunca reprocessa um pedido já pago);
--   * RPC payment_register_webhook_event — idempotência de webhook de
--     pagamento (dedupe por transaction_nsu, mesmo padrão de
--     bling_register_webhook_event).
--
-- Por que estas colunas e não outras:
--   * `origin`/`external_order_id` — permitem à Gestão Anarosa mostrar
--     pedidos de qualquer canal (FASE 7) e permitem importar pedidos que
--     chegam ao Bling vindos de Shopee/Mercado Livre sem duplicar
--     (FASE 9/10 — ver docs/MARKETPLACE_SETUP.md para o que é e não é
--     confirmável hoje via API oficial do Bling).
--   * `payment_status` só aceita 'pending' | 'paid' | 'failed' | 'cancelled'.
--     A documentação oficial do Checkout Integrado InfinitePay
--     (https://www.infinitepay.io/checkout-documentacao, consultada em
--     2026-09-14) só evidencia paid:true/false via POST /payment_check —
--     a InfinitePay NÃO fornece um status "failed" literal. Por isso:
--       'pending'   → padrão; também cobre "consultamos e ainda não pagou";
--       'paid'      → payment_check confirmou success=true, paid=true E
--                      amount == total esperado (ver mark_order_paid);
--       'failed'    → status INTERNO nosso (não da InfinitePay): usado
--                      quando a reconciliação encontra uma ANOMALIA que
--                      exige atenção humana (ex.: valor pago diverge do
--                      esperado — possível adulteração/erro), nunca só
--                      por "ainda não pago";
--       'cancelled' → decisão OPERACIONAL da própria loja (ex.: pedido
--                      abandonado cancelado manualmente na Gestão), não
--                      um status reportado pela InfinitePay.
--     Ver docs/INFINITEPAY_SETUP.md e o relatório final para o detalhe
--     completo desta decisão.
--   * `public_token` — identificador aleatório INDEPENDENTE de `id`,
--     usado pela página de confirmação pública (FASE 6): mesmo que um
--     `id` apareça em algum log interno, ele não permite consultar o
--     status do pedido publicamente.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. store_orders — novas colunas
-- ---------------------------------------------------------------------
alter table public.store_orders
  add column if not exists origin                    text not null default 'site',
  add column if not exists external_order_id          text,
  add column if not exists payment_provider           text,
  add column if not exists payment_status             text not null default 'pending',
  add column if not exists payment_url                text,
  add column if not exists payment_transaction_nsu    text,
  add column if not exists payment_invoice_slug        text,
  add column if not exists payment_capture_method      text,
  add column if not exists payment_paid_amount         integer,
  add column if not exists payment_installments        integer,
  add column if not exists payment_receipt_url         text,
  add column if not exists payment_created_at          timestamptz,
  add column if not exists payment_paid_at             timestamptz,
  add column if not exists payment_checked_at          timestamptz,
  add column if not exists payment_raw_status          jsonb not null default '{}'::jsonb,
  add column if not exists bling_sync_attempts         integer not null default 0,
  add column if not exists bling_last_attempt_at       timestamptz,
  add column if not exists public_token                text;

comment on column public.store_orders.origin is
  'Canal de origem do pedido. "bling_import": pedido encontrado no Bling '
  '(webhook order.created) sem idempotency_key nossa — provavelmente '
  'marketplace conectado nativamente ao Bling ou balcão. "other": canal '
  'reconhecido mas não mapeado nesta versão.';
comment on column public.store_orders.payment_status is
  'pending|paid|failed|cancelled — ver nota no topo desta migration.';
comment on column public.store_orders.payment_paid_amount is
  'paid_amount devolvido pelo payment_check, em CENTAVOS. Pode ser maior '
  'que o total esperado (ex.: acréscimo de parcelamento) — a reconciliação '
  'em mark_order_paid compara contra o campo "amount" (valor da cobrança), '
  'não contra paid_amount.';
comment on column public.store_orders.public_token is
  'Token aleatório independente de id, para consulta pública de status '
  '(pedido-confirmado.html / storefront-order-status). Nunca usar id como '
  'identificador público.';

-- Backfill de public_token para linhas existentes (idempotente: só afeta
-- quem ainda está nulo) e trava NOT NULL + default para linhas futuras.
update public.store_orders
   set public_token = encode(extensions.gen_random_bytes(20), 'hex')
 where public_token is null;

alter table public.store_orders
  alter column public_token set default encode(extensions.gen_random_bytes(20), 'hex'),
  alter column public_token set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'chk_store_orders_origin'
  ) then
    alter table public.store_orders
      add constraint chk_store_orders_origin
      check (origin in ('site', 'shopee', 'mercado_livre', 'manual', 'bling_import', 'other'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_store_orders_payment_status'
  ) then
    alter table public.store_orders
      add constraint chk_store_orders_payment_status
      check (payment_status in ('pending', 'paid', 'failed', 'cancelled'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_store_orders_payment_provider'
  ) then
    alter table public.store_orders
      add constraint chk_store_orders_payment_provider
      check (payment_provider is null or payment_provider in ('infinitepay'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'chk_store_orders_payment_capture_method'
  ) then
    alter table public.store_orders
      add constraint chk_store_orders_payment_capture_method
      check (payment_capture_method is null or payment_capture_method in ('pix', 'credit_card'));
  end if;
end $$;

create index if not exists idx_store_orders_origin on public.store_orders (origin);
create index if not exists idx_store_orders_payment_status on public.store_orders (payment_status);
create index if not exists idx_store_orders_bling_pending
  on public.store_orders (bling_sync_status)
  where bling_sync_status in ('pending', 'failed');

create unique index if not exists uq_store_orders_public_token
  on public.store_orders (public_token);

-- Um pedido por (canal, id externo) — evita importar o mesmo pedido de
-- marketplace duas vezes caso ele não tenha bling_id ainda no primeiro
-- registro (ex.: cadastrado via outra rota antes do webhook confirmar).
create unique index if not exists uq_store_orders_external_order
  on public.store_orders (origin, external_order_id)
  where external_order_id is not null;

-- Um pedido por (provedor, transaction_nsu) — evita dois pedidos
-- diferentes reivindicarem a mesma transação InfinitePay.
create unique index if not exists uq_store_orders_payment_transaction
  on public.store_orders (payment_provider, payment_transaction_nsu)
  where payment_transaction_nsu is not null;

-- ---------------------------------------------------------------------
-- 2. payment_webhook_events (SECRETA) — idempotência de webhook de
--    pagamento. Mesmo padrão de bling_webhook_events, adaptado: a
--    InfinitePay não documenta um eventId próprio (ver
--    checkout-documentacao), então a chave de dedupe é
--    (provider, transaction_nsu).
-- ---------------------------------------------------------------------
create table if not exists public.payment_webhook_events (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null,
  transaction_nsu  text,
  order_nsu        text,
  invoice_slug     text,
  payload          jsonb not null,
  status           text not null default 'pending'
                   check (status in ('pending', 'processed', 'ignored', 'failed')),
  received_at      timestamptz not null default now(),
  processed_at      timestamptz,
  error_message    text
);

comment on table public.payment_webhook_events is
  'Eventos recebidos do webhook de pagamento (InfinitePay). NUNCA é a '
  'fonte de verdade sobre o pagamento por si só — todo evento é '
  'reconciliado contra POST /payment_check antes de marcar um pedido '
  'como pago (a InfinitePay não documenta assinatura/HMAC de webhook).';

create unique index if not exists uq_payment_webhook_events_provider_txn
  on public.payment_webhook_events (provider, transaction_nsu)
  where transaction_nsu is not null;

create index if not exists idx_payment_webhook_events_status
  on public.payment_webhook_events (status, received_at);

alter table public.payment_webhook_events enable row level security;
revoke all on table public.payment_webhook_events from anon, authenticated;
grant select, insert, update on table public.payment_webhook_events to service_role;

-- ---------------------------------------------------------------------
-- 3. Rate limiting (contador privado + função pública service_role-only)
-- ---------------------------------------------------------------------
-- IMPORTANTE: a função fica no schema `public` (não `private`) porque
-- PostgREST/supabase-js só expõe RPCs do(s) schema(s) configurados em
-- db.schemas — hoje só "public". Colocar a função em "private" a
-- deixaria INALCANÇÁVEL via ctx.db.rpc(...) a partir das Edge Functions
-- (mesmo padrão de bling_consume_oauth_state etc.: função em `public`,
-- mas sem GRANT para anon/authenticated — anon não consegue chamar
-- mesmo conhecendo o nome/endpoint). A TABELA de contagem em si
-- continua em `private` (nunca exposta como recurso REST).
create table if not exists private.rate_limit_hits (
  bucket        text not null,
  window_start  timestamptz not null,
  hits          integer not null default 0,
  primary key (bucket, window_start)
);

alter table private.rate_limit_hits enable row level security;
revoke all on table private.rate_limit_hits from anon, authenticated;

create or replace function public.rl_check_and_increment(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = private, public, pg_temp
as $$
declare
  v_window timestamptz;
  v_hits   integer;
begin
  if p_bucket is null or p_bucket = '' or p_limit <= 0 or p_window_seconds <= 0 then
    return true; -- configuração inválida nunca bloqueia o chamador
  end if;
  v_window := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into private.rate_limit_hits (bucket, window_start, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start) do update
    set hits = private.rate_limit_hits.hits + 1
  returning hits into v_hits;
  return v_hits <= p_limit;
exception when others then
  -- rate limit nunca pode derrubar o endpoint que protege
  return true;
end;
$$;

revoke execute on function public.rl_check_and_increment(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rl_check_and_increment(text, integer, integer) to service_role;

create or replace function private.cleanup_rate_limit_hits()
returns void
language sql
security definer
set search_path = private, pg_temp
as $$
  delete from private.rate_limit_hits where window_start < now() - interval '1 day';
$$;

revoke execute on function private.cleanup_rate_limit_hits() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'rate-limit-hits-cleanup';
select cron.schedule(
  'rate-limit-hits-cleanup',
  '17 * * * *',
  $$select private.cleanup_rate_limit_hits();$$
);

-- ---------------------------------------------------------------------
-- 4. RPC: transição atômica e idempotente pending → paid
-- ---------------------------------------------------------------------
-- Só transiciona quando payment_status ainda é 'pending' (guarda contra
-- webhook duplicado, reconciliação concorrente, retry). Sempre marca
-- bling_sync_status='pending' (fila) — mesmo que BLING_ORDER_SYNC_ENABLED
-- esteja false: o worker de sincronização (bling-order-sync-process)
-- consulta a flag antes de qualquer chamada ao Bling; com a flag
-- desligada, o pedido só fica "pending" na fila sem nenhum efeito.
create or replace function public.mark_order_paid(
  p_order_id           uuid,
  p_payment_provider   text,
  p_transaction_nsu    text,
  p_invoice_slug       text,
  p_capture_method     text,
  p_paid_amount        integer,
  p_installments       integer,
  p_receipt_url        text,
  p_raw                jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.store_orders
     set payment_status          = 'paid',
         payment_provider        = coalesce(p_payment_provider, payment_provider),
         payment_transaction_nsu = coalesce(p_transaction_nsu, payment_transaction_nsu),
         payment_invoice_slug    = coalesce(p_invoice_slug, payment_invoice_slug),
         payment_capture_method  = coalesce(p_capture_method, payment_capture_method),
         payment_paid_amount     = coalesce(p_paid_amount, payment_paid_amount),
         payment_installments    = coalesce(p_installments, payment_installments),
         payment_receipt_url     = coalesce(p_receipt_url, payment_receipt_url),
         payment_raw_status      = coalesce(p_raw, payment_raw_status),
         payment_paid_at         = now(),
         payment_checked_at      = now(),
         bling_sync_status       = case when bling_sync_status = 'disabled' then 'pending' else bling_sync_status end
   where id = p_order_id
     and payment_status = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.mark_order_paid(uuid, text, text, text, text, integer, integer, text, jsonb) from public, anon, authenticated;
grant execute on function public.mark_order_paid(uuid, text, text, text, text, integer, integer, text, jsonb) to service_role;

-- Marca anomalia detectada na reconciliação (ex.: amount pago diverge do
-- esperado) — status INTERNO 'failed', nunca reportado pela InfinitePay
-- (ver comentário no topo da migration). Só transiciona a partir de
-- 'pending' (idempotente: uma segunda tentativa não sobrescreve).
create or replace function public.payment_flag_failed(
  p_order_id uuid,
  p_reason   text,
  p_raw      jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.store_orders
     set payment_status     = 'failed',
         payment_checked_at = now(),
         payment_raw_status = coalesce(p_raw, payment_raw_status) || jsonb_build_object('failure_reason', p_reason)
   where id = p_order_id
     and payment_status = 'pending';
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.payment_flag_failed(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_flag_failed(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------
-- 5. RPC: registro idempotente de webhook de pagamento
-- ---------------------------------------------------------------------
create or replace function public.payment_register_webhook_event(
  p_provider        text,
  p_transaction_nsu text,
  p_order_nsu       text,
  p_invoice_slug    text,
  p_payload         jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  if p_transaction_nsu is null or p_transaction_nsu = '' then
    -- Sem identificador único: não há como dedupe automático — registra
    -- sempre e deixa o handler decidir (ele reconcilia via payment_check
    -- antes de qualquer mudança de estado, então um registro duplicado
    -- aqui não duplica efeito no pedido).
    insert into public.payment_webhook_events (provider, transaction_nsu, order_nsu, invoice_slug, payload)
    values (p_provider, null, p_order_nsu, p_invoice_slug, p_payload);
    return true;
  end if;

  insert into public.payment_webhook_events (provider, transaction_nsu, order_nsu, invoice_slug, payload)
  values (p_provider, p_transaction_nsu, p_order_nsu, p_invoice_slug, p_payload)
  on conflict (provider, transaction_nsu) where transaction_nsu is not null do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.payment_register_webhook_event(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_register_webhook_event(text, text, text, text, jsonb) to service_role;

create or replace function public.payment_mark_webhook_event(
  p_id     uuid,
  p_status text,
  p_error  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.payment_webhook_events
     set status = p_status,
         processed_at = now(),
         error_message = p_error
   where id = p_id;
end;
$$;

revoke execute on function public.payment_mark_webhook_event(uuid, text, text) from public, anon, authenticated;
grant execute on function public.payment_mark_webhook_event(uuid, text, text) to service_role;
