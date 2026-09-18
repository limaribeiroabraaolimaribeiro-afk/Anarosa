-- =====================================================================
-- ANAROSA × BLING — correção dos privilégios da service_role
-- ---------------------------------------------------------------------
-- Erro em produção corrigido por esta migration:
--   "permission denied for table bling_webhook_events"
--   (refletido em bling-status como webhook_last_read_failed /
--   webhook_stats_failed, ao chamar catalog-repo.ts:lastWebhookAt() e
--   webhookStats())
--
-- CAUSA RAIZ
-- ---------------------------------------------------------------------
-- A migration inicial (20260904120000_bling_integration_initial.sql)
-- habilitou RLS e REVOGOU o acesso de anon/authenticated nas tabelas
-- internas — isso está correto e continua assim. O que faltou: ela
-- nunca emitiu um GRANT explícito para a service_role em nenhuma
-- tabela/função (ver a própria migration: zero ocorrências de
-- "grant" no arquivo). O comentário "Service role ignora RLS por
-- definição" descrevia só a camada de RLS; RLS-bypass (atributo
-- BYPASSRLS da role, gerenciado pela plataforma Supabase, não
-- alterado por nenhuma migration) é uma camada INDEPENDENTE do
-- controle de acesso por GRANT/REVOKE em tabelas e funções — bypassar
-- RLS não concede privilégio de SELECT/INSERT/UPDATE. Sem GRANT
-- explícito, e sem este projeto aplicar um default privilege
-- equivalente para tabelas criadas via migration, a service_role
-- ficou sem nenhum privilégio nessas tabelas, causando o
-- "permission denied" observado.
--
-- CORREÇÃO
-- ---------------------------------------------------------------------
-- Concede à service_role SOMENTE os privilégios que o código das Edge
-- Functions de fato usa em cada tabela (auditado via grep de
-- `.from('<tabela>')...` em supabase/functions/**/*.ts — sem DELETE
-- em lugar nenhum, pois o projeto usa soft-disable, nunca apaga
-- histórico) e EXECUTE nas funções (RPCs) chamadas via `.rpc(...)`.
--
-- NÃO concede nada a anon/authenticated (reforça o revoke, sem
-- alterar a migration já aplicada). NÃO cria nenhuma policy nova.
-- =====================================================================

-- ---------------------------------------------------------------------
-- bling_connections — SupabaseTokenStore.getConnection() [select],
-- .saveConnection() [insert/update/select]. Leitura/renovação de token
-- via RPC (security definer, roda como owner) não precisa de grant
-- adicional aqui.
-- ---------------------------------------------------------------------
grant select, insert, update on table public.bling_connections to service_role;
revoke all on table public.bling_connections from anon, authenticated;

-- ---------------------------------------------------------------------
-- bling_oauth_states — SupabaseOAuthStateStore.insert() [insert]. A
-- leitura/consumo (marcar usado) acontece só via RPC
-- bling_consume_oauth_state (security definer, roda como owner) —
-- por isso service_role não precisa de select/update diretos aqui.
-- ---------------------------------------------------------------------
grant insert on table public.bling_oauth_states to service_role;
revoke all on table public.bling_oauth_states from anon, authenticated;

-- ---------------------------------------------------------------------
-- bling_webhook_events — SupabaseWebhookEventStore.markProcessed()/
-- markFailed()/markIgnored()/listPending() [select/update] e
-- CatalogRepository.lastWebhookAt()/webhookStats() [select], usados
-- por bling-status (era exatamente esta a tabela do erro reportado).
-- O registro e o claim do evento acontecem via RPC (owner), por isso
-- não é necessário insert direto aqui.
-- ---------------------------------------------------------------------
grant select, update on table public.bling_webhook_events to service_role;
revoke all on table public.bling_webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- integration_logs — dbLogSink() [insert] e
-- CatalogRepository.recentErrors() [select]. Logs são append-only:
-- nunca há update/delete no código.
-- ---------------------------------------------------------------------
grant select, insert on table public.integration_logs to service_role;
revoke all on table public.integration_logs from anon, authenticated;

-- ---------------------------------------------------------------------
-- Cache de catálogo — CatalogRepository faz select + upsert
-- (insert/update) nestas quatro tabelas durante sync e leitura pública
-- (via storefront-*, que só lê o cache, nunca escreve).
-- ---------------------------------------------------------------------
grant select, insert, update on table public.store_categories        to service_role;
grant select, insert, update on table public.store_products           to service_role;
grant select, insert, update on table public.store_product_variants  to service_role;
grant select, insert, update on table public.store_inventory          to service_role;
revoke all on table
  public.store_categories,
  public.store_products,
  public.store_product_variants,
  public.store_inventory
