/**
 * Mapeamento Bling → tabelas store_*.
 *
 * Funções PURAS (sem rede/banco) para serem testadas isoladamente.
 * Os nomes de campo seguem a API v3 (/produtos, /produtos/{id},
 * /estoques/saldos, /categorias/produtos). Todo acesso é defensivo:
 * campos ausentes viram null — nunca inventamos variações ou estoque.
 *
 * Suporta:
 *   Produto simples (formato "S")
 *   Produto pai (formato "V") ── variações (array `variacoes`)
 *   Variação recebida isoladamente (possui idProdutoPai / produtoPai)
 */

// deno-lint-ignore no-explicit-any
export type BlingRaw = Record<string, any>;

export interface StoreProductRow {
  bling_id: string;
  parent_bling_id: string | null;
  sku: string | null;
  name: string;
  slug: string;
  short_description: string | null;
  description: string | null;
  brand: string | null;
  price: number;
  promotional_price: number | null;
  format: string | null;
  condition: string | null;
  active: boolean;
  images: Array<{ url: string; alt: string | null; source: 'internal' | 'external' | 'unknown' }>;
  metadata: Record<string, unknown>;
  bling_updated_at: string | null;
}

export interface StoreVariantRow {
  bling_id: string;
  sku: string | null;
  name: string;
  color: string | null;
  size: string | null;
  price: number | null;
  promotional_price: number | null;
  active: boolean;
  attributes: Record<string, string>;
  metadata: Record<string, unknown>;
}

export interface MappedProduct {
  product: StoreProductRow;
  variants: StoreVariantRow[];
  categoryBlingId: string | null;
  /** true se o registro recebido é ele próprio uma variação de outro produto. */
  isVariantOfParent: boolean;
}

export interface InventoryRow {
  bling_product_id: string;
  deposit_id: string;
  physical_stock: number;
  virtual_stock: number | null;
}

export interface StoreCategoryRow {
  bling_id: string;
  name: string;
  slug: string;
  parent_bling_id: string | null;
}

// ---------------------------------------------------------------------
// utilidades
// ---------------------------------------------------------------------
export function slugify(input: string): string {
  return (input ?? '')
    .toString()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'produto';
}

export function toId(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return toId((value as BlingRaw).id);
  return String(value);
}

export function toNumber(value: unknown, fallback: number | null = null): number | null {
  if (value == null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function toText(value: unknown): string | null {
  if (value == null) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Bling: situacao "A" = ativo, "I" = inativo, "E" = excluído. */
export function isActiveSituation(value: unknown): boolean {
  if (value == null) return true;
  const s = String(value).trim().toUpperCase();
  if (s === 'A' || s === 'ATIVO' || s === 'ACTIVE' || s === 'TRUE' || s === '1') return true;
  return false;
}

const CONDITION_MAP: Record<string, string> = {
  '0': 'unspecified',
  '1': 'new',
  '2': 'used',
  '3': 'refurbished',
};

/** Regra central de estoque disponível — espelha public.store_available_stock(). */
export function computeAvailableStock(physical: number | null, virtual: number | null): number {
  const base = virtual ?? physical ?? 0;
  return Math.max(base, 0);
}

/**
 * Interpreta o nome de variação do Bling, ex.: "Cor:Azul;Tamanho:M".
 * Não inventa atributos: só extrai o que está no texto.
 */
export function parseVariationAttributes(raw: unknown): {
  color: string | null;
  size: string | null;
  attributes: Record<string, string>;
} {
  const attributes: Record<string, string> = {};
  const text = toText(raw);
  if (!text) return { color: null, size: null, attributes };

  for (const part of text.split(';')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && value) attributes[key] = value;
  }

  let color: string | null = null;
  let size: string | null = null;
  for (const [key, value] of Object.entries(attributes)) {
    const k = slugify(key);
    if (!color && (k === 'cor' || k === 'color')) color = value;
    if (!size && (k === 'tamanho' || k === 'tam' || k === 'size')) size = value;
  }
  return { color, size, attributes };
}

export function extractImages(raw: BlingRaw): StoreProductRow['images'] {
  const out: StoreProductRow['images'] = [];
  const seen = new Set<string>();
  const push = (link: unknown, source: 'internal' | 'external' | 'unknown') => {
    const url = toText(link);
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ url, alt: null, source });
  };

  const midia = raw?.midia ?? {};
  const imagens = midia?.imagens ?? {};
  for (const img of Array.isArray(imagens?.internas) ? imagens.internas : []) {
    push(img?.link ?? img?.url ?? img, 'internal');
  }
  for (const img of Array.isArray(imagens?.externas) ? imagens.externas : []) {
    push(img?.link ?? img?.url ?? img, 'external');
  }
  if (typeof raw?.imagemURL === 'string') push(raw.imagemURL, 'unknown');
  if (Array.isArray(raw?.imagemURL)) for (const i of raw.imagemURL) push(i, 'unknown');
  return out;
}

function baseFields(raw: BlingRaw) {
  const price = toNumber(raw?.preco, 0) ?? 0;
  return {
    sku: toText(raw?.codigo),
    price,
    // A API v3 não expõe "preço promocional" no cadastro básico
    // (existe apenas em listas de preço). Fica null até definirmos a
    // regra comercial. Nunca inventamos desconto.
    promotional_price: null as number | null,
    active: isActiveSituation(raw?.situacao),
  };
}

