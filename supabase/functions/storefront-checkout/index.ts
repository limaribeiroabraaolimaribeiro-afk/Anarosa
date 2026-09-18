/**
 * POST /storefront-checkout  (PÚBLICO — chamado pelo navegador do cliente)
 *
 * Registra a intenção de compra. NÃO cria pedido no Bling (nem quando
 * BLING_ORDER_SYNC_ENABLED=true — este endpoint, deliberadamente, nunca
 * chama o Bling; isso é uma decisão explícita, não um esquecimento:
 * ligar a criação real a partir do storefront é uma próxima etapa que
 * exige revisão do mapeamento e aprovação do fluxo operacional).
 *
 * Fonte de verdade = BACKEND, sempre:
 *   1. o corpo da requisição NUNCA contém preço — só slug + variação +
 *      quantidade; `CatalogRepository.resolveOrderItems()` busca o
 *      preço/estoque/situação ATUAIS no cache (store_products/
 *      store_product_variants/store_inventory);
 *   2. produto inativo, variação inexistente/inativa ou estoque
 *      insuficiente → 400 com o motivo exato, nada é criado;
 *   3. idempotência (mesma chave → mesmo pedido) via
 *      order-mapper.ts:buildIdempotencyKey + unique constraint em
 *      store_orders.idempotency_key — clique duplo/retry HTTP nunca
 *      duplica.
 *
 * Este endpoint é público (sem x-integration-admin-secret) porque
 * precisa ser chamado por qualquer visitante da loja — por isso a
 * validação acima é a única linha de defesa; nenhum dado sensível é
 * lido ou exposto (não usa bling_connections, não chama o Bling).
 */
import { serve } from '../_shared/context.ts';
import { ValidationError } from '../_shared/errors.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';
import { validateOrderInput } from '../_shared/order-mapper.ts';
import type { OrderItemRequest } from '../_shared/catalog-repo.ts';

const MAX_ITEMS = 50;
const MAX_QUANTITY_PER_ITEM = 20;
const MAX_BODY_BYTES = 20_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

function clientIp(req: Request): string {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim().slice(0, 64);
  return req.headers.get('x-real-ip')?.trim().slice(0, 64) || 'unknown';
}

