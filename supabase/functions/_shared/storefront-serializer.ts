/**
 * Serialização PÚBLICA do catálogo. Somente os campos abaixo saem para o
 * navegador — nada de custo, tokens, logs, metadata interna.
 */
import { computeAvailableStock } from './product-mapper.ts';

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

export interface PublicVariant {
  id: string;
  blingId: string;
  sku: string | null;
  name: string;
  color: string | null;
  size: string | null;
  price: number | null;
  promotionalPrice: number | null;
  attributes: Record<string, string>;
  stock: number | null;
  available: boolean;
}

export interface PublicProduct {
  id: string;
  blingId: string;
  sku: string | null;
  name: string;
  slug: string;
  shortDescription: string | null;
  description: string | null;
  category: { name: string; slug: string } | null;
  brand: string | null;
  price: number;
  promotionalPrice: number | null;
  images: Array<{ url: string; alt: string | null }>;
  variants: PublicVariant[];
  stock: number | null;
  available: boolean;
  tags: string[];
  updatedAt: string | null;
}

export interface StockTotal {
  bling_product_id: string;
  physical_stock: number | null;
  virtual_stock: number | null;
  available_stock: number | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Retorna o disponível consolidado de um bling_id (soma dos depósitos ou linha __total__). */
export function resolveStock(blingId: string, totals: StockTotal[], totalsFallback: StockTotal[] = []): number | null {
  const byDeposits = totals.find((t) => t.bling_product_id === blingId);
  if (byDeposits && byDeposits.available_stock != null) return num(byDeposits.available_stock);
  const total = totalsFallback.find((t) => t.bling_product_id === blingId);
  if (total) return computeAvailableStock(num(total.physical_stock), num(total.virtual_stock));
  return null;
}

/**
 * Regra de disponibilidade:
 *   - produto inativo → indisponível
 *   - sem informação de estoque (null) → disponível (o Bling ainda não
 *     informou; a venda continua sujeita à confirmação do pedido)
 *   - estoque conhecido → disponível se > 0 (ou se alguma variação tiver > 0)
 */
export function serializePublicProduct(
  product: Row,
  variants: Row[],
  stockByDeposits: StockTotal[],
  stockTotals: StockTotal[],
  category: Row | null,
): PublicProduct {
  const publicVariants: PublicVariant[] = variants
    .filter((v) => v.active !== false)
    .map((v) => {
      const stock = resolveStock(String(v.bling_id), stockByDeposits, stockTotals);
      return {
        id: v.id,
        blingId: String(v.bling_id),
        sku: v.sku ?? null,
        name: v.name,
        color: v.color ?? null,
        size: v.size ?? null,
        price: num(v.price),
        promotionalPrice: num(v.promotional_price),
        attributes: (v.attributes ?? {}) as Record<string, string>,
        stock,
        available: stock == null ? true : stock > 0,
      };
    });

  let stock = resolveStock(String(product.bling_id), stockByDeposits, stockTotals);
  if (publicVariants.length > 0) {
    const known = publicVariants.filter((v) => v.stock != null);
    if (known.length > 0) stock = known.reduce((acc, v) => acc + (v.stock ?? 0), 0);
  }

  const active = product.active !== false;
  const available = active && (stock == null ? true : stock > 0);
  const tags = Array.isArray(product.metadata?.tags)
    ? (product.metadata.tags as unknown[]).map(String)
    : [];

  return {
    id: product.id,
    blingId: String(product.bling_id),
    sku: product.sku ?? null,
    name: product.name,
    slug: product.slug,
    shortDescription: product.short_description ?? null,
    description: product.description ?? null,
    category: category ? { name: category.name, slug: category.slug } : null,
    brand: product.brand ?? null,
    price: num(product.price) ?? 0,
    promotionalPrice: num(product.promotional_price),
    images: Array.isArray(product.images)
      ? (product.images as Row[]).map((i) => ({ url: String(i.url ?? i), alt: i.alt ?? null }))
      : [],
    variants: publicVariants,
    stock,
    available,
    tags,
    updatedAt: product.updated_at ?? null,
  };
}
