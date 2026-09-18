/**
 * POST /bling-webhook-process  (admin)
 * Processa eventos "pending"/"failed" da tabela bling_webhook_events.
 * Complementa o processamento em background do bling-webhook e serve
 * de reprocessamento manual. Pode ser agendado via pg_cron + pg_net
 * (ver docs/ARCHITECTURE.md).
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { SupabaseWebhookEventStore } from '../_shared/webhook.ts';
import { processPendingEvents } from '../_shared/webhook-handlers.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);

  const store = new SupabaseWebhookEventStore(ctx.db);
  const summary = await processPendingEvents(
    store,
    { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore, db: ctx.db },
    limit,
  );

  return json(req, { ok: true, summary });
});