from anon, authenticated;

-- ---------------------------------------------------------------------
-- store_orders / store_order_items — bling-create-order faz select +
-- insert em store_orders (idempotência) e update (status de sync);
-- store_order_items só recebe insert (itens do pedido nunca são lidos
-- de volta pelo código atual).
-- ---------------------------------------------------------------------
grant select, insert, update on table public.store_orders       to service_role;
grant insert                 on table public.store_order_items  to service_role;
revoke all on table public.store_orders, public.store_order_items from anon, authenticated;

-- ---------------------------------------------------------------------
-- store_stock_totals — view com security_invoker = true: quem
-- consulta precisa do próprio grant de select (além do já concedido
-- acima em store_inventory, que a view lê por baixo).
-- ---------------------------------------------------------------------
grant select on public.store_stock_totals to service_role;
revoke all on public.store_stock_totals from anon, authenticated;

-- ---------------------------------------------------------------------
-- Funções (RPCs) chamadas via `.rpc(...)` pelas Edge Functions —
-- confirmado por grep em supabase/functions/**/*.ts. Sem esse EXECUTE,
-- a chamada retorna "permission denied for function <nome>", mesmo
-- efeito da causa raiz desta migration, só que em RPC em vez de tabela.
-- ---------------------------------------------------------------------
grant execute on function public.bling_consume_oauth_state(text)                                          to service_role;
grant execute on function public.bling_register_webhook_event(text, text, text, timestamptz, jsonb)     to service_role;
grant execute on function public.bling_try_acquire_refresh_lock(uuid, integer)                            to service_role;
grant execute on function public.bling_complete_token_refresh(uuid, text, text, text, timestamptz, text) to service_role;
grant execute on function public.bling_fail_token_refresh(uuid, text)                                     to service_role;
grant execute on function public.bling_claim_webhook_event(text)                                          to service_role;

-- bling_cleanup_oauth_states() foi propositalmente OMITIDA: nenhuma
-- Edge Function a chama hoje (utilitário de limpeza manual/futura).
-- Concedido apenas "o necessário" — quando ela for de fato agendada
-- (ex.: um novo job de pg_cron), adicione o grant numa migration nova.

-- ---------------------------------------------------------------------
-- store_available_stock(numeric, numeric) — usada dentro da expressão
-- da coluna gerada store_inventory.available_stock. O privilégio de
-- EXECUTE é verificado também para funções referenciadas em expressões
-- de coluna gerada (não só em chamadas diretas via SELECT/RPC): sem
-- este grant, todo insert/update em store_inventory feito pela
-- service_role falharia com "permission denied for function
-- store_available_stock" — mesma causa raiz, ainda não observada em
-- produção porque a leitura (bling-status) falhou primeiro.
-- ---------------------------------------------------------------------
grant execute on function public.store_available_stock(numeric, numeric) to service_role;

-- Reforço explícito do revoke já existente na migration inicial (sem
-- alterá-la) — sem mudança de comportamento, só deixa este arquivo
-- autocontido caso seja reaplicado isoladamente.
revoke execute on function public.bling_consume_oauth_state(text)                                          from public, anon, authenticated;
revoke execute on function public.bling_register_webhook_event(text, text, text, timestamptz, jsonb)     from public, anon, authenticated;
revoke execute on function public.bling_try_acquire_refresh_lock(uuid, integer)                            from public, anon, authenticated;
revoke execute on function public.bling_complete_token_refresh(uuid, text, text, text, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.bling_fail_token_refresh(uuid, text)                                     from public, anon, authenticated;
revoke execute on function public.bling_claim_webhook_event(text)                                          from public, anon, authenticated;
revoke execute on function public.store_available_stock(numeric, numeric)                                  from public, anon, authenticated;

-- Nenhuma policy foi criada. Nenhum grant foi feito para anon ou
-- authenticated em nenhuma tabela desta migration. anon/authenticated
-- continuam sem acesso algum às tabelas internas; a única mudança de
-- comportamento observável é: a service_role (usada exclusivamente
-- pelas Edge Functions, nunca pelo navegador) volta a conseguir ler e
-- escrever nas tabelas para as quais o código já foi desenhado.
