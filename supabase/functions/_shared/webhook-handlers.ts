/**
 * Handlers dos eventos de webhook do Bling.
 *
 * Regras:
 *   - eventos podem chegar fora de ordem → sempre que possível consultamos
 *     o ESTADO ATUAL da entidade no Bling em vez de confiar no payload;
 *   - produto removido → soft-disable (active=false), sem apagar histórico;
 *   - pedidos → apenas sincronização de status (nunca criamos pedidos aqui);
 *   - nenhum handler escreve no Bling.
 */
import { describeError } from './errors.ts';
import { extractStockFromWebhook, toId } from './product-mapper.ts';
import { mapBlingOrderStatus } from './order-mapper.ts';
import { syncProductById, syncStockForProducts, type SyncDeps } from './sync-service.ts';
import {
  isSupportedEvent,
  retryDelaySeconds,
  type ParsedWebhookEvent,
  type WebhookEventStore,
} from './webhook.ts';

export type HandlerOutcome = 'processed' | 'ignored';

export interface HandlerDeps extends SyncDeps {
  // deno-lint-ignore no-explicit-any
  db?: any;
}

function productIdFrom(evt: ParsedWebhookEvent): string | null {
  const d = evt.data ?? {};
  return toId(d.id) ?? toId(d.produto) ?? toId(d.idProduto) ?? null;
}

// ---------------------------------------------------------------------
// Produto
// ---------------------------------------------------------------------
export async function handleProductEvent(evt: ParsedWebhookEvent, deps: HandlerDeps): Promise<HandlerOutcome> {
  const blingId = productIdFrom(evt);
  if (!blingId) {
    deps.logger.warn('webhook.product', 'evento de produto sem id', { entityId: evt.eventId });
    return 'ignored';
  }

  if (evt.event === 'product.deleted') {
    const what = await deps.repo.deactivateByBlingId(blingId);
    deps.logger.info('webhook.product', `soft-disable (${what})`, { entityType: 'product', entityId: blingId });
    return what === 'none' ? 'ignored' : 'processed';
  }

  // created/updated: consulta o estado atual (payload pode estar defasado)
  await syncProductById(deps, blingId, { syncStock: true });
  return 'processed';
}

// ---------------------------------------------------------------------
// Estoque
// ---------------------------------------------------------------------
export async function handleStockEvent(evt: ParsedWebhookEvent, deps: HandlerDeps): Promise<HandlerOutcome> {
  const info = extractStockFromWebhook(evt.data ?? {});
  if (!info.productId) {
    deps.logger.warn('webhook.stock', 'evento de estoque sem produto', { entityId: evt.eventId });
    return 'ignored';
  }

  // Sempre consultamos o saldo atual no Bling (fonte de verdade); o
  // payload serve apenas para identificar o produto. Isso elimina o
  // risco de aplicar um evento antigo por cima de um mais novo.
  const rows = await syncStockForProducts(deps, [info.productId]);
  if (rows === 0 && info.physical != null) {
    // Bling não devolveu saldo (produto pode não existir mais no cache):
    // aplica o valor do payload apenas como último recurso.
    await deps.repo.upsertInventory([{
      bling_product_id: info.productId,
      deposit_id: info.depositId ?? '__total__',
      physical_stock: info.physical,
      virtual_stock: info.virtual,
    }]);
  }
  return 'processed';
}

// ---------------------------------------------------------------------
// Pedido (somente status; criação real fica para bling-create-order)
// ---------------------------------------------------------------------
export async function handleOrderEvent(evt: ParsedWebhookEvent, deps: HandlerDeps): Promise<HandlerOutcome> {
  const blingOrderId = toId(evt.data?.id) ?? null;
  if (!blingOrderId || !deps.db) return 'ignored';

  const { data: existing, error } = await deps.db
    .from('store_orders')
    .select('id, status')
    .eq('bling_id', blingOrderId)
    .maybeSingle();
  if (error) throw new Error(`order_lookup_failed: ${error.message}`);

  if (!existing) {
    // Pedido criado fora da loja (balcão, marketplace via Bling).
    // Não duplicamos nem criamos nada: apenas registramos.
    deps.logger.info('webhook.order', 'pedido não originado na loja; ignorado', {
      entityType: 'order',
      entityId: blingOrderId,
      event: evt.event,
    });
    return 'ignored';
  }

  if (evt.event === 'order.deleted') {
    await deps.db.from('store_orders').update({ status: 'cancelled', synced_at: new Date().toISOString() }).eq('id', existing.id);
    return 'processed';
  }

  const detail = await deps.client.getOrderById(blingOrderId);
  const status = mapBlingOrderStatus((detail?.data ?? {}) as { situacao?: { id?: number } });
  await deps.db
    .from('store_orders')
    .update({ status, synced_at: new Date().toISOString(), bling_sync_status: 'synced' })
    .eq('id', existing.id);
  deps.logger.info('webhook.order', 'status do pedido sincronizado', {
    entityType: 'order',
    entityId: blingOrderId,
    status,
  });
  return 'processed';
}

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------
export async function dispatchWebhookEvent(evt: ParsedWebhookEvent, deps: HandlerDeps): Promise<HandlerOutcome> {
  if (!isSupportedEvent(evt.event)) return 'ignored';
  const [resource] = evt.event.split('.');
  switch (resource) {
    case 'product':
      return await handleProductEvent(evt, deps);
    case 'stock':
    case 'virtual_stock':
      return await handleStockEvent(evt, deps);
    case 'order':
      return await handleOrderEvent(evt, deps);
    default:
      return 'ignored';
  }
}

export interface ProcessSummary {
  processed: number;
  ignored: number;
  failed: number;
  skipped: number;
}

/**
 * Processa um único evento já registrado: claim → dispatch → marcar.
 * Nunca lança: falhas viram status "failed" com backoff.
 */
export async function processRegisteredEvent(
  evt: ParsedWebhookEvent,
  store: WebhookEventStore,
  deps: HandlerDeps,
  retryCount = 0,
): Promise<'processed' | 'ignored' | 'failed' | 'skipped'> {
  const claimed = await store.claim(evt.eventId);
  if (!claimed) return 'skipped';

  try {
    const outcome = await dispatchWebhookEvent(evt, deps);
    if (outcome === 'ignored') {
      await store.markIgnored(evt.eventId, `evento ${evt.event} ignorado`);
    } else {
      await store.markProcessed(evt.eventId);
    }
    return outcome;
  } catch (err) {
    const d = describeError(err);
    deps.logger.error('webhook.process', 'falha ao processar evento', {
      entityType: 'webhook_event',
      entityId: evt.eventId,
      event: evt.event,
      errorCode: d.code,
      httpStatus: d.details?.blingStatus ?? null,
    });
    try {
      await store.markFailed(evt.eventId, `${d.code}: ${d.message}`, retryDelaySeconds(retryCount));
    } catch {
      // não propagar
    }
    return 'failed';
  }
}

/** Processa eventos pendentes/falhos (usado por bling-webhook-process). */
export async function processPendingEvents(
  store: WebhookEventStore,
  deps: HandlerDeps,
  limit = 20,
): Promise<ProcessSummary> {
  const summary: ProcessSummary = { processed: 0, ignored: 0, failed: 0, skipped: 0 };
  const pending = await store.listPending(limit);
  for (const evt of pending) {
    const r = await processRegisteredEvent(evt, store, deps);
    summary[r]++;
  }
  return summary;
}
