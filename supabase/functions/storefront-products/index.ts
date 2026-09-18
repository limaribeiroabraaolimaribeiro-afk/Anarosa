/**
 * GET /storefront-products?category=<slug>&q=<busca>&limit=60&offset=0
 * Catálogo público lido do CACHE (store_*). Nunca consulta o Bling.
 * Retorna apenas campos públicos (ver storefront-serializer.ts).
 */
import { serve } from '../_shared/context.ts';
import { json, methodNotAllowed } from '../_shared/responses.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);

  const url = new URL(req.url);
  const category = url.searchParams.get('category')?.trim().slice(0, 80) || null;
  const search = url.searchParams.get('q')?.trim().slice(0, 80) || null;
  const limit = Number(url.searchParams.get('limit')) || 60;
  const offset = Number(url.searchParams.get('offset')) || 0;

  const { items, total } = await ctx.repo.listPublicProducts({ category, search, limit, offset });

  return json(
    req,
    { ok: true, items, total, limit: Math.min(Math.max(limit, 1), 200), offset: Math.max(offset, 0) },
    200,
    { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' },
  );
});