export function mapBlingVariant(raw: BlingRaw): StoreVariantRow {
  const parsed = parseVariationAttributes(raw?.variacao?.nome ?? raw?.variacao ?? null);
  const base = baseFields(raw);
  return {
    bling_id: String(raw.id),
    sku: base.sku,
    name: toText(raw?.nome) ?? 'Variação',
    color: parsed.color,
    size: parsed.size,
    price: toNumber(raw?.preco, null),
    promotional_price: base.promotional_price,
    active: base.active,
    attributes: parsed.attributes,
    metadata: {
      order: toNumber(raw?.variacao?.ordem, null),
      gtin: toText(raw?.gtin),
      images: extractImages(raw).map((i) => i.url),
    },
  };
}

/**
 * Mapeia o retorno de GET /produtos/{id} (ou item de GET /produtos).
 * Para produto pai (formato "V") também devolve `variants`.
 */
export function mapBlingProduct(raw: BlingRaw): MappedProduct {
  if (raw == null || raw.id == null) {
    throw new Error('product_mapper: produto sem id');
  }
  const base = baseFields(raw);
  const name = toText(raw?.nome) ?? `Produto ${raw.id}`;
  const parentId = toId(raw?.idProdutoPai) ?? toId(raw?.produtoPai) ?? null;
  const format = toText(raw?.formato);
  const variationsRaw: BlingRaw[] = Array.isArray(raw?.variacoes) ? raw.variacoes : [];

  const product: StoreProductRow = {
    bling_id: String(raw.id),
    parent_bling_id: parentId,
    sku: base.sku,
    name,
    slug: slugify(name),
    short_description: toText(raw?.descricaoCurta),
    description: toText(raw?.descricaoComplementar) ?? toText(raw?.descricaoCurta),
    brand: toText(raw?.marca),
    price: base.price,
    promotional_price: base.promotional_price,
    format,
    condition: raw?.condicao != null ? (CONDITION_MAP[String(raw.condicao)] ?? String(raw.condicao)) : null,
    active: base.active,
    images: extractImages(raw),
    metadata: {
      type: toText(raw?.tipo),
      unit: toText(raw?.unidade),
      gtin: toText(raw?.gtin),
      hasVariations: format === 'V' || variationsRaw.length > 0,
      variationCount: variationsRaw.length,
      stockTotals: raw?.estoque && typeof raw.estoque === 'object'
        ? {
          physical: toNumber(raw.estoque.saldoFisicoTotal, null),
          virtual: toNumber(raw.estoque.saldoVirtualTotal, null),
        }
        : null,
    },
    bling_updated_at: null,
  };

  const variants = variationsRaw
    .filter((v) => v && v.id != null)
    .map(mapBlingVariant);

  return {
    product,
    variants,
    categoryBlingId: toId(raw?.categoria) ?? null,
    isVariantOfParent: parentId != null,
  };
}

/**
 * Mapeia GET /estoques/saldos → linhas de store_inventory.
 * Gera uma linha "__total__" com o consolidado e uma por depósito.
 */
export function mapBlingStockBalances(raw: BlingRaw[] | BlingRaw): InventoryRow[] {
  const list: BlingRaw[] = Array.isArray(raw) ? raw : [raw];
  const rows: InventoryRow[] = [];

  for (const item of list) {
    const productId = toId(item?.produto) ?? toId(item?.idProduto) ?? toId(item?.id);
    if (!productId) continue;

    const physicalTotal = toNumber(item?.saldoFisicoTotal, null);
    const virtualTotal = toNumber(item?.saldoVirtualTotal, null);
    if (physicalTotal != null || virtualTotal != null) {
      rows.push({
        bling_product_id: productId,
        deposit_id: '__total__',
        physical_stock: physicalTotal ?? 0,
        virtual_stock: virtualTotal,
      });
    }

    const deposits: BlingRaw[] = Array.isArray(item?.depositos) ? item.depositos : [];
    for (const dep of deposits) {
      const depId = toId(dep?.id) ?? toId(dep?.deposito);
      if (!depId) continue;
      rows.push({
        bling_product_id: productId,
        deposit_id: depId,
        physical_stock: toNumber(dep?.saldoFisico, 0) ?? 0,
        virtual_stock: toNumber(dep?.saldoVirtual, null),
      });
    }
  }
  return rows;
}

/**
 * Extrai (produto, depósito, saldos) do `data` de um webhook de estoque.
 * Os nomes de campo do payload de estoque não estão publicados de forma
 * completa na documentação pública; por isso aceitamos as variantes
 * mais prováveis e devolvemos null quando não há saldo — o handler
 * então consulta GET /estoques/saldos (estado atual) em vez de adivinhar.
 */
export function extractStockFromWebhook(data: BlingRaw): {
  productId: string | null;
  depositId: string | null;
  physical: number | null;
  virtual: number | null;
} {
  const d = data ?? {};
  return {
    productId: toId(d.produto) ?? toId(d.idProduto) ?? toId(d.produtoId) ?? toId(d.id),
    depositId: toId(d.deposito) ?? toId(d.idDeposito) ?? toId(d.depositoId),
    physical: toNumber(d.saldoFisico, null) ?? toNumber(d.saldoFisicoTotal, null),
    virtual: toNumber(d.saldoVirtual, null) ?? toNumber(d.saldoVirtualTotal, null),
  };
}

export function mapBlingCategory(raw: BlingRaw): StoreCategoryRow | null {
  const id = toId(raw?.id);
  if (!id) return null;
  const name = toText(raw?.descricao) ?? toText(raw?.nome) ?? `Categoria ${id}`;
  return {
    bling_id: id,
    name,
    slug: slugify(name),
    parent_bling_id: toId(raw?.categoriaPai) ?? null,
  };
}
