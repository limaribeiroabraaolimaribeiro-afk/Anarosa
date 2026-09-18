/**
 * POST /infinitepay-create-payment  (PÚBLICO — chamado pelo navegador
 * imediatamente após storefront-checkout criar o pedido)
 *
 * Recebe SOMENTE um identificador do pedido (orderId ou publicToken —
 * nunca preço, total, status de pagamento ou qualquer dado sensível).
 * Tudo o que é enviado à InfinitePay é recalculado aqui a partir do
 * pedido já validado no banco:
 *   1. carrega o pedido + itens reais (store_orders/store_order_items);
 *   2. valida estado (só cria link quando payment_status='pending');
 *   3. "reivindica" a criação de forma atômica (evita 2 links para o
 *      mesmo pedido em clique duplo/retry — ver claimCreation abaixo);
 *   4. converte para centavos (payment-mapper.ts) e chama
 *      POST /links da InfinitePay;
 *   5. persiste payment_url e devolve ao navegador SOMENTE a url.
 *
 * handle da InfinitePay, webhook_url e redirect_url vêm de configuração
 * de backend (config.ts/env) — nunca do navegador.
 */
import { releasePaymentLinkClaim, tryClaimPaymentLinkCreation } from '../_shared/payment-claim.ts';
import { buildCheckoutItems, type PaymentOrderItemInput } from '../_shared/payment-mapper.ts';
import { isInfinitePayConfigured } from '../_shared/config.ts';
import { serve } from '../_shared/context.ts';
import { ConfigError, NotFoundError, ValidationError, describeError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{20,64}$/i;

const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_SECONDS = 60;
// Generoso em relação ao timeout de rede para a InfinitePay
// (INFINITEPAY_DEFAULTS.requestTimeoutMs = 15s): dá folga para a
// chamada completar normalmente antes de considerar o claim expirado.
const CLAIM_TTL_MS = 30_000;

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

function normalizePhoneBR(phone: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const digits = String(phone).replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) return `+${digits}`;
  if (digits.length === 10 || digits.length === 11) return `+55${digits}`;
  return undefined; // formato não reconhecido: melhor omitir do que enviar errado
}

function parseSlugFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    const slug = path.split('/').filter(Boolean).pop();
    return slug || null;
  } catch {
    return null;
  }
}

