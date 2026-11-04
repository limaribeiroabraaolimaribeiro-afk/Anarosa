/**
 * Meta Commerce Manager -> Catálogo -> Fonte de dados -> Feed programado.
 * Somente GET público. Nunca cria ou publica anúncios na Meta por conta própria.
 */
import { serve } from '../_shared/context.ts';
import { methodNotAllowed } from '../_shared/responses.ts';
import { renderMetaCatalog } from '../_shared/meta-catalog-feed.ts';

serve(async (req, ctx) => {
  if (req.method !== 'GET') return methodNotAllowed(req, ['GET']);
  const products = [];
  let offset = 0;
  let total = 0;
  do {
    const result = await ctx.repo.listPublicProducts({ limit: 200, offset });
    total = result.total;
    products.push(...result.items);
    offset += result.items.length;
    // Never send a truncated feed: that could remove catalog items.
    if (total > 1000) throw new Error('meta_feed_catalog_size_exceeded');
    if (result.items.length === 0) break;
  } while (offset < total);

  const result = renderMetaCatalog(products);
  if (!result.items) {
    // Don't accidentally replace a working Meta catalog with an empty feed.
    return new Response('Nenhum produto elegível com foto, marca e preço no momento.', {
      status: 503, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  return new Response('\uFEFF' + result.csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'inline; filename="anarosa-meta-catalog.csv"',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
});
