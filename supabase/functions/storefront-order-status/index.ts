/**
 * GET /storefront-order-status?token=<public_token>[&transactionNsu=&slug=&receiptUrl=]
 * (PÚBLICO — usado por pedido-confirmado.html)
 *
 * Nunca aceita o id interno do pedido — só o public_token aleatório
 * (ver migration 20260914160000). Nunca decide "pago" a partir de
 * parâmetros de query: transactionNsu/slug, quando presentes (vieram
 * do redirect_url da InfinitePay), são usados APENAS como gatilho para
 * uma reconciliação real via payment_check (payment-reconcile.ts) —
 * exatamente a mesma verificação do webhook, nunca menos rigorosa.
 *
 * Retorna só o necessário para a tela de confirmação — nunca id
 * interno, dados de outros clientes, ou detalhes de erro internos.
 */
import { serve } from '../_shared/context.ts';
import { NotFoundError, ValidationError } from '../_shared/errors.ts';
import { reconcilePayment } from '../_shared/payment-reconcile.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const TOKEN_RE = /^[0-9a-f]{20,64}$/i;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

type UiStatus = 'confirmado' | 'em_processamento' | 'ainda_nao_confirmado' | 'necessita_atencao' | 'cancelado' | 'nao_foi_possivel_consultar';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `order-status:${clientIp(req)}`,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (allowed.data === false) throw new ValidationError('Muitas tentativas. Aguarde um instante e tente novamente.');

  const url = new URL(req.url);
  const token = (url.searchParams.get('token') || '').trim();
  if (!TOKEN_RE.test(token)) throw new ValidationError('token inválido.');

  const transactionNsu = url.searchParams.get('transactionNsu')?.trim().slice(0, 120) || null;
  const slug = url.searchParams.get('slug')?.trim().slice(0, 120) || null;
  const receiptUrl = url.searchParams.get('receiptUrl')?.trim().slice(0, 500) || null;

  const selectCols = 'id, order_number, status, payment_status, payment_capture_method, payment_installments, payment_receipt_url, payment_paid_at, total, shipping_data, created_at';
  const { data: order, error } = await ctx.db
    .from('store_orders')
    .select(selectCols)
    .eq('public_token', token)
    .maybeSingle();
  if (error) throw new Error(`order_status_lookup_failed: ${error.message}`);
  if (!order) throw new NotFoundError('Pedido não encontrado.');

  let uiStatus: UiStatus;
  let current = order;

  if (order.payment_status === 'pending' && transactionNsu && slug) {
    const result = await reconcilePayment(
      ctx,
      { id: order.id, total: order.total, payment_status: order.payment_status },
      { transactionNsu, invoiceSlug: slug, receiptUrl },
    );
    if (result.changed || result.paid) {
      const { data: refreshed } = await ctx.db.from('store_orders').select(selectCols).eq('id', order.id).maybeSingle();
      if (refreshed) current = refreshed;
    }
    uiStatus = current.payment_status === 'paid'
      ? 'confirmado'
      : current.payment_status === 'failed'
        ? 'necessita_atencao'
        : result.reason === 'payment_check_unavailable'
          ? 'nao_foi_possivel_consultar'
          : result.reason === 'not_paid_yet'
            ? 'em_processamento'
            : 'ainda_nao_confirmado';
  } else {
    uiStatus = current.payment_status === 'paid'
      ? 'confirmado'
      : current.payment_status === 'failed'
        ? 'necessita_atencao'
        : current.payment_status === 'cancelled' || current.status === 'cancelled'
          ? 'cancelado'
          : 'ainda_nao_confirmado';
  }

  const shippingMethod = (current.shipping_data as { method?: string } | null)?.method ?? null;

  return json(req, {
    ok: true,
    uiStatus,
    orderNumber: current.order_number ?? null,
    total: current.total,
    deliveryMethod: shippingMethod,
    createdAt: current.created_at,
    payment: {
      captureMethod: current.payment_capture_method ?? null,
      installments: current.payment_installments ?? null,
      paidAt: current.payment_paid_at ?? null,
      receiptUrl: current.payment_status === 'paid' ? (current.payment_receipt_url ?? null) : null,
    },
  }, 200);
});
