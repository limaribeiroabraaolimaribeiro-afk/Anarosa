/**
 * Sincronização Bling → cache (store_*).
 * Usado por bling-sync-products, bling-sync-product e pelos handlers de webhook.
 *
 * Somente LEITURA no Bling. Nenhuma função aqui escreve na conta Bling.
 */
import type { BlingClient } from './bling-client.ts';
import type { CatalogRepository } from './catalog-repo.ts';
import { BlingAuthError, describeError, NotConnectedError, TokenRefreshError } from './errors.ts';
import type { Logger } from './logger.ts';
import {
  mapBlingCategory,
  mapBlingProduct,
  mapBlingStockBalances,
  toId,
  type BlingRaw,
  type StoreCategoryRow,
} from './product-mapper.ts';
import type { TokenStore } from './token-store.ts';

export interface SyncDeps {
  client: BlingClient;
  repo: CatalogRepository;
  logger: Logger;
  tokenStore?: TokenStore;
}

export interface SyncSummary {
  categories: number;
  products: number;
  variants: number;
  inventoryRows: number;
  skippedVariants: number;
  errors: Array<{ blingId: string | null; code: string; message: string }>;
  startedAt: string;
  finishedAt: string;
}

/** Erros que devem interromper a sincronização inteira. */
function isFatal(err: unknown): boolean {
  return err instanceof NotConnectedError || err instanceof BlingAuthError || err instanceof TokenRefreshError;
}

export async function syncCategories(deps: SyncDeps): Promise<Map<string, string>> {
  const raw = await deps.client.getCategories();
  const rows = raw.map(mapBlingCategory).filter((r): r is StoreCategoryRow => r != null);
  const ids = await deps.repo.upsertCategories(rows);
  deps.logger.info('sync.categories', 'categorias sincronizadas', { count: ids.size });
  return ids;
}

export async function syncStockForProducts(deps: SyncDeps, blingIds: string[]): Promise<number> {
  const ids = Array.from(new Set(blingIds.filter(Boolean)));
  if (ids.length === 0) return 0;
  const balances = await deps.client.getStocks(ids);
  const rows = mapBlingStockBalances(balances as BlingRaw[]);
  const count = await deps.repo.upsertInventory(rows);
  deps.logger.info('sync.stock', 'estoque sincronizado', { products: ids.length, rows: count });
  return count;
}

export interface ProductSyncResult {
  productId: string;
  blingId: string;
  variantBlingIds: string[];
  syncedParentInstead: boolean;
}

/**
 * Sincroniza UM produto pelo id do Bling (consulta o estado atual).
 * Se o id for de uma variação, sincroniza o produto PAI (que traz todas
 * as variações) para manter o agrupamento consistente.
 */
export async function syncProductById(
  deps: SyncDeps,
  blingId: string,
  opts: { syncStock?: boolean; categoryIds?: Map<string, string> } = {},
): Promise<ProductSyncResult> {
  const detail = await deps.client.getProductById(blingId);
  let raw = (detail?.data ?? {}) as BlingRaw;
  let mapped = mapBlingProduct(raw);
  let syncedParentInstead = false;

  if (mapped.isVariantOfParent && mapped.product.parent_bling_id) {
    const parent = await deps.client.getProductById(mapped.product.parent_bling_id);
    raw = (parent?.data ?? {}) as BlingRaw;
    mapped = mapBlingProduct(raw);
    syncedParentInstead = true;
  }

  const categoryId = mapped.categoryBlingId
    ? (opts.categoryIds?.get(mapped.categoryBlingId) ?? await deps.repo.findCategoryIdByBlingId(mapped.categoryBlingId))
    : null;

  const { productId, variantIds } = await deps.repo.upsertProduct(mapped, categoryId);
  const variantBlingIds = [...variantIds.keys()];

  deps.logger.info('sync.product', 'produto sincronizado', {
    entityType: 'product',
    entityId: mapped.product.bling_id,
    variants: variantBlingIds.length,
    syncedParentInstead,
  });

  if (opts.syncStock !== false) {
    await syncStockForProducts(deps, [mapped.product.bling_id, ...variantBlingIds]);
  }

  return { productId, blingId: mapped.product.bling_id, variantBlingIds, syncedParentInstead };
}

/**
 * Sincronização completa (manual). Lista todas as páginas de /produtos,
 * busca detalhes de cada produto pai/simples, faz upsert e atualiza estoque.
 * Erros por produto são coletados; erros de autenticação interrompem.
 */
export async function syncAllProducts(deps: SyncDeps, opts: { criterio?: number } = {}): Promise<SyncSummary> {
  const startedAt = new Date().toISOString();
  const summary: SyncSummary = {
    categories: 0,
    products: 0,
    variants: 0,
    inventoryRows: 0,
    skippedVariants: 0,
    errors: [],
    startedAt,
    finishedAt: startedAt,
  };

  let categoryIds = new Map<string, string>();
  try {
    categoryIds = await syncCategories(deps);
    summary.categories = categoryIds.size;
  } catch (err) {
    if (isFatal(err)) throw err;
    const d = describeError(err);
    summary.errors.push({ blingId: null, code: d.code, message: d.message });
    deps.logger.warn('sync.categories', 'falha ao sincronizar categorias (continuando)', { errorCode: d.code });
  }

  // criterio 5 = todos (ativos + inativos) para permitir soft-disable
  const listed = await deps.client.listAllProducts({
    criterio: opts.criterio ?? 5,
    onPage: (page, count) => deps.logger.debug('sync.products', 'página listada', { page, count }),
  });

  const stockIds: string[] = [];

  for (const item of listed as BlingRaw[]) {
    const id = toId(item?.id);
    if (!id) continue;
    // variações aparecem na listagem com idProdutoPai; o pai já as traz
    if (toId(item?.idProdutoPai) || toId(item?.produtoPai)) {
      summary.skippedVariants++;
      continue;
    }
    try {
      const result = await syncProductById(deps, id, { syncStock: false, categoryIds });
      summary.products++;
      summary.variants += result.variantBlingIds.length;
      stockIds.push(result.blingId, ...result.variantBlingIds);
    } catch (err) {
      if (isFatal(err)) throw err;
      const d = describeError(err);
      summary.errors.push({ blingId: id, code: d.code, message: d.message });
      deps.logger.error('sync.product', 'falha ao sincronizar produto', {
        entityType: 'product',
        entityId: id,
        errorCode: d.code,
        httpStatus: d.details?.blingStatus ?? null,
      });
    }
  }

  try {
    summary.inventoryRows = await syncStockForProducts(deps, stockIds);
  } catch (err) {
    if (isFatal(err)) throw err;
    const d = describeError(err);
    summary.errors.push({ blingId: null, code: d.code, message: d.message });
  }

  if (deps.tokenStore) {
    const conn = await deps.tokenStore.getConnection();
    if (conn) await deps.tokenStore.markSynced(conn.id);
  }

  summary.finishedAt = new Date().toISOString();
  deps.logger.info('sync.products', 'sincronização concluída', {
    products: summary.products,
    variants: summary.variants,
    inventoryRows: summary.inventoryRows,
    errors: summary.errors.length,
  });
  return summary;
}
