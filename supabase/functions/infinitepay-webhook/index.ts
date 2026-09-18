/**
 * POST /infinitepay-webhook  (PÚBLICO — chamado pela InfinitePay)
 *
 * A documentação oficial do Checkout Integrado InfinitePay (consultada
 * em 2026-09-14) NÃO documenta assinatura/HMAC para este webhook. Por
 * isso este endpoint NUNCA marca um pedido como pago só por ter
 * recebido a chamada — ele só REGISTRA o evento (idempotente, dedupe
 * por transaction_nsu) e a reconciliação real via POST /payment_check
 * (payment-reconcile.ts) é quem decide.
 *
 * IMPORTANTE (auditoria 2026-09-17): a reconciliação NUNCA é aguardada
 * de forma síncrona aqui. A InfinitePay recomenda resposta em menos de
 * 1s e não redelivera depois de um 200 — esperar por payment_check
 * (chamada de rede a terceiro) antes de responder arriscava exceder
 * esse tempo E deixava a reconciliação sem nenhuma rede de segurança
 * caso o processo morresse no meio do caminho. Por isso:
 *   1. registra o evento (durável) e responde 200 imediatamente;
 *   2. a reconciliação roda em background (EdgeRuntime.waitUntil —
 *      mesmo mecanismo já usado por bling-webhook, oficialmente
 *      suportado pela Supabase Edge Runtime);
 *   3. se o background não rodar ou falhar, o evento fica
 *      "pending"/"failed" em payment_webhook_events e é reprocessado
 *      por infinitepay-webhook-process (agendável via pg_cron+pg_net —
 *      mesmo padrão do bling-webhook-process).
 * Sempre responde 200 quando o corpo é JSON válido com order_nsu — a
 * documentação informa que HTTP 400 faz a InfinitePay tentar reenviar;
 * como um order_nsu desconhecido nunca vai "ficar conhecido" só de
 * repetir, reenviar não ajudaria e só geraria mais carga.
 */
import { runInBackground, serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { reconcileWebhookEventById } from '../_shared/payment-webhook-queue.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const MAX_BODY_BYTES = 100_000;

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new ValidationError('Content-Type deve ser application/json.');
  }

  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES) {
    throw new ValidationError('Payload muito grande.');
  }

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }

  const orderNsu = typeof payload.order_nsu === 'string' ? payload.order_nsu.trim() : '';
  const transactionNsu = typeof payload.transaction_nsu === 'string' ? payload.transaction_nsu.trim() : null;
  const invoiceSlug = typeof payload.invoice_slug === 'string' ? payload.invoice_slug.trim() : null;
  const receiptUrl = typeof payload.receipt_url === 'string' ? payload.receipt_url.trim().slice(0, 500) : null;

  if (!orderNsu) {
    // Sem order_nsu não há como localizar nenhum pedido — corpo
    // realmente malformado (não é um "pedido inexistente" comum).
    throw new ValidationError('order_nsu ausente no payload.');
  }

  const { data: eventId, error: registerErr } = await ctx.db.rpc('payment_register_webhook_event', {
    p_provider: 'infinitepay',
    p_transaction_nsu: transactionNsu,
    p_order_nsu: orderNsu,
    p_invoice_slug: invoiceSlug,
    p_payload: {
      amount: payload.amount ?? null,
      paid_amount: payload.paid_amount ?? null,
      installments: payload.installments ?? null,
      capture_method: payload.capture_method ?? null,
      transaction_nsu: transactionNsu,
      order_nsu: orderNsu,
      invoice_slug: invoiceSlug,
      receipt_url: receiptUrl,
    },
  });
  if (registerErr) throw new Error(`payment_webhook_register_failed: ${registerErr.message}`);

  if (!eventId) {
    // transaction_nsu já visto antes — evento duplicado, nada a fazer.
    ctx.logger.info('payment.webhook_duplicate', 'webhook de pagamento duplicado — ignorado', {
      entityType: 'order',
      entityId: orderNsu,
    });
    return json(req, { success: true, duplicate: true }, 200);
  }

  // Evento já está persistido de forma durável (RPC acima). A partir
  // daqui, reconciliar é "best effort rápido" — se não rodar agora, o
  // sweep de pg_cron garante que rode depois.
  const scheduled = runInBackground(
    reconcileWebhookEventById(ctx, eventId).then(() => ctx.logger.flush()),
  );
  if (!scheduled) {
    ctx.logger.warn('payment.webhook_no_background', 'EdgeRuntime.waitUntil indisponível — evento fica para o sweep de pg_cron', {
      entityType: 'payment_webhook_event',
      entityId: eventId,
    });
  }

  return json(req, { success: true, accepted: true }, 200);
});
