/**
 * POST /infinitepay-webhook-process  (admin)
 * Reprocessa eventos "pending"/"failed" de payment_webhook_events.
 * Complementa a reconciliação em background de infinitepay-webhook e
 * serve de reprocessamento manual. Agendável via pg_cron + pg_net —
 * ver private.infinitepay_process_webhook_queue()
 * (migration 20260917120000) e docs/INFINITEPAY_SETUP.md.
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { serve } from '../_shared/context.ts';
import { processPendingPaymentEvents } from '../_shared/payment-webhook-queue.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  const url = new URL(req.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);

  const summary = await processPendingPaymentEvents(ctx, limit);
  return json(req, { ok: true, summary });
});
