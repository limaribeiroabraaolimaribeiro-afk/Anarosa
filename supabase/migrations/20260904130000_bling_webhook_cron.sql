-- =====================================================================
-- ANAROSA × BLING — processamento automático da fila de webhooks
-- ---------------------------------------------------------------------
-- Contexto: bling-webhook responde 2xx rapidamente e processa em
-- background (EdgeRuntime.waitUntil). Se o worker for encerrado antes
-- de concluir, o evento fica "pending"/"failed" em bling_webhook_events.
-- Esta migration agenda uma varredura automática (~1x/minuto) que chama
-- a Edge Function bling-webhook-process para reprocessar o que sobrou.
--
-- Segurança:
--   * NENHUM segredo real é gravado aqui. A URL da função e o
--     INTEGRATION_ADMIN_SECRET ficam em private.integration_settings,
--     preenchidos manualmente após o deploy (ver docs/BLING_SETUP_MANUAL.md,
--     ETAPA 5-B). Sem esses valores, a rotina simplesmente não faz nada
--     (nenhum erro, nenhum request).
--   * schema `private` não é exposto via PostgREST (só `public` é
--     publicado pela API por padrão) e, como camada extra, RLS fica
--     habilitado sem nenhuma policy para anon/authenticated.
--
-- Proteções contra concorrência/loop:
--   * lock leve (private.try_acquire_cron_lock) com TTL de 55s: se uma
--     execução anterior ainda não terminou (ou travou), o próximo tick
--     do minuto seguinte não dispara outra chamada.
--   * cada chamada processa no máximo `limit=20` eventos (bounded work).
--   * o processamento de cada evento individual já é atômico via
--     bling_claim_webhook_event (definido na migration inicial) — dois
--     disparos concorrentes nunca processam o mesmo evento duas vezes.
--   * qualquer erro (rede, configuração ausente, extensão indisponível)
--     é capturado e ignorado silenciosamente: o cron NUNCA falha nem
--     bloqueia o restante do banco.
--   * net.http_post é assíncrono (fire-and-forget): o job do pg_cron
--     não fica bloqueado esperando a Edge Function terminar, então
--     nunca atrasa nem se sobrepõe por causa de uma resposta lenta.
-- =====================================================================

-- pg_cron e pg_net são extensões gerenciadas pelo Supabase (schemas
-- fixos "cron" e "net"). Se o projeto não permitir habilitá-las por SQL
-- (varia por plano), habilite manualmente em Database → Extensions e
-- rode esta migration novamente — ver docs/BLING_SETUP_MANUAL.md.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- Configuração privada (URL + secret administrativo da função) —
-- criada vazia; preenchida manualmente pelo operador.
-- ---------------------------------------------------------------------
create schema if not exists private;

create table if not exists private.integration_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table private.integration_settings enable row level security;
revoke all on table private.integration_settings from anon, authenticated;

comment on table private.integration_settings is
  'Configuração interna (URL/secret da fila de webhooks para o pg_cron). '
  'Nunca populada por migration; preenchida manualmente. Não exposta via API '
  '(schema "private" não está em db.schemas) nem legível por anon/authenticated.';

-- ---------------------------------------------------------------------
-- Lock leve para evitar disparos sobrepostos do sweep de webhooks
-- (mesmo padrão de public.bling_try_acquire_refresh_lock).
-- ---------------------------------------------------------------------
create table if not exists private.cron_locks (
  name          text primary key,
  locked_until  timestamptz not null
);

alter table private.cron_locks enable row level security;
revoke all on table private.cron_locks from anon, authenticated;

create or replace function private.try_acquire_cron_lock(p_name text, p_ttl_seconds integer)
returns boolean
language plpgsql
security definer
set search_path = private, pg_temp
as $$
declare
  v_rows integer;
begin
  insert into private.cron_locks (name, locked_until)
  values (p_name, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
    set locked_until = excluded.locked_until
    where private.cron_locks.locked_until < now();
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end;
$$;

revoke execute on function private.try_acquire_cron_lock(text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Disparo do sweep (fire-and-forget via pg_net).
-- ---------------------------------------------------------------------
create or replace function private.bling_process_webhook_queue()
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
  select private.try_acquire_cron_lock('bling-webhook-process', 55) into v_locked;
  if not v_locked then
    return; -- execução anterior ainda dentro do TTL: não sobrepõe
  end if;

  select value into v_url    from private.integration_settings where key = 'bling_webhook_process_url';
  select value into v_secret from private.integration_settings where key = 'bling_webhook_process_secret';

  if v_url is null or v_secret is null or v_url = '' or v_secret = '' then
    return; -- não configurado ainda (ver docs/BLING_SETUP_MANUAL.md, ETAPA 5-B)
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
  -- nunca deixar o cron falhar por erro de rede/configuração/extensão ausente
  return;
end;
$$;

revoke execute on function private.bling_process_webhook_queue() from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- Agendamento (~1x/minuto). Idempotente: remove um job antigo do mesmo
-- nome antes de recriar, para que esta migration possa ser reaplicada.
-- (cron.job já existe neste ponto: a extensão foi criada acima, no
-- início desta mesma migration/transação.)
-- ---------------------------------------------------------------------
select cron.unschedule(jobid) from cron.job where jobname = 'bling-webhook-process-tick';

select cron.schedule(
  'bling-webhook-process-tick',
  '* * * * *',
  $$select private.bling_process_webhook_queue();$$
);
