import type { AppContext } from './context.ts';
import { describeError, ValidationError } from './errors.ts';
import { mapOrderToBling, validateOrderInput } from './order-mapper.ts';
import { validDocument } from './commerce-input.ts';
import { sha256Hex } from './crypto.ts';
import { runAdminMutation } from './admin-mutation.ts';

// Business logic uses an injected repository so failure windows can be tested.
export interface OrderJob {
  id: string;
  total: number;
  customer_data: Record<string, string>;
  shipping_data: Record<string, unknown>;
  payment_data: Record<string, unknown>;
  discount: number;
  bling_claim_token: string;
  bling_submission_started_at: string | null;
  bling_sync_attempts: number;
}
export interface OrderWorkerDeps {
  enabled: boolean;
  claim: () => Promise<OrderJob | null>;
  find: (reference: string) => Promise<Array<{ id: unknown; numeroLoja?: unknown }>>;
  prepare: (order: OrderJob) => Promise<Record<string, unknown>>;
  start: (order: OrderJob) => Promise<void>;
  create: (payload: Record<string, unknown>) => Promise<{ data?: { id?: unknown } }>;
  finish: (order: OrderJob, status: string, blingId: string | null, error: string | null) => Promise<void>;
}
export async function processOrderJob(d: OrderWorkerDeps): Promise<string> {
  if (!d.enabled) return 'disabled';
  const order = await d.claim();
  if (!order) return 'empty';
  const reference = `anarosa-${order.id}`;
  let submitted = Boolean(order.bling_submission_started_at);
  try {
    const found = (await d.find(reference)).filter((x) => x.numeroLoja === reference);
    if (found.length > 1) {
      await d.finish(order, 'review', null, 'duplicate_reference');
      return 'review';
    }
    if (found.length === 1 && found[0].id) {
      await d.finish(order, 'synced', String(found[0].id), null);
      return 'synced';
    }
    if (submitted) {
      await d.finish(order, 'review', null, 'ambiguous_submission');
      return 'review';
    }
    const payload = await d.prepare(order);
    await d.start(order);
    submitted = true;
    const result = await d.create({ ...payload, numeroLoja: reference });
    if (!result.data?.id) throw new Error('missing_order_id');
    await d.finish(order, 'synced', String(result.data.id), null);
    return 'synced';
  } catch (error) {
    // Read/validation failures can retry; after POST, only reference recovery.
    await d.finish(order, submitted ? 'review' : 'failed', null, describeError(error).code);
    return submitted ? 'review' : 'failed';
  }
}

export function workerDeps(ctx: AppContext, id?: string): OrderWorkerDeps {
  const update = async (order: OrderJob, values: Record<string, unknown>) => {
    const { data, error } = await ctx.db.from('store_orders').update(values).eq('id', order.id).eq(
      'bling_claim_token',
      order.bling_claim_token,
    ).select('id').maybeSingle();
    if (error || !data) throw new Error('bling_claim_lost');
  };
  return {
    // Separate operational prerequisite: must be explicitly validated in Bling.
    enabled: ctx.blingConfig.orderSyncEnabled && Deno.env.get('BLING_ORDER_OPERATION_VALIDATED') === 'true',
    claim: async () => {
      const { data, error } = await ctx.db.rpc('claim_bling_order', { p_id: id ?? null });
      if (error) throw new Error('bling_claim_failed');
      return data;
    },
    find: async (ref) =>
      (await ctx.client().findOrdersByReference(ref)).data as Array<{ id: unknown; numeroLoja?: unknown }>,
    prepare: async (order) => {
      const document = order.customer_data.document;
      if (!document || !validDocument(document)) {
        throw new ValidationError('Documento válido necessário para vincular o contato no Bling.');
      }
      const contacts = await ctx.client().findContactsByDocument(document);
      const exact = (contacts.data ?? []).filter((c) =>
        String(c.numeroDocumento ?? '').replace(/\D/g, '') === document
      );
      if (exact.length > 1) {
        throw new ValidationError(
          'Resolva os contatos duplicados deste documento no Bling antes de reprocessar.',
        );
      }
      let contactId = exact[0]?.id;
      if (!contactId) {
        if (Deno.env.get('BLING_CONTACT_CREATE_ENABLED') !== 'true') {
          throw new ValidationError(
            'Cadastro de contatos ainda não validado. Cadastre o contato no Bling antes de reprocessar.',
          );
        }
        const hash = await sha256Hex(document);
        const key = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${
          hash.slice(20, 32)
        }`;
        const contact = await runAdminMutation(ctx, {
          key,
          resource: `contact:${hash}`,
          actor: null,
          payload: { document },
        }, async (submitted) => {
          await submitted();
          const created = await ctx.client().createContact({
            nome: order.customer_data.name,
            tipo: document.length === 14 ? 'J' : 'F',
            numeroDocumento: document,
            situacao: 'A',
          });
          if (!created.data?.id) throw new Error('contact_create_no_id');
          return { blingId: String(created.data.id) };
        });
        contactId = contact.blingId;
      }
      const { data: items, error } = await ctx.db.from('store_order_items').select('*').eq(
        'order_id',
        order.id,
      );
      if (error || !items?.length) throw new Error('order_items_unavailable');
      const normalized = await validateOrderInput({
        idempotencyKey: `anarosa-${order.id}`,
        customer: order.customer_data,
        shipping: order.shipping_data,
        payment: order.payment_data,
        discount: order.discount,
        items: items.map((it) => ({
          blingProductId: it.bling_product_id,
          sku: it.sku,
          name: it.name,
          quantity: Number(it.quantity),
          unitPrice: Number(it.unit_price),
        })),
      });
      if (Math.round(normalized.total * 100) !== Math.round(Number(order.total) * 100)) {
        throw new ValidationError('Total do pedido inconsistente.');
      }
      const mapped = mapOrderToBling(normalized);
      return {
        ...mapped,
        contato: { id: Number(contactId) },
        parcelas: [],
        ...(Deno.env.get('BLING_SITE_STORE_ID')
          ? { loja: { id: Number(Deno.env.get('BLING_SITE_STORE_ID')) } }
          : {}),
      };
    },
    start: (order) => update(order, { bling_submission_started_at: new Date().toISOString() }),
    create: (payload) => ctx.client().createOrder(payload),
    finish: async (order, status, blingId, error) => {
      const result = await ctx.db.rpc('finish_bling_order', {
        p_id: order.id,
        p_claim: order.bling_claim_token,
        p_status: status,
        p_bling_id: blingId,
        p_error: error,
      });
      if (result.error || result.data !== true) throw new Error('bling_finish_failed');
    },
  };
}
