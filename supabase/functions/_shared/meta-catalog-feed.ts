/**
 * Public Meta Commerce Manager CSV. Uses ONLY the already-public storefront DTO.
 * No user data, credentials, Bling costs, unpublished drafts or private media.
 */
import type { PublicProduct, PublicVariant } from './storefront-serializer.ts';

const META_SITE = 'https://www.lojaanarosa.com.br';
const COLUMNS = [
  'id', 'title', 'description', 'availability', 'condition', 'price',
  'link', 'image_link', 'brand', 'sale_price', 'additional_image_link',
  'item_group_id', 'color', 'size', 'mpn',
] as const;
const TEST_IDS = new Set([
  'a93ccd7c-7bd9-4f15-9f3f-090fc91c7f74',
  'b37ce022-22df-4a7a-8267-e3e3e775a765',
]);

const text = (x: unknown, length: number): string =>
  String(x ?? '').replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, length);

function httpsImage(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' ||
      /placeholder|sem-foto|no-image|\/logo\//i.test(url.pathname)) return null;
    return url.href;
  } catch { return null; }
}

function csvValue(value: string | number): string {
  let s = String(value);
  // Avoid accidental spreadsheet formula execution when reviewing exported CSV.
  if (/^[=+@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function price(value: number): string {
  return value.toFixed(2) + ' BRL';
}

export function renderMetaCatalog(products: PublicProduct[]): {
  csv: string; items: number; excludedProducts: number;
} {
  const rows: string[][] = [];
  let excludedProducts = 0;
  const seen = new Set<string>();

  for (const product of products) {
    const images = product.images.map(i => httpsImage(i.url)).filter((s): s is string => !!s);
    const brand = text(product.brand, 100);
    const name = text(product.name, 200);
    const validPrice = Number.isFinite(product.price) && product.price > 0;
    if (TEST_IDS.has(product.id) || !name || !brand || !validPrice || !images.length ||
        !/^[a-z0-9-]{1,160}$/i.test(product.slug)) {
      excludedProducts++;
      continue;
    }
    const description = text(product.description || product.shortDescription, 9900) ||
      `Conheça ${name} na loja ANAROSA. Confira fotos, tamanhos e detalhes antes da compra.`;
    const productUrl = `${META_SITE}/p/${encodeURIComponent(product.slug)}.html`;
    const itemVariants: Array<PublicVariant | null> =
      product.variants.length ? product.variants : [null];
    for (const variant of itemVariants) {
      const itemId = 'anarosa-' + String(variant?.blingId || product.blingId);
      if (seen.has(itemId)) continue;
      const regular = variant?.price != null && variant.price > 0 ? variant.price : product.price;
      const sale = variant?.promotionalPrice ?? product.promotionalPrice;
      const hasDiscount = sale != null && Number.isFinite(sale) && sale > 0 && sale < regular;
      const itemStock = variant ? variant.stock : product.stock;
      // Unknown stock is NOT advertised as available: prevents overselling.
      const availability = product.available && (variant?.available !== false) &&
        itemStock != null && itemStock > 0 ? 'in stock' : 'out of stock';
      rows.push([
        itemId, text(variant?.name && variant.name !== product.name ?
          `${name} — ${variant.name}` : name, 200),
        description, availability, 'new', price(regular), productUrl,
        images[0], brand, hasDiscount ? price(sale) : '',
        images.slice(1, 11).join(','), variant ? 'anarosa-' + product.blingId : '',
        text(variant?.color, 100), text(variant?.size, 100),
        text(variant?.sku || product.sku, 100),
      ]);
      seen.add(itemId);
    }
  }
  return { csv: [COLUMNS.join(','), ...rows.map(row => row.map(csvValue).join(','))].join('\r\n') + '\r\n',
    items: rows.length, excludedProducts };
}
