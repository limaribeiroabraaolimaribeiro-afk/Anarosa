/**
 * Reconciliação de pagamento InfinitePay — usado pelo webhook
 * (infinitepay-webhook) E pelo retorno do cliente (storefront-order-status).
 *
 * Regra central (repetida de propósito nos dois pontos de entrada):
 * NUNCA marcar um pedido como pago só porque um payload de webhook ou
 * um parâmetro de redirect diz isso. A única fonte de verdade é a
 * resposta de POST /payment_check, comparada contra o total já
 * calculado no backend no momento do checkout.
 */
import type { AppContext } from './context.ts';
import { describeError } from './errors.ts';

export interface ReconcileOrder {
  id: string;
  total: number;
  payment_status: string;
}

export interface ReconcileResult {
  paid: boolean;
  changed: boolean;
  reason:
    | 'already_paid'
    | 'confirmed'
    | 'not_paid_yet'
    | 'missing_reconciliation_data'
    | 'payment_check_unavailable'
    | 'amount_mismatch'
    | 'not_pending';
}

export async function reconcilePayment(
  ctx: AppContext,
  order: ReconcileOrder,
  input: { transactionNsu: string | null; invoiceSlug: string | null; receiptUrl?: string | null },
): Promise<ReconcileResult> {
  if (order.payment_status !== 'pending') {
    return { paid: order.payment_status === 'paid', changed: false, reason: order.payment_status === 'paid' ? 'already_paid' : 'not_pending' };
  }
  if (!input.transactionNsu || !input.invoiceSlug) {
    return { paid: false, changed: false, reason: 'missing_reconciliation_data' };
  }

  let check;
  try {
    check = await ctx.paymentClient().checkPayment({
      orderNsu: order.id,
      transactionNsu: input.transactionNsu,
      slug: input.invoiceSlug,
    });
  } catch (err) {
    ctx.logger.warn('payment.reconcile_error', 'falha ao consultar payment_check', {
      entityType: 'order',
      entityId: order.id,
      errorCode: describeError(err).code,
    });
    return { paid: false, changed: false, reason: 'payment_check_unavailable' };
  }

  if (!check.success || !check.paid) {
    return { paid: false, changed: false, reason: 'not_paid_yet' };
  }

  const expectedCents = Math.round((Number(order.total) || 0) * 100);
  if (check.amount == null || check.amount !== expectedCents) {
    await ctx.db.rpc('payment_flag_failed', {
      p_order_id: order.id,
      p_reason: 'amount_mismatch',
      p_raw: {
        expectedCents,
        gotAmount: check.amount,
        gotPaidAmount: check.paidAmount,
        captureMethod: check.captureMethod,
      },
    });
    ctx.logger.error('payment.amount_mismatch', 'valor confirmado pela InfinitePay diverge do esperado — pedido NÃO marcado como pago', {
      entityType: 'order',
      entityId: order.id,
      expectedCents,
      gotAmount: check.amount,
    });
    return { paid: false, changed: true, reason: 'amount_mismatch' };
  }

  const { data: transitioned, error } = await ctx.db.rpc('mark_order_paid', {
    p_order_id: order.id,
    p_payment_provider: 'infinitepay',
    p_transaction_nsu: input.transactionNsu,
    p_invoice_slug: input.invoiceSlug,
    p_capture_method: check.captureMethod,
    p_paid_amount: check.paidAmount,
    p_installments: check.installments,
    p_receipt_url: input.receiptUrl ?? null,
    p_raw: {
      amount: check.amount,
      paidAmount: check.paidAmount,
      installments: check.installments,
      captureMethod: check.captureMethod,
    },
  });
  if (error) throw new Error(`mark_order_paid_failed: ${error.message}`);

  if (transitioned) {
    ctx.logger.info('payment.confirmed', 'pagamento confirmado via payment_check', {
      entityType: 'order',
      entityId: order.id,
    });
  }
  return { paid: true, changed: Boolean(transitioned), reason: transitioned ? 'confirmed' : 'already_paid' };
}
