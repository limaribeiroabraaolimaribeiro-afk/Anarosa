-- =====================================================================
-- ANAROSA × InfinitePay — correções de confiabilidade encontradas na
-- auditoria pré-produção de 2026-09-17.
-- ---------------------------------------------------------------------
-- NÃO edita as migrations já aplicadas (20260914160000/20260914170000).
--
-- ACHADO 1 — infinitepay-webhook aguardava payment_check de forma
-- SÍNCRONA antes de responder (risco de exceder o tempo recomendado
-- pela InfinitePay e de nenhuma tentativa acontecer se o processo
-- morrer no meio do caminho, já que a InfinitePay não reenvia depois
-- de um 200). Correção: fila de reprocessamento idêntica em desenho à
-- já usada para os webhooks do Bling (bling_webhook_events +
-- bling-webhook-process + pg_cron) — mesmo mecanismo oficialmente
-- suportado (EdgeRuntime.waitUntil + pg_cron/pg_net), nada novo
-- inventado. Requer:
--   * payment_webhook_events: colunas retry_count/next_retry_at;
--   * status agora aceita também 'processing' (claim atômico);
--   * payment_register_webhook_event passa a devolver o id (uuid) do
--     evento em vez de um boolean — precisamos do id para agendar o
--     processamento em background;
--   * payment_claim_webhook_event(uuid) — mesmo padrão de
--     bling_claim_webhook_event;
--   * private.infinitepay_process_webhook_queue() + job de pg_cron —
--     mesmo padrão de private.bling_process_webhook_queue().
-- O RPC payment_mark_webhook_event(uuid,text,text) criado em
-- 20260914160000 nunca chegou a ser usado por nenhum código (a função
-- só foi criada, nunca chamada) — substituído aqui por updates diretos
-- na tabela (mesmo padrão de SupabaseWebhookEventStore para o Bling,
-- que já tem GRANT de update). Removido para não deixar uma função
-- morta com semântica incompleta (sem retry_count/next_retry_at).
--
-- ACHADO 2 — infinitepay-create-payment "reivindicava" a criação do
-- link com um UPDATE que só verificava payment_provider IS NULL, sem
-- prazo de expiração. Se o processo morresse DEPOIS do claim e ANTES
-- de gravar payment_url (ou de cair no catch que libera o claim), o
-- pedido ficava com payment_provider='infinitepay' para sempre, sem
-- payment_url — nenhuma tentativa futura conseguia reivindicar de novo
-- (bloqueio permanente). Correção: claim com PRAZO (TTL), mesmo padrão
-- já usado em bling_connections.refresh_lock_until /
-- private.cron_locks.locked_until — adiciona
-- store_orders.payment_claim_expires_at.
-- =====================================================================

-- ---------------------------------------------------------------------
-- ACHADO 2 — TTL no claim de criação do link de pagamento
-- ---------------------------------------------------------------------
alter table public.store_orders
  add column if not exists payment_claim_expires_at timestamptz;

comment on column public.store_orders.payment_claim_expires_at is
  'Prazo do claim atômico de infinitepay-create-payment (payment_provider '
  'setado, ainda sem payment_url). Expira sozinho — se o processo morrer '
  'entre o claim e a gravação de payment_url, uma nova tentativa após '
  'este prazo consegue reivindicar de novo. Nunca fica bloqueado para sempre.';

-- ---------------------------------------------------------------------
-- ACHADO 1 — fila de reprocessamento do webhook de pagamento
-- ---------------------------------------------------------------------
alter table public.payment_webhook_events
  add column if not exists retry_count  integer not null default 0,
  add column if not exists next_retry_at timestamptz;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'payment_webhook_events_status_check') then
    alter table public.payment_webhook_events drop constraint payment_webhook_events_status_check;
  end if;
  alter table public.payment_webhook_events
    add constraint payment_webhook_events_status_check
    check (status in ('pending', 'processing', 'processed', 'ignored', 'failed'));
end $$;

create index if not exists idx_payment_webhook_events_pending
  on public.payment_webhook_events (status, next_retry_at)
  where status in ('pending', 'failed');

