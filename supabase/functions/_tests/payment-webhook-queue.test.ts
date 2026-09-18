import assert from 'node:assert/strict';
import type { AppContext } from '../_shared/context.ts';
import type { PaymentCheckResult } from '../_shared/infinitepay-client.ts';
import { processPendingPaymentEvents, reconcileWebhookEventById } from '../_shared/payment-webhook-queue.ts';
import { silentLogger } from './helpers.ts';

interface EventRow {
  id: string;
  order_nsu: string | null;
  transaction_nsu: string | null;
  invoice_slug: string | null;
  payload: Record<string, unknown>;
  retry_count: number;
  status?: string;
}

function buildFakeCtx(opts: {
  event: EventRow;
  order?: Record<string, unknown> | null;
  claimResult?: boolean;
  checkPayment?: () => Promise<PaymentCheckResult>;
  pendingList?: EventRow[];
  markOrderPaidResult?: boolean;
}) {
  const updates: Array<{ id: string; payload: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { logger } = silentLogger();
  const event = { ...opts.event };

  const db = {
    // deno-lint-ignore no-explicit-any
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === 'payment_claim_webhook_event') return { data: opts.claimResult ?? true, error: null };
      if (name === 'mark_order_paid') return { data: opts.markOrderPaidResult ?? true, error: null };
      if (name === 'payment_flag_failed') return { data: true, error: null };
      return { data: null, error: null };
    },
    // deno-lint-ignore no-explicit-any
    from: (table: string) => {
      if (table === 'payment_webhook_events') {
        return {
          // deno-lint-ignore no-explicit-any
          select: (_cols?: string) => ({
            eq: (_col: string, _val: string) => ({ maybeSingle: () => Promise.resolve({ data: event, error: null }) }),
            in: (_col: string, _vals: string[]) => ({
              lt: () => ({
                or: () => ({
                  order: () => ({
                    limit: () => Promise.resolve({ data: opts.pendingList ?? [], error: null }),
                  }),
                }),
              }),
            }),
          }),
          // deno-lint-ignore no-explicit-any
          update: (payload: Record<string, unknown>) => ({
            eq: (_col: string, val: string) => {
              updates.push({ id: val, payload });
              Object.assign(event, payload);
              return Promise.resolve({ error: null });
            },
          }),
        };
      }
      if (table === 'store_orders') {
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: opts.order ?? null, error: null }) }) }),
        };
      }
      throw new Error(`fake db: tabela inesperada "${table}"`);
    },
  };

  const checkPayment = opts.checkPayment ?? (() => Promise.reject(new Error('checkPayment não deveria ser chamado neste teste')));
  const ctx = {
    db,
    logger,
    // deno-lint-ignore no-explicit-any
    paymentClient: () => ({ checkPayment, createCheckoutLink: () => { throw new Error('não usado neste teste'); } }),
  } as unknown as AppContext;

  return { ctx, updates, rpcCalls, event };
}

Deno.test('reconcileWebhookEventById: claim falha (já em processamento) → skipped, nada mais roda', async () => {
  const { ctx, updates } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: 'order-1', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 0 },
    claimResult: false,
  });
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'skipped');
  assert.equal(updates.length, 0);
});

Deno.test('reconcileWebhookEventById: evento sem order_nsu → ignored', async () => {
  const { ctx, updates } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: null, transaction_nsu: null, invoice_slug: null, payload: {}, retry_count: 0 },
  });
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'ignored');
  assert.equal(updates[0].payload.status, 'ignored');
});

Deno.test('reconcileWebhookEventById: order_nsu sem pedido correspondente → ignored', async () => {
  const { ctx, updates } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: 'order-inexistente', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 0 },
    order: null,
  });
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'ignored');
  assert.equal(updates[0].payload.status, 'ignored');
});

Deno.test('reconcileWebhookEventById: reconciliação confirma pagamento → processed (nunca "failed" só por ainda não ter pago)', async () => {
  const { ctx, updates, rpcCalls } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: 'order-1', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 0 },
    order: { id: 'order-1', total: 60, payment_status: 'pending' },
    checkPayment: () => Promise.resolve({ success: true, paid: true, amount: 6000, paidAmount: 6000, installments: 1, captureMethod: 'pix', raw: {} }),
  });
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'processed');
  assert.equal(updates[updates.length - 1].payload.status, 'processed');
  assert.ok(rpcCalls.some((c) => c.name === 'mark_order_paid'));
});

Deno.test('reconcileWebhookEventById: payment_check ainda não confirmou → processed (evento tratado, pedido continua pending)', async () => {
  const { ctx, updates } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: 'order-1', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 0 },
    order: { id: 'order-1', total: 60, payment_status: 'pending' },
    checkPayment: () => Promise.resolve({ success: true, paid: false, amount: null, paidAmount: null, installments: null, captureMethod: null, raw: {} }),
  });
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'processed');
  assert.equal(updates[updates.length - 1].payload.status, 'processed');
});

Deno.test('reconcileWebhookEventById: erro inesperado (ex.: banco fora do ar) → failed com backoff, nunca propaga', async () => {
  const { ctx, updates } = buildFakeCtx({
    event: { id: 'evt-1', order_nsu: 'order-1', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 2 },
    order: { id: 'order-1', total: 60, payment_status: 'pending' },
    checkPayment: () => { throw new Error('nunca deveria chegar aqui'); },
  });
  // força um erro inesperado: sobrescreve o lookup de store_orders para lançar
  // deno-lint-ignore no-explicit-any
  (ctx.db as any).from = (table: string) => {
    if (table === 'payment_webhook_events') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { id: 'evt-1', order_nsu: 'order-1', transaction_nsu: 't1', invoice_slug: 's1', payload: {}, retry_count: 2 }, error: null }) }) }),
        update: (payload: Record<string, unknown>) => ({
          eq: (_col: string, val: string) => { updates.push({ id: val, payload }); return Promise.resolve({ error: null }); },
        }),
      };
    }
    if (table === 'store_orders') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'connection refused' } }) }) }) };
    }
    throw new Error('tabela inesperada ' + table);
  };
  const outcome = await reconcileWebhookEventById(ctx, 'evt-1');
  assert.equal(outcome, 'failed');
  const failUpdate = updates.find((u) => u.payload.status === 'failed');
  assert.ok(failUpdate, 'deve marcar failed');
  assert.equal(failUpdate!.payload.retry_count, 3);
  assert.ok(failUpdate!.payload.next_retry_at, 'deve agendar next_retry_at (backoff)');
});

Deno.test('processPendingPaymentEvents: soma processed/ignored/failed/skipped corretamente', async () => {
  const pendingList = [
    { id: 'evt-a', order_nsu: null, transaction_nsu: null, invoice_slug: null, payload: {}, retry_count: 0 },
  ];
  const { ctx } = buildFakeCtx({
    event: pendingList[0],
    pendingList,
  });
  const summary = await processPendingPaymentEvents(ctx, 20);
  assert.equal(summary.ignored, 1);
  assert.equal(summary.processed, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.skipped, 0);
});
