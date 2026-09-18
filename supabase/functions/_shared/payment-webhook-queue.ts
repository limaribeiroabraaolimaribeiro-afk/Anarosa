/**
 * Fila de reprocessamento do webhook InfinitePay — mesmo desenho da
 * fila de webhooks do Bling (webhook-handlers.ts): claim atômico →
 * reconcilia → marca processado/ignorado/falhado (com backoff).
 *
 * Por que existe: infinitepay-webhook responde rápido (só registra o
 * evento) e reconcilia em background (EdgeRuntime.waitUntil). Se o
 * background for encerrado antes de terminar, o evento fica "pending"
 * — processPendingPaymentEvents (chamado por
 * infinitepay-webhook-process, agendado via pg_cron) reprocessa.
 */
import type { AppContext } from './context.ts';
import { describeError } from './errors.ts';
import { reconcilePayment } from './payment-reconcile.ts';
import { retryDelaySeconds } from './webhook.ts';

export interface PaymentWebhookEventRow {
  id: string;
  order_nsu: string | null;
  transaction_nsu: string | null;
  invoice_slug: string | null;
  payload: Record<string, unknown>;
  retry_count: number;
}

export async function claimPaymentWebhookEvent(ctx: AppContext, id: string): Promise<boolean> {
  const { data, error } = await ctx.db.rpc('payment_claim_webhook_event', { p_id: id });
  if (error) throw new Error(`payment_webhook_claim_failed: ${error.message}`);
  return data === true;
}

export async function markPaymentEventProcessed(ctx: AppContext, id: string): Promise<void> {
  const { error } = await ctx.db
    .from('payment_webhook_events')
    .update({ status: 'processed', processed_at: new Date().toISOString(), error_message: null, next_retry_at: null })
    .eq('id', id);
  if (error) throw new Error(`payment_webhook_mark_processed_failed: ${error.message}`);
}

export async function markPaymentEventIgnored(ctx: AppContext, id: string, reason: string): Promise<void> {
  const { error } = await ctx.db
    .from('payment_webhook_events')
    .update({ status: 'ignored', processed_at: new Date().toISOString(), error_message: reason.slice(0, 500) })
    .eq('id', id);
  if (error) throw new Error(`payment_webhook_mark_ignored_failed: ${error.message}`);
}

export async function markPaymentEventFailed(ctx: AppContext, id: string, errorMessage: string, retryCount: number): Promise<void> {
  const { error } = await ctx.db
    .from('payment_webhook_events')
    .update({
      status: 'failed',
      error_message: errorMessage.slice(0, 500),
      retry_count: retryCount + 1,
      next_retry_at: new Date(Date.now() + retryDelaySeconds(retryCount) * 1000).toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(`payment_webhook_mark_failed_failed: ${error.message}`);
}

/**
 * Processa um evento já registrado: claim → busca o pedido pelo
 * order_nsu → reconcilia (payment_check é a única fonte de verdade,
 * nunca o payload do evento) → marca o resultado. Nunca lança — falha
 * inesperada vira "failed" com backoff, para a fila reprocessar depois.
 */
export async function reconcileWebhookEventById(
  ctx: AppContext,
  id: string,
): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  const claimed = await claimPaymentWebhookEvent(ctx, id);
  if (!claimed) return 'skipped';

  try {
    const { data: evt, error: evtErr } = await ctx.db
      .from('payment_webhook_events')
      .select('id, order_nsu, transaction_nsu, invoice_slug, payload, retry_count')
      .eq('id', id)
      .maybeSingle<PaymentWebhookEventRow>();
    if (evtErr) throw new Error(`payment_webhook_event_lookup_failed: ${evtErr.message}`);
    if (!evt || !evt.order_nsu) {
      await markPaymentEventIgnored(ctx, id, 'evento sem order_nsu');
      return 'ignored';
    }

    const { data: order, error: orderErr } = await ctx.db
      .from('store_orders')
      .select('id, total, payment_status')
      .eq('id', evt.order_nsu)
      .maybeSingle();
    if (orderErr) throw new Error(`payment_webhook_order_lookup_failed: ${orderErr.message}`);

    if (!order) {
      ctx.logger.warn('payment.webhook_unknown_order', 'evento de webhook sem pedido correspondente', {
        entityType: 'order',
        entityId: evt.order_nsu,
      });
      await markPaymentEventIgnored(ctx, id, 'order_nsu sem pedido correspondente');
      return 'ignored';
    }

    const receiptUrl = typeof evt.payload?.receipt_url === 'string' ? evt.payload.receipt_url : null;
    const result = await reconcilePayment(ctx, order, {
      transactionNsu: evt.transaction_nsu,
      invoiceSlug: evt.invoice_slug,
      receiptUrl,
    });
    ctx.logger.info('payment.webhook_processed', `webhook processado: ${result.reason}`, {
      entityType: 'order',
      entityId: order.id,
      paid: result.paid,
      changed: result.changed,
    });
    await markPaymentEventProcessed(ctx, id);
    return 'processed';
  } catch (err) {
    const d = describeError(err);
    ctx.logger.error('payment.webhook_process_failed', 'falha ao reconciliar evento de webhook', {
      entityType: 'payment_webhook_event',
      entityId: id,
      errorCode: d.code,
    });
    try {
      const { data: row } = await ctx.db
        .from('payment_webhook_events')
        .select('retry_count')
        .eq('id', id)
        .maybeSingle<{ retry_count: number }>();
      await markPaymentEventFailed(ctx, id, `${d.code}: ${d.message}`, row?.retry_count ?? 0);
    } catch {
      // nunca propagar falha do próprio tratamento de falha
    }
    return 'failed';
  }
}

export interface ProcessPaymentEventsSummary {
  processed: number;
  ignored: number;
  failed: number;
  skipped: number;
}

/** Usado por infinitepay-webhook-process (admin, agendável via pg_cron). */
export async function processPendingPaymentEvents(ctx: AppContext, limit = 20): Promise<ProcessPaymentEventsSummary> {
  const summary: ProcessPaymentEventsSummary = { processed: 0, ignored: 0, failed: 0, skipped: 0 };
  const { data, error } = await ctx.db
    .from('payment_webhook_events')
    .select('id')
    .in('status', ['pending', 'failed'])
    .lt('retry_count', 10)
    .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
    .order('received_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`payment_webhook_list_pending_failed: ${error.message}`);

  for (const row of data ?? []) {
    const r = await reconcileWebhookEventById(ctx, (row as { id: string }).id);
    summary[r]++;
  }
  return summary;
}