-- payment_register_webhook_event agora devolve o id do evento (uuid) —
-- necessário para agendar o processamento em background a partir do
-- próprio infinitepay-webhook. NULL quando o evento já existia
-- (transaction_nsu duplicado) — mesmo sinal de "não é novo" de antes,
-- só que carregando o id em vez de um boolean.
drop function if exists public.payment_register_webhook_event(text, text, text, text, jsonb);

create or replace function public.payment_register_webhook_event(
  p_provider        text,
  p_transaction_nsu text,
  p_order_nsu       text,
  p_invoice_slug    text,
  p_payload         jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_transaction_nsu is null or p_transaction_nsu = '' then
    insert into public.payment_webhook_events (provider, transaction_nsu, order_nsu, invoice_slug, payload)
    values (p_provider, null, p_order_nsu, p_invoice_slug, p_payload)
    returning id into v_id;
    return v_id;
  end if;

  insert into public.payment_webhook_events (provider, transaction_nsu, order_nsu, invoice_slug, payload)
  values (p_provider, p_transaction_nsu, p_order_nsu, p_invoice_slug, p_payload)
  on conflict (provider, transaction_nsu) where transaction_nsu is not null do nothing
  returning id into v_id;
  return v_id; -- NULL quando o conflito ocorreu (evento duplicado)
end;
$$;

revoke execute on function public.payment_register_webhook_event(text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payment_register_webhook_event(text, text, text, text, jsonb) to service_role;

-- Claim atômico (mesmo padrão de bling_claim_webhook_event): só entra
-- em 'processing' quem estiver 'pending' ou 'failed' e sem retry_at no
-- futuro. Evita duas execuções (background + sweep de cron) processando
-- o mesmo evento ao mesmo tempo.
create or replace function public.payment_claim_webhook_event(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rows integer;
begin
  update public.payment_webhook_events
     set status = 'processing'
   where id = p_id
     and status in ('pending', 'failed')
     and (next_retry_at is null or next_retry_at <= now());
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function public.payment_claim_webhook_event(uuid) from public, anon, authenticated;
grant execute on function public.payment_claim_webhook_event(uuid) to service_role;

-- payment_mark_webhook_event (20260914160000) nunca foi chamada por
-- nenhum código — remove para não deixar semântica incompleta (sem
-- retry_count/next_retry_at). Os "marks" passam a ser updates diretos
-- feitos pela Edge Function (_shared/payment-webhook-queue.ts), mesmo
-- padrão de SupabaseWebhookEventStore.markProcessed/markFailed/markIgnored
-- para o Bling — a tabela já tem GRANT UPDATE para service_role desde
-- 20260914160000, nenhum grant novo é necessário aqui.
drop function if exists public.payment_mark_webhook_event(uuid, text, text);

-- ---------------------------------------------------------------------
-- Sweep de reprocessamento (fire-and-forget via pg_net) — mesmo padrão
-- de private.bling_process_webhook_queue(). Usa as MESMAS chaves de
-- private.integration_settings só que com nomes próprios; preenchidas
-- manualmente (ver docs/INFINITEPAY_SETUP.md), nunca por migration.
-- ---------------------------------------------------------------------
create or replace function private.infinitepay_process_webhook_queue()
returns void
language plpgsql
security definer
set search_path = private, net, pg_temp
as $$
declare
  v_locked boolean;
  v_url    text;
  v_secret text;
begin
  select private.try_acquire_cron_lock('infinitepay-webhook-process', 55) into v_locked;
  if not v_locked then
    return;
  end if;

  select value into v_url    from private.integration_settings where key = 'infinitepay_webhook_process_url';
  select value into v_secret from private.integration_settings where key = 'infinitepay_webhook_process_secret';

  if v_url is null or v_secret is null or v_url = '' or v_secret = '' then
    return; -- não configurado ainda
  end if;

  perform net.http_post(
    url := v_url || '?limit=20',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-integration-admin-secret', v_secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
exception when others then
  return;
end;
$$;

revoke execute on function private.infinitepay_process_webhook_queue() from public, anon, authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'infinitepay-webhook-process-tick';
select cron.schedule(
  'infinitepay-webhook-process-tick',
  '* * * * *',
  $$select private.infinitepay_process_webhook_queue();$$
);
