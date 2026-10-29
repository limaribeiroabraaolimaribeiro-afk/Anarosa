/**
 * Auditoria somente leitura do catálogo local vinculado ao Bling.
 * Nenhum registro é alterado aqui; correções comerciais devem ser
 * realizadas no ERP ou pelo editor de produtos com autorização.
 */
import { serve } from '../_shared/context.ts';
import { requireAdminUser } from '../_shared/admin-user-auth.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

type ProductRow = {
  id: string; bling_id: string; sku: string | null; name: string;
  price: number | string; active: boolean; parent_bling_id: string | null;
  category_id: string | null; short_description: string | null;
  description: string | null; images: Array<{ url?: string }> | null;
};
type VariantRow = { bling_id: string; product_id: string };
type Issue = { blingId: string; sku: string | null; name: string; issues: string[] };

function isExpiredImage(url: string, nowSeconds: number): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.s3.amazonaws.com')) return false;
    const expiry = parsed.searchParams.get('Expires');
    return expiry != null && /^\d+$/.test(expiry) && Number(expiry) < nowSeconds + 24 * 3600;
  } catch { return false; }
}

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  await requireAdminUser(req, ctx.db);
  const [productsResult, variantsResult, categoriesResult] = await Promise.all([
    ctx.db.from('store_products')
      .select('id, bling_id, sku, name, price, active, parent_bling_id, category_id, short_description, description, images')
      .eq('active', true).range(0, 1999),
    ctx.db.from('store_product_variants').select('bling_id,product_id').range(0, 1999),
    ctx.db.from('store_categories').select('id,bling_id').eq('active', true).range(0, 499),
  ]);
  if (productsResult.error || variantsResult.error || categoriesResult.error) {
    throw new Error('catalog_audit_read_failed');
  }
  const all = productsResult.data as ProductRow[];
  const variants = variantsResult.data as VariantRow[];
  const categories = categoriesResult.data as Array<{ id: string; bling_id: string }>;
  const byId = new Map(all.map((p) => [p.id, p]));
  const variantOwners = new Map(variants.map((v) => [String(v.bling_id), String(v.product_id)]));
  const categoryIds = new Set(categories.map((c) => c.id));
  const products = all.filter((p) =>
    !p.parent_bling_id && !variantOwners.has(String(p.bling_id)));
  const duplicateVariationCards = all.filter((p) =>
    !p.parent_bling_id && variantOwners.has(String(p.bling_id)));
  const nowSeconds = Date.now() / 1000;
  const issues: Issue[] = [];
  for (const p of products) {
    const found: string[] = [];
    if (!p.sku?.trim()) found.push('SKU ausente');
    if (!(Number(p.price) > 0)) found.push('Preço inválido');
    if (!p.category_id || !categoryIds.has(p.category_id)) found.push('Categoria não vinculada');
    if (!p.description?.trim() && !p.short_description?.trim()) found.push('Descrição ausente');
    const images = Array.isArray(p.images) ? p.images : [];
    if (!images.length) found.push('Sem fotos');
    else if (images.some((img) => isExpiredImage(String(img.url ?? ''), nowSeconds))) {
      found.push('Foto temporária vencida ou perto de vencer');
    }
    if (/^teste(?:\b|[-_])/i.test(p.name.trim())) found.push('Produto de teste ativo');
    if (found.length) issues.push({ blingId: String(p.bling_id), sku: p.sku, name: p.name, issues: found });
  }
  const stats = {
    activeRecords: all.length,
    storefrontProducts: products.length,
    activeCategories: categories.length,
    duplicateVariationCards: duplicateVariationCards.length,
    productsWithIssues: issues.length,
    missingCategory: issues.filter((v) => v.issues.includes('Categoria não vinculada')).length,
    missingImages: issues.filter((v) => v.issues.includes('Sem fotos')).length,
    expiringImages: issues.filter((v) => v.issues.includes('Foto temporária vencida ou perto de vencer')).length,
  };
  return json(req, { ok: true, stats, issues: issues.slice(0, 150), generatedAt: new Date().toISOString(),
    truncated: productsResult.data.length >= 2000,
    note: 'Auditoria do cache Supabase. Para alterar dados mestres, confira o cadastro original no Bling.' });
});
