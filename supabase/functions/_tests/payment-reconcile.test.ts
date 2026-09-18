import assert from 'node:assert/strict';
import type { AppContext } from '../_shared/context.ts';
import type { PaymentCheckResult } from '../_shared/infinitepay-client.ts';
import { reconcilePayment } from '../_shared/payment-reconcile.ts';
import { silentLogger } from './helpers.ts';

// deno-lint-ignore no-explicit-any
type RpcCall = { name: string; args: any };

function buildFakeCtx(opts: {
  checkPayment?: () => Promise<PaymentCheckResult>;
  // deno-lint-ignore no-explicit-any
  rpc?: (name: string, args: any) => Promise<{ data: any; error: any }>;
}) {
  const rpcCalls: RpcCall[] = [];
  const rpcImpl = opts.rpc ?? (() => Promise.resolve({ data: true, error: null }));
  const { logger } = silentLogger();
  let checkPaymentCalls = 0;
  const checkPayment = async () => {
    checkPaymentCalls += 1;
    if (!opts.checkPayment) throw new Error('checkPayment não deveria ter sido chamado neste teste');
    return await opts.checkPayment();
  };
  const ctx = {
    db: {
      // deno-lint-ignore no-explicit-any
      rpc: async (name: string, args: any) => {
        rpcCalls.push({ name, args });
        return await rpcImpl(name, args);
      },
    },
    logger,
    paymentClient: () => ({ checkPayment, createCheckoutLink: () => { throw new Error('não usado neste teste'); } }),
  };
  return { ctx: ctx as unknown as AppContext, rpcCalls, checkPaymentCallCount: () => checkPaymentCalls };
}

const ORDER = { id: 'order-1', total: 60, payment_status: 'pending' };

Deno.test('reconcilePayment: pedido já pago — não chama payment_check nem rpc', async () => {
  const { ctx, rpcCalls, checkPaymentCallCount } = buildFakeCtx({});
  const result = await reconcilePayment(ctx, { ...ORDER, payment_status: 'paid' }, { transactionNsu: 't1', invoiceSlug: 's1' });
  assert.deepEqual(result, { paid: true, changed: false, reason: 'already_paid' });
  assert.equal(rpcCalls.length, 0);
  assert.equal(checkPaymentCallCount(), 0);
});

Deno.test('reconcilePayment: sem transactionNsu/slug — não chama payment_check', async () => {
  const { ctx, checkPaymentCallCount } = buildFakeCtx({});
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: null, invoiceSlug: null });
  assert.equal(result.reason, 'missing_reconciliation_data');
  assert.equal(result.paid, false);
  assert.equal(checkPaymentCallCount(), 0);
});

Deno.test('reconcilePayment: payment_check indisponível (erro de rede) — não marca pago', async () => {
  const { ctx } = buildFakeCtx({ checkPayment: () => { throw new Error('timeout'); } });
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: 't1', invoiceSlug: 's1' });
  assert.deepEqual(result, { paid: false, changed: false, reason: 'payment_check_unavailable' });
});

Deno.test('reconcilePayment: success=false — ainda não pago, não marca', async () => {
  const { ctx, rpcCalls } = buildFakeCtx({
    checkPayment: () => Promise.resolve({ success: false, paid: false, amount: null, paidAmount: null, installments: null, captureMethod: null, raw: {} }),
  });
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: 't1', invoiceSlug: 's1' });
  assert.deepEqual(result, { paid: false, changed: false, reason: 'not_paid_yet' });
  assert.equal(rpcCalls.length, 0);
});

Deno.test('reconcilePayment: paid=false — ainda processando, não marca', async () => {
  const { ctx } = buildFakeCtx({
    checkPayment: () => Promise.resolve({ success: true, paid: false, amount: null, paidAmount: null, installments: null, captureMethod: null, raw: {} }),
  });
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: 't1', invoiceSlug: 's1' });
  assert.equal(result.reason, 'not_paid_yet');
  assert.equal(result.paid, false);
});

Deno.test('reconcilePayment: amount divergente — NUNCA marca pago, chama payment_flag_failed', async () => {
  const { ctx, rpcCalls } = buildFakeCtx({
    checkPayment: () => Promise.resolve({ success: true, paid: true, amount: 1, paidAmount: 1, installments: 1, captureMethod: 'pix', raw: {} }),
  });
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: 't1', invoiceSlug: 's1' });
  assert.equal(result.paid, false);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'amount_mismatch');
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'payment_flag_failed');
  assert.equal(rpcCalls[0].args.p_order_id, 'order-1');
  assert.equal(rpcCalls[0].args.p_reason, 'amount_mismatch');
});

Deno.test('reconcilePayment: amount confere — marca pago via mark_order_paid', async () => {
  const { ctx, rpcCalls } = buildFakeCtx({
    checkPayment: () => Promise.resolve({ success: true, paid: true, amount: 6000, paidAmount: 6000, installments: 1, captureMethod: 'pix', raw: {} }),
    rpc: (name) => Promise.resolve({ data: name === 'mark_order_paid' ? true : null, error: null }),
  });
  const result = await reconcilePayment(ctx, ORDER, { transactionNsu: 'txn-1', invoiceSlug: 'slug-1', receiptUrl: 'https://recibo.test/1' });
  assert.deepEqual(result, { paid: true, changed: true, reason: 'confirmed' });
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0].name, 'mark_order_paid');
  assert.equal(rpcCalls[0].args.p_order_id, 'order-1');
  assert.equal(rpcCalls[0].args.p_transaction_nsu, 'txn-1');
  assert.equal(rpcCalls[0].args.p_receipt_url, 'https://recibo.test/1');
});

Deno.test('reconcilePayment: amount confere mas pedido já havia sido marcado por outra chamada concorrente', async () => {
  const { ctx } = buildFakeCtx({
    checkPayment: () => Promise.resolve({ success: true, paid: true, amount: 6000, paidAmount: 6000, installments: 1, captureMethod: 'pix', raw: {} }),
    rpc: (name) => Promise.resolve({ data: name === 'mark_order_paid' ? false : null, error: null }),
  });
  const result = await reconcilePayment(ctx, { ...ORDER, total: 60 }, { transactionNsu: 'txn-1', invoiceSlug: 'slug-1' });
  assert.deepEqual(result, { paid: true, changed: false, reason: 'already_paid' });
});