function parseItemRequests(raw: unknown): OrderItemRequest[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ValidationError('items vazio.');
  }
  if (raw.length > MAX_ITEMS) {
    throw new ValidationError(`Máximo de ${MAX_ITEMS} itens por pedido.`);
  }
  const errors: string[] = [];
  const items: OrderItemRequest[] = raw.map((it, idx) => {
    const o = (it ?? {}) as Record<string, unknown>;
    const slug = typeof o.slug === 'string' ? o.slug.trim() : '';
    const quantity = Number(o.quantity);
    if (!slug) errors.push(`items[${idx}].slug obrigatório`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_ITEM) {
      errors.push(`items[${idx}].quantity deve ser um inteiro entre 1 e ${MAX_QUANTITY_PER_ITEM}`);
    }
    return {
      slug,
      variantBlingId: typeof o.variantBlingId === 'string' && o.variantBlingId.trim() ? o.variantBlingId.trim() : null,
      quantity: Number.isInteger(quantity) ? quantity : 0,
    };
  });
  if (errors.length) throw new ValidationError('Itens inválidos.', { errors });
  return items;
}

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);

  const allowed = await ctx.db.rpc('rl_check_and_increment', {
    p_bucket: `checkout:${clientIp(req)}`,
    p_limit: RATE_LIMIT_MAX,
    p_window_seconds: RATE_LIMIT_WINDOW_SECONDS,
  });
  if (allowed.data === false) {
    throw new ValidationError('Muitas tentativas. Aguarde um instante e tente novamente.');
  }

  const rawText = await req.text();
  if (rawText.length > MAX_BODY_BYTES) throw new ValidationError('Payload muito grande.');
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }
  const body = (raw ?? {}) as Record<string, unknown>;

  const headerKey = req.headers.get('x-idempotency-key');
  if (headerKey && !body.idempotencyKey) body.idempotencyKey = headerKey;

  // 1) resolve cada item contra o catálogo REAL — preço/estoque/situação
  //    vêm sempre do backend; qualquer "price" enviado pelo cliente é
  //    ignorado (nem é lido aqui).
  const itemRequests = parseItemRequests(body.items);
  const resolved = await ctx.repo.resolveOrderItems(itemRequests);

  // 2) valida/normaliza customer/shipping/payment e calcula totais a
  //    partir dos preços resolvidos no passo 1 (nunca do cliente).
  // IMPORTANTE: "discount" NUNCA é lido do body aqui — não existe hoje
  // nenhum mecanismo de cupom/desconto autorizado pelo backend para o
  // checkout público; aceitar um valor vindo do cliente permitiria
  // zerar o total do pedido (ver relatório da FASE 2). Descontos
  // administrativos continuam possíveis via bling-create-order (rota
  // admin, não pública).
  const order = await validateOrderInput({
    idempotencyKey: body.idempotencyKey,
    customer: body.customer,
    shipping: body.shipping,
    payment: body.payment,
    notes: body.notes,
    items: resolved.map((r) => ({
      blingProductId: r.blingProductId,
      variantBlingId: r.variantBlingId,
      sku: r.sku,
      name: r.name,
      quantity: r.quantity,
      unitPrice: r.unitPrice,
    })),
  });

  // 3) idempotência local (mesma chave → mesmo pedido; nunca duplica)
  const { data: existing, error: lookupErr } = await ctx.db
    .from('store_orders')
    .select('id, status, bling_sync_status, total, public_token')
    .eq('idempotency_key', order.idempotencyKey)
    .maybeSingle();
  if (lookupErr) throw new Error(`checkout_order_lookup_failed: ${lookupErr.message}`);

  if (existing) {
    return json(req, {
      ok: true,
      duplicate: true,
      orderId: existing.id,
      publicToken: existing.public_token,
      status: existing.status,
      total: existing.total,
      message: 'Este pedido já havia sido registrado.',
    }, 200);
  }

  const { data: inserted, error: insertErr } = await ctx.db
    .from('store_orders')
    .insert({
      idempotency_key: order.idempotencyKey,
      status: 'pending',
      customer_data: order.customer,
      shipping_data: order.shipping,
      payment_data: order.payment,
      subtotal: order.subtotal,
      discount: order.discount,
      shipping: order.shippingCost,
      total: order.total,
      // Deliberadamente SEMPRE 'disabled' neste endpoint público — ver
      // comentário no topo do arquivo. Não depende de
      // BLING_ORDER_SYNC_ENABLED.
      bling_sync_status: 'disabled',
      metadata: { notes: order.notes, source: 'storefront-checkout' },
    })
    .select('id, status, total, public_token')
    .single();

  if (insertErr) {
    if (insertErr.code === '23505') {
      const { data: again } = await ctx.db
        .from('store_orders')
        .select('id, status, bling_sync_status, total, public_token')
        .eq('idempotency_key', order.idempotencyKey)
        .maybeSingle();
      if (again) {
        return json(req, { ok: true, duplicate: true, orderId: again.id, publicToken: again.public_token, status: again.status, total: again.total }, 200);
      }
    }
    throw new Error(`checkout_order_insert_failed: ${insertErr.message}`);
  }

  const items = order.items.map((it) => ({
    order_id: inserted.id,
    bling_product_id: it.variantBlingId ?? it.blingProductId,
    sku: it.sku,
    name: it.name,
    quantity: it.quantity,
    unit_price: it.unitPrice,
    total: it.total,
    metadata: { parentBlingId: it.variantBlingId ? it.blingProductId : null },
  }));
  const { error: itemsErr } = await ctx.db.from('store_order_items').insert(items);
  if (itemsErr) throw new Error(`checkout_order_items_insert_failed: ${itemsErr.message}`);

  ctx.logger.info('checkout.create', 'pedido registrado localmente (Bling não é chamado por este endpoint)', {
    entityType: 'order',
    entityId: inserted.id,
    itemCount: items.length,
  });

  return json(req, {
    ok: true,
    orderId: inserted.id,
    publicToken: inserted.public_token,
    status: inserted.status,
    total: inserted.total,
    message: 'Pedido registrado! Nossa equipe vai confirmar os detalhes com você.',
  }, 201);
});
