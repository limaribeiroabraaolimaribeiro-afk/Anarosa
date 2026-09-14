/**
 * Repositório do cache de catálogo (store_* + leitura de status).
 * Recebe o cliente Supabase (service role) por injeção.
 * Todas as escritas são UPSERTs por bling_id — nunca geram duplicados.
 */
import { DatabaseError, ValidationError } from './errors.ts';
import type {
  InventoryRow,
  MappedProduct,
  StoreCategoryRow,
} from './product-mapper.ts';
import {
  resolveStock,
  serializePublicProduct,
  type PublicProduct,
  type StockTotal,
} from './storefront-serializer.ts';

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

interface PostgrestErrorLike {
  message?: string | null;
  code?: string | null;
  details?: string | null;
  hint?: string | null;
}

/**
 * Lança um DatabaseError preservando code/details/hint do Postgrest.
 * Nunca produz mensagem vazia: quando `error.message` vem em branco
 * (ex.: falha numa consulta `head: true`, que por definição do HTTP não
 * carrega corpo de resposta — daí nenhuma mensagem chegar ao cliente),
 * DatabaseError já substitui por um texto explícito.
 */
function fail(op: string, error: PostgrestErrorLike | null): never {
  throw new DatabaseError(op, error);
}

export interface ListPublicOptions {
  category?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
  includeUnavailable?: boolean;
}

export interface OrderItemRequest {
  slug: string;
  variantBlingId?: string | null;
  quantity: number;
}

export interface ResolvedOrderItem {
  blingProductId: string;
  variantBlingId: string | null;
  sku: string | null;
  name: string;
  quantity: number;
  /** Preço unitário ATUAL do backend — nunca o que o cliente enviou. */
  unitPrice: number;
  availableStock: number | null;
}

export type OrderItemRejectionReason =
  | 'product_not_found'
  | 'product_inactive'
  | 'variant_not_found'
  | 'variant_inactive'
  | 'insufficient_stock';

/** 400 com o motivo exato — usado pelo checkout para dar feedback claro ao cliente. */
export class OrderItemRejectedError extends ValidationError {
  readonly reason: OrderItemRejectionReason;
  readonly slug: string;

  constructor(reason: OrderItemRejectionReason, slug: string, message: string) {
    super(message, { reason, slug });
    this.reason = reason;
    this.slug = slug;
  }
}

export interface AdminProductVariant {
  id: string;
  blingId: string;
  sku: string | null;
  name: string;
  color: string | null;
  size: string | null;
  active: boolean;
  availableStock: number | null;
}

export interface AdminProductListItem {
  id: string;
  blingId: string;
  sku: string | null;
  name: string;
  slug: string;
  category: string | null;
  price: number;
  promotionalPrice: number | null;
  availableStock: number | null;
  active: boolean;
  image: string | null;
  updatedAt: string | null;
  syncedAt: string | null;
  variants: AdminProductVariant[];
}

export interface ListAdminProductsOptions {
  active?: boolean | null;
  stock?: 'esgotado' | 'baixo' | null;
  category?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
  lowStockThreshold?: number;
}

export class CatalogRepository {
  constructor(private readonly db: Db) {}