interface OrderRow {
  id: string;
  public_token: string;
  status: string;
  payment_status: string;
  payment_provider: string | null;
  payment_url: string | null;
  total: number;
  discount: number;
  shipping: number;
  customer_data: { name?: string; email?: string | null; phone?: string | null } | null;
  shipping_data: { method?: string | null; address?: Record<string, string> | null } | null;
}

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `create-payment:${clientIp(req)}`,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (allowed.data === false) {
    throw new ValidationError('Muitas tentativas. Aguarde um instante e tente novamente.');
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }
  const body = (raw ?? {}) as Record<string, unknown>;
  const orderId = typeof body.orderId === 'string' ? body.orderId.trim() : '';
  const publicToken = typeof body.publicToken === 'string' ? body.publicToken.trim() : '';

  if (!orderId && !publicToken) throw new ValidationError('orderId ou publicToken é obrigatório.');
  if (orderId && !UUID_RE.test(orderId)) throw new ValidationError('orderId inválido.');
  if (publicToken && !TOKEN_RE.test(publicToken)) throw new ValidationError('publicToken inválido.');

  const query = ctx.db
    .from('store_orders')
    .select('id, public_token, status, payment_status, payment_provider, payment_url, total, discount, shipping, customer_data, shipping_data');
  const { data: order, error: loadErr } = await (orderId ? query.eq('id', orderId) : query.eq('public_token', publicToken))
    .maybeSingle<OrderRow>();
  if (loadErr) throw new Error(`create_payment_order_lookup_failed: ${loadErr.message}`);
  if (!order) throw new NotFoundError('Pedido não encontrado.');

  if (order.payment_status === 'paid') {
    return json(req, { ok: true, alreadyPaid: true, publicToken: order.public_token }, 200);
  }
  if (order.payment_status === 'failed' || order.payment_status === 'cancelled' || order.status === 'cancelled') {
    throw new ValidationError('Este pedido não pode mais receber pagamento. Faça um novo pedido.');
  }
  if (order.payment_url) {
    // idempotente: clique duplo/retry reaproveita o link já criado
    return json(req, { ok: true, paymentUrl: order.payment_url, publicToken: order.public_token }, 200);
  }

  if (!isInfinitePayConfigured(ctx.infinitePayConfig)) {
    throw new ConfigError('INFINITEPAY_HANDLE não configurado no backend.');
  }

  // "Reivindica" a criação de forma atômica, com PRAZO (TTL) — ver
  // _shared/payment-claim.ts (extraído para ser testável sem banco
  // real, com os 5 cenários da auditoria de 2026-09-17 cobertos em
  // _tests/payment-claim.test.ts).
  const claimed = await tryClaimPaymentLinkCreation(ctx.db, order.id, CLAIM_TTL_MS);
  if (!claimed) {
    // outra requisição já está criando (ou já criou) o link deste pedido
    const { data: again } = await ctx.db
      .from('store_orders')
      .select('payment_url, public_token')
      .eq('id', order.id)
      .maybeSingle<{ payment_url: string | null; public_token: string }>();
    if (again?.payment_url) {
      return json(req, { ok: true, paymentUrl: again.payment_url, publicToken: again.public_token }, 200);
    }
    return json(req, { ok: true, pending: true, message: 'Estamos preparando seu pagamento. Tente novamente em alguns segundos.' }, 202);
  }

  const { data: itemRows, error: itemsErr } = await ctx.db
    .from('store_order_items')
    .select('name, sku, quantity, unit_price')
    .eq('order_id', order.id);
  if (itemsErr) throw new Error(`create_payment_items_lookup_failed: ${itemsErr.message}`);
  const items: PaymentOrderItemInput[] = (itemRows ?? []).map((it: Record<string, unknown>) => ({
    name: String(it.name ?? 'Item'),
    sku: (it.sku as string | null) ?? null,
    quantity: Number(it.quantity) || 1,
    unitPrice: Number(it.unit_price) || 0,
  }));
  if (items.length === 0) {
    throw new ValidationError('Pedido sem itens — não é possível criar o pagamento.');
  }

  const { items: checkoutItems, totalCents } = buildCheckoutItems({
    items,
    shippingCost: Number(order.shipping) || 0,
    discount: Number(order.discount) || 0,
    orderTotal: Number(order.total) || 0,
  });
  if (checkoutItems.length === 0 || totalCents <= 0) {
    throw new ValidationError('Valor do pedido inválido para pagamento.');
  }

  const customerData = order.customer_data ?? {};
  const shippingData = order.shipping_data ?? {};
  const customer: Record<string, string> = {};
  if (customerData.name) customer.name = String(customerData.name).slice(0, 120);
  if (customerData.email) customer.email = String(customerData.email).slice(0, 160);
  const phone = normalizePhoneBR(customerData.phone);
  if (phone) customer.phone_number = phone;

  let address: Record<string, string> | undefined;
  if (shippingData.method === 'delivery' && shippingData.address) {
    const a = shippingData.address;
    address = {
      ...(a.zip ? { cep: String(a.zip).replace(/\D/g, '').slice(0, 8) } : {}),
      ...(a.street ? { street: String(a.street).slice(0, 160) } : {}),
      ...(a.district ? { neighborhood: String(a.district).slice(0, 120) } : {}),
      ...(a.number ? { number: String(a.number).slice(0, 20) } : {}),
      ...(a.complement ? { complement: String(a.complement).slice(0, 120) } : {}),
    };
  }
  // Retirada na loja: nunca inventamos endereço de entrega.

  // O redirect_url leva o public_token do PRÓPRIO pedido — é assim que
  // pedido-confirmado.html sabe qual pedido consultar quando o cliente
  // volta da InfinitePay (que anexa os parâmetros dela: receipt_url,
  // order_nsu, slug, capture_method, transaction_nsu). Nunca usamos o
  // id interno aqui.
  const redirectUrl = `${ctx.infinitePayConfig.redirectUrl}?token=${encodeURIComponent(order.public_token)}`;

  try {
    const result = await ctx.paymentClient().createCheckoutLink({
      orderNsu: order.id,
      items: checkoutItems,
      redirectUrl,
      webhookUrl: ctx.infinitePayConfig.webhookUrl,
      customer: Object.keys(customer).length ? customer : undefined,
      address,
    });

    await ctx.db
      .from('store_orders')
      .update({
        payment_url: result.url,
        payment_invoice_slug: parseSlugFromUrl(result.url),
        payment_created_at: new Date().toISOString(),
        payment_claim_expires_at: null,
      })
      .eq('id', order.id);

    ctx.logger.info('payment.create_link', 'link de pagamento InfinitePay criado', {
      entityType: 'order',
      entityId: order.id,
      totalCents,
    });

    return json(req, { ok: true, paymentUrl: result.url, publicToken: order.public_token }, 201);
  } catch (err) {
    const d = describeError(err);
    // Libera a reivindicação para permitir uma nova tentativa manual
    // imediata — não deixamos o pedido travado por uma falha
    // transitória da InfinitePay. Mesmo que este release nunca rode
    // (processo morto), o CLAIM_TTL_MS acima garante a liberação
    // automática depois.
    await releasePaymentLinkClaim(ctx.db, order.id, { payment_raw_status: { last_create_error: d.code } });
    ctx.logger.error('payment.create_link', 'falha ao criar link de pagamento InfinitePay', {
      entityType: 'order',
      entityId: order.id,
      errorCode: d.code,
    });
    throw err;
  }
});
