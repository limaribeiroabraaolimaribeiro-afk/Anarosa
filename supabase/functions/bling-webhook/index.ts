/**
 * POST /bling-webhook  (chamado pelo Bling)
 *
 * 1. lê o RAW BODY;
 * 2. valida X-Bling-Signature-256 (HMAC-SHA256 com BLING_CLIENT_SECRET);
 * 3. registra o evento (idempotente por eventId) — duplicado → 200 imediato;
 * 4. responde 2xx rapidamente;
 * 5. processa em background (EdgeRuntime.waitUntil). Se o runtime não
 *    permitir, o evento fica "pending" e é processado por
 *    bling-webhook-process (ver docs/ARCHITECTURE.md — limitação de fila).
 */
import { BLING_DEFAULTS } from '../_shared/config.ts';
import { runInBackground, serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import {
  isSupportedEvent,
  parseWebhookEvent,
  SupabaseWebhookEventStore,
  verifyWebhookSignature,
  WebhookParseError,
} from '../_shared/webhook.ts';
import { processRegisteredEvent } from '../_shared/webhook-handlers.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);

  const secret = ctx.blingConfig.clientSecret;
  if (!secret) {
    ctx.logger.error('webhook.receive', 'BLING_CLIENT_SECRET ausente; webhook rejeitado');
    return json(req, { ok: false, error: 'not_configured' }, 503);
  }

  const rawBody = await req.text();
  const signature = req.headers.get(BLING_DEFAULTS.webhookSignatureHeader);
  const valid = await verifyWebhookSignature(rawBody, signature, secret);
  if (!valid) {
    ctx.logger.warn('webhook.receive', 'assinatura inválida', {
      hasSignature: Boolean(signature),
      bodyLength: rawBody.length,
    });
    return json(req, { ok: false, error: 'invalid_signature' }, 401);
  }

  let evt;
  try {
    evt = parseWebhookEvent(rawBody);
  } catch (err) {
    const msg = err instanceof WebhookParseError ? err.message : 'payload inválido';
    ctx.logger.warn('webhook.receive', msg);
    return json(req, { ok: false, error: 'invalid_payload' }, 400);
  }

  const store = new SupabaseWebhookEventStore(ctx.db);
  const isNew = await store.register(evt);

  if (!isNew) {
    ctx.logger.info('webhook.receive', 'evento duplicado ignorado', {
      entityType: 'webhook_event',
      entityId: evt.eventId,
      event: evt.event,
    });
    return json(req, { ok: true, duplicate: true }, 200);
  }

  ctx.logger.info('webhook.receive', 'evento registrado', {
    entityType: 'webhook_event',
    entityId: evt.eventId,
    event: evt.event,
    companyId: evt.companyId,
  });

  if (!isSupportedEvent(evt.event)) {
    await store.markIgnored(evt.eventId, `evento ${evt.event} não suportado`);
    return json(req, { ok: true, accepted: true, ignored: true }, 202);
  }

  const deps = { client: ctx.client(), repo: ctx.repo, logger: ctx.logger, tokenStore: ctx.tokenStore, db: ctx.db };
  const scheduled = runInBackground(
    processRegisteredEvent(evt, store, deps).then(() => ctx.logger.flush()),
  );

  return json(req, { ok: true, accepted: true, background: scheduled }, 202);
});