  // -------------------------------------------------------------------
  // Categorias
  // -------------------------------------------------------------------
  async upsertCategory(row: StoreCategoryRow, parentId: string | null = null): Promise<string> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from('store_categories')
      .upsert(
        {
          bling_id: row.bling_id,
          name: row.name,
          slug: await this.uniqueSlug('store_categories', row.slug, row.bling_id),
          parent_id: parentId,
          active: true,
          synced_at: now,
        },
        { onConflict: 'bling_id' },
      )
      .select('id')
      .single();
    if (error) fail('category_upsert_failed', error);
    return data.id as string;
  }

  async upsertCategories(rows: StoreCategoryRow[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    // primeiro sem pai, depois resolve pais (até 5 níveis)
    const pending = [...rows];
    for (let pass = 0; pass < 5 && pending.length; pass++) {
      for (const row of [...pending]) {
        const parentId = row.parent_bling_id ? ids.get(row.parent_bling_id) ?? null : null;
        if (row.parent_bling_id && !parentId && pass < 4) continue;
        ids.set(row.bling_id, await this.upsertCategory(row, parentId));
        pending.splice(pending.indexOf(row), 1);
      }
    }
    return ids;
  }

  async findCategoryIdByBlingId(blingId: string | null): Promise<string | null> {
    if (!blingId) return null;
    const { data, error } = await this.db
      .from('store_categories')
      .select('id')
      .eq('bling_id', blingId)
      .maybeSingle();
    if (error) fail('category_lookup_failed', error);
    return data?.id ?? null;
  }

  // -------------------------------------------------------------------
  // Slug estável e único
  // -------------------------------------------------------------------
  private async uniqueSlug(table: 'store_products' | 'store_categories', slug: string, blingId: string): Promise<string> {
    const { data: existing, error: e1 } = await this.db
      .from(table)
      .select('slug')
      .eq('bling_id', blingId)
      .maybeSingle();
    if (e1) fail('slug_lookup_failed', e1);
    if (existing?.slug) return existing.slug; // mantém URL estável

    const { data: clash, error: e2 } = await this.db
      .from(table)
      .select('bling_id')
      .eq('slug', slug)
      .maybeSingle();
    if (e2) fail('slug_clash_lookup_failed', e2);
    if (!clash || clash.bling_id === blingId) return slug;
    return `${slug}-${blingId}`;
  }

  // -------------------------------------------------------------------
  // Produtos + variações
  // -------------------------------------------------------------------
  async upsertProduct(mapped: MappedProduct, categoryId: string | null): Promise<{ productId: string; variantIds: Map<string, string> }> {
    const now = new Date().toISOString();
    const p = mapped.product;
    const { data, error } = await this.db
      .from('store_products')
      .upsert(
        {
          bling_id: p.bling_id,
          parent_bling_id: p.parent_bling_id,
          sku: p.sku,
          name: p.name,
          slug: await this.uniqueSlug('store_products', p.slug, p.bling_id),
          short_description: p.short_description,
          description: p.description,
          category_id: categoryId,
          brand: p.brand,
          price: p.price,
          promotional_price: p.promotional_price,
          format: p.format,
          condition: p.condition,
          active: p.active,
          images: p.images,
          metadata: p.metadata,
          bling_updated_at: p.bling_updated_at,
          synced_at: now,
        },
        { onConflict: 'bling_id' },
      )
      .select('id')
      .single();
    if (error) fail('product_upsert_failed', error);
    const productId = data.id as string;

    const variantIds = new Map<string, string>();
    if (mapped.variants.length > 0) {
      const rows = mapped.variants.map((v) => ({
        product_id: productId,
        bling_id: v.bling_id,
        sku: v.sku,
        name: v.name,
        color: v.color,
        size: v.size,
        price: v.price,
        promotional_price: v.promotional_price,
        active: v.active,
        attributes: v.attributes,
        metadata: v.metadata,
        synced_at: now,
      }));
      const { data: vdata, error: verr } = await this.db
        .from('store_product_variants')
        .upsert(rows, { onConflict: 'bling_id' })
        .select('id, bling_id');
      if (verr) fail('variant_upsert_failed', verr);
      for (const v of vdata ?? []) variantIds.set(String(v.bling_id), v.id);

      // variações que sumiram do Bling → soft-disable
      const keep = mapped.variants.map((v) => v.bling_id);
      const { error: derr } = await this.db
        .from('store_product_variants')
        .update({ active: false, synced_at: now })
        .eq('product_id', productId)
        .not('bling_id', 'in', `(${keep.map((k) => `"${k}"`).join(',')})`);
      if (derr) fail('variant_disable_failed', derr);
    }

    return { productId, variantIds };
  }

  async findProductByBlingId(blingId: string): Promise<Row | null> {
    const { data, error } = await this.db
      .from('store_products')
      .select('id, bling_id, slug, active, parent_bling_id')
      .eq('bling_id', blingId)
      .maybeSingle();
    if (error) fail('product_lookup_failed', error);
    return data ?? null;
  }

  async findVariantByBlingId(blingId: string): Promise<Row | null> {
    const { data, error } = await this.db
      .from('store_product_variants')
      .select('id, bling_id, product_id, active')
      .eq('bling_id', blingId)
      .maybeSingle();
    if (error) fail('variant_lookup_failed', error);
    return data ?? null;
  }

  /** Soft-disable: nunca apaga histórico. */
  async deactivateByBlingId(blingId: string): Promise<'product' | 'variant' | 'none'> {
    const now = new Date().toISOString();
    const product = await this.findProductByBlingId(blingId);
    if (product) {
      const { error } = await this.db
        .from('store_products')
        .update({ active: false, synced_at: now })
        .eq('id', product.id);
      if (error) fail('product_disable_failed', error);
      return 'product';
    }
    const variant = await this.findVariantByBlingId(blingId);
    if (variant) {
      const { error } = await this.db
        .from('store_product_variants')
        .update({ active: false, synced_at: now })
        .eq('id', variant.id);
      if (error) fail('variant_disable_failed', error);
      return 'variant';
    }
    return 'none';
  }

  // -------------------------------------------------------------------
  // Estoque
  // -------------------------------------------------------------------
  async upsertInventory(rows: InventoryRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const now = new Date().toISOString();
    const payload: Row[] = [];
    for (const r of rows) {
      let productId: string | null = null;
      let variantId: string | null = null;
      const product = await this.findProductByBlingId(r.bling_product_id);
      if (product) {
        productId = product.id;
      } else {
        const variant = await this.findVariantByBlingId(r.bling_product_id);
        if (variant) {
          productId = variant.product_id;
          variantId = variant.id;
        }
      }
      payload.push({
        bling_product_id: r.bling_product_id,
        product_id: productId,
        variant_id: variantId,
        deposit_id: r.deposit_id,
        physical_stock: r.physical_stock,
        virtual_stock: r.virtual_stock,
        synced_at: now,
      });
    }
    const { error } = await this.db
      .from('store_inventory')
      .upsert(payload, { onConflict: 'bling_product_id,deposit_id' });
    if (error) fail('inventory_upsert_failed', error);
    return payload.length;
  }

  // -------------------------------------------------------------------
  // Leitura pública (storefront)
  // -------------------------------------------------------------------
  private async stockFor(blingIds: string[]): Promise<{ byDeposits: StockTotal[]; totals: StockTotal[] }> {
    if (blingIds.length === 0) return { byDeposits: [], totals: [] };
    const [{ data: byDeposits, error: e1 }, { data: totals, error: e2 }] = await Promise.all([
      this.db.from('store_stock_totals').select('bling_product_id, physical_stock, virtual_stock, available_stock').in('bling_product_id', blingIds),
      this.db.from('store_inventory').select('bling_product_id, physical_stock, virtual_stock, available_stock').eq('deposit_id', '__total__').in('bling_product_id', blingIds),
    ]);
    if (e1) fail('stock_totals_read_failed', e1);
    if (e2) fail('stock_read_failed', e2);
    return { byDeposits: byDeposits ?? [], totals: totals ?? [] };
  }

  private async hydrate(products: Row[]): Promise<PublicProduct[]> {
    if (products.length === 0) return [];
    const productIds = products.map((p) => p.id);
    const categoryIds = Array.from(new Set(products.map((p) => p.category_id).filter(Boolean)));

    const [{ data: variants, error: e1 }, { data: categories, error: e2 }] = await Promise.all([
      this.db.from('store_product_variants').select('*').in('product_id', productIds).eq('active', true),
      categoryIds.length
        ? this.db.from('store_categories').select('id, name, slug').in('id', categoryIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (e1) fail('variants_read_failed', e1);
    if (e2) fail('categories_read_failed', e2);

    const allBlingIds = [
      ...products.map((p) => String(p.bling_id)),
      ...(variants ?? []).map((v: Row) => String(v.bling_id)),
    ];
    const stock = await this.stockFor(allBlingIds);
    const catById = new Map<string, Row>((categories ?? []).map((c: Row) => [c.id, c]));

    return products.map((p) =>
      serializePublicProduct(
        p,
        (variants ?? []).filter((v: Row) => v.product_id === p.id),
        stock.byDeposits,
        stock.totals,
        p.category_id ? catById.get(p.category_id) ?? null : null,
      )
    );
  }

  async listPublicProducts(opts: ListPublicOptions = {}): Promise<{ items: PublicProduct[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);

    let categoryId: string | null = null;
    if (opts.category) {
      const { data, error } = await this.db
        .from('store_categories')
        .select('id')
        .eq('slug', opts.category)
        .maybeSingle();
      if (error) fail('category_slug_lookup_failed', error);
      if (!data) return { items: [], total: 0 };
      categoryId = data.id;
    }

    let query = this.db
      .from('store_products')
      .select('*', { count: 'exact' })
      .eq('active', true)
      .is('parent_bling_id', null) // variações isoladas não viram cards
      .order('updated_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (categoryId) query = query.eq('category_id', categoryId);
    if (opts.search) {
      const term = opts.search.replace(/[%_,]/g, ' ').trim().slice(0, 80);
      if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
    }

    const { data, error, count } = await query;
    if (error) fail('products_list_failed', error);
    const items = await this.hydrate(data ?? []);
    return {
      items: opts.includeUnavailable ? items : items,
      total: count ?? items.length,
    };
  }

  async getPublicProductBySlug(slug: string): Promise<PublicProduct | null> {
    const { data, error } = await this.db
      .from('store_products')
      .select('*')
      .eq('slug', slug)
      .eq('active', true)
      .maybeSingle();
    if (error) fail('product_slug_lookup_failed', error);
    if (!data) return null;
    const [item] = await this.hydrate([data]);
    return item ?? null;
  }

  // -------------------------------------------------------------------
  // Resolução de itens de pedido (checkout) — o BACKEND é a fonte de
  // verdade para preço/estoque/existência. O chamador nunca envia preço;
  // se enviasse, seria ignorado aqui de qualquer forma.
  // -------------------------------------------------------------------
  /**
   * Para cada item solicitado (slug + variação opcional + quantidade),
   * busca o produto/variação ATUAIS no cache e valida:
   *   - produto existe e está ativo;
   *   - variação (se informada) existe, pertence ao produto e está ativa;
   *   - estoque disponível é suficiente para a quantidade pedida.
   * Lança ValidationError (400) com o motivo exato na primeira falha —
   * nunca "corrige" silenciosamente a quantidade nem inventa preço.
   */
  async resolveOrderItems(requests: OrderItemRequest[]): Promise<ResolvedOrderItem[]> {
    const resolved: ResolvedOrderItem[] = [];
    for (const req of requests) {
      const { data: product, error } = await this.db
        .from('store_products')
        .select('id, bling_id, sku, name, price, promotional_price, active')
        .eq('slug', req.slug)
        .maybeSingle();
      if (error) fail('order_item_product_lookup_failed', error);
      if (!product) {
        throw new OrderItemRejectedError('product_not_found', req.slug, `Produto não encontrado (${req.slug}).`);
      }
      if (!product.active) {
        throw new OrderItemRejectedError('product_inactive', req.slug, `"${product.name}" não está disponível.`);
      }

      let blingProductId = String(product.bling_id);
      let sku: string | null = product.sku ?? null;
      let name: string = product.name;
      let unitPrice = Number(product.promotional_price ?? product.price ?? 0);

      if (req.variantBlingId) {
        const { data: variant, error: verr } = await this.db
          .from('store_product_variants')
          .select('id, bling_id, product_id, sku, name, price, promotional_price, active')
          .eq('bling_id', req.variantBlingId)
          .eq('product_id', product.id)
          .maybeSingle();
        if (verr) fail('order_item_variant_lookup_failed', verr);
        if (!variant) {
          throw new OrderItemRejectedError('variant_not_found', req.slug, `Variação não encontrada para "${product.name}".`);
        }
        if (!variant.active) {
          throw new OrderItemRejectedError('variant_inactive', req.slug, `Variação de "${product.name}" não está disponível.`);
        }
        blingProductId = String(variant.bling_id);
        sku = variant.sku ?? sku;
        name = variant.name ? `${product.name} — ${variant.name}` : product.name;
        unitPrice = Number(variant.promotional_price ?? variant.price ?? unitPrice);
      }

      const stock = await this.stockFor([blingProductId]);
      const availableStock = resolveStock(blingProductId, stock.byDeposits, stock.totals);
      if (availableStock != null && availableStock < req.quantity) {
        throw new OrderItemRejectedError(
          'insufficient_stock',
          req.slug,
          `Estoque insuficiente para "${name}" (disponível: ${availableStock}, solicitado: ${req.quantity}).`,
        );
      }

      resolved.push({
        blingProductId,
        variantBlingId: req.variantBlingId ?? null,
        sku,
        name,
        quantity: req.quantity,
        unitPrice,
        availableStock,
      });
    }
    return resolved;
  }

  // -------------------------------------------------------------------
  // Visão administrativa de produtos (/gestao/) — diferente da pública:
  // inclui produtos INATIVOS, expõe `active`/`blingId`/timestamps.
  // Bling é fonte de verdade: somente leitura, sem edição aqui.
  // -------------------------------------------------------------------
  async listAdminProducts(opts: ListAdminProductsOptions = {}): Promise<{ items: AdminProductListItem[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const offset = Math.max(opts.offset ?? 0, 0);
    const lowStockThreshold = opts.lowStockThreshold ?? 5;
    // Filtro de estoque só pode ser aplicado DEPOIS de calcular o
    // estoque (que depende de outra tabela) — paginar no banco antes
    // disso deixaria `total`/páginas errados quando `stock` é usado.
    // Nesse caso buscamos todos os produtos que passam os demais
    // filtros (limitado a um teto de segurança) e paginamos em memória.
    const needsInMemoryPaging = opts.stock === 'esgotado' || opts.stock === 'baixo';
    const SAFETY_CAP = 2000;

    let categoryId: string | null = null;
    if (opts.category) {
      const { data, error } = await this.db.from('store_categories').select('id').eq('slug', opts.category).maybeSingle();
      if (error) fail('admin_category_lookup_failed', error);
      if (!data) return { items: [], total: 0 };
      categoryId = data.id;
    }

    let query = this.db
      .from('store_products')
      .select('*', { count: 'exact' })
      .is('parent_bling_id', null)
      .order('updated_at', { ascending: false });

    query = needsInMemoryPaging ? query.range(0, SAFETY_CAP - 1) : query.range(offset, offset + limit - 1);

    if (opts.active === true) query = query.eq('active', true);
    if (opts.active === false) query = query.eq('active', false);
    if (categoryId) query = query.eq('category_id', categoryId);
    if (opts.search) {
      const term = opts.search.replace(/[%_,]/g, ' ').trim().slice(0, 80);
      if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`);
    }

    const { data: products, error, count } = await query;
    if (error) fail('admin_products_list_failed', error);
    const rows: Row[] = products ?? [];
    if (rows.length === 0) return { items: [], total: needsInMemoryPaging ? 0 : (count ?? 0) };

    const productIds = rows.map((p) => p.id);
    const categoryIds = Array.from(new Set(rows.map((p) => p.category_id).filter(Boolean)));

    const [{ data: variants, error: e1 }, { data: categories, error: e2 }] = await Promise.all([
      this.db.from('store_product_variants').select('*').in('product_id', productIds),
      categoryIds.length
        ? this.db.from('store_categories').select('id, name').in('id', categoryIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (e1) fail('admin_variants_read_failed', e1);
    if (e2) fail('admin_categories_read_failed', e2);

    const allBlingIds = [...rows.map((p) => String(p.bling_id)), ...(variants ?? []).map((v: Row) => String(v.bling_id))];
    const stock = await this.stockFor(allBlingIds);
    const catById = new Map<string, Row>((categories ?? []).map((c: Row) => [c.id, c]));

    let items: AdminProductListItem[] = rows.map((p) => {
      const productVariants: Row[] = (variants ?? []).filter((v: Row) => v.product_id === p.id);
      const variantItems: AdminProductVariant[] = productVariants.map((v) => ({
        id: v.id,
        blingId: String(v.bling_id),
        sku: v.sku ?? null,
        name: v.name,
        color: v.color ?? null,
        size: v.size ?? null,
        active: v.active,
        availableStock: resolveStock(String(v.bling_id), stock.byDeposits, stock.totals),
      }));

      const availableStock = variantItems.length > 0
        ? variantItems.filter((v) => v.availableStock != null).reduce((sum, v) => sum + (v.availableStock ?? 0), 0)
        : resolveStock(String(p.bling_id), stock.byDeposits, stock.totals);

      const images = Array.isArray(p.images) ? p.images : [];
      return {
        id: p.id,
        blingId: String(p.bling_id),
        sku: p.sku ?? null,
        name: p.name,
        slug: p.slug,
        category: p.category_id ? catById.get(p.category_id)?.name ?? null : null,
        price: Number(p.price ?? 0),
        promotionalPrice: p.promotional_price != null ? Number(p.promotional_price) : null,
        availableStock,
        active: p.active,
        image: images[0]?.url ?? null,
        updatedAt: p.updated_at ?? null,
        syncedAt: p.synced_at ?? null,
        variants: variantItems,
      };
    });

    if (opts.stock === 'esgotado') {
      items = items.filter((i) => i.availableStock != null && i.availableStock <= 0);
    } else if (opts.stock === 'baixo') {
      items = items.filter((i) => i.availableStock != null && i.availableStock > 0 && i.availableStock <= lowStockThreshold);
    }

    if (needsInMemoryPaging) {
      const total = items.length;
      return { items: items.slice(offset, offset + limit), total };
    }
    return { items, total: count ?? items.length };
  }

  // -------------------------------------------------------------------
  // Diagnóstico (sem segredos)
  // -------------------------------------------------------------------
  /**
   * Conta produtos no cache. Usa `.limit(1)` em vez de `head: true`:
   * `count: 'exact'` já devolve o total via header `Content-Range`
   * independente do limite aplicado às linhas retornadas, mas uma
   * requisição HEAD nunca carrega corpo (RFC 7231 §4.3.2) — se o
   * Postgrest retornar um erro numa consulta `head: true`, o cliente
   * nunca vê `message`/`code`/`details`/`hint`, só um erro em branco.
   * Com `.limit(1)` a contagem continua igualmente barata (1 linha),
   * mas um eventual erro chega com a mensagem completa do Postgres.
   */
  async countProducts(): Promise<{ total: number; active: number }> {
    const [{ count: total, error: e1 }, { count: active, error: e2 }] = await Promise.all([
      this.db.from('store_products').select('id', { count: 'exact' }).limit(1),
      this.db.from('store_products').select('id', { count: 'exact' }).eq('active', true).limit(1),
    ]);
    if (e1) fail('products_count_total_failed', e1);
    if (e2) fail('products_count_active_failed', e2);
    return { total: total ?? 0, active: active ?? 0 };
  }

  async lastWebhookAt(): Promise<string | null> {
    const { data, error } = await this.db
      .from('bling_webhook_events')
      .select('received_at')
      .order('received_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) fail('webhook_last_read_failed', error);
    return data?.received_at ?? null;
  }

  /** Ver countProducts() acima: `.limit(1)` em vez de `head: true`, mesmo motivo. */
  async webhookStats(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const status of ['pending', 'processing', 'processed', 'failed', 'ignored']) {
      const { count, error } = await this.db
        .from('bling_webhook_events')
        .select('event_id', { count: 'exact' })
        .eq('status', status)
        .limit(1);
      if (error) fail(`webhook_stats_failed[${status}]`, error);
      out[status] = count ?? 0;
    }
    return out;
  }

  /** Erros recentes já sanitizados pelo logger na gravação. */
  async recentErrors(limit = 10): Promise<Array<{ at: string; operation: string; message: string; code: string | null; httpStatus: number | null }>> {
    const { data, error } = await this.db
      .from('integration_logs')
      .select('created_at, operation, message, details')
      .in('level', ['error', 'warn'])
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) fail('logs_read_failed', error);
    return (data ?? []).map((r: Row) => ({
      at: r.created_at,
      operation: r.operation,
      message: r.message,
      code: r.details?.errorCode ?? r.details?.blingType ?? null,
      httpStatus: r.details?.httpStatus ?? null,
    }));
  }
}
