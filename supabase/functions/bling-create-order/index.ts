/**
 * POST /bling-create-order  (admin — checkout ainda NÃO existe)
 *
 * Fluxo preparado, DESATIVADO por padrão (BLING_ORDER_SYNC_ENABLED=false):
 *   1. valida e normaliza o pedido;
 *   2. garante idempotência: mesma idempotency_key → mesmo store_orders.id,
 *      nunca dois pedidos (clique duplo / retry HTTP);
 *   3. se a flag estiver desligada, grava localmente com
 *      bling_sync_status='disabled' e NÃO chama o Bling;
 *   4. se ligada, cria no Bling UMA única vez (sem retry automático) e
 *      salva o bling_id. Falha → 'failed' + erro, sem repetir sozinho.
 */
import { requireAdmin } from '../_shared/admin-auth.ts';
import { serve } from '../_shared/context.ts';
import { describeError, ValidationError } from '../_shared/errors.ts';
import { mapOrderToBling, validateOrderInput } from '../_shared/order-mapper.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'POST') return methodNotAllowed(req, ['POST']);
  requireAdmin(req);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ValidationError('Body JSON inválido.');
  }
  const headerKey = req.headers.get('x-idempotency-key');
  if (headerKey && raw && typeof raw === 'object' && !(raw as Record<string, unknown>).idempotencyKey) {
    (raw as Record<string, unknown>).idempotencyKey = headerKey;
  }

  const order = await validateOrderInput(raw);

  // 1) idempotência local: reaproveita se já existir
  const { data: existing, error: lookupErr } = await ctx.db
    .from('store_orders')
    .select('id, bling_id, bling_sync_status, status, total')
    .eq('idempotency_key', order.idempotencyKey)
    .maybeSingle();
  if (lookupErr) throw new Error(`order_lookup_failed: ${lookupErr.message}`);

  let orderId: string = existing?.id ?? '';
  if (!existing) {
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
        bling_sync_status: ctx.blingConfig.orderSyncEnabled ? 'pending' : 'disabled',
        metadata: { notes: order.notes, source: 'storefront' },
      })
      .select('id')
      .single();
    if (insertErr) {
      // corrida: outro request inseriu a mesma chave → reler
      if (insertErr.code === '23505') {
        const { data: again } = await ctx.db
          .from('store_orders')
          .select('id, bling_id, bling_sync_status, status, total')
          .eq('idempotency_key', order.idempotencyKey)
          .maybeSingle();
        if (again) {
          return json(req, { ok: true, duplicate: true, orderId: again.id, blingId: again.bling_id, blingSyncStatus: again.bling_sync_status }, 200);
        }
      }
      throw new Error(`order_insert_failed: ${insertErr.message}`);
    }
    orderId = inserted.id;

    const items = order.items.map((it) => ({
      order_id: orderId,
      bling_product_id: it.variantBlingId ?? it.blingProductId,
      sku: it.sku,
      name: it.name,
      quantity: it.quantity,
      unit_price: it.unitPrice,
      total: it.total,
      metadata: { parentBlingId: it.variantBlingId ? it.blingProductId : null },
    }));
    const { error: itemsErr } = await ctx.db.from('store_order_items').insert(items);
    if (itemsErr) throw new Error(`order_items_insert_failed: ${itemsErr.message}`);
  } else if (existing.bling_id) {
    return json(req, { ok: true, duplicate: true, orderId, blingId: existing.bling_id, blingSyncStatus: existing.bling_sync_status }, 200);
  }

  // 2) flag desligada → nunca escreve no Bling
  if (!ctx.blingConfig.orderSyncEnabled) {
    ctx.logger.info('order.create', 'pedido salvo localmente; sincronização com Bling DESATIVADA', {
      entityType: 'order',
      entityId: orderId,
    });
    return json(req, {
      ok: true,
      created: false,
      reason: 'order_sync_disabled',
      orderId,
      blingSyncStatus: 'disabled',
      message: 'BLING_ORDER_SYNC_ENABLED=false: pedido registrado apenas localmente.',
    }, 202);
  }

  // 3) flag ligada → UMA tentativa, sem retry automático
  try {
    const payload = mapOrderToBling(order, { orderNumber: null });
    const res = await ctx.client().createOrder(payload as unknown as Record<string, unknown>);
    const blingId = res?.data?.id != null ? String(res.data.id) : null;
    await ctx.db
      .from('store_orders')
      .update({ bling_id: blingId, bling_sync_status: 'synced', bling_sync_error: null, synced_at: new Date().toISOString(), status: 'confirmed' })
      .eq('id', orderId);
    ctx.logger.info('order.create', 'pedido criado no Bling', { entityType: 'order', entityId: orderId, blingId });
    return json(req, { ok: true, created: true, orderId, blingId, blingSyncStatus: 'synced' }, 201);
  } catch (err) {
    const d = describeError(err);
    await ctx.db
      .from('store_orders')
      .update({ bling_sync_status: 'failed', bling_sync_error: `${d.code}: ${d.message}`.slice(0, 500) })
      .eq('id', orderId);
    ctx.logger.error('order.create', 'falha ao criar pedido no Bling (sem retry automático)', {
      entityType: 'order',
      entityId: orderId,
      errorCode: d.code,
      httpStatus: d.details?.blingStatus ?? null,
    });
    throw err;
  }
});
